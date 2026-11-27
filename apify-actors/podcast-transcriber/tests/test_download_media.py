"""U-11 to U-13: download failures and cleanup, ffprobe and DRM, chunking (synthetic audio made by ffmpeg at test time)."""
import asyncio
import subprocess
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import httpx
import pytest

from helpers import HAS_FFMPEG, FakeEngine, Web, audio, net, run
from src import media
from src import net as netmod
from src.download import download
from src.net import Net, SourceError
from src.transcribe import Transcriber

URL = "https://cdn.example.org/ep.mp3"
needs_ffmpeg = pytest.mark.skipif(not HAS_FFMPEG, reason="ffmpeg/ffprobe not installed")


def _dl(web, tmp_path, **kw):
    dest = tmp_path / "audio"
    try:
        run(download(net(web), URL, dest, stall_seconds=kw.pop("stall", 5), **kw))
    except SourceError as e:
        assert not dest.exists(), "partial file removed"
        assert list(tmp_path.iterdir()) == []
        return e.code
    return "ok"


class Silent(BaseHTTPRequestHandler):
    def do_GET(self):  # noqa: N802
        self.send_response(200)
        self.send_header("Content-Type", "audio/mpeg")
        self.send_header("Content-Length", "1000000")
        self.end_headers()
        self.wfile.write(b"ID3" + b"\0" * 100)
        self.wfile.flush()
        time.sleep(5)

    def log_message(self, *a):
        pass


def test_u11_stall_on_a_real_loopback_server(tmp_path, monkeypatch):
    monkeypatch.setattr(netmod, "_ALLOW_LOOPBACK_FOR_TESTS", True)
    srv = ThreadingHTTPServer(("127.0.0.1", 0), Silent)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    try:
        async def go():
            async with httpx.AsyncClient() as c:
                t0 = time.monotonic()
                with pytest.raises(SourceError) as e:
                    await download(Net(c), f"http://127.0.0.1:{srv.server_port}/a.mp3", tmp_path / "a", stall_seconds=0.5)
                return e.value.code, time.monotonic() - t0
        code, took = asyncio.run(go())
    finally:
        srv.shutdown()
    assert code == "download_stall_timeout" and took < 0.5 + 2
    assert not (tmp_path / "a").exists()


def test_u11_loopback_is_blocked_without_the_test_switch(tmp_path):
    async def go():
        async with httpx.AsyncClient() as c:
            await download(Net(c), "http://127.0.0.1:9/a.mp3", tmp_path / "a", stall_seconds=1)
    with pytest.raises(SourceError) as e:
        asyncio.run(go())
    assert e.value.code == "ssrf_blocked"


def test_u11_status_codes_and_cleanup(tmp_path):
    for status, code in ((401, "audio_access_denied"), (403, "audio_access_denied"), (404, "audio_not_found"), (410, "audio_not_found")):
        web = Web()
        web.add(URL, httpx.Response(status))
        assert _dl(web, tmp_path) == code
        assert len(web.requests) <= 2  # at most one retry
    web = Web()
    web.add(URL, [httpx.Response(429, headers={"retry-after": "2"}), audio()])
    assert _dl(web, tmp_path) == "ok" and len(web.requests) == 2
    (tmp_path / "audio").unlink()
    web = Web()
    web.add(URL, httpx.Response(503))
    assert _dl(web, tmp_path) == "audio_unavailable"
    web = Web()
    web.add(URL, httpx.Response(200, content=b"<html>login</html>", headers={"content-type": "text/html"}))
    assert _dl(web, tmp_path) == "not_audio"
    web = Web()
    web.add(URL, audio(b"ID3" + b"\0" * (2 * 1024 * 1024)))
    assert _dl(web, tmp_path, max_mb=1) == "file_too_large"


def test_u11_temp_files_removed_after_every_episode(tmp_path):
    from helpers import FakeMedia, deps
    from src.runner import run as run_actor
    web = Web()
    web.add("https://cdn.example.org/ok.mp3", audio())
    web.add("https://cdn.example.org/gone.mp3", httpx.Response(404))
    d, out = deps(web, fake_media=FakeMedia(60), tmp=tmp_path)
    run(run_actor({"confirmRights": True, "sources": ["https://cdn.example.org/ok.mp3", "https://cdn.example.org/gone.mp3"]}, d))
    assert {r["status"] for r in out.rows} == {"ok", "error"}
    assert list(tmp_path.iterdir()) == []


def ffmpeg(*args):
    subprocess.run(["ffmpeg", "-nostdin", "-v", "error", "-y", *args], check=True)


def tone(path, seconds=3, extra=()):
    ffmpeg("-f", "lavfi", "-i", f"sine=frequency=440:duration={seconds}", *extra, str(path))
    return path


