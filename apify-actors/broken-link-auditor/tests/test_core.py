import asyncio
import gzip
import json
import pathlib
import sys

import httpx

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))
from src import core, runner  # noqa: E402
from src.polite import HostLimiter  # noqa: E402


async def nosleep(_):
    return None


def drive(inp, handler):
    pushed = []

    async def push(row, charge):
        pushed.append((row, charge))
        return False

    async def status(_):
        return None

    async def go():
        async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as c:
            return await runner.run(inp, client=c, push=push, set_status=status, sleep=nosleep, limiter=HostLimiter(0, sleep=nosleep))
    res = asyncio.run(go())
    return res, {r["url"]: (r, c) for r, c in pushed}, pushed


def html(body):
    return httpx.Response(200, headers={"content-type": "text/html; charset=utf-8"}, text=body)


def no_robots(req):
    return httpx.Response(404) if req.url.path == "/robots.txt" else None


def test_redirect_chain_final_status_and_content_type():
    def h(req):
        if (r := no_robots(req)):
            return r
        p = req.url.path
        if p == "/a":
            return httpx.Response(301, headers={"location": "/b"})
        if p == "/b":
            return httpx.Response(302, headers={"location": "https://ex.com/c#frag"})
        return httpx.Response(200, headers={"content-type": "text/plain"}, text="x")
    (ok, _), rows, _ = drive({"startUrls": ["https://ex.com/a"]}, h)
    row, charge = rows["https://ex.com/a"]
    assert ok and charge and row["category"] == "redirect" and row["statusCode"] == 200
    assert row["redirectChain"] == [{"status": 301, "url": "https://ex.com/a"}, {"status": 302, "url": "https://ex.com/b"}]
    assert row["finalUrl"] == "https://ex.com/c" and row["contentType"] == "text/plain" and row["responseTimeMs"] is not None


def test_redirect_loop_flagged():
    def h(req):
        if (r := no_robots(req)):
            return r
        return httpx.Response(302, headers={"location": "/b" if req.url.path == "/a" else "/a"})
    _, rows, _ = drive({"startUrls": ["https://ex.com/a"]}, h)
    row, charge = rows["https://ex.com/a"]
    assert row["redirectLoop"] and row["category"] == "error" and row["error"] == "redirect loop" and charge


def test_more_than_ten_redirects_flagged():
    def h(req):
        if (r := no_robots(req)):
            return r
        n = int(req.url.path[1:] or 0)
        return httpx.Response(302, headers={"location": f"/{n + 1}"})
    _, rows, _ = drive({"startUrls": ["https://ex.com/0"]}, h)
    row, _ = rows["https://ex.com/0"]
    assert row["redirectLoop"] and len(row["redirectChain"]) == 10 and "10" in row["error"]


def test_head_to_get_fallback():
    methods = []

    def h(req):
        if (r := no_robots(req)):
            return r
        methods.append(req.method)
        return httpx.Response(405) if req.method == "HEAD" else httpx.Response(200, text="ok")
    _, rows, _ = drive({"startUrls": ["https://ex.com/p"]}, h)
    assert methods == ["HEAD", "GET"] and rows["https://ex.com/p"][0]["statusCode"] == 200


def test_head_transport_failure_falls_back_to_get():
    def h(req):
        if (r := no_robots(req)):
            return r
        if req.method == "HEAD":
            raise httpx.ReadError("empty")
        return httpx.Response(404)
    _, rows, _ = drive({"startUrls": ["https://ex.com/p"]}, h)
    assert rows["https://ex.com/p"][0]["category"] == "4xx"


def test_robots_disallow_is_skipped_and_not_charged():
    seen = []

    def h(req):
        seen.append(req.url.path)
        if req.url.path == "/robots.txt":
            return httpx.Response(200, text="User-agent: *\nDisallow: /private\n")
        return httpx.Response(200, text="x")
    _, rows, _ = drive({"startUrls": ["https://ex.com/private/a", "https://ex.com/open"]}, h)
    row, charge = rows["https://ex.com/private/a"]
    assert row["category"] == "robots_blocked" and charge is False and "/private/a" not in seen
    assert rows["https://ex.com/open"][1] is True
    _, rows2, _ = drive({"startUrls": ["https://ex.com/private/a"], "respectRobots": False}, h)
    assert rows2["https://ex.com/private/a"][0]["statusCode"] == 200


