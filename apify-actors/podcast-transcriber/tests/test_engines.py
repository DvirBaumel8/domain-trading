"""U-14 to U-17: adapters on recorded answers, fail-over, silent-truncation guard, hallucination filter."""
import asyncio
import json

import httpx
import pytest

from helpers import CANARIES, FIX, Clock, FakeEngine, FakeMedia, failing, per_second, run
from src import engines, media
from src.engines import AssemblyAI, Gemini, Groq, NotSelectable, Result, parse_assemblyai, parse_gemini, parse_groq, parse_openai
from src.net import SourceError
from src.transcribe import Transcriber, hallucination_filter


def load(name):
    return json.loads((FIX / name).read_text())


def test_u14_gemini_recorded_answer():
    r = parse_gemini(load("stt-gemini-3.5-transcribe-meditations-intro.json"))
    assert len(r.words) == 417
    assert r.segments[0] == {"start": 0.8, "end": 3.4, "text": "Introduction to the Meditations of Marcus Aurelius.", "speaker": None}
    assert engines._offset("4s") == 4.0 and engines._offset("4.200s") == 4.2 and engines._offset(3) == 3.0


def test_u14_openai_no_timestamps_is_refused():
    data = load("stt-openai-gpt-transcribe-meditations-intro.json")
    with pytest.raises(NotSelectable, match="no timestamps"):
        parse_openai(data)
    assert engines.OpenAI.timestamps is False


def test_u14_openai_is_never_selected(monkeypatch):
    for k, v in CANARIES.items():
        monkeypatch.setenv(k, v)
    logs = []
    chosen = engines.chain(httpx.AsyncClient(), speakers=False, order=["openai", "gemini"], log=logs.append)
    assert [e.name for e in chosen] == ["gemini"] and any("openai" in m for m in logs)


def test_u14_groq_and_assemblyai_shapes_parse_to_the_same_model():
    g = parse_groq(load("stt-groq-verbose-json.synthetic.json"))
    a = parse_assemblyai(load("stt-assemblyai.synthetic.json"))
    assert load("stt-groq-verbose-json.synthetic.json")["synthetic"] is True
    assert [s["start"] for s in g.segments] == [s["start"] for s in a.segments] == [0.8, 4.0]
    assert g.segments[0]["text"] == a.segments[0]["text"] == "Introduction to the Meditations of Marcus Aurelius."
    assert g.language == a.language == "en"
    assert [s["speaker"] for s in a.segments] == ["spk_1", "spk_2"]
    assert len(g.words) == len(a.words) == 12


def _adapter_run(cls, routes, tmp_path, monkeypatch, **kw):
    for k, v in CANARIES.items():
        monkeypatch.setenv(k, v)
    seen = []

    def handler(req):
        seen.append(req)
        for prefix, resp in routes.items():
            if str(req.url).startswith(prefix):
                return resp
        return httpx.Response(404)
    p = tmp_path / "c.mp3"
    p.write_bytes(b"ID3audio")
    clock = Clock()
    eng = cls(httpx.AsyncClient(transport=httpx.MockTransport(handler)), sleep=clock.sleep)
    res = run(eng.transcribe(p, language=None, speakers=kw.get("speakers", False), words=True))
    return res, seen


def _key_only_in_header(seen, key):
    for req in seen:
        assert key not in str(req.url)
        assert key.encode() not in (req.content or b"")
        assert key in " ".join(req.headers.values())


def test_u14_adapters_send_the_key_only_in_a_header(tmp_path, monkeypatch):
    res, seen = _adapter_run(Groq, {"https://api.groq.com/": httpx.Response(200, json=load("stt-groq-verbose-json.synthetic.json"))},
                             tmp_path, monkeypatch)
    assert res.segments and seen[0].headers["authorization"] == f"Bearer {CANARIES['GROQ_API_KEY']}"
    _key_only_in_header(seen, CANARIES["GROQ_API_KEY"])
    res, seen = _adapter_run(Gemini, {"https://generativelanguage.googleapis.com/": httpx.Response(
        200, json=load("stt-gemini-3.5-transcribe-meditations-intro.json"))}, tmp_path, monkeypatch)
    assert len(res.words) == 417
    _key_only_in_header(seen, CANARIES["GEMINI_API_KEY"])
    routes = {"https://api.assemblyai.com/v2/upload": httpx.Response(200, json={"upload_url": "https://cdn.assemblyai.com/upload/x"}),
              "https://api.assemblyai.com/v2/transcript/": httpx.Response(200, json=load("stt-assemblyai.synthetic.json")),
              "https://api.assemblyai.com/v2/transcript": httpx.Response(200, json={"id": "synthetic-id", "status": "queued"})}
    res, seen = _adapter_run(AssemblyAI, routes, tmp_path, monkeypatch, speakers=True)
    assert [s["speaker"] for s in res.segments] == ["spk_1", "spk_2"]
    _key_only_in_header(seen, CANARIES["ASSEMBLYAI_API_KEY"])


def _tr(engs, tmp_path, **kw):
    src = tmp_path / "a.mp3"
    src.write_bytes(b"x")
    clock = Clock()
    logs = []
    tr = Transcriber(engs, sleep=clock.sleep, cutter=FakeMedia().cut, log=logs.append, **kw)
    return tr, src, logs


