"""Domain Checkup Report - RDAP, DNS, email auth, landing/for-sale, safety & trademark hint."""
from __future__ import annotations
import asyncio
import time
from datetime import datetime, timezone
from urllib.parse import urlparse

import httpx
from apify import Actor

from .core import (
    analyse_dmarc_basic,
    analyse_spf_basic,
    check_trademark_risk,
    compute_score_and_summary,
    detect_email_provider,
    detect_ns_provider,
    detect_parked_ns,
    extract_js_or_meta_redirect,
    index_bootstrap,
    inspect_landing_html,
    is_null_mx,
    normalize_domain,
    parse_mx,
    parse_rdap,
    rdap_base_for,
    unquote_txt,
)
from .doh import DohResolver

BOOTSTRAP_URL = 'https://data.iana.org/rdap/dns.json'
UA = 'Mozilla/5.0 (compatible; ApifyDomainCheckupReport/0.1; +https://apify.com)'
BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
EXTRA_RDAP = {
    'io': 'https://rdap.identitydigital.services/rdap/',
    'me': 'https://rdap.identitydigital.services/rdap/',
    'co': 'https://rdap.registry.co/co/',
    'de': 'https://rdap.denic.de/',
}
RDAP_MIN_INTERVAL = 0.35
T = {'A': 1, 'NS': 2, 'MX': 15, 'TXT': 16}


class HostThrottle:
    def __init__(self, interval: float):
        self.interval = interval
        self.locks: dict[str, asyncio.Lock] = {}
        self.last: dict[str, float] = {}

    async def wait(self, host: str) -> None:
        lock = self.locks.setdefault(host, asyncio.Lock())
        async with lock:
            delta = time.monotonic() - self.last.get(host, 0.0)
            if delta < self.interval:
                await asyncio.sleep(self.interval - delta)
            self.last[host] = time.monotonic()


async def rdap_lookup(client: httpx.AsyncClient, throttle: HostThrottle, base: str, domain: str):
    """Return (http_status_or_None, parsed_dict_or_None, error)."""
    url = f'{base}domain/{domain}'
    host = urlparse(base).netloc
    err = None
    for attempt in range(4):
        await throttle.wait(host)
        try:
            r = await client.get(url, headers={'User-Agent': UA, 'Accept': 'application/rdap+json'})
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
            await asyncio.sleep(2 * (attempt + 1))
            err = f'HTTP {r.status_code}'
            continue
        return None, None, f'HTTP {r.status_code}'
    return None, None, err or 'RDAP retries exhausted'


async def fetch_landing(client: httpx.AsyncClient, domain: str) -> dict:
    """Fetch HTTPS (or HTTP fallback) landing page, following 1 JS/meta redirect if needed."""
    out = {
        'httpStatus': None,
        'httpsValid': None,
        'finalUrl': None,
        'pageTitle': None,
        'pageForSale': False,
        'pageReason': None,
        'forSaleUrl': None,
        'askingPrice': None,
    }
    headers = {'User-Agent': BROWSER_UA}
    resp = None
    try:
        resp = await client.get(f'https://{domain}', headers=headers, timeout=10, follow_redirects=True)
        out['httpsValid'] = True
    except httpx.HTTPError:
        out['httpsValid'] = False
        try:
            resp = await client.get(f'http://{domain}', headers=headers, timeout=10, follow_redirects=True)
        except httpx.HTTPError:
            return out

    if resp is None:
        return out

    final_url = str(resp.url)
    text = resp.text[:300000] if 'text' in (resp.headers.get('content-type') or 'text').lower() or '<html' in resp.text[:500].lower() else ''
    redir = extract_js_or_meta_redirect(text, final_url)
    if redir:
        try:
            r2 = await client.get(redir, headers=headers, timeout=10, follow_redirects=True)
            resp = r2
            final_url = str(r2.url)
            text = r2.text[:300000]
        except httpx.HTTPError:
            pass

    out['httpStatus'] = resp.status_code
    out['finalUrl'] = final_url
    parsed = inspect_landing_html(final_url, text, domain)
    out.update(parsed)
    return out


