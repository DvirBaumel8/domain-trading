"""The run loop without the Apify SDK: push(row, charge) decides what is charged."""
from __future__ import annotations

import asyncio
import time
from datetime import datetime, timezone

import httpx

from . import core
from .polite import FetchError, HostLimiter, request

REDIRECT_CODES = (301, 302, 303, 307, 308)
GET_FALLBACK = (403, 405, 501)
MAX_BODY = 2 * 1024 * 1024


class Auditor:
    def __init__(self, client, limiter, sleep, respect_robots, clock=time.monotonic):
        self.client, self.limiter, self.sleep, self.respect, self.clock = client, limiter, sleep, respect_robots, clock
        self._robots: dict[str, tuple] = {}

    async def robots(self, url):
        o = core.origin(url)
        if o not in self._robots:
            parser, text = None, ""
            try:
                r = await request(self.client, "GET", o + "/robots.txt", limiter=self.limiter, sleep=self.sleep, retries=1)
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
                r = await request(self.client, "HEAD", url, limiter=self.limiter, sleep=self.sleep)
                if r.status_code not in GET_FALLBACK:
                    return r
            except FetchError:
                pass  # empty or broken HEAD answer: try GET once
        return await request(self.client, "GET", url, limiter=self.limiter, sleep=self.sleep)

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
            row["error"] = str(e)
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
                r = await request(self.client, "GET", sm, limiter=self.limiter, sleep=self.sleep)
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


async def run(inp: dict, *, client, push, set_status, sleep=asyncio.sleep, limiter=None) -> tuple[bool, str]:
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
    aud = Auditor(client, limiter or HostLimiter(0.2), sleep, inp.get("respectRobots", True) is not False)
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

    for s in starts:
        if state["stop"] or len(seen) >= max_pages:
            break
        if mode == "list":
            await check_list([s])
        elif mode == "sitemap":
            await check_list(await aud.sitemap_urls(s, max_pages))
        else:
            await crawl(s)
    msg = f"Done: {state['done']} URLs ({state['uncharged']} not charged: robots skips and failed lookups)."
    if len(seen) >= max_pages:
        msg += f" Stopped at the {max_pages}-URL cap."
    return True, msg
