"""One honest User-Agent on every request; no browser impersonation; a 403 is reported, not retried."""
import asyncio
import pathlib
import re
import sys

import httpx

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))
from src import main  # noqa: E402

ROOT = pathlib.Path(__file__).resolve().parents[1]
HONEST = "Mozilla/5.0 (compatible; ApifyDomainCheckupReport/0.1; +https://apify.com)"
HTML = "<html><head><title>Hello</title></head><body>hi</body></html>"


def _client(status, seen):
    def handler(request):
        seen.append(request)
        return httpx.Response(status, text=HTML, headers={"content-type": "text/html"})
    return httpx.AsyncClient(transport=httpx.MockTransport(handler))


def test_no_browser_strings_in_source():
    bad = re.compile(r"Windows NT|Macintosh|AppleWebKit|Chrome/|Safari/")
    hits = [str(p) for p in (ROOT / "src").rglob("*.py") if bad.search(p.read_text())]
    assert hits == []


def test_honest_ua_constant():
    assert main.UA == HONEST
    assert not hasattr(main, "BROWSER_UA")


def test_landing_fetch_uses_honest_ua():
    seen = []

    async def run():
        async with _client(200, seen) as c:
            return await main.fetch_landing(c, "example.test")

    out = asyncio.run(run())
    assert out["httpStatus"] == 200
    assert seen and all(r.headers["user-agent"] == HONEST for r in seen)


def test_rdap_and_landing_share_ua():
    seen = []

    async def run():
        async with _client(404, seen) as c:
            await main.rdap_lookup(c, main.HostThrottle(0), "https://rdap.test/", "example.test")
            await main.fetch_landing(c, "example.test")

    asyncio.run(run())
    assert len(seen) == 2
    assert {r.headers["user-agent"] for r in seen} == {HONEST}


def test_403_reported_without_retry():
    seen = []

    async def run():
        async with _client(403, seen) as c:
            return await main.fetch_landing(c, "example.test")

    out = asyncio.run(run())
    assert len(seen) == 1
    assert out["httpStatus"] == 403
    assert out["httpsValid"] is True
    assert set(out) == {"httpStatus", "httpsValid", "finalUrl", "pageTitle", "pageForSale", "pageReason", "forSaleUrl", "askingPrice"}
