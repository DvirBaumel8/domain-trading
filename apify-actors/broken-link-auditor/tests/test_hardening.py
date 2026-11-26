"""H2 hardening: retry policy, streaming crawl, input errors, sitemap message (offline, mock transports)."""
import asyncio
import pathlib
import socket
import ssl
import sys
import time

import httpx

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))
from src import core, runner  # noqa: E402
from src.polite import HostLimiter  # noqa: E402


async def nosleep(_):
    return None


def drive(inp, handler, sleep=nosleep, push_stop=lambda row: False):
    pushed, logs, saved = [], [], {}

    async def push(row, charge):
        pushed.append((row, charge))
        return push_stop(row)

    async def status(_):
        return None

    async def save(items):
        saved["INVALID_INPUTS"] = items

    async def go():
        async with httpx.AsyncClient(transport=httpx.MockTransport(handler), follow_redirects=False) as c:
            return await runner.run(inp, client=c, push=push, set_status=status, sleep=sleep, limiter=HostLimiter(0, sleep=nosleep),
                                    log=logs.append, save_invalid=save)
    return asyncio.run(go()), pushed, logs, saved


def _chained(outer, inner):
    outer.__cause__ = inner
    return outer


def test_nxdomain_is_one_attempt_and_fast():
    calls = []

    def h(req):
        if req.url.path != "/robots.txt":
            calls.append(1)
        raise _chained(httpx.ConnectError("x"), socket.gaierror(-2, "Name or service not known"))
    t = time.monotonic()
    _, pushed, _, _ = drive({"startUrls": ["https://nope.invalid/x"]}, h, sleep=asyncio.sleep)
    assert len(calls) == 1 and time.monotonic() - t < 2
    assert pushed[0][0]["error"] == "dns_failure" and pushed[0][1] is False


def test_tls_error_is_one_attempt():
    calls = []

    def h(req):
        if req.url.path != "/robots.txt":
            calls.append(1)
        raise _chained(httpx.ConnectError("x"), ssl.SSLError("CERTIFICATE_VERIFY_FAILED certificate"))
    _, pushed, _, _ = drive({"startUrls": ["https://bad.example/"]}, h)
    assert len(calls) == 1 and pushed[0][0]["error"] == "tls_error"


def test_timeouts_resets_and_429_5xx_are_retried():
    def count(exc=None, status=None):
        calls = []

        def h(req):
            if req.url.path == "/robots.txt":
                return httpx.Response(404)
            calls.append(1)
            if exc:
                raise exc
            return httpx.Response(status)
        drive({"startUrls": ["https://ex.com/x"]}, h)
        return len(calls)
    # the back-off budget (about 5 s: 2 s then 3 s) allows two retries, so three attempts
    assert count(exc=httpx.ReadTimeout("t")) >= 3
    assert count(exc=_chained(httpx.ReadError("r"), ConnectionResetError())) >= 3
    assert count(status=429) == 3 and count(status=503) == 3
    assert count(status=404) == 1


def site(req):
    """Fake 3-level site: / -> /l1a,/l1b ; /l1a -> /l2a ; /l2a -> /l3a. /l2a links back to /."""
    pages = {"/": ["/l1a", "/l1b"], "/l1a": ["/l2a"], "/l1b": [], "/l2a": ["/l3a", "/"], "/l3a": []}
    if req.url.path == "/robots.txt":
        return httpx.Response(404)
    if req.url.path in pages:
        return httpx.Response(200, headers={"content-type": "text/html"},
                              text="".join(f'<a href="{p}">x</a>' for p in pages[req.url.path]))
    return httpx.Response(404)


def test_crawl_streams_and_stop_after_first_row_keeps_it():
    inp = {"startUrls": ["https://ex.com/"], "mode": "crawl", "maxDepth": 5}
    # forced stop as soon as the first row is pushed
    _, pushed, _, _ = drive(inp, site, push_stop=lambda row: row["url"] == "https://ex.com/")
    urls = [r["url"] for r, _ in pushed]
    assert urls == ["https://ex.com/"]  # rows are pushed right after each check; the stop is honoured at once
    # without a stop all levels arrive, in level order
    _, pushed, _, _ = drive(inp, site)
    assert [r["url"].rsplit("/", 1)[-1] for r, _ in pushed] == ["", "l1a", "l1b", "l2a", "l3a"]


def test_crawl_cancelled_on_level_two_keeps_level_zero_and_one():
    pushed = []

    async def go():
        reached = asyncio.Event()

        class T(httpx.AsyncBaseTransport):
            async def handle_async_request(self, req):
                if req.url.path == "/l2a":
                    reached.set()
                    await asyncio.sleep(60)  # the "run timeout" strikes while level 2 is in flight
                return site(req)

        async def push(row, charge):
            pushed.append(row["url"])
            return False

        async def status(_):
            return None
        async with httpx.AsyncClient(transport=T(), follow_redirects=False) as c:
            task = asyncio.create_task(runner.run({"startUrls": ["https://ex.com/"], "mode": "crawl", "maxDepth": 5},
                                                  client=c, push=push, set_status=status, limiter=HostLimiter(0, sleep=nosleep)))
            await reached.wait()
            task.cancel()
            try:
                await task
            except asyncio.CancelledError:
                pass
    asyncio.run(go())
    assert pushed == ["https://ex.com/", "https://ex.com/l1a", "https://ex.com/l1b"]


