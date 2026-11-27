"""U-01 to U-05 and U-25: input checks, deny-list, SSRF guard, politeness."""
import asyncio
import re
import time

import httpx
import pytest

from helpers import Web, audio, deps, net, resolver, run, xml
from src import inputs
from src import net as netmod
from src.net import SourceError
from src.runner import run as run_actor


def test_u01_empty_sources_fail_without_network_or_charge():
    web = Web()
    d, out = deps(web)
    ok, msg = run(run_actor({"sources": [], "confirmRights": True}, d))
    assert not ok and "at least one source" in msg
    assert web.requests == [] and out.charges.calls == [] and out.rows == []


@pytest.mark.parametrize("rights", [False, None, "yes"])
def test_u02_rights_not_confirmed(rights):
    web = Web()
    d, out = deps(web)
    raw = {"sources": ["https://example.org/feed.xml"]}
    if rights is not None:
        raw["confirmRights"] = rights
    with pytest.raises(inputs.InputError) as e:
        inputs.parse(raw)
    assert e.value.code == "rights_not_confirmed"
    ok, msg = run(run_actor(raw, d))
    assert not ok and "confirmRights" in msg and web.requests == [] and out.charges.calls == []


def test_u03_normalisation_and_invalid_inputs(tmp_path):
    o = inputs.parse({"confirmRights": True, "sources": [
        "podcasts.example.org/feed.xml", "https://podcasts.example.org/feed.xml", " https://podcasts.example.org/feed.xml ",
        "ftp://files.example.org/a.mp3", "file:///etc/passwd", "javascript:alert(1)", "just some words", "hello"]})
    assert o.sources == ["https://podcasts.example.org/feed.xml"]
    assert len(o.invalid) == 5
    web = Web()
    web.add("https://podcasts.example.org/feed.xml", xml("feed-librivox-meditations.xml"))
    web.add("https://www.archive.org/download/meditations_0708_librivox/meditations_00_marcusaurelius_64kb.mp3", audio())
    d, out = deps(web, tmp=tmp_path)
    run(run_actor({"confirmRights": True, "maxEpisodesPerFeed": 1, "sources": ["podcasts.example.org/feed.xml", "ftp://x.org/a.mp3"]}, d))
    assert out.kv["INVALID_INPUTS"][0] == [{"input": "ftp://x.org/a.mp3", "reason": "Not an http or https URL."}]
    assert all(r["source"] != "ftp://x.org/a.mp3" for r in out.rows)


DENY = ["https://www.youtube.com/watch?v=abc", "https://youtu.be/abc", "https://open.spotify.com/show/abc", "https://soundcloud.com/a/b",
        "https://www.tiktok.com/@a/video/1", "https://www.instagram.com/p/a", "https://www.facebook.com/a/videos/1", "https://x.com/a/status/1",
        "https://www.audible.com/pd/a", "https://music.apple.com/us/album/a", "https://cdn.example.org/live/stream.m3u8"]


def test_u04_platform_deny_list_makes_no_request(tmp_path):
    web = Web()
    d, out = deps(web, tmp=tmp_path)
    ok, msg = run(run_actor({"confirmRights": True, "sources": DENY}, d))
    assert web.requests == []
    codes = {r["source"]: r["errorCode"] for r in out.rows}
    assert codes["https://cdn.example.org/live/stream.m3u8"] == "unsupported_stream"
    assert all(c == "unsupported_platform" for s, c in codes.items() if not s.endswith(".m3u8"))
    spotify = next(r for r in out.rows if "spotify" in r["source"])
    assert "RSS" in spotify["errorMessage"]
    assert out.charges.calls == [] and not ok


SSRF = ["http://localhost/a.mp3", "http://127.0.0.1/a.mp3", "http://[::1]/a.mp3", "http://10.0.0.1/a.mp3", "http://192.168.1.1/a.mp3",
        "http://172.16.0.1/a.mp3", "http://169.254.169.254/latest/meta-data/", "http://internal.example.org/a.mp3"]


@pytest.mark.parametrize("url", SSRF)
def test_u05_ssrf_blocked(url):
    web = Web()
    n = net(web, mapping={"internal.example.org": "10.1.2.3"})
    with pytest.raises(SourceError) as e:
        run(n.check(url))
    assert e.value.code == "ssrf_blocked" and web.requests == []


def test_u05_redirect_to_private_ip_is_checked_at_each_hop():
    web = Web()
    web.add("https://public.example.org/a.mp3", httpx.Response(302, headers={"location": "http://10.0.0.7/secret.mp3"}))
    web.add("http://10.0.0.7/secret.mp3", audio())
    n = net(web)

    async def go():
        async with n.stream("https://public.example.org/a.mp3"):
            pass
    with pytest.raises(SourceError) as e:
        run(go())
    assert e.value.code == "ssrf_blocked"
    assert [str(r.url) for r in web.requests] == ["https://public.example.org/a.mp3"]


def test_u05_more_than_five_redirects():
    web = Web()
    for i in range(7):
        web.add(f"https://r.example.org/{i}", httpx.Response(302, headers={"location": f"/{i + 1}"}))
    n = net(web)

    async def go():
        async with n.stream("https://r.example.org/0"):
            pass
    with pytest.raises(SourceError) as e:
        run(go())
    assert e.value.code == "too_many_redirects" and len(web.requests) == 6


def test_u05_loopback_switch_is_off_by_default_and_not_from_input_or_env(monkeypatch):
    monkeypatch.undo()
    assert netmod._ALLOW_LOOPBACK_FOR_TESTS is False
    import inspect
    src = inspect.getsource(netmod)
    assert not re.search(r"os\.environ|getenv", src)
    assert "_ALLOW_LOOPBACK_FOR_TESTS" not in inspect.getsource(inputs)


def test_u25_politeness_rate_and_concurrency_and_user_agent():
    """Real (short) clock: the per-host interval is scaled down to 0.05 s so the gaps can be measured."""
    clock = time.monotonic
    web = Web()
    active, peak = [0], [0]

    stamps = []

    async def slow(request):
        stamps.append(clock())
        active[0] += 1
        peak[0] = max(peak[0], active[0])
        await asyncio.sleep(0.01)
        active[0] -= 1
        return audio()
    for i in range(5):
        web.add(f"https://cdn.example.org/{i}.mp3", slow)
    n = netmod.Net(web.client(), resolver=resolver(), interval=0.05)

    async def one(i):
        async with n.download_slot(f"https://cdn.example.org/{i}.mp3"):
            async with n.stream(f"https://cdn.example.org/{i}.mp3") as r:
                await r.aread()

    async def go():
        await asyncio.gather(*(one(i) for i in range(5)))
    run(go())
    assert peak[0] <= 2
    stamps.sort()
    assert all(b - a >= 0.049 for a, b in zip(stamps, stamps[1:]))
    assert {r.headers["user-agent"] for r in web.requests} == {"PodcastTranscriberActor/0.1 (Apify Actor)"}
    from src import config, polite
    assert polite.HostLimiter().min_interval == 1.0 and config.HOST_INTERVAL == 1.0 and config.DOWNLOADS_PER_HOST == 2
    assert config.UA == "PodcastTranscriberActor/0.1 (Apify Actor)"
