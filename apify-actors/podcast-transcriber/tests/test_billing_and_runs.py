"""U-19 to U-24: billing matrix, budget check before paid calls, free plan, caps and clocks, run result, no secrets."""
import asyncio
import base64
import io
import json
import logging
import re
from urllib.parse import quote

import httpx

from helpers import CANARIES, Charges, Clock, FakeEngine, FakeMedia, Web, audio, deps, run, xml
from src import billing
from src.addons import Summariser
from src.billing import Billing
from src.runner import run as run_actor

A = "https://cdn.example.org/a.mp3"
B = "https://cdn.example.org/b.mp3"


class StubSummary:
    def __init__(self, result=None):
        self.result = result or {"summary": "Short.", "chapters": [{"start": 0.0, "title": "Start"}], "keyQuotes": []}

    async def run(self, segs, duration, want):
        return dict(self.result)


def go(raw, web=None, **kw):
    web = web or Web()
    for u in (A, B):
        if u not in web.routes:
            web.add(u, audio())
    d, out = deps(web, **kw)
    ok, msg = run(run_actor({"confirmRights": True, **raw}, d))
    return ok, msg, out, web


def test_u19_audio_minutes(tmp_path):
    ok, _m, out, _w = go({"sources": [A]}, fake_media=FakeMedia(61), tmp=tmp_path)
    assert ok and out.charges.events() == [("audio-minute", 2)] and out.rows[0]["billedMinutes"] == 2


def test_u19_speakers_and_summary(tmp_path):
    eng = FakeEngine("ai", speakers=True)
    ok, _m, out, _w = go({"sources": [A], "speakerLabels": True, "addOns": ["summary"]}, engines=[eng], fake_media=FakeMedia(125),
                         summariser=StubSummary(), tmp=tmp_path)
    assert out.charges.events() == [("audio-minute", 3), ("speaker-minute", 3), ("summary", 1)]
    assert out.rows[0]["segments"][0]["speaker"] == "spk_1"


def test_u19_error_and_skipped_rows_not_charged(tmp_path):
    web = Web()
    web.add(A, httpx.Response(404))
    ok, _m, out, _w = go({"sources": [A, B], "maxAudioMinutesPerEpisode": 1}, web=web, fake_media=FakeMedia(300), tmp=tmp_path)
    assert {r["status"] for r in out.rows} == {"error", "skipped"} and out.charges.calls == [] and ok


def test_u19_event_names_are_exactly_four_and_only_billing_charges():
    from pathlib import Path
    assert set(billing.EVENTS) == {"audio-minute", "speaker-minute", "summary", "publisher-transcript"}
    src = Path(billing.__file__).parent
    for p in src.glob("*.py"):
        text = p.read_text()
        if p.name != "billing.py":
            assert "Actor.charge" not in text and "charged_event_name" not in text, p
            assert not re.search(r"['\"](audio-minute|speaker-minute|publisher-transcript)['\"]", text), p
    assert "Actor.charge(" in (src / "billing.py").read_text()


def test_u19_idempotency_keys_stable_and_charged_once():
    c = Charges()
    b = Billing(c.charge, c.max, log=lambda m: None)
    run(b.charge("guid|url", "audio-minute", 3))
    run(b.charge("guid|url", "audio-minute", 3))
    assert c.calls == [("audio-minute", 3, billing.idempotency_key("guid|url", "audio-minute"))]
    assert billing.idempotency_key("guid|url", "audio-minute") == billing.idempotency_key("guid|url", "audio-minute")


def test_u19_charge_limit_reached_stops_gracefully(tmp_path):
    ok, msg, out, _w = go({"sources": [A, B]}, charges=Charges(short={"audio-minute": 1}), fake_media=FakeMedia(180), tmp=tmp_path)
    assert ok and "maximum charge" in msg
    assert out.rows[0]["status"] == "ok"
    assert out.charges.events() == [("audio-minute", 3)]  # nothing charged after the limit was hit
    assert any("charge limit reached" in x for x in out.logs)


def test_u20_budget_too_low_engine_never_called(tmp_path):
    eng = FakeEngine()
    ok, _m, out, _w = go({"sources": [A]}, engines=[eng], charges=Charges(limit={"audio-minute": 2}), fake_media=FakeMedia(600), tmp=tmp_path)
    assert out.rows[0]["status"] == "skipped" and out.rows[0]["errorCode"] == "budget_too_low"
    assert eng.calls == [] and out.charges.calls == []


def test_u21_free_plan_cap(tmp_path, monkeypatch):
    ok, msg, out, _w = go({"sources": [A, B]}, paying=False, fake_media=FakeMedia(1200), tmp=tmp_path)
    codes = sorted((r["status"], r["errorCode"]) for r in out.rows)
    assert codes == [("skipped", "free_plan_cap"), ("skipped", "free_plan_cap")]
    assert "Free-plan runs transcribe up to 15 minutes" in msg
    ok, msg, out, _w = go({"sources": [A, B]}, paying=False, fake_media=FakeMedia(480), tmp=tmp_path)
    assert sorted(r["status"] for r in out.rows) == ["ok", "skipped"]
    assert sum(r["billedMinutes"] for r in out.rows) <= 15