def test_dns_failure_and_timeout_not_charged():
    def h(req):
        if (r := no_robots(req)):
            return r
        if "dead" in req.url.host:
            raise httpx.ConnectError("dns")
        raise httpx.ReadTimeout("slow")
    _, rows, _ = drive({"startUrls": ["https://dead.example/", "https://slow.example/"]}, h)
    for u in ("https://dead.example/", "https://slow.example/"):
        row, charge = rows[u]
        assert row["category"] == "error" and row["statusCode"] is None and charge is False


def test_5xx_after_retries_is_charged_finding():
    _, rows, _ = drive({"startUrls": ["https://ex.com/x"]}, lambda r: httpx.Response(404) if r.url.path == "/robots.txt" else httpx.Response(503))
    row, charge = rows["https://ex.com/x"]
    assert row["category"] == "5xx" and charge


def test_crawl_sources_anchor_dedupe_and_external():
    pages = {
        "/": '<a href="/a">First</a> <a href="/a#top">again</a> <a href="https://other.org/z">Out</a> <a href="mailto:x@y.z">m</a>',
        "/a": '<a href="/">Home <b>page</b></a> <a href="/gone">Gone</a>',
    }

    def h(req):
        if (r := no_robots(req)):
            return r
        if req.url.host == "other.org":
            return httpx.Response(200, text="x")
        if req.url.path in pages:
            return html(pages[req.url.path])
        return httpx.Response(404)
    (ok, _), rows, pushed = drive({"startUrls": ["https://ex.com/"], "mode": "crawl", "checkExternal": True}, h)
    assert [r["url"] for r, _ in pushed].count("https://ex.com/a") == 1  # each URL once
    assert set(rows) == {"https://ex.com/", "https://ex.com/a", "https://ex.com/gone", "https://other.org/z"}
    assert rows["https://ex.com/gone"][0]["category"] == "4xx"
    assert rows["https://ex.com/gone"][0]["sources"] == [{"sourceUrl": "https://ex.com/a", "anchorText": "Gone"}]
    a_src = rows["https://ex.com/a"][0]["sources"]
    assert {"sourceUrl": "https://ex.com/", "anchorText": "First"} in a_src and len(a_src) == 2
    assert rows["https://ex.com/"][0]["sources"] == []  # rows are pushed at once: later back-links are not listed
    _, rows2, _ = drive({"startUrls": ["https://ex.com/"], "mode": "crawl"}, h)
    assert "https://other.org/z" not in rows2


def test_crawl_max_pages_and_depth_cap():
    def h(req):
        if (r := no_robots(req)):
            return r
        return html("".join(f'<a href="/p{i}">l</a>' for i in range(50)))
    _, rows, pushed = drive({"startUrls": ["https://ex.com/"], "mode": "crawl", "maxPages": 7}, h)
    assert len(pushed) == 7
    _, rows, pushed = drive({"startUrls": ["https://ex.com/"], "mode": "crawl", "maxDepth": 0}, h)
    assert len(pushed) == 1


def test_sitemap_mode_nested_gz_and_dedupe():
    idx = b'<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><sitemap><loc>https://ex.com/s1.xml.gz</loc></sitemap></sitemapindex>'
    urlset = b'<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>https://ex.com/a</loc></url><url><loc>https://EX.com/a</loc></url><url><loc>https://ex.com/b</loc></url></urlset>'

    def h(req):
        p = req.url.path
        if p == "/robots.txt":
            return httpx.Response(200, text="Sitemap: https://ex.com/index.xml\n")
        if p == "/index.xml":
            return httpx.Response(200, content=idx)
        if p == "/s1.xml.gz":
            return httpx.Response(200, content=gzip.compress(urlset))
        return httpx.Response(200, text="x")
    (ok, _), rows, pushed = drive({"startUrls": ["https://ex.com"], "mode": "sitemap"}, h)
    assert ok and sorted(rows) == ["https://ex.com/a", "https://ex.com/b"] and len(pushed) == 2


