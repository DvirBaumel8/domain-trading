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
    assert rows["https://ex.com/"][0]["sources"] == [{"sourceUrl": "https://ex.com/a", "anchorText": "Home page"}]
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