def test_u21_publisher_transcripts_not_capped_and_paying_flag(tmp_path, monkeypatch):
    from src import config
    vtt = b"WEBVTT\n\n" + b"".join(f"00:00:{i:02d}.000 --> 00:00:{i:02d}.900\nword word word word word\n\n".encode() for i in range(10))
    web = Web()
    web.add("https://podnews.net/rss", xml("feed-podnews-with-transcript-tag.xml"))
    for d_ in ("261126", "261125", "261124"):
        web.add(f"https://podnews.net/audio/podnews{d_}.mp3.vtt", httpx.Response(200, content=vtt, headers={"content-type": "text/vtt"}))
    ok, _m, out, _w = go({"sources": ["https://podnews.net/rss"]}, web=web, paying=False, tmp=tmp_path)
    assert [r["transcriptSource"] for r in out.rows] == ["publisher"] * 3
    assert not config.is_paying()
    monkeypatch.setenv("APIFY_USER_IS_PAYING", "0")
    monkeypatch.setenv("APIFY_USER_ID", "u1")
    monkeypatch.setenv("OPERATOR_USER_IDS", "u0, u1")
    assert config.is_paying()
    monkeypatch.setenv("OPERATOR_USER_IDS", "u0")
    assert not config.is_paying()
    monkeypatch.setenv("APIFY_USER_IS_PAYING", "1")
    assert config.is_paying()


def test_u22_episode_and_run_caps(tmp_path):
    _ok, _m, out, _w = go({"sources": [A], "maxAudioMinutesPerEpisode": 5}, fake_media=FakeMedia(400), tmp=tmp_path)
    assert out.rows[0]["errorCode"] == "episode_too_long" and out.charges.calls == []
    _ok, _m, out, _w = go({"sources": [A, B], "maxTotalAudioMinutes": 8}, fake_media=FakeMedia(300), tmp=tmp_path)
    assert sorted(str(r["errorCode"]) for r in out.rows) == ["None", "run_minute_cap"]


def test_u22_episode_timeout_by_fake_clock_next_episode_runs(tmp_path):
    clock = Clock()

    class SlowMedia(FakeMedia):
        async def probe(self, path):
            self.calls.append("probe")
            if len(self.calls) == 1:
                clock.t += 46 * 60  # past episodeTimeoutMinutes (45)
            return 60.0
    web = Web()
    web.add(A, audio())
    web.add(B, audio())
    import src.runner as r
    old = r.config.EPISODE_CONCURRENCY
    r.config.EPISODE_CONCURRENCY = 1
    try:
        d, out = deps(web, fake_media=SlowMedia(), clock=clock, tmp=tmp_path)
        ok, _m = run(run_actor({"confirmRights": True, "sources": [A, B]}, d))
    finally:
        r.config.EPISODE_CONCURRENCY = old
    assert [r_["errorCode"] for r_ in out.rows] == ["episode_timeout", None]
    assert out.charges.events() == [("audio-minute", 1)] and ok


def test_u22_episode_timeout_real_wall_clock(tmp_path, monkeypatch):
    async def hang(c):
        await asyncio.sleep(30)
    import src.runner as r
    monkeypatch.setattr(r.inputs, "_int", lambda raw, name, default, lo, hi: 0 if name == "episodeTimeoutMinutes" else
                        raw.get(name, default) if isinstance(raw.get(name, default), int) else default)
    ok, _m, out, _w = go({"sources": [A]}, engines=[FakeEngine("h", hang)], tmp=tmp_path)
    assert out.rows[0]["errorCode"] == "episode_timeout" and out.charges.calls == []
    assert list(tmp_path.iterdir()) == []


def test_u23_mixed_run_succeeds_all_failed_run_fails(tmp_path):
    web = Web()
    web.add(A, httpx.Response(404))
    ok, _m, out, _w = go({"sources": [A, B]}, web=web, tmp=tmp_path)
    assert ok and len(out.rows) == 2
    web = Web()
    web.add(A, httpx.Response(404))
    web.add(B, httpx.Response(403))
    ok, msg, out, _w = go({"sources": [A, B, "https://example.com/"]}, web=web, tmp=tmp_path)
    assert not ok and msg == "No episode could be processed. See the dataset for the reason per source."
    assert out.charges.calls == [] and len(out.rows) == 3


def test_u24_no_secret_anywhere(tmp_path, monkeypatch, caplog):
    for k, v in CANARIES.items():
        monkeypatch.setenv(k, v)
    forms = set()
    for v in CANARIES.values():
        forms |= {v, base64.b64encode(v.encode()).decode(), quote(v), quote(v, safe="")}

    def boom(c):
        raise RuntimeError("engine said: " + CANARIES["GROQ_API_KEY"])
    web = Web()
    web.add("https://cdn.example.org/s.mp3?sig=SIGNEDSECRET123", httpx.Response(403))
    web.add(A, audio())

    def llm(req):
        return httpx.Response(500, text="upstream " + CANARIES["OPENAI_API_KEY"])
    s = Summariser(httpx.AsyncClient(transport=httpx.MockTransport(llm)), models=["openai:x"], log=lambda m: logs.append(m))
    logs = []
    caplog.set_level(logging.DEBUG)
    stream = io.StringIO()
    handler = logging.StreamHandler(stream)
    logging.getLogger().addHandler(handler)
    try:
        ok, msg, out, _w = go({"sources": [A, "https://cdn.example.org/s.mp3?sig=SIGNEDSECRET123", B], "addOns": ["summary"]},
                              engines=[FakeEngine("bad", boom), FakeEngine()], summariser=s, logs=logs, tmp=tmp_path)
    finally:
        logging.getLogger().removeHandler(handler)
    everything = json.dumps([out.rows, {k: str(v) for k, v in out.kv.items()}, out.status, msg, logs]) + caplog.text + stream.getvalue()
    for f in forms:
        assert f not in everything
    # The signed URL the user typed is echoed only in its own source/audioUrl fields, never in messages or logs.
    said = json.dumps([[r["errorMessage"] for r in out.rows], out.status, msg, logs]) + caplog.text + stream.getvalue()
    assert "SIGNEDSECRET123" not in said
    assert all("?" not in (r["errorMessage"] or "") for r in out.rows)