def test_empty_and_invalid_input_fails_without_charge():
    for inp in ({}, {"startUrls": []}, {"startUrls": ["ftp://x", "mailto:a@b.c", ""]}):
        (ok, msg), _, pushed = drive(inp, lambda r: httpx.Response(200))
        assert not ok and "start URL" in msg and pushed == []


def test_row_matches_dataset_schema():
    schema = json.loads((pathlib.Path(__file__).resolve().parents[1] / ".actor" / "dataset_schema.json").read_text())
    _, rows, _ = drive({"startUrls": ["https://ex.com/x"]}, lambda r: httpx.Response(404) if r.url.path == "/robots.txt" else httpx.Response(200, text="x"))
    assert set(rows["https://ex.com/x"][0]) <= set(schema["fields"]["properties"])


def test_normalize():
    assert core.normalize_url("EX.com/a#b") == "https://ex.com/a"
    assert core.normalize_url("/x", "https://ex.com/a/b") == "https://ex.com/x"
    assert core.normalize_url("javascript:void(0)", "https://ex.com/") is None


# ---- BLA-1..4 ----
import socket  # noqa: E402
import ssl  # noqa: E402

from src import polite  # noqa: E402


def drive_with(inp, handler, **kw):
    pushed = []

    async def push(row, charge):
        pushed.append((row, charge))
        return False

    async def status(_):
        return None

    async def go():
        async with httpx.AsyncClient(transport=httpx.MockTransport(handler), follow_redirects=False) as c:
            return await runner.run(inp, client=c, push=push, set_status=status, sleep=nosleep,
                                    limiter=HostLimiter(0, sleep=nosleep), **kw)
    return asyncio.run(go()), pushed


def test_make_client_does_not_follow_redirects():
    c = runner.make_client()
    assert c.follow_redirects is False
    asyncio.run(c.aclose())


def test_mock_301_gives_redirect_chain_of_one():
    def h(req):
        if req.url.path == "/robots.txt":
            return httpx.Response(404)
        if req.url.path == "/old":
            return httpx.Response(301, headers={"location": "https://ex.com/new"})
        return httpx.Response(200, headers={"content-type": "text/html"}, text="ok")
    _, pushed = drive_with({"startUrls": ["https://ex.com/old"]}, h)
    row = pushed[0][0]
    assert row["category"] == "redirect" and len(row["redirectChain"]) == 1 and row["finalUrl"] == "https://ex.com/new"


def test_eleven_hops_is_a_redirect_loop():
    def h(req):
        if req.url.path == "/robots.txt":
            return httpx.Response(404)
        n = int(req.url.path.strip("/") or 0)
        return httpx.Response(301, headers={"location": f"/{n + 1}"})
    _, pushed = drive_with({"startUrls": ["https://ex.com/0"]}, h)
    assert pushed[0][0]["redirectLoop"] is True


def test_retry_only_on_timeout_and_connect_error():
    def run_with(exc, status=None):
        calls = []

        def h(req):
            calls.append(1)
            if status:
                return httpx.Response(status)
            raise exc
        async def go():
            async with httpx.AsyncClient(transport=httpx.MockTransport(h)) as c:
                try:
                    return await polite.request(c, "GET", "https://ex.com/", sleep=nosleep, retries=2,
                                                retry_on=runner.RETRY_ON, retry_status=())
                except polite.FetchError:
                    return None
        asyncio.run(go())
        return len(calls)
    assert run_with(httpx.ConnectTimeout("t")) == 3
    assert run_with(httpx.ConnectError("c")) == 3
    assert run_with(httpx.TooManyRedirects("r")) == 1
    assert run_with(httpx.ReadError("r")) == 1
    assert run_with(None, status=503) == 1
    assert run_with(None, status=429) == 1


