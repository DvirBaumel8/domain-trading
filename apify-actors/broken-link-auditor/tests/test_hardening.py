"""H2 hardening: retry policy, streaming crawl, input errors, sitemap message (offline, mock transports)."""
import asyncio
import json
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
    assert count(exc=httpx.ReadTimeout("t")) >= 4
    assert count(exc=_chained(httpx.ReadError("r"), ConnectionResetError())) >= 4
    assert count(status=429) == 4 and count(status=503) == 4
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


def test_crawl_streams_and_stop_after_level_one_keeps_rows():
    inp = {"startUrls": ["https://ex.com/"], "mode": "crawl", "maxDepth": 5}
    # forced stop as soon as the first row (level 0) is pushed
    _, pushed, _, _ = drive(inp, site, push_stop=lambda row: row["url"] == "https://ex.com/")
    urls = [r["url"] for r, _ in pushed]
    assert urls == ["https://ex.com/", "https://ex.com/l1a", "https://ex.com/l1b"]
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


def test_crawl_sources_still_include_next_level_backlinks():
    _, pushed, _, _ = drive({"startUrls": ["https://ex.com/"], "mode": "crawl", "maxDepth": 5}, site)
    rows = {r["url"]: r for r, _ in pushed}
    assert {"sourceUrl": "https://ex.com/l1a", "anchorText": "x"} in rows["https://ex.com/l2a"]["sources"]


def test_invalid_inputs_are_listed_not_charged_and_duplicates_logged():
    (ok, _), pushed, logs, saved = drive(
        {"startUrls": ["ftp://a.com", "javascript:x", "not a url", "https://a.com", "https://a.com/"]},
        lambda r: httpx.Response(404) if r.url.path == "/robots.txt" else httpx.Response(200, text="x"))
    assert ok and len(pushed) == 1 and pushed[0][0]["url"] == "https://a.com/"
    assert saved["INVALID_INPUTS"] == ["ftp://a.com", "javascript:x", "not a url"]
    assert any("1 duplicate" in l and "merged" in l for l in logs)
    assert sum("invalid" in l for l in logs) == 1  # one warning line


def test_all_invalid_reports_message_and_lists_them():
    (ok, msg), pushed, _, saved = drive({"startUrls": ["not a url", "mailto:a@b.c"]}, lambda r: httpx.Response(200))
    assert not ok and pushed == [] and saved["INVALID_INPUTS"] == ["not a url", "mailto:a@b.c"]
    assert msg == "Add at least one valid start URL (a site, a sitemap or a list of URLs)."


def test_bad_mode_message():
    (ok, msg), pushed, _, _ = drive({"startUrls": ["https://a.com"], "mode": "x"}, lambda r: httpx.Response(200))
    assert not ok and pushed == [] and msg == "Mode must be list, sitemap or crawl."


def test_default_max_pages_is_200_and_explicit_wins():
    urls = [f"https://a.com/{i}" for i in range(250)]
    ok_h = lambda r: httpx.Response(404) if r.url.path == "/robots.txt" else httpx.Response(200, text="x")
    _, pushed, _, _ = drive({"startUrls": urls}, ok_h)
    assert len(pushed) == 200
    _, pushed, _, _ = drive({"startUrls": urls, "maxPages": 3}, ok_h)
    assert len(pushed) == 3


def test_new_defaults_in_actor_files():
    d = pathlib.Path(__file__).resolve().parents[1] / ".actor"
    schema = json.loads((d / "input_schema.json").read_text())
    opts = json.loads((d / "actor.json").read_text())["defaultRunOptions"]
    assert schema["properties"]["maxPages"]["default"] == 200 and schema["properties"]["maxPages"]["maximum"] == 100000
    assert opts["timeoutSecs"] == 7200 and opts["memoryMbytes"] == 256


class FakeActor:
    def __init__(self, inp):
        self.inp, self.pushed, self.values, self.failed, self.status = inp, [], {}, None, None
        self.log = type("L", (), {"info": staticmethod(lambda *a: None), "warning": staticmethod(lambda *a: None)})()

    async def __aenter__(self):
        return self

    async def __aexit__(self, *a):
        return False

    async def get_input(self):
        return self.inp

    async def push_data(self, row, charged_event_name=None):
        self.pushed.append((row, charged_event_name))

    async def set_value(self, k, v):
        self.values[k] = v

    async def set_status_message(self, msg):
        self.status = msg

    async def fail(self, status_message=None):
        self.failed = status_message


def test_main_invalid_input_exits_cleanly(monkeypatch):
    from src import main as m
    calls = []
    real = httpx.AsyncClient
    monkeypatch.setattr(m, "make_client", lambda: real(transport=httpx.MockTransport(lambda r: calls.append(1) or httpx.Response(200))))
    for inp, msg in (({"startUrls": ["not a url", "mailto:a@b.c"]}, "Add at least one valid start URL (a site, a sitemap or a list of URLs)."),
                     ({"startUrls": ["https://a.com"], "mode": "x"}, "Mode must be list, sitemap or crawl.")):
        fake = FakeActor(inp)
        monkeypatch.setattr(m, "Actor", fake)
        asyncio.run(m.main())
        assert calls == [] and fake.pushed == [] and fake.failed is None and fake.status == msg
        assert fake.values["STATUS"] == {"ok": False, "reason": "invalid_input", "message": msg}
    assert fake.values.get("INVALID_INPUTS") is None  # second input has no invalid lines


def test_normalize_rejects_spaces_in_host_only():
    assert core.normalize_url("not a url") is None
    assert core.normalize_url("a.com/with space") == "https://a.com/with space"


def test_sitemap_mode_without_sitemap_says_so():
    (ok, msg), pushed, _, _ = drive({"startUrls": ["https://ex.com/"], "mode": "sitemap"}, lambda r: httpx.Response(404))
    assert ok and pushed == [] and msg == "No sitemap found for ex.com (robots.txt and /sitemap.xml checked)."
