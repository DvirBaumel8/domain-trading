"""Sitemap URL Extractor: discover sitemaps, walk indexes, output every page URL."""
from __future__ import annotations
import asyncio
import re

import httpx
from apify import Actor

from .core import (COMMON_PATHS, failure_reason, looks_like_sitemap, normalize_start, valid_modified_since, parse_sitemap, passes_filters, site_root, sitemaps_from_robots)

UA = 'Mozilla/5.0 (compatible; ApifySitemapExtractor/0.1; +https://apify.com)'
MAX_BYTES = 60 * 1024 * 1024


async def fetch(client: httpx.AsyncClient, url: str) -> tuple[int | None, bytes]:
    last = None
    for attempt in range(3):
        try:
            r = await client.get(url)
            if r.status_code in (429, 500, 502, 503, 504):
                await asyncio.sleep(2 * (attempt + 1))
                continue
            return r.status_code, r.content[:MAX_BYTES]
        except httpx.HTTPError as e:
            last = e
            await asyncio.sleep(1 + attempt)
    if last is not None:
        Actor.log.warning(f'{url}: could not connect ({failure_reason(last)})')
    return None, b''


async def discover(client, start: str) -> list[str]:
    if looks_like_sitemap(start) and start.startswith('http'):
        return [start]
    root = site_root(start)
    found: list[str] = []
    code, body = await fetch(client, root + '/robots.txt')
    if code == 200:
        found = sitemaps_from_robots(body.decode('utf-8', 'ignore'), root)
    if not found:
        for p in COMMON_PATHS:
            code, body = await fetch(client, root + p)
            if code == 200 and parse_sitemap(body)[0] != 'invalid':
                found.append(root + p)
                break
    return found


async def check_status(client, url: str) -> tuple[int | None, str | None]:
    try:
        r = await client.head(url)
        if r.status_code in (405, 403, 501):
            r = await client.get(url)
        return r.status_code, str(r.url)
    except httpx.HTTPError:
        return None, None


async def main() -> None:
    async with Actor:
        inp = await Actor.get_input() or {}
        since_raw = inp.get('modifiedSince')
        if since_raw is not None and not valid_modified_since(str(since_raw)):
            await Actor.fail(status_message='modifiedSince must look like 2026-01-31')
            return
        # accept the Apify requestListSources shape too
        raw = [s if isinstance(s, str) else (s.get('url') if isinstance(s, dict) else None) for s in inp.get('startUrls') or []]
        starts, invalid = [], []
        for r in raw:
            if r is None or (isinstance(r, str) and not r.strip()):
                continue
            n = normalize_start(r)
            (starts if n else invalid).append(n or str(r))
        starts = list(dict.fromkeys(starts))
        if invalid:
            await Actor.set_value('INVALID_INPUTS', invalid[:5000])  # never pushed to the dataset, so never charged
            Actor.log.warning(f'{len(invalid)} invalid start URL(s) skipped (saved to INVALID_INPUTS, not charged).')
        if not starts:
            await Actor.fail(status_message='Add at least one website or sitemap URL.')
            return
        max_urls = int(inp.get('maxUrlsPerSite') or 1000)
        max_maps = int(inp.get('maxSitemaps') or 500)
        try:
            include = re.compile(inp['includeRegex']) if inp.get('includeRegex') else None
            exclude = re.compile(inp['excludeRegex']) if inp.get('excludeRegex') else None
        except re.error as e:
            await Actor.fail(status_message=f'Invalid regex: {e}')
            return
        since = (inp.get('modifiedSince') or '').strip()[:10] or None
        check = bool(inp.get('checkStatus'))
        total = 0
        stop = False
        async with httpx.AsyncClient(timeout=30, follow_redirects=True, headers={'User-Agent': UA}) as client:
            for start in starts:
                if stop:
                    break
                maps = await discover(client, start)
                if not maps:
                    Actor.log.warning(f'{start}: no sitemap found (robots.txt and common paths checked).')
                    continue
                queue, seen_maps, seen_urls, site_count = list(maps), set(), set(), 0
                while queue and site_count < max_urls and len(seen_maps) < max_maps and not stop:
                    sm = queue.pop(0)
                    if sm in seen_maps:
                        continue
                    seen_maps.add(sm)
                    code, body = await fetch(client, sm)
                    if code != 200:
                        if code is not None:  # a failed connection was already logged by fetch()
                            Actor.log.warning(f'{sm}: HTTP {code}')
                        continue
                    kind, items = parse_sitemap(body)
                    if kind == 'index':
                        queue.extend(u for u in items if u not in seen_maps)
                        continue
                    batch = []
                    for e in items:
                        if site_count >= max_urls:
                            break
                        if e['url'] in seen_urls or not passes_filters(e, include, exclude, since):
                            continue
                        seen_urls.add(e['url'])
                        row = {'url': e['url'], 'lastmod': e.get('lastmod'), 'changefreq': e.get('changefreq'),
                               'priority': e.get('priority'), 'imageCount': e.get('imageCount', 0),
                               'hreflang': e.get('hreflang', []), 'sitemapUrl': sm, 'site': start,
                               'statusCode': None, 'finalUrl': None}
                        batch.append(row)
                        site_count += 1
                    if check and batch:
                        sem = asyncio.Semaphore(8)

                        async def one(r):
                            async with sem:
                                r['statusCode'], r['finalUrl'] = await check_status(client, r['url'])
                        await asyncio.gather(*(one(r) for r in batch))
                    for i in range(0, len(batch), 500):
                        res = await Actor.push_data(batch[i:i + 500], charged_event_name='result')
                        if res is not None and getattr(res, 'event_charge_limit_reached', False):
                            Actor.log.info('Spending limit reached - stopping.')
                            stop = True
                            break
                total += site_count
                Actor.log.info(f'{start}: {site_count} URLs from {len(seen_maps)} sitemap file(s).')
                await Actor.set_status_message(f'{total} URLs so far')
        await Actor.set_status_message(f'Done: {total} URLs from {len(starts)} site(s).')
