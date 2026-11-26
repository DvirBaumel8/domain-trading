"""Bulk Domain Availability Checker - DNS pre-check, RDAP (official registry) confirmation."""
from __future__ import annotations
import asyncio
import time
from datetime import datetime, timezone
from urllib.parse import urlparse

import httpx
from apify import Actor

from .doh import DohResolver
from .core import (TLD_LIST_URL, bundled_tlds, generate_candidates, index_bootstrap, is_charged, is_valid_tld_list,
                   normalize_domain, parked_hint, parse_rdap, parse_tld_list, rdap_base_for, should_push)

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


async def load_tlds(client: httpx.AsyncClient) -> set[str]:
    """IANA TLD list, fetched once per run; the copy bundled in the Actor is the fallback."""
    try:
        r = await client.get(TLD_LIST_URL)
        tlds = parse_tld_list(r.text) if r.status_code == 200 else set()
        if is_valid_tld_list(tlds):
            return tlds
    except Exception as e:  # noqa: BLE001
        Actor.log.warning(f'IANA TLD list unavailable ({type(e).__name__}); using the bundled copy.')
    return bundled_tlds()


async def check_domain(domain: str, kw: str | None, *, resolver: DohResolver, client: httpx.AsyncClient,
                       throttle: HostThrottle, bootstrap: dict, valid_tlds: set[str], lookup_registered: bool) -> dict:
    """Build one result row (no pushing, no charging)."""
    row = dict(domain=domain, tld=domain.rsplit('.', 1)[-1], length=len(domain.split('.')[0]),
               keyword=kw, available=None, status='unknown', method='dns', hasDns=None,
               nameservers=[], registrar=None, createdDate=None, expiryDate=None,
               domainAgeYears=None, rdapStatus=[], parkedOrForSale=None, error=None)
    if row['tld'] not in valid_tlds:
        row.update(status='invalid_tld', error=f".{row['tld']} is not a TLD in the IANA root zone list")
        row['checkedAt'] = datetime.now(timezone.utc).isoformat(timespec='seconds')
        return row
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
            row.update(available=None, status='likely_available', method='dns')
            row['error'] = 'No RDAP server for this TLD - DNS says the name does not exist, but the registry could not confirm it. Verify at a registrar'
        else:
            row['error'] = 'No RDAP server for this TLD and no DNS answer'
    row['checkedAt'] = datetime.now(timezone.utc).isoformat(timespec='seconds')
    return row


async def main() -> None:
    async with Actor:
        inp = await Actor.get_input() or {}
        max_domains = int(inp.get('maxDomains') or 5000)
        only_available = bool(inp.get('onlyAvailable'))
        include_likely = bool(inp.get('includeLikelyAvailable'))
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
            valid_tlds = await load_tlds(client)
            resolver = DohResolver(client)
            throttle = HostThrottle(RDAP_MIN_INTERVAL)
            sem = asyncio.Semaphore(concurrency)
            stop = asyncio.Event()
            counts = {'available': 0, 'likely_available': 0, 'registered': 0, 'unknown': 0, 'invalid_tld': 0}
            done = 0

            async def check(domain: str, kw: str | None):
                nonlocal done
                async with sem:
                    if stop.is_set():
                        return
                    row = await check_domain(domain, kw, resolver=resolver, client=client, throttle=throttle,
                                             bootstrap=bootstrap, valid_tlds=valid_tlds, lookup_registered=lookup_registered)
                    counts[row['status']] = counts.get(row['status'], 0) + 1
                    done += 1
                    if row['status'] == 'invalid_tld':
                        invalid.append(domain)
                    if not should_push(row, only_available, include_likely):
                        return
                    if is_charged(row):
                        res = await Actor.push_data(row, charged_event_name='result')
                        if res is not None and getattr(res, 'event_charge_limit_reached', False):
                            Actor.log.info('Spending limit reached - stopping.')
                            stop.set()
                    else:
                        await Actor.push_data(row)  # invalid TLD: returned, never charged
                    if done % 200 == 0:
                        await Actor.set_status_message(f'Checked {done}/{len(items)} - {counts}')

            await asyncio.gather(*(check(d, k) for d, k in items))
            if invalid:
                # Not charged, so users are never billed for bad input lines.
                await Actor.set_value('INVALID_INPUTS', invalid[:5000])
                Actor.log.warning(f'{len(invalid)} invalid inputs skipped (saved to key-value store as INVALID_INPUTS).')
            msg = (f"Done: {done} checked - {counts['available']} available, {counts['likely_available']} likely available, "
                   f"{counts['registered']} registered, {counts['unknown']} unknown, {counts['invalid_tld']} invalid TLD.")
            Actor.log.info(msg)
            await Actor.set_status_message(msg)
