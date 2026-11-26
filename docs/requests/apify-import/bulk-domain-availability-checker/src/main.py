"""Bulk Domain Availability Checker - DNS pre-check, RDAP (official registry) confirmation."""
from __future__ import annotations
import asyncio
import time
from datetime import datetime, timezone
from urllib.parse import urlparse

import httpx
from apify import Actor

from .doh import DohResolver
from .core import parked_hint, generate_candidates, index_bootstrap, normalize_domain, parse_rdap, rdap_base_for

BOOTSTRAP_URL = 'https://data.iana.org/rdap/dns.json'
UA = 'Mozilla/5.0 (compatible; ApifyDomainAvailability/0.1; +https://apify.com)'
EXTRA_RDAP = {  # ccTLDs with public RDAP that are missing from the IANA bootstrap file
    'io': 'https://rdap.identitydigital.services/rdap/',
    'me': 'https://rdap.identitydigital.services/rdap/',
    'co': 'https://rdap.registry.co/co/',
    'de': 'https://rdap.denic.de/',
}
RDAP_MIN_INTERVAL = 0.35  # seconds between requests to the same registry host (~3/s)


class HostThrottle:
    def __init__(self, interval: float):
        self.interval = interval
        self.locks: dict[str, asyncio.Lock] = {}
        self.last: dict[str, float] = {}

    async def wait(self, host: str):
        lock = self.locks.setdefault(host, asyncio.Lock())
        async with lock:
            delta = time.monotonic() - self.last.get(host, 0)
            if delta < self.interval:
                await asyncio.sleep(self.interval - delta)
            self.last[host] = time.monotonic()


async def dns_check(resolver: DohResolver, domain: str) -> tuple[str, list[str]]:
    """Return ('nxdomain'|'has_ns'|'no_ns'|'error', nameservers)."""
    rcode, ns = await resolver.records(domain, 'NS', 2)
    if rcode is None:
        return 'error', []
    if rcode == 3:
        return 'nxdomain', []
    if rcode == 0 and ns:
        return 'has_ns', sorted(n.rstrip('.').lower() for n in ns)
    if rcode == 0:
        return 'no_ns', []
    return 'error', []


async def rdap_lookup(client: httpx.AsyncClient, throttle: HostThrottle, base: str, domain: str):
    """Return (http_status_or_None, parsed_dict_or_None, error)."""
    url = f'{base}domain/{domain}'
    host = urlparse(base).netloc
    for attempt in range(4):
        await throttle.wait(host)
        try:
            r = await client.get(url)
        except httpx.HTTPError as e:
            err = type(e).__name__
            await asyncio.sleep(1 + attempt)
            continue
        if r.status_code == 404:
            return 404, None, None
        if r.status_code == 200:
            try:
                return 200, parse_rdap(r.json()), None
            except ValueError:
                return None, None, 'bad RDAP JSON'
        if r.status_code in (429, 500, 502, 503, 504):
            await asyncio.sleep(3 * (attempt + 1))
            err = f'HTTP {r.status_code}'
            continue
        return None, None, f'HTTP {r.status_code}'
    return None, None, locals().get('err', 'RDAP retries exhausted')