async def check_one(
    domain: str,
    resolver: DohResolver,
    client: httpx.AsyncClient,
    throttle: HostThrottle,
    bootstrap: dict[str, str],
    lookup_rdap: bool,
    fetch_page: bool,
) -> dict:
    tm_risk, tm_matches, tm_note = check_trademark_risk(domain)
    row: dict = {
        'domain': domain,
        'tld': domain.rsplit('.', 1)[-1],
        'registered': None,
        'status': 'unknown',
        'createdDate': None,
        'domainAgeYears': None,
        'expiryDate': None,
        'daysUntilExpiry': None,
        'registrar': None,
        'rdapStatus': [],
        'rdapSource': 'dns-only',
        'hasA': None,
        'hasMx': None,
        'hasNs': None,
        'aRecords': [],
        'mxRecords': [],
        'nameservers': [],
        'nameserverProvider': None,
        'emailProvider': None,
        'isParkedOrForSale': None,
        'parkedOrForSaleReason': None,
        'forSaleUrl': None,
        'askingPrice': None,
        'httpStatus': None,
        'httpsValid': None,
        'finalUrl': None,
        'pageTitle': None,
        'hasSpf': None,
        'spfPolicy': None,
        'hasDmarc': None,
        'dmarcPolicy': None,
        'safetyStatus': 'not_checked',
        'safetyDetail': 'Not checked.',
        'safetySource': None,
        'trademarkRisk': tm_risk,
        'trademarkMatches': tm_matches,
        'trademarkNote': tm_note,
        'score': 0,
        'scoreReasons': [],
        'summary': '',
        'error': None,
    }

    (ns_rc, ns_list), (a_rc, a_list), (mx_rc, mx_raw), (txt_rc, txt_raw), (dm_rc, dm_raw), safety = await asyncio.gather(
        resolver.records(domain, 'NS', T['NS']),
        resolver.records(domain, 'A', T['A']),
        resolver.records(domain, 'MX', T['MX']),
        resolver.records(domain, 'TXT', T['TXT']),
        resolver.records(f'_dmarc.{domain}', 'TXT', T['TXT']),
        resolver.security_check(domain),
    )
    row['safetyStatus'], row['safetyDetail'], row['safetySource'] = safety

    is_nxdomain = (ns_rc == 3 and a_rc == 3)
    if ns_rc is None and a_rc is None:
        row['error'] = 'DNS lookup failed (resolvers unreachable)'
    elif is_nxdomain:
        row.update(hasNs=False, hasA=False, hasMx=False, hasSpf=False, hasDmarc=False)
    else:
        ns_clean = sorted(n.rstrip('.').lower() for n in ns_list if n)
        mx_clean = parse_mx(mx_raw)
        null_mx = is_null_mx(mx_raw)
        txts = [unquote_txt(t) for t in txt_raw]
        dm_txts = [unquote_txt(t) for t in dm_raw]
        has_spf, spf_pol = analyse_spf_basic(txts)
        has_dmarc, dm_pol = analyse_dmarc_basic(dm_txts)

        row['hasNs'] = bool(ns_clean)
        row['hasA'] = bool(a_list)
        row['hasMx'] = bool(mx_clean) and not null_mx
        row['aRecords'] = a_list[:10]
        row['mxRecords'] = mx_clean[:10]
        row['nameservers'] = ns_clean
        row['nameserverProvider'] = detect_ns_provider(ns_clean)
        row['emailProvider'] = detect_email_provider(mx_clean, null_mx)
        row['hasSpf'] = has_spf
        row['spfPolicy'] = spf_pol
        row['hasDmarc'] = has_dmarc
        row['dmarcPolicy'] = dm_pol

        if ns_clean or a_list or mx_clean:
            row.update(registered=True, status='registered')

        ns_parked = detect_parked_ns(ns_clean)
        if ns_parked:
            row['isParkedOrForSale'] = True
            row['parkedOrForSaleReason'] = f'Nameservers indicate {ns_parked}'
        else:
            row['isParkedOrForSale'] = False

    # RDAP check (throttled ~3 req/s per registry)
    base = rdap_base_for(domain, bootstrap)
    if lookup_rdap and base:
        code, info, err = await rdap_lookup(client, throttle, base, domain)
        if code == 404 and not row['hasNs'] and not row['hasA']:
            row.update(registered=False, status='available', rdapSource='rdap')
        elif code == 404 and row['hasA']:
            row.update(registered=True, status='registered', rdapSource='dns-only')
        elif code == 200 and info:
            rdap_ns = info.pop('rdapNameservers', [])
            row.update(info)
            row.update(registered=True, status='registered', rdapSource='rdap')
            if not row['nameservers'] and rdap_ns:
                row['nameservers'] = rdap_ns
                row['nameserverProvider'] = detect_ns_provider(rdap_ns)
                ns_parked = detect_parked_ns(rdap_ns)
                if ns_parked:
                    row['isParkedOrForSale'] = True
                    row['parkedOrForSaleReason'] = f'Nameservers indicate {ns_parked}'
        elif err and row['registered'] is None:
            row['error'] = err
    elif lookup_rdap and not base:
        row['rdapSource'] = 'no-rdap-server'
        if is_nxdomain:
            row.update(registered=False, status='available')
            row['error'] = 'No public RDAP server for this TLD - DNS-only availability'
    elif is_nxdomain:
        row.update(registered=False, status='available', rdapSource='dns-only')

    # Landing page HTTP/HTTPS check when domain resolves in DNS
    if fetch_page and row['registered'] is True and (row['hasA'] or row['isParkedOrForSale']):
        landing = await fetch_landing(client, domain)
        row['httpStatus'] = landing['httpStatus']
        row['httpsValid'] = landing['httpsValid']
        row['finalUrl'] = landing['finalUrl']
        row['pageTitle'] = landing['pageTitle']
        if landing['pageForSale']:
            row['isParkedOrForSale'] = True
            if row['parkedOrForSaleReason'] and landing['pageReason']:
                row['parkedOrForSaleReason'] = f"{row['parkedOrForSaleReason']}; {landing['pageReason']}"
            elif landing['pageReason']:
                row['parkedOrForSaleReason'] = landing['pageReason']
            row['forSaleUrl'] = landing['forSaleUrl']
            row['askingPrice'] = landing['askingPrice']

    score, reasons, summary = compute_score_and_summary(row)
    row['score'] = score
    row['scoreReasons'] = reasons
    row['summary'] = summary
    row['checkedAt'] = datetime.now(timezone.utc).isoformat(timespec='seconds')
    return row