def test_u15_failover_after_three_429(tmp_path):
    e1, e2 = FakeEngine("one", failing()), FakeEngine("two")
    tr, src, logs = _tr([e1, e2], tmp_path)
    m = run(tr.run(src, media.plan(60, []), [], language=None, speakers=False, words=False, workdir=tmp_path, duration=60))
    assert len(e1.calls) == 3 and len(e2.calls) == 1 and m.engine == "two-model"


def test_u15_hang_counts_as_failure(tmp_path):
    async def hang(c):
        await asyncio.sleep(10)
    e1, e2 = FakeEngine("one", hang), FakeEngine("two")
    tr, src, _ = _tr([e1, e2], tmp_path, timeout=0.05)
    m = run(tr.run(src, media.plan(30, []), [], language=None, speakers=False, words=False, workdir=tmp_path, duration=30))
    assert m.engine == "two-model"


def test_u15_every_engine_fails_stt_failed_and_no_charge(tmp_path):
    from helpers import Web, audio, deps
    from src.runner import run as run_actor
    web = Web()
    web.add("https://cdn.example.org/a.mp3", audio())
    engs = [FakeEngine("one", failing()), FakeEngine("two", failing(transient=False, msg="HTTP 400"))]
    d, out = deps(web, engines=engs, tmp=tmp_path / "w")
    (tmp_path / "w").mkdir()
    ok, _msg = run(run_actor({"confirmRights": True, "sources": ["https://cdn.example.org/a.mp3"]}, d))
    assert out.rows[0]["errorCode"] == "stt_failed" and out.charges.calls == [] and not ok


def test_u16_truncated_chunk_retried_at_half_then_failover(tmp_path):
    truncating = FakeEngine("gem", lambda c: per_second(c, until=(c["end"] - c["start"]) * 0.6))
    good = FakeEngine("good")
    tr, src, logs = _tr([truncating, good], tmp_path)
    m = run(tr.run(src, media.plan(600, []), [], language=None, speakers=False, words=False, workdir=tmp_path, duration=600))
    assert len(truncating.calls) == 2  # the chunk, then the first half (still cut short) -> fail over
    assert m.engine == "good-model" and len(m.segments) == 600
    assert any("stops early" in x for x in logs)


def test_u16_half_length_retry_succeeds(tmp_path):
    def behave(c):
        return per_second(c, until=(c["end"] - c["start"]) * (0.6 if c["end"] - c["start"] > 400 else 1.0))
    eng = FakeEngine("gem", behave)
    tr, src, _ = _tr([eng], tmp_path)
    m = run(tr.run(src, media.plan(600, []), [], language=None, speakers=False, words=False, workdir=tmp_path, duration=600))
    assert len(eng.calls) == 3 and len(m.segments) == 600


def test_u16_silent_tail_is_accepted(tmp_path):
    eng = FakeEngine("gem", lambda c: per_second(c, until=360))
    tr, src, _ = _tr([eng], tmp_path)
    m = run(tr.run(src, media.plan(600, [(360.5, 600.0)]), [(360.5, 600.0)], language=None, speakers=False, words=False,
                   workdir=tmp_path, duration=600))
    assert len(eng.calls) == 1 and len(m.segments) == 360


def seg(text, **kw):
    return {"start": 0.0, "end": 1.0, "text": text, "speaker": None, **kw}


def test_u17_hallucination_filter():
    segs = [seg("real words one", no_speech_prob=0.1, avg_logprob=-0.2, compression_ratio=1.2),
            seg("Thanks for watching!", no_speech_prob=0.9, avg_logprob=-1.5, compression_ratio=1.0),
            seg("la la la la la la la", no_speech_prob=0.1, avg_logprob=-0.3, compression_ratio=3.0),
            *[seg("Thank you.", no_speech_prob=0.2, avg_logprob=-0.4, compression_ratio=1.0) for _ in range(5)],
            seg("real words two", no_speech_prob=0.7, avg_logprob=-0.5, compression_ratio=1.1)]
    out, counts = hallucination_filter(segs)
    assert [s["text"] for s in out] == ["real words one", "Thank you.", "real words two"]
    assert counts == {"no_speech": 1, "compression": 1, "repeats": 4}


def test_u17_filter_counts_are_logged(tmp_path):
    def behave(c):
        return Result([seg("hello there"), seg("Bye."), seg("Bye."), seg("Bye."), seg("x", end=50.0)], None, "en", "m")
    tr, src, logs = _tr([FakeEngine("g", behave)], tmp_path)
    run(tr.run(src, media.plan(55, [(50, 55)]), [(50, 55)], language=None, speakers=False, words=False, workdir=tmp_path, duration=55))
    assert any("filtered segments" in x and "'repeats': 2" in x for x in logs)


def test_no_engine_at_all_is_stt_failed(tmp_path):
    tr, src, _ = _tr([], tmp_path)
    with pytest.raises(SourceError) as e:
        run(tr.run(src, media.plan(30, []), [], language=None, speakers=False, words=False, workdir=tmp_path, duration=30))
    assert e.value.code == "stt_failed"