async def main() -> None:
    async with Actor:
        inp = await Actor.get_input() or {}
        max_domains = int(inp.get('maxDomains') or 5000)
        only_available = bool(inp.get('onlyAvailable'))
        lookup_registered = bool(inp.get('lookupRegistered'))
        concurrency = max(1, min(50, int(inp.get('concurrency') or 20)))

        items: list[tuple[str, str | None]] = []
        seen: set[str] = set()
        invalid: list[str] = []
        for raw in inp.get('domains') or []:
            d = normalize_domain(raw)
            if not d:
                invalid.append(str(raw))
            elif d not in seen:
                seen.add(d)
                items.append((d, None))
        for d, kw in generate_candidates(inp.get('keywords'), inp.get('tlds') or ['com'],
                                         inp.get('prefixes'), inp.get('suffixes')):
            if d not in seen:
                seen.add(d)
                items.append((d, kw))
        if len(items) > max_domains:
            Actor.log.warning(f'{len(items)} domains given, checking the first {max_domains} (maxDomains).')
            items = items[:max_domains]
        if not items:
            await Actor.fail(status_message='Please add at least one domain in Domains, or a keyword in Keywords.')
            return
        Actor.log.info(f'Checking {len(items)} domains ({len(invalid)} invalid inputs skipped).')

        async with httpx.AsyncClient(timeout=20, headers={'User-Agent': UA, 'Accept': 'application/rdap+json'},
                                     follow_redirects=True) as client:
            try:
                bootstrap = index_bootstrap((await client.get(BOOTSTRAP_URL)).json())
            except Exception as e:  # noqa: BLE001
                Actor.log.warning(f'IANA RDAP bootstrap unavailable ({e}); DNS-only mode.')
                bootstrap = {}
            for tld, url in EXTRA_RDAP.items():
                bootstrap.setdefault(tld, url)
            resolver = DohResolver(client)
            throttle = HostThrottle(RDAP_MIN_INTERVAL)
            sem = asyncio.Semaphore(concurrency)
            stop = asyncio.Event()
            counts = {'available': 0, 'registered': 0, 'unknown': 0}
            done = 0

            async def check(domain: str, kw: str | None):
                nonlocal done
                async with sem:
                    if stop.is_set():
                        return
                    row = dict(domain=domain, tld=domain.rsplit('.', 1)[-1], length=len(domain.split('.')[0]),
                               keyword=kw, available=None, status='unknown', method='dns', hasDns=None,
                               nameservers=[], registrar=None, createdDate=None, expiryDate=None,
                               domainAgeYears=None, rdapStatus=[], parkedOrForSale=None, error=None)
                    dstate, ns = await dns_check(resolver, domain)
                    row['hasDns'] = dstate == 'has_ns' if dstate != 'error' else None
                    row['nameservers'] = ns
                    row['parkedOrForSale'] = parked_hint(ns)
                    need_rdap = dstate in ('nxdomain', 'no_ns', 'error') or lookup_registered
                    if dstate == 'has_ns':
                        row.update(available=False, status='registered')
                    base = rdap_base_for(domain, bootstrap) if need_rdap else None
                    if need_rdap and base:
                        code, info, err = await rdap_lookup(client, throttle, base, domain)
                        if code == 404 and dstate != 'has_ns':
                            row.update(available=True, status='available', method='rdap')
                        elif code == 200:
                            info.pop('rdapNameservers', None)
                            row.update(info)
                            row.update(available=False, status='registered', method='rdap')
                        elif dstate != 'has_ns':
                            row['error'] = err or 'RDAP inconclusive'
                    elif need_rdap and not base and dstate != 'has_ns':
                        if dstate == 'nxdomain':
                            row.update(available=True, status='available', method='dns')
                            row['error'] = 'No RDAP server for this TLD - DNS-only result, verify at a registrar'
                        else:
                            row['error'] = 'No RDAP server for this TLD and no DNS answer'
                    row['checkedAt'] = datetime.now(timezone.utc).isoformat(timespec='seconds')
                    counts[row['status']] = counts.get(row['status'], 0) + 1
                    done += 1
                    if only_available and row['status'] != 'available':
                        return
                    res = await Actor.push_data(row, charged_event_name='result')
                    if res is not None and getattr(res, 'event_charge_limit_reached', False):
                        Actor.log.info('Spending limit reached - stopping.')
                        stop.set()
                    if done % 200 == 0:
                        await Actor.set_status_message(f'Checked {done}/{len(items)} - {counts}')

            await asyncio.gather(*(check(d, k) for d, k in items))
            if invalid:
                # Not pushed to the dataset, so users are never charged for bad input lines.
                await Actor.set_value('INVALID_INPUTS', invalid[:5000])
                Actor.log.warning(f'{len(invalid)} invalid inputs skipped (saved to key-value store as INVALID_INPUTS).')
            msg = f"Done: {done} checked - {counts['available']} available, {counts['registered']} registered, {counts['unknown']} unknown."
            Actor.log.info(msg)
            await Actor.set_status_message(msg)