async def main() -> None:
    async with Actor:
        inp = await Actor.get_input() or {}
        lookup_rdap = inp.get('lookupRdap', True)
        fetch_page = inp.get('fetchLandingPage', True)
        max_domains = max(1, min(10000, int(inp.get('maxDomains') or 500)))
        concurrency = max(1, min(30, int(inp.get('concurrency') or 15)))

        domains: list[str] = []
        seen: set[str] = set()
        invalid: list[str] = []
        for raw in inp.get('domains') or []:
            d = normalize_domain(raw)
            if not d:
                invalid.append(str(raw))
            elif d not in seen:
                seen.add(d)
                domains.append(d)

        if len(domains) > max_domains:
            Actor.log.warning(f'{len(domains)} domains provided; checking first {max_domains} (maxDomains).')
            domains = domains[:max_domains]

        if not domains:
            if invalid:
                await Actor.set_value('INVALID_INPUTS', invalid[:5000])
            await Actor.fail(status_message='Please add at least one domain, URL or email in the Domains field.')
            return

        Actor.log.info(f'Checking {len(domains)} domains ({len(invalid)} invalid inputs skipped).')

        limits = httpx.Limits(max_connections=60, max_keepalive_connections=30)
        async with httpx.AsyncClient(timeout=20, follow_redirects=True, limits=limits) as client:
            bootstrap: dict[str, str] = {}
            if lookup_rdap:
                try:
                    r = await client.get(BOOTSTRAP_URL, headers={'User-Agent': UA})
                    bootstrap = index_bootstrap(r.json())
                except Exception as e:  # noqa: BLE001
                    Actor.log.warning(f'IANA RDAP bootstrap unavailable ({e}); falling back to extra list / DNS.')
                for tld, url in EXTRA_RDAP.items():
                    bootstrap.setdefault(tld, url)

            resolver = DohResolver(client)
            throttle = HostThrottle(RDAP_MIN_INTERVAL)
            sem = asyncio.Semaphore(concurrency)
            stop = asyncio.Event()
            done = 0

            async def run_one(d: str) -> None:
                nonlocal done
                async with sem:
                    if stop.is_set():
                        return
                    try:
                        row = await check_one(d, resolver, client, throttle, bootstrap, lookup_rdap, fetch_page)
                    except Exception as e:  # noqa: BLE001
                        row = {
                            'domain': d,
                            'tld': d.rsplit('.', 1)[-1],
                            'status': 'unknown',
                            'score': 0,
                            'scoreReasons': [f'Check failed: {type(e).__name__}'],
                            'summary': f'{d} check failed ({type(e).__name__}).',
                            'error': f'{type(e).__name__}: {e}',
                            'checkedAt': datetime.now(timezone.utc).isoformat(timespec='seconds'),
                        }
                    res = await Actor.push_data(row, charged_event_name='report')
                    done += 1
                    if res is not None and getattr(res, 'event_charge_limit_reached', False):
                        Actor.log.info('Spending limit reached - stopping.')
                        stop.set()
                    if done % 50 == 0:
                        await Actor.set_status_message(f'Checked {done}/{len(domains)} domains')

            await asyncio.gather(*(run_one(d) for d in domains))

            if invalid:
                await Actor.set_value('INVALID_INPUTS', invalid[:5000])
                Actor.log.warning(f'{len(invalid)} invalid inputs skipped (saved to INVALID_INPUTS, not charged).')

            msg = f'Done: {done} domain checkup report(s) generated.'
            Actor.log.info(msg)
            await Actor.set_status_message(msg)