def test_default_policy_still_retries_429_and_5xx_and_http_errors():
    for status in (429, 500, 503):
        calls = []

        def h(req):
            calls.append(1)
            return httpx.Response(status)

        async def go():
            async with httpx.AsyncClient(transport=httpx.MockTransport(h)) as c:
                return await polite.request(c, "GET", "https://ex.com/", sleep=nosleep, retries=2)
        assert asyncio.run(go()).status_code == status and len(calls) == 3
    calls = []

    def h2(req):
        calls.append(1)
        raise httpx.ReadError("x")

    async def go2():
        async with httpx.AsyncClient(transport=httpx.MockTransport(h2)) as c:
            try:
                await polite.request(c, "GET", "https://ex.com/", sleep=nosleep, retries=2)
            except polite.FetchError:
                pass
    asyncio.run(go2())
    assert len(calls) == 3


def test_list_mode_runs_with_concurrency_above_one():
    active = {"now": 0, "max": 0}

    async def go():
        async def handler(req):
            return httpx.Response(200, headers={"content-type": "text/plain"})
        pushed = []

        class T(httpx.AsyncBaseTransport):
            async def handle_async_request(self, req):
                if req.url.path == "/robots.txt":
                    return httpx.Response(404)
                active["now"] += 1
                active["max"] = max(active["max"], active["now"])
                await asyncio.sleep(0.01)
                active["now"] -= 1
                return httpx.Response(200, headers={"content-type": "text/plain"})

        async def push(row, charge):
            pushed.append(row)
            return False

        async def status(_):
            return None
        async with httpx.AsyncClient(transport=T()) as c:
            await runner.run({"startUrls": [f"https://ex.com/{i}" for i in range(6)], "maxConcurrency": 4, "respectRobots": False},
                             client=c, push=push, set_status=status, limiter=HostLimiter(0, sleep=nosleep))
        return pushed
    rows = asyncio.run(go())
    assert len(rows) == 6 and active["max"] > 1


def _chained(outer, inner):
    outer.__cause__ = inner
    return outer


def test_error_reason_mapping():
    assert runner.error_reason(_chained(httpx.ConnectError("x"), socket.gaierror(-2, "Name or service not known"))) == "dns_failure"
    assert runner.error_reason(_chained(httpx.ConnectError("x"), ConnectionRefusedError())) == "connection_refused"
    assert runner.error_reason(httpx.ConnectTimeout("x")) == "connect_timeout"
    assert runner.error_reason(_chained(httpx.ConnectError("x"), ssl.SSLError("bad"))) == "tls_error"
    assert runner.error_reason(_chained(httpx.ConnectError("x"), ConnectionResetError())) == "connection_reset"
    assert runner.error_reason(_chained(httpx.ReadError("x"), ConnectionResetError(104, "reset"))) == "connection_reset"
    assert runner.error_reason(httpx.ReadError("x")) == "other"
    assert runner.error_reason(httpx.ReadTimeout("x")) == "other"
    assert runner.error_reason(None) == "other"


def test_error_row_has_plain_reason_and_is_uncharged():
    def h(req):
        if req.url.path == "/robots.txt":
            return httpx.Response(404)
        raise _chained(httpx.ConnectError("x"), ConnectionRefusedError())
    _, pushed = drive_with({"startUrls": ["https://ex.com/a"]}, h)
    row, charge = pushed[0]
    assert row["category"] == "error" and row["error"] == "connection_refused" and charge is False


def test_debug_network_is_opt_in_and_logs_no_path_headers_or_bodies():
    def h(req):
        if req.url.path == "/robots.txt":
            return httpx.Response(404)
        raise _chained(httpx.ConnectError("x"), socket.gaierror(-2, "Name or service not known"))
    url = "https://ex.com/secret/path?token=abc"
    off, on = [], []
    drive_with({"startUrls": [url]}, h, debug_log=off.append)
    drive_with({"startUrls": [url], "debugNetwork": True}, h, debug_log=on.append)
    assert off == [] and on
    text = " ".join(on)
    assert "ex.com" in text and "dns_failure" in text and "secret" not in text and "token" not in text
