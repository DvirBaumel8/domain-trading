"""The run loop without the Apify SDK: push(row, charge) decides what is charged."""
from __future__ import annotations

import asyncio
import socket
import ssl
import time
from datetime import datetime, timezone

import httpx

from . import core
from .polite import FetchError, HostLimiter, request
from urllib.parse import urlsplit

REDIRECT_CODES = (301, 302, 303, 307, 308)
GET_FALLBACK = (403, 405, 501)
MAX_BODY = 2 * 1024 * 1024
# Retry only on timeouts and connect errors; never on HTTP status, TooManyRedirects or read errors.
RETRY_ON = (httpx.TimeoutException, httpx.ConnectError)
DNS_HINTS = ("name or service not known", "nodename nor servname", "temporary failure in name resolution",
             "no address associated", "getaddrinfo", "name resolution")


def make_client(timeout: float = 20) -> httpx.AsyncClient:
    """The one place the client is built. Redirects are followed by the runner (chain, loop, finalUrl), never by httpx."""
    return httpx.AsyncClient(timeout=timeout, follow_redirects=False, headers={"User-Agent": core.UA})


def error_reason(exc: BaseException | None) -> str:
    """A plain reason for a failed request: dns_failure, connection_refused, connection_reset, connect_timeout, tls_error or other."""
    chain, e = [], exc
    while e is not None and e not in chain:
        chain.append(e)
        e = e.__cause__ or e.__context__
    if any(isinstance(e, httpx.ConnectTimeout) for e in chain):
        return "connect_timeout"
    if any(isinstance(e, ssl.SSLError) for e in chain) or any("ssl" in str(e).lower() and "certificate" in str(e).lower() for e in chain):
        return "tls_error"
    if any(isinstance(e, ConnectionRefusedError) for e in chain):
        return "connection_refused"
    if any(isinstance(e, ConnectionResetError) for e in chain):
        return "connection_reset"
    if any(isinstance(e, socket.gaierror) or any(h in str(e).lower() for h in DNS_HINTS) for e in chain):
        return "dns_failure"
    return "other"


class Auditor:
    def __init__(self, client, limiter, sleep, respect_robots, clock=time.monotonic, debug_log=None):
        self.client, self.limiter, self.sleep, self.respect, self.clock = client, limiter, sleep, respect_robots, clock
        self.debug_log = debug_log
        self._robots: dict[str, tuple] = {}

    async def _req(self, method, url, **kw):
        def on_error(attempt, exc):
            # Connect details only: host, attempt, reason, exception classes. No path, query, headers or bodies.
            if self.debug_log:
                chain, e = [], exc
                while e is not None and e not in chain:
                    chain.append(type(e).__name__)
                    e = e.__cause__ or e.__context__
                self.debug_log(f"network debug: host={urlsplit(url).netloc} attempt={attempt + 1} "
                               f"reason={error_reason(exc)} chain={'>'.join(chain)}")
        return await request(self.client, method, url, limiter=self.limiter, sleep=self.sleep,
                             retry_on=RETRY_ON, retry_status=(), on_error=on_error, **kw)

    async def robots(self, url):
        o = core.origin(url)
        if o not in self._robots:
            parser, text = None, ""
            try:
                r = await self._req("GET", o + "/robots.txt", retries=1)
                if r.status_code == 200:
                    text = r.text
                    parser = core.parse_robots(text)
            except FetchError:
                pass
            self._robots[o] = (parser, text)
        return self._robots[o]

    async def _probe(self, url, want_body):
        if not want_body:
            try:
                r = await self._req("HEAD", url)
                if r.status_code not in GET_FALLBACK:
                    return r
            except FetchError:
                pass  # empty or broken HEAD answer: try GET once
        return await self._req("GET", url)

    async def check(self, url: str, want_body: bool = False) -> tuple[dict, str | None]:
        row = {"url": url, "category": "error", "statusCode": None, "finalUrl": None, "redirectChain": [],
               "redirectLoop": False, "error": None, "responseTimeMs": None, "contentType": None, "sources": []}
        if self.respect:
            parser, _ = await self.robots(url)
            if not core.robots_allows(parser, url):
                row.update(category="robots_blocked", error="disallowed by robots.txt")
                return self._stamp(row), None
        start, cur, visited, chain, resp, body = self.clock(), url, {url}, row["redirectChain"], None, None
        try:
            while True:
                resp = await self._probe(cur, want_body)
                loc = resp.headers.get("location")
                if resp.status_code in REDIRECT_CODES and loc:
                    if len(chain) >= core.MAX_REDIRECTS:
                        row.update(redirectLoop=True, error=f"more than {core.MAX_REDIRECTS} redirects")
                        break
                    chain.append({"status": resp.status_code, "url": cur})
                    nxt = core.normalize_url(loc, cur)
                    if nxt is None:
                        row["error"] = "redirect to an invalid URL"
                        break
                    if nxt in visited:
                        row.update(redirectLoop=True, error="redirect loop")
                        break
                    visited.add(nxt)
                    cur = nxt
                    continue
                break
        except FetchError as e:
            row["error"] = error_reason(e.__cause__)
            resp = None
        row["responseTimeMs"] = int((self.clock() - start) * 1000)
        row["finalUrl"] = cur
        if resp is not None:
            row["statusCode"] = resp.status_code
            row["contentType"] = (resp.headers.get("content-type") or "").split(";")[0].strip().lower() or None
            if want_body and resp.status_code == 200 and row["contentType"] in ("text/html", "application/xhtml+xml"):
                body = resp.content[:MAX_BODY].decode(resp.encoding or "utf-8", "ignore")
        if row["error"] is None or row["redirectLoop"]:
            row["category"] = core.categorize(row["statusCode"], chain, row["redirectLoop"])
        return self._stamp(row), body

    @staticmethod
    def _stamp(row):
        row["checkedAt"] = datetime.now(timezone.utc).isoformat(timespec="seconds")
        return row

    async def sitemap_urls(self, start: str, limit: int) -> list[str]:
        path = start.split("?")[0].lower()
        if path.endswith((".xml", ".xml.gz", ".txt", ".gz")) or "sitemap" in path:
            queue = [start]
        else:
            _, text = await self.robots(start)
            queue = core.robots_sitemaps(text, core.origin(start)) or [core.origin(start) + "/sitemap.xml"]
        seen_maps, urls = set(), []
        while queue and len(urls) < limit and len(seen_maps) < 500:
            sm = queue.pop(0)
            if sm in seen_maps:
                continue
            seen_maps.add(sm)
            try:
                r = await self._req("GET", sm)
            except FetchError:
                continue
            if r.status_code != 200:
                continue
            kind, items = core.parse_sitemap(r.content)
            if kind == "index":
                queue += [u for u in items if u not in seen_maps]
            elif kind == "urlset":
                urls += items
        return urls


