"""Pure helpers: normalisation, candidate generation, DNS/RDAP interpretation."""
from __future__ import annotations
import re
from datetime import datetime, timezone
from pathlib import Path

LABEL_RE = re.compile(r'^(?!-)[a-z0-9-]{1,63}(?<!-)$')


def normalize_domain(raw: str) -> str | None:
    """Turn user input (URL, email, mixed case, IDN) into an ASCII domain, or None if invalid."""
    if not raw or not isinstance(raw, str):
        return None
    s = raw.strip().lower()
    s = re.sub(r'^[a-z][a-z0-9+.-]*://', '', s)  # scheme
    s = s.split('@')[-1]                            # email -> domain
    s = re.split(r'[/?#:\s]', s)[0]                 # path/port
    s = s.strip('.')
    if s.startswith('www.'):
        s = s[4:]
    if not s or '.' not in s:
        return None
    try:
        s = s.encode('idna').decode('ascii')
    except Exception:
        return None
    labels = s.split('.')
    if len(s) > 253 or not all(LABEL_RE.match(l) for l in labels):
        return None
    if not re.match(r'^(xn--[a-z0-9-]+|[a-z]{2,63})$', labels[-1]):
        return None
    return s


def clean_label(raw: str) -> str | None:
    s = re.sub(r'[\s_]+', '', (raw or '').strip().lower())
    s = s.split('.')[0] if '.' in s else s
    try:
        s = s.encode('idna').decode('ascii')
    except Exception:
        return None
    return s if LABEL_RE.match(s) else None


def generate_candidates(keywords, tlds, prefixes=None, suffixes=None):
    """Yield (domain, keyword) for keyword x (prefix/suffix variants) x tld, de-duplicated, order-preserving."""
    tlds = [t.strip().lower().lstrip('.') for t in (tlds or ['com']) if t and t.strip()]
    pre = [''] + [p for p in (clean_label(x) for x in (prefixes or [])) if p]
    suf = [''] + [p for p in (clean_label(x) for x in (suffixes or [])) if p]
    seen = set()
    for kw in keywords or []:
        base = clean_label(kw)
        if not base:
            continue
        for p in pre:
            for s in suf:
                label = f'{p}{base}{s}'
                if len(label) > 63:
                    continue
                for t in tlds:
                    d = normalize_domain(f'{label}.{t}')
                    if d and d not in seen:
                        seen.add(d)
                        yield d, kw


def parse_rdap(j: dict) -> dict:
    ev = {e.get('eventAction'): e.get('eventDate') for e in j.get('events', []) if isinstance(e, dict)}
    registrar = None
    for ent in j.get('entities', []) or []:
        if 'registrar' in (ent.get('roles') or []):
            vc = ent.get('vcardArray')
            if isinstance(vc, list) and len(vc) > 1:
                for f in vc[1]:
                    if isinstance(f, list) and f and f[0] == 'fn':
                        registrar = f[3]
            registrar = registrar or ent.get('handle')
    created = (ev.get('registration') or '')[:10] or None
    expiry = (ev.get('expiration') or '')[:10] or None
    age = None
    if created:
        try:
            dt = datetime.strptime(created, '%Y-%m-%d').replace(tzinfo=timezone.utc)
            age = round((datetime.now(timezone.utc) - dt).days / 365.25, 2)
        except ValueError:
            pass
    ns = [n.get('ldhName', '').lower().rstrip('.') for n in j.get('nameservers', []) or [] if n.get('ldhName')]
    return dict(registrar=registrar, createdDate=created, expiryDate=expiry, domainAgeYears=age,
                rdapStatus=j.get('status') or [], rdapNameservers=ns)


def rdap_base_for(domain: str, bootstrap: dict) -> str | None:
    """Find the RDAP base URL for a domain's TLD from the IANA bootstrap file (longest suffix match)."""
    labels = domain.split('.')
    for i in range(1, len(labels)):
        suffix = '.'.join(labels[i:])
        if suffix in bootstrap:
            return bootstrap[suffix]
    return None


def index_bootstrap(raw: dict) -> dict:
    out = {}
    for entry in raw.get('services', []):
        tlds, urls = entry[0], entry[1]
        url = next((u for u in urls if u.startswith('https://')), urls[0] if urls else None)
        if not url:
            continue
        if not url.endswith('/'):
            url += '/'
        for t in tlds:
            out[t.lower()] = url
    return out


PARKING_NS = {
    'afternic.com': 'Afternic (listed for sale)', 'sedoparking.com': 'Sedo parking', 'dan.com': 'Dan.com (listed for sale)',
    'parkingcrew.net': 'ParkingCrew', 'bodis.com': 'Bodis parking', 'above.com': 'Above.com parking',
    'parklogic.com': 'ParkLogic', 'uniregistrymarket.link': 'Uniregistry market', 'domaincontrol.com': None,
    'atom.com': 'Atom (listed for sale)', 'squadhelp.com': 'Atom/Squadhelp (listed for sale)', 'hugedomains.com': 'HugeDomains (for sale)',
    'brandbucket.com': 'BrandBucket (for sale)', 'namebright.com': None, 'dynadot.com': None,
}


def parked_hint(nameservers) -> str | None:
    for ns in nameservers or []:
        for key, label in PARKING_NS.items():
            if label and (ns == key or ns.endswith('.' + key)):
                return label
    return None


TLD_LIST_URL = 'https://data.iana.org/TLD/tlds-alpha-by-domain.txt'
BUNDLED_TLDS = Path(__file__).with_name('iana_tlds.txt')


def parse_tld_list(text: str) -> set[str]:
    """Parse the IANA tlds-alpha-by-domain.txt format (comment lines start with #)."""
    return {l.strip().lower() for l in (text or '').splitlines() if l.strip() and not l.startswith('#')}


def bundled_tlds() -> set[str]:
    return parse_tld_list(BUNDLED_TLDS.read_text())


def is_valid_tld_list(tlds: set[str]) -> bool:
    return len(tlds) >= 500 and 'com' in tlds


def should_push(row: dict, only_available: bool, include_likely: bool) -> bool:
    """Which rows reach the dataset. With onlyAvailable, only 'available' (plus 'likely_available' if asked)."""
    if not only_available:
        return True
    return row.get('status') == 'available' or (include_likely and row.get('status') == 'likely_available')


def is_charged(row: dict) -> bool:
    """Invalid-TLD rows are returned but never charged."""
    return row.get('status') != 'invalid_tld'
