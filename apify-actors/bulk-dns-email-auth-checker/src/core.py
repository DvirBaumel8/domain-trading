"""Pure analysis helpers for DNS/email-auth records."""
from __future__ import annotations
import re

LABEL_RE = re.compile(r'^(?!-)[a-z0-9-]{1,63}(?<!-)$')

PROVIDERS = [
    ('google.com', 'Google Workspace'), ('googlemail.com', 'Google Workspace'),
    ('outlook.com', 'Microsoft 365'), ('protection.outlook.com', 'Microsoft 365'),
    ('zoho.com', 'Zoho Mail'), ('zoho.eu', 'Zoho Mail'), ('protonmail.ch', 'Proton Mail'),
    ('mimecast.com', 'Mimecast'), ('pphosted.com', 'Proofpoint'), ('ppe-hosted.com', 'Proofpoint'),
    ('barracudanetworks.com', 'Barracuda'), ('messagingengine.com', 'Fastmail'), ('secureserver.net', 'GoDaddy'),
    ('mail.ovh.net', 'OVH'), ('yandex.net', 'Yandex'), ('icloud.com', 'iCloud'), ('emailsrvr.com', 'Rackspace'),
    ('amazonaws.com', 'Amazon SES/WorkMail'), ('mailgun.org', 'Mailgun'), ('hostinger.com', 'Hostinger'),
    ('titan.email', 'Titan'), ('improvmx.com', 'ImprovMX'), ('forwardemail.net', 'Forward Email'),
]
PARKING_NS = {'afternic.com': 'Afternic (listed for sale)', 'sedoparking.com': 'Sedo parking', 'dan.com': 'Dan.com (listed for sale)',
              'parkingcrew.net': 'ParkingCrew', 'bodis.com': 'Bodis parking', 'above.com': 'Above.com parking', 'parklogic.com': 'ParkLogic',
              'atom.com': 'Atom (listed for sale)', 'squadhelp.com': 'Atom/Squadhelp (listed for sale)', 'hugedomains.com': 'HugeDomains (for sale)',
              'brandbucket.com': 'BrandBucket (for sale)'}


def normalize_domain(raw: str) -> str | None:
    if not raw or not isinstance(raw, str):
        return None
    s = raw.strip().lower()
    s = re.sub(r'^[a-z][a-z0-9+.-]*://', '', s)
    s = s.split('@')[-1]
    s = re.split(r'[/?#:\s]', s)[0].strip('.')
    if s.startswith('www.'):
        s = s[4:]
    if '.' not in s:
        return None
    try:
        s = s.encode('idna').decode('ascii')
    except Exception:
        return None
    if len(s) > 253 or not all(LABEL_RE.match(l) for l in s.split('.')):
        return None
    return s


def unquote_txt(data: str) -> str:
    """DoH TXT data comes as '"part1" "part2"' - join the quoted chunks."""
    parts = re.findall(r'"((?:[^"\\]|\\.)*)"', data or '')
    return ''.join(parts) if parts else (data or '').strip('"')


def parse_mx(data_list):
    out = []
    for d in data_list:
        bits = d.split()
        if len(bits) >= 2 and bits[0].isdigit() and bits[1].rstrip('.') != '':
            out.append({'priority': int(bits[0]), 'host': bits[1].rstrip('.').lower()})
    return sorted(out, key=lambda m: m['priority'])


def detect_provider(mx):
    for m in mx:
        for key, name in PROVIDERS:
            if m['host'] == key or m['host'].endswith('.' + key):
                return name
    return 'Other / self-hosted' if mx else None


def parked_hint(ns):
    for n in ns or []:
        for key, label in PARKING_NS.items():
            if n == key or n.endswith('.' + key):
                return label
    return None


def analyse_spf(txts):
    spfs = [t for t in txts if t.lower().startswith('v=spf1')]
    if not spfs:
        return None, None, None, ['No SPF record - receivers cannot verify who may send mail for this domain.'] , 0
    issues = []
    if len(spfs) > 1:
        issues.append('Multiple SPF records - this is invalid (permerror); merge them into one.')
    spf = spfs[0]
    toks = spf.split()[1:]
    allm = next((t for t in toks if re.match(r'^[+\-~?]?all$', t, re.I)), None)
    if allm and allm[0] not in '+-~?':
        allm = '+' + allm
    lookups = sum(1 for t in toks if re.match(r'^[+\-~?]?(include:|a\b|a:|a/|mx\b|mx:|mx/|ptr|exists:|redirect=)', t, re.I))
    if lookups > 10:
        issues.append(f'SPF uses about {lookups} DNS lookups at the top level (limit is 10) - may fail.')
    if allm is None and not any(t.lower().startswith('redirect=') for t in toks):
        issues.append("SPF has no 'all' mechanism - anyone may pass as neutral.")
    elif allm == '+all':
        issues.append('SPF ends with +all - allows ANY server to send as this domain.')
    elif allm == '?all':
        issues.append('SPF ends with ?all (neutral) - offers no protection.')
    if any(t.lower().startswith('ptr') for t in toks):
        issues.append('SPF uses the deprecated ptr mechanism.')
    score = 25 if allm == '-all' else 20 if allm == '~all' else 8 if allm in ('?all', None) else 0
    if len(spfs) > 1:
        score = 0
    return spf, allm, lookups, issues, score


def analyse_dmarc(txts):
    recs = [t for t in txts if t.lower().startswith('v=dmarc1')]
    if not recs:
        return None, None, None, ['No DMARC record - spoofed mail from this domain is not blocked and you get no reports.'], 0
    rec = recs[0]
    tags = {}
    for part in rec.split(';'):
        if '=' in part:
            k, v = part.split('=', 1)
            tags[k.strip().lower()] = v.strip()
    p = (tags.get('p') or '').lower() or None
    issues = []
    if len(recs) > 1:
        issues.append('Multiple DMARC records - receivers will ignore DMARC.')
    if p not in ('none', 'quarantine', 'reject'):
        issues.append('DMARC record has no valid p= policy.')
    elif p == 'none':
        issues.append('DMARC policy is p=none (monitoring only) - spoofed mail is still delivered.')
    if not tags.get('rua'):
        issues.append('DMARC has no rua= address - you receive no aggregate reports.')
    pct = tags.get('pct')
    if pct and pct.isdigit() and int(pct) < 100 and p in ('quarantine', 'reject'):
        issues.append(f'DMARC pct={pct} - policy applies to only part of the mail.')
    score = {'reject': 35, 'quarantine': 28, 'none': 12}.get(p, 0)
    if len(recs) > 1:
        score = 0
    return rec, p, tags.get('rua'), issues, score


def email_score(has_mx, spf_score, dmarc_score, dkim_found, mta_sts, bimi):
    s = spf_score + dmarc_score + (25 if dkim_found else 0) + (8 if mta_sts else 0) + (7 if bimi else 0)
    return max(0, min(100, s if has_mx or spf_score or dmarc_score else s))


def is_null_mx(data_list) -> bool:
    """RFC 7505 null MX: '0 .' means the domain accepts no mail."""
    return any(d.split()[1:2] == ['.'] for d in data_list if len(d.split()) >= 2)


def dkim_has_key(txts) -> bool:
    """True when a TXT looks like a DKIM key with a non-empty p= (empty p= means revoked)."""
    import re as _re
    for t in txts:
        m = _re.search(r'(?:^|;)\s*p=([^;\s]*)', t)
        if m and m.group(1):
            return True
    return False