@needs_ffmpeg
@pytest.mark.parametrize("ext", ["mp3", "m4a", "wav", "ogg", "flac"])
def test_u12_formats_measured_by_ffprobe(tmp_path, ext):
    p = tone(tmp_path / f"a.{ext}")
    assert abs(run(media.probe(p)) - 3.0) < 0.2


@needs_ffmpeg
def test_u12_mp4_with_audio_and_not_audio_and_streams(tmp_path):
    mp4 = tmp_path / "v.mp4"
    ffmpeg("-f", "lavfi", "-i", "color=c=black:s=64x64:d=2", "-f", "lavfi", "-i", "sine=duration=2", "-shortest", "-pix_fmt", "yuv420p", str(mp4))
    assert abs(run(media.probe(mp4)) - 2.0) < 0.3
    fake = tmp_path / "text.mp3"
    fake.write_text("this is not audio at all\n" * 50)
    with pytest.raises(SourceError) as e:
        run(media.probe(fake))
    assert e.value.code == "not_audio"
    hls = tmp_path / "list.mp3"
    hls.write_text('#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="k"\nseg1.ts\n')
    with pytest.raises(SourceError) as e:
        run(media.probe(hls))
    assert e.value.code in ("drm_protected", "unsupported_stream")


@needs_ffmpeg
def test_u12_duration_is_ffprobe_not_feed(tmp_path):
    from helpers import deps
    from src.runner import run as run_actor
    web = Web()
    p = tone(tmp_path / "t.mp3", 7)
    web.add("https://feeds.example.org/f", httpx.Response(200, content=(
        '<rss><channel><item><title>t</title><itunes:duration xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd">'
        ' 99:00:00 </itunes:duration><enclosure url="https://cdn.example.org/t.mp3" length="0" type="audio/mpeg"/></item></channel></rss>'),
        headers={"content-type": "application/rss+xml"}))
    web.add("https://cdn.example.org/t.mp3", audio(p.read_bytes()))
    work = tmp_path / "w"
    work.mkdir()
    from types import SimpleNamespace

    from helpers import FakeMedia
    real = SimpleNamespace(probe=media.probe, reencode=media.reencode, silences=media.silences, plan=media.plan, cut=FakeMedia().cut)
    d, out = deps(web, fake_media=real, tmp=work)
    run(run_actor({"confirmRights": True, "sources": ["https://feeds.example.org/f"]}, d))
    assert out.rows[0]["durationSeconds"] == 7 and out.rows[0]["billedMinutes"] == 1


@pytest.fixture(scope="module")
def long_file(tmp_path_factory):
    if not HAS_FFMPEG:
        pytest.skip("ffmpeg/ffprobe not installed")
    p = tmp_path_factory.mktemp("long") / "65min.mp3"
    # 8 s of tone, 2 s of silence, repeated: speech-like bursts with pauses, 65 minutes, mono 16 kHz 32 kbps.
    ffmpeg("-f", "lavfi", "-i", "aevalsrc=0.5*sin(2*PI*300*t)*lt(mod(t\\,10)\\,8):s=16000:d=3900", "-ac", "1", "-b:a", "32k", str(p))
    return p


def test_u13_chunking_cuts_in_silence(long_file):
    dur = run(media.probe(long_file))
    assert abs(dur - 3900) < 1
    sil = run(media.silences(long_file))
    chunks = media.plan(dur, sil)
    assert len(chunks) == 4
    assert all(c.duration <= 20 * 60 for c in chunks)
    assert chunks[0].start == 0 and abs(chunks[-1].end - dur) < 1e-6
    assert all(a.end == b.start for a, b in zip(chunks, chunks[1:]))  # offsets add up, no overlap
    for c in chunks[1:]:
        assert 8.0 <= c.start % 10 <= 10.0, "each cut falls inside a 2-second pause"


def test_u13_hard_cut_overlap_has_no_duplicate_words_at_the_join(tmp_path):
    chunks = media.plan(3900.0, [])
    assert all(c.duration <= 20 * 60 for c in chunks)
    assert chunks[1].start == chunks[0].end - 2.0 and chunks[1].keep_from == chunks[0].end
    from helpers import FakeMedia
    src = tmp_path / "a.mp3"
    src.write_bytes(b"x")
    tr = Transcriber([FakeEngine()], cutter=FakeMedia().cut, log=lambda m: None)
    merged = run(tr.run(src, chunks, [], language=None, speakers=False, words=True, workdir=tmp_path, duration=3900.0))
    words = [s["text"] for s in merged.segments]
    assert len(words) == len(set(words)) == 3900
    starts = [s["start"] for s in merged.segments]
    assert starts == sorted(starts)
