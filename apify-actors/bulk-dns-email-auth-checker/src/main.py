"""Bulk DNS & Email Authentication Checker (DNS-over-HTTPS)."""
from __future__ import annotations
import asyncio
from datetime import datetime, timezone

import httpx
from apify import Actor

from .core import (analyse_dmarc, analyse_spf, detect_provider, email_score, normalize_domain, parked_hint,
                   parse_mx, unquote_txt, is_null_mx, dkim_has_key)
from .doh import DohResolver

T = {'A': 1, 'NS': 2, 'CNAME': 5, 'MX': 15, 'TXT': 16, 'AAAA': 28, 'CAA': 257}


async def check_domain(r: DohResolver, domain: str, selectors: list[str], include_records: bool) -> dict:
    row = {'domain': domain, 'resolves': None, 'a': [], 'aaaa': [], 'ns': [], 'mx': [], 'emailProvider': None,
           'spf': None, 'spfAll': None, 'spfLookups': None, 'dmarc': None, 'dmarcPolicy': None, 'dmarcRua': None,
           'dkimSelectorsFound': [], 'mtaSts': False, 'bimi': False, 'caa': [], 'parkedOrForSale': None,
           'emailScore': 0, 'issues': [], 'error': None}
    (ns_rc, ns), (mx_rc, mx), (txt_rc, txt), (dm_rc, dm) = await asyncio.gather(
        r.records(domain, 'NS', T['NS']), r.records(domain, 'MX', T['MX']),
        r.records(domain, 'TXT', T['TXT']), r.records('_dmarc.' + domain, 'TXT', T['TXT']))
    if ns_rc is None and mx_rc is None and txt_rc is None:
        row['error'] = 'DNS lookup failed (resolvers unreachable)'
        return row
    if ns_rc == 3:
        row.update(resolves=False, issues=['Domain does not exist in DNS (NXDOMAIN).'])
        return row
    row['resolves'] = True
    row['ns'] = sorted(n.rstrip('.').lower() for n in ns)
    row['parkedOrForSale'] = parked_hint(row['ns'])
    row['mx'] = parse_mx(mx)
    null_mx = is_null_mx(mx)
    row['emailProvider'] = detect_provider(row['mx'])
    txts = [unquote_txt(t) for t in txt]
    dm_txts = [unquote_txt(t) for t in dm]
    spf, spf_all, lookups, spf_issues, spf_score = analyse_spf(txts)
    dmarc, pol, rua, dm_issues, dm_score = analyse_dmarc(dm_txts)
    row.update(spf=spf, spfAll=spf_all, spfLookups=lookups, dmarc=dmarc, dmarcPolicy=pol, dmarcRua=rua)

    async def dkim(sel):
        rc, recs = await r.records(f'{sel}._domainkey.{domain}', 'TXT', T['TXT'])
        if dkim_has_key([unquote_txt(x) for x in recs]):
            return sel
        rc2, cn = await r.records(f'{sel}._domainkey.{domain}', 'CNAME', T['CNAME'])
        if cn:
            rc3, tgt = await r.records(cn[0].rstrip('.'), 'TXT', T['TXT'])
            return sel if dkim_has_key([unquote_txt(x) for x in tgt]) else None
        return None
    extra = [r.records('_mta-sts.' + domain, 'TXT', T['TXT']), r.records('default._bimi.' + domain, 'TXT', T['TXT'])]
    if include_records:
        extra += [r.records(domain, 'A', T['A']), r.records(domain, 'AAAA', T['AAAA']), r.records(domain, 'CAA', T['CAA'])]
    probe = 'zz-nonexistent-probe-7x1q'
    dk_res, extra_res = await asyncio.gather(asyncio.gather(*(dkim(s) for s in selectors + [probe])), asyncio.gather(*extra))
    wildcard = dk_res[-1] is not None
    row['dkimSelectorsFound'] = [] if wildcard else [s for s in dk_res[:-1] if s]
    row['mtaSts'] = any('v=stsv1' in unquote_txt(x).lower() for x in extra_res[0][1])
    row['bimi'] = any('v=bimi1' in unquote_txt(x).lower() for x in extra_res[1][1])
    if include_records:
        row['a'], row['aaaa'], row['caa'] = extra_res[2][1], extra_res[3][1], extra_res[4][1]
    issues = []
    if wildcard:
        issues.append('Wildcard DKIM record answers every selector - DKIM selectors could not be verified.')
    if null_mx:
        issues.append('Null MX (RFC 7505): the domain declares it accepts no email.')
    elif not row['mx']:
        issues.append('No MX records - the domain cannot receive email.')
    if not row['mx']:
        if not spf or spf_all != '-all':
            issues.append("Domain does not receive mail: publish 'v=spf1 -all' and DMARC p=reject to stop spoofing.")
    issues += spf_issues + dm_issues
    if row['mx'] and not row['dkimSelectorsFound'] and not wildcard:
        issues.append('No DKIM key found on common selectors (add your provider\'s selector to check).')
    row['issues'] = issues
    row['emailScore'] = email_score(bool(row['mx']), spf_score, dm_score, bool(row['dkimSelectorsFound']), row['mtaSts'], row['bimi'])
    return row


async def main() -> None:
    async with Actor:
        inp = await Actor.get_input() or {}
        selectors = [s.strip() for s in (inp.get('dkimSelectors') or []) if s and s.strip()] or ['google', 'selector1', 'selector2', 'default']
        include_records = inp.get('includeRecords', True)
        conc = max(1, min(30, int(inp.get('concurrency') or 10)))
        max_domains = int(inp.get('maxDomains') or 10000)
        domains, invalid = [], []
        for raw in inp.get('domains') or []:
            d = normalize_domain(raw)
            (domains if d else invalid).append(d or raw)
        domains = list(dict.fromkeys(domains))[:max_domains]
        if not domains:
            await Actor.fail(status_message='Please add at least one domain, URL or email in the Domains field.')
            return
        Actor.log.info(f'Checking {len(domains)} domains ({len(invalid)} invalid skipped).')
        sem = asyncio.Semaphore(conc)
        stop = asyncio.Event()
        done = 0
        async with httpx.AsyncClient(http2=False, timeout=12,
                                     limits=httpx.Limits(max_connections=60, max_keepalive_connections=30)) as client:
            r = DohResolver(client)

            async def one(d):
                nonlocal done
                async with sem:
                    if stop.is_set():
                        return
                    try:
                        row = await check_domain(r, d, selectors, include_records)
                    except Exception as e:  # noqa: BLE001
                        row = {'domain': d, 'error': f'{type(e).__name__}: {e}', 'issues': []}
                    row['checkedAt'] = datetime.now(timezone.utc).isoformat(timespec='seconds')
                    res = await Actor.push_data(row, charged_event_name='result')
                    done += 1
                    if res is not None and getattr(res, 'event_charge_limit_reached', False):
                        stop.set()
                    if done % 100 == 0:
                        await Actor.set_status_message(f'Checked {done}/{len(domains)}')
            await asyncio.gather(*(one(d) for d in domains))
        await Actor.set_status_message(f'Done: {done} domains checked.')
