"""The run loop without the Apify SDK: push(row, charge) decides what is charged."""
from __future__ import annotations

import asyncio
import socket
import ssl
import time
from datetime import datetime, timezone

import httpx

from . import core
from .polite import RETRY_STATUS, FetchError, HostLimiter, _retry_after, request
from urllib.parse import urlsplit

REDIRECT_CODES = (301, 302, 303, 307, 308)
GET_FALLBACK = (403, 405, 501)
MAX_BODY = 2 * 1024 * 1024
# Transport errors worth another try: timeouts and connection resets. DNS failures (NXDOMAIN), TLS errors,
# refused connections and everything else fail at once. HTTP 429 and 5xx are retried with a back-off.
RETRY_ON = (httpx.TimeoutException, httpx.ConnectError)
RETRY_REASONS = ("connect_timeout", "connection_reset")
NO_GET_FALLBACK = ("dns_failure", "tls_error", "connection_refused")
HTTP_RETRIES = 3
BACKOFF_BUDGET = 5.0  # most seconds of back-off slept on one URL (all retries and any Retry-After together)
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

    @staticmethod
    def _worth_retry(exc: BaseException | None) -> bool:
        return isinstance(exc, httpx.TimeoutException) or error_reason(exc) in RETRY_REASONS

    async def _req(self, method, url, retries: int = HTTP_RETRIES, budget: list | None = None, **kw):
        """`budget` is a one-item list of seconds already slept backing off, shared by every request for one URL."""
        budget = budget if budget is not None else [0.0]
        def on_error(attempt, exc):
            # Connect details only: host, attempt, reason, exception classes. No path, query, headers or bodies.
            if self.debug_log:
                chain, e = [], exc
                while e is not None and e not in chain:
                    chain.append(type(e).__name__)
                    e = e.__cause__ or e.__context__
                self.debug_log(f"network debug: host={urlsplit(url).netloc} attempt={attempt + 1} "
                               f"reason={error_reason(exc)} chain={'>'.join(chain)}")
        attempt = 0

        async def back_off(wanted: float) -> bool:
            """Sleep at most what is left of the budget; False when nothing is left (the caller gives up)."""
            left = BACKOFF_BUDGET - budget[0]
            if left <= 0:
                return False
            wait = min(wanted, left)
            budget[0] += wait
            await self.sleep(wait)
            return True

        while True:
            try:
                # One attempt here; the retry decision below is ours (polite.request would retry any ConnectError).
                r = await request(self.client, method, url, limiter=self.limiter, sleep=self.sleep, retries=0,
                                  retry_on=(), retry_status=(), on_error=lambda _a, exc: on_error(attempt, exc), **kw)
            except FetchError as e:
                if attempt >= retries or not self._worth_retry(e.__cause__):
                    raise
                if not await back_off(2.0 ** (attempt + 1)):
                    raise
                attempt += 1
                continue
            if r.status_code in RETRY_STATUS and attempt < retries:
                if not await back_off(_retry_after(r, attempt)):
                    return r
                attempt += 1
                continue
            return r

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

    async def _probe(self, url, want_body, budget):
        if not want_body:
            try:
                r = await self._req("HEAD", url, budget=budget)
                if r.status_code not in GET_FALLBACK:
                    return r
            except FetchError as e:
                if error_reason(e.__cause__) in NO_GET_FALLBACK:
                    raise  # the host does not exist or refuses TLS: GET cannot do better
                # empty or broken HEAD answer: try GET once
        return await self._req("GET", url, budget=budget)

    async def check(self, url: str, want_body: bool = False) -> tuple[dict, str | None]:
        row = {"url": url, "category": "error", "statusCode": None, "finalUrl": None, "redirectChain": [],
               "redirectLoop": False, "error": None, "responseTimeMs": None, "contentType": None, "sources": []}
        if self.respect:
            parser, _ = await self.robots(url)
            if not core.robots_allows(parser, url):
                row.update(category="robots_blocked", error="disallowed by robots.txt")
                return self._stamp(row), None
        budget = [0.0]  # one back-off budget for this URL, redirects and the GET fallback included
        start, cur, visited, chain, resp, body = self.clock(), url, {url}, row["redirectChain"], None, None
        try:
            while True:
                resp = await self._probe(cur, want_body, budget)
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


async def run(inp: dict, *, client, push, set_status, sleep=asyncio.sleep, limiter=None, debug_log=None,
              log=None, save_invalid=None, stop_event=None) -> tuple[bool, str]:
    """`log(text)` gets the warning and info lines; `save_invalid(list)` stores the INVALID_INPUTS record.
    `stop_event` (asyncio.Event) is set on a platform abort or migration: no new URL is started, rows are already pushed."""
    inp = inp or {}
    log = log or (lambda _t: None)
    raw = inp.get("startUrls") or []
    starts, invalid, given = [], [], 0
    for s in raw:
        text = s.get("url") if isinstance(s, dict) else s
        u = core.normalize_url(text)
        if u:
            starts.append(u)
            given += 1
        elif text not in (None, ""):
            invalid.append(str(text))
    starts = list(dict.fromkeys(starts))
    if invalid:
        if save_invalid:
            await save_invalid(invalid[:5000])
        log(f"{len(invalid)} invalid start URL(s) skipped (saved to INVALID_INPUTS, not charged): "
            "only http and https URLs or bare hostnames are accepted.")
    if given > len(starts):
        log(f"{given - len(starts)} duplicate start URL(s) merged.")
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
            if state["stop"] or (stop_event is not None and stop_event.is_set()):
                state["stop"] = True
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
        """Breadth-first. Every row is pushed (and charged) as soon as its URL is checked, so a stop, an abort or a
        run timeout keeps every row checked so far. A row lists the links found on earlier levels, not deeper ones."""
        if start in seen or len(seen) >= max_pages:
            return
        seen.add(start)
        sources: dict[str, list] = {}
        frontier, depth = [start], 0
        while frontier and not state["stop"]:
            cur: list[tuple] = []

            async def one(u, want_body):
                row, html = await guarded(u, want_body)
                if row is None:
                    return
                row["sources"] = sources.get(u, [])
                await emit(row)
                cur.append((u, row, html))

            await asyncio.gather(*(one(u, depth <= max_depth and core.same_site(u, start)) for u in frontier))
            order = {u: i for i, u in enumerate(frontier)}
            nxt = []
            for u, row, html in sorted(cur, key=lambda c: order[c[0]]):
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
                        nxt.append(link)
            frontier, depth = nxt, depth + 1

    if mode == "list":
        await check_list(starts)  # one call, so maxConcurrency applies across all start URLs
    no_sitemap = []
    for s in ([] if mode == "list" else starts):
        if state["stop"] or len(seen) >= max_pages:
            break
        if mode == "sitemap":
            urls = await aud.sitemap_urls(s, max_pages)
            if not urls:
                no_sitemap.append(s)
            await check_list(urls)
        else:
            await crawl(s)
    if no_sitemap and not state["done"]:
        host = urlsplit(no_sitemap[0]).hostname
        return True, f"No sitemap found for {host} (robots.txt and /sitemap.xml checked)."
    msg = f"Done: {state['done']} URLs ({state['uncharged']} not charged: robots skips and failed lookups)."
    if len(seen) >= max_pages:
        msg += f" Stopped at the {max_pages}-URL cap."
    return True, msg