async def run(inp: dict, *, client, push, set_status, sleep=asyncio.sleep, limiter=None, debug_log=None) -> tuple[bool, str]:
    inp = inp or {}
    raw = inp.get("startUrls") or []
    starts = []
    for s in raw:
        u = core.normalize_url(s.get("url") if isinstance(s, dict) else s)
        if u:
            starts.append(u)
    starts = list(dict.fromkeys(starts))
    if not starts:
        return False, "Add at least one valid start URL (a site, a sitemap or a list of URLs)."
    mode = inp.get("mode") or "list"
    if mode not in ("list", "sitemap", "crawl"):
        return False, "Mode must be list, sitemap or crawl."
    max_pages = max(1, int(inp.get("maxPages") or 1000))
    max_depth = max(0, int(3 if inp.get("maxDepth") is None else inp["maxDepth"]))
    check_ext = bool(inp.get("checkExternal"))
    conc = max(1, min(20, int(inp.get("maxConcurrency") or 5)))
    aud = Auditor(client, limiter or HostLimiter(0.2), sleep, inp.get("respectRobots", True) is not False,
                  debug_log=debug_log if inp.get("debugNetwork") is True else None)
    sem = asyncio.Semaphore(conc)
    state = {"done": 0, "stop": False, "uncharged": 0}
    seen: set[str] = set()

    async def emit(row):
        if not core.chargeable(row):
            state["uncharged"] += 1
        state["done"] += 1
        if await push(row, core.chargeable(row)):
            state["stop"] = True
        if state["done"] % 50 == 0:
            await set_status(f"Checked {state['done']} URLs")

    async def guarded(url, want_body):
        async with sem:
            if state["stop"]:
                return None, None
            return await aud.check(url, want_body)

    async def check_list(urls):
        urls = [u for u in dict.fromkeys(urls) if u not in seen][: max(0, max_pages - len(seen))]
        seen.update(urls)

        async def one(u):
            row, _ = await guarded(u, False)
            if row:
                await emit(row)
        await asyncio.gather(*(one(u) for u in urls))

    async def crawl(start):
        if start in seen or len(seen) >= max_pages:
            return
        order, rows, sources = [start], {}, {}
        seen.add(start)
        frontier, depth = [start], 0
        while frontier and not state["stop"]:
            results = await asyncio.gather(*(guarded(u, depth <= max_depth and core.same_site(u, start)) for u in frontier))
            nxt = []
            for u, (row, html) in zip(frontier, results):
                if row is None:
                    continue
                rows[u] = row
                if html is None or depth >= max_depth:
                    continue
                for link, text in core.extract_links(html, row["finalUrl"] or u):
                    internal = core.same_site(link, start)
                    if not internal and not check_ext:
                        continue
                    lst = sources.setdefault(link, [])
                    if len(lst) < core.MAX_SOURCES:
                        lst.append({"sourceUrl": u, "anchorText": text})
                    if link not in seen and len(seen) < max_pages:
                        seen.add(link)
                        order.append(link)
                        nxt.append(link)
            frontier, depth = nxt, depth + 1
        for u in order:
            if u in rows:
                rows[u]["sources"] = sources.get(u, [])
                await emit(rows[u])

    if mode == "list":
        await check_list(starts)  # one call, so maxConcurrency applies across all start URLs
    for s in ([] if mode == "list" else starts):
        if state["stop"] or len(seen) >= max_pages:
            break
        if mode == "sitemap":
            await check_list(await aud.sitemap_urls(s, max_pages))
        else:
            await crawl(s)
    msg = f"Done: {state['done']} URLs ({state['uncharged']} not charged: robots skips and failed lookups)."
    if len(seen) >= max_pages:
        msg += f" Stopped at the {max_pages}-URL cap."
    return True, msg
