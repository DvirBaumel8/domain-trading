"""U-26 output files, U-27 golden run (real ffmpeg, the real Gemini adapter on its recorded answer, the LibriVox feed)."""
import json

import httpx
import pytest

from helpers import CANARIES, FIX, HAS_FFMPEG, Web, deps, run, xml
from src import engines, formats, media
from src.engines import parse_gemini
from src.runner import run as run_actor

SEGS = parse_gemini(json.loads((FIX / "stt-gemini-3.5-transcribe-meditations-intro.json").read_text())).segments
GOLDEN = FIX / "golden-meditations-row.json"
MP3 = "https://www.archive.org/download/meditations_0708_librivox/meditations_00_marcusaurelius_64kb.mp3"


def test_u26_txt_srt_vtt_json():
    srt = formats.to_srt(SEGS[:2])
    assert srt.startswith("1\n00:00:00,800 --> 00:00:03,400\nIntroduction to the Meditations of Marcus Aurelius.\n")
    vtt = formats.to_vtt(SEGS[:2])
    assert vtt.startswith("WEBVTT\n\n00:00:00.800 --> 00:00:03.400\nIntroduction")
    assert "spk_" not in srt + vtt
    assert formats.to_txt(SEGS[:2]) == "Introduction to the Meditations of Marcus Aurelius. This is an LibriVox recording.\n"
    spk = [dict(s, speaker=f"spk_{i % 2 + 1}") for i, s in enumerate(SEGS[:2])]
    assert "spk_1: Introduction" in formats.to_srt(spk) and "spk_2: This is" in formats.to_vtt(spk)
    assert formats.to_txt(spk).splitlines()[0] == "spk_1: Introduction to the Meditations of Marcus Aurelius."
    j = json.loads(formats.to_json({"text": "t", "segments": SEGS[:1]}, [{"word": "a", "start": 0, "end": 1}]))
    assert j["words"] and j["segments"][0]["start"] == 0.8


def test_u26_files_link_saved_keys_and_no_audio_bytes(tmp_path):
    from helpers import FakeMedia, audio
    web = Web()
    web.add("https://cdn.example.org/a.mp3", audio(b"ID3" + b"\xAA" * 5000))
    d, out = deps(web, fake_media=FakeMedia(30), tmp=tmp_path)
    run(run_actor({"confirmRights": True, "outputFormats": ["txt", "srt", "vtt", "json"], "wordTimestamps": True,
                   "sources": ["https://cdn.example.org/a.mp3"]}, d))
    row = out.rows[0]
    assert set(row["files"]) == {"txt", "srt", "vtt", "json"}
    for fmt, url in row["files"].items():
        key = url.rsplit("/", 1)[-1]
        assert url == f"https://api.apify.com/v2/key-value-stores/STORE1/records/{key}" and key in out.kv
    assert "words" in json.loads(out.kv["transcript-1.json"][0]) and "words" not in row
    blob = json.dumps(out.rows) + "".join(str(v) for v in out.kv.values())
    assert "\\u00aa" * 10 not in blob.lower() and "\xAA" * 10 not in blob
    assert list(tmp_path.iterdir()) == []


@pytest.mark.skipif(not HAS_FFMPEG, reason="ffmpeg/ffprobe not installed")
def test_u27_golden_run(tmp_path, monkeypatch):
    monkeypatch.setenv("GEMINI_API_KEY", CANARIES["GEMINI_API_KEY"])
    web = Web()
    web.add("https://librivox.org/rss/1095", xml("feed-librivox-meditations.xml"))
    web.add(MP3, httpx.Response(200, content=(FIX / "meditations-intro-30s.mp3").read_bytes(), headers={"content-type": "audio/mpeg"}))
    web.add("https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-transcribe:generateContent",
            httpx.Response(200, json=json.loads((FIX / "stt-gemini-3.5-transcribe-meditations-intro.json").read_text())))
    d, out = deps(web, fake_media=media, tmp=tmp_path)
    d.engines = lambda speakers: engines.chain(d.net.client, speakers, order=["gemini"], sleep=d.sleep)
    ok, msg = run(run_actor({"confirmRights": True, "maxEpisodesPerFeed": 1, "sources": ["https://librivox.org/rss/1095"]}, d))
    assert ok, msg
    row = dict(out.rows[0], files=None)
    assert out.charges.events() == [("audio-minute", 1)]
    assert row == json.loads(GOLDEN.read_text())
    assert row["durationSeconds"] == 30 and row["segments"][0]["start"] == 0.8 and row["publishedAt"] is None