def test_crawl_row_sources_list_earlier_levels_only():
    _, pushed, _, _ = drive({"startUrls": ["https://ex.com/"], "mode": "crawl", "maxDepth": 5}, site)
    rows = {r["url"]: r for r, _ in pushed}
    assert {"sourceUrl": "https://ex.com/l1a", "anchorText": "x"} in rows["https://ex.com/l2a"]["sources"]
    assert rows["https://ex.com/"]["sources"] == []  # the back-link from /l2a was found later


def test_abort_mid_crawl_keeps_and_charges_every_checked_row():
    """A platform timeout cancels the run task: every URL checked before that is already pushed (and charged)."""
    pushed, reached = [], asyncio.Event()

    class T(httpx.AsyncBaseTransport):
        async def handle_async_request(self, req):
            if req.url.path == "/l2a":
                reached.set()
                await asyncio.sleep(60)
            if req.url.path == "/l1b":
                return httpx.Response(404)
            return site(req)

    async def push(row, charge):
        pushed.append((row["url"], charge))
        return False

    async def status(_):
        return None

    async def go():
        async with httpx.AsyncClient(transport=T(), follow_redirects=False) as c:
            task = asyncio.create_task(runner.run({"startUrls": ["https://ex.com/"], "mode": "crawl", "maxDepth": 5},
                                                  client=c, push=push, set_status=status, limiter=HostLimiter(0, sleep=nosleep)))
            await reached.wait()
            task.cancel()
            try:
                await task
            except asyncio.CancelledError:
                pass
    asyncio.run(go())
    assert dict(pushed) == {"https://ex.com/": True, "https://ex.com/l1a": True, "https://ex.com/l1b": True}
    assert "https://ex.com/l2a" not in dict(pushed)


def test_stop_event_ends_crawl_cleanly_without_new_urls():
    ev, pushed = asyncio.Event(), []

    async def push(row, charge):
        pushed.append(row["url"])
        ev.set()  # an abort or migration arrives after the first row
        return False

    async def status(_):
        return None

    async def go():
        async with httpx.AsyncClient(transport=httpx.MockTransport(site), follow_redirects=False) as c:
            return await runner.run({"startUrls": ["https://ex.com/"], "mode": "crawl", "maxDepth": 5}, client=c,
                                    push=push, set_status=status, limiter=HostLimiter(0, sleep=nosleep), stop_event=ev)
    ok, _ = asyncio.run(go())
    assert ok and pushed == ["https://ex.com/"]


def _sleeps(handler):
    slept = []

    async def sl(t):
        slept.append(t)
    drive({"startUrls": ["https://ex.com/x"], "respectRobots": False}, handler, sleep=sl)
    return slept


def test_backoff_is_capped_at_about_five_seconds_per_url():
    n = []

    def always_429(req):
        n.append(1)
        return httpx.Response(429)
    slept = _sleeps(always_429)
    assert 0 < sum(slept) <= 5.0 and len(n) == 3
    big = _sleeps(lambda req: httpx.Response(429, headers={"retry-after": "120"}))
    assert big == [5.0]  # never more than the remaining budget
    mixed = _sleeps(lambda req: httpx.Response(503, headers={"retry-after": "3"}))
    assert sum(mixed) <= 5.0
    timeouts = _sleeps(lambda req: (_ for _ in ()).throw(httpx.ReadTimeout("t")))
    assert 0 < sum(timeouts) <= 5.0


def test_capped_url_still_yields_a_result():
    _, pushed, _, _ = drive({"startUrls": ["https://ex.com/x"], "respectRobots": False}, lambda r: httpx.Response(429))
    assert len(pushed) == 1 and pushed[0][0]["statusCode"] == 429


def test_invalid_inputs_are_listed_not_charged_and_duplicates_logged():
    (ok, _), pushed, logs, saved = drive(
        {"startUrls": ["ftp://a.com", "javascript:x", "not a url", "https://a.com", "https://a.com/"]},
        lambda r: httpx.Response(404) if r.url.path == "/robots.txt" else httpx.Response(200, text="x"))
    assert ok and len(pushed) == 1 and pushed[0][0]["url"] == "https://a.com/"
    assert saved["INVALID_INPUTS"] == ["ftp://a.com", "javascript:x", "not a url"]
    assert any("1 duplicate" in l and "merged" in l for l in logs)
    assert sum("invalid" in l for l in logs) == 1  # one warning line


def test_all_invalid_still_fails_and_lists_them():
    (ok, msg), pushed, _, saved = drive({"startUrls": ["not a url", "mailto:a@b.c"]}, lambda r: httpx.Response(200))
    assert not ok and pushed == [] and saved["INVALID_INPUTS"] == ["not a url", "mailto:a@b.c"]


def test_normalize_rejects_spaces_in_host_only():
    assert core.normalize_url("not a url") is None
    assert core.normalize_url("a.com/with space") == "https://a.com/with space"


def test_sitemap_mode_without_sitemap_says_so():
    (ok, msg), pushed, _, _ = drive({"startUrls": ["https://ex.com/"], "mode": "sitemap"}, lambda r: httpx.Response(404))
    assert ok and pushed == [] and msg == "No sitemap found for ex.com (robots.txt and /sitemap.xml checked)."
