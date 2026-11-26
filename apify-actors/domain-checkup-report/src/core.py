"""Pure analysis helpers for Domain Checkup Report."""
from __future__ import annotations
import html as html_lib
import json
import re
from datetime import datetime, timezone
from urllib.parse import urljoin, urlparse

LABEL_RE = re.compile(r'^(?!-)[a-z0-9-]{1,63}(?<!-)$')

PARKING_NS = {
    'afternic.com': 'Afternic (listed for sale)',
    'sedoparking.com': 'Sedo parking',
    'sedo.com': 'Sedo parking',
    'dan.com': 'Dan.com (listed for sale)',
    'parkingcrew.net': 'ParkingCrew (parked)',
    'bodis.com': 'Bodis parking',
    'above.com': 'Above.com parking',
    'abovedomains.com': 'Above.com parking',
    'eftydns.com': 'Efty (listed for sale)',
    'parklogic.com': 'ParkLogic parking',
    'uniregistrymarket.link': 'Uniregistry market',
    'atom.com': 'Atom (listed for sale)',
    'squadhelp.com': 'Atom/Squadhelp (listed for sale)',
    'hugedomains.com': 'HugeDomains (listed for sale)',
    'brandbucket.com': 'BrandBucket (listed for sale)',
    'sav.com': 'Sav.com (listed for sale)',
    'namefind.com': 'NameFind / GoDaddy (listed for sale)',
    'cashparking.com': 'GoDaddy CashParking',
    'parking.godaddy.com': 'GoDaddy Parking',
    'epik.com': 'Epik marketplace/parking',
}

NS_PROVIDERS = [
    ('cloudflare.com', 'Cloudflare'),
    ('foundationdns.com', 'Cloudflare'),
    ('foundationdns.net', 'Cloudflare'),
    ('foundationdns.org', 'Cloudflare'),
    ('awsdns-', 'Amazon Route 53'),
    ('googledomains.com', 'Google Cloud DNS / Squarespace'),
    ('ns-cloud-', 'Google Cloud DNS'),
    ('google.com', 'Google DNS'),
    ('domaincontrol.com', 'GoDaddy'),
    ('registrar-servers.com', 'Namecheap'),
    ('namecheaphosting.com', 'Namecheap Hosting'),
    ('digitalocean.com', 'DigitalOcean'),
    ('azure-dns.', 'Microsoft Azure DNS'),
    ('akam.net', 'Akamai'),
    ('akamaitechnologies.com', 'Akamai'),
    ('linode.com', 'Akamai / Linode'),
    ('ovh.net', 'OVH'),
    ('hetzner.com', 'Hetzner'),
    ('hetzner.de', 'Hetzner'),
    ('dnsimple.com', 'DNSimple'),
    ('dnsmadeeasy.com', 'DNS Made Easy'),
    ('nsone.net', 'NS1'),
    ('vercel-dns.com', 'Vercel'),
    ('netlify.com', 'Netlify'),
    ('wixdns.net', 'Wix'),
    ('squarespacedns.com', 'Squarespace'),
    ('shopify.com', 'Shopify'),
    ('bluehost.com', 'Bluehost'),
    ('hostgator.com', 'HostGator'),
    ('siteground.net', 'SiteGround'),
    ('wpengine.com', 'WP Engine'),
    ('dynadot.com', 'Dynadot'),
    ('namebrightdns.com', 'NameBright'),
    ('porkbun.com', 'Porkbun'),
    ('gandi.net', 'Gandi'),
    ('hover.com', 'Hover'),
    ('hostinger.com', 'Hostinger'),
    ('dreamhost.com', 'DreamHost'),
    ('iana-servers.net', 'IANA'),
]

EMAIL_PROVIDERS = [
    ('google.com', 'Google Workspace'),
    ('googlemail.com', 'Google Workspace'),
    ('outlook.com', 'Microsoft 365'),
    ('protection.outlook.com', 'Microsoft 365'),
    ('zoho.com', 'Zoho Mail'),
    ('zoho.eu', 'Zoho Mail'),
    ('protonmail.ch', 'Proton Mail'),
    ('mimecast.com', 'Mimecast'),
    ('pphosted.com', 'Proofpoint'),
    ('ppe-hosted.com', 'Proofpoint'),
    ('barracudanetworks.com', 'Barracuda'),
    ('messagingengine.com', 'Fastmail'),
    ('secureserver.net', 'GoDaddy'),
    ('mail.ovh.net', 'OVH'),
    ('yandex.net', 'Yandex'),
    ('icloud.com', 'iCloud'),
    ('emailsrvr.com', 'Rackspace'),
    ('amazonaws.com', 'Amazon SES/WorkMail'),
    ('mailgun.org', 'Mailgun'),
    ('hostinger.com', 'Hostinger'),
    ('titan.email', 'Titan'),
    ('improvmx.com', 'ImprovMX'),
    ('forwardemail.net', 'Forward Email'),
    ('cloudflare.net', 'Cloudflare Email Routing'),
]

MARKETPLACE_HOSTS = {
    'forsale.godaddy.com': 'GoDaddy / Afternic',
    'godaddy.com': 'GoDaddy',
    'afternic.com': 'Afternic',
    'dan.com': 'Dan.com',
    'sedo.com': 'Sedo',
    'sedoparking.com': 'Sedo',
    'bodis.com': 'Bodis',
    'hugedomains.com': 'HugeDomains',
    'atom.com': 'Atom',
    'squadhelp.com': 'Atom/Squadhelp',
    'brandbucket.com': 'BrandBucket',
    'sav.com': 'Sav.com',
    'parkingcrew.net': 'ParkingCrew',
}

# Small built-in famous-brand list for trademark-risk hint (not exhaustive; not legal advice).
# Short brands (<= 4 chars) only match as whole labels or hyphen-separated tokens.
FAMOUS_BRANDS = {
    'adobe', 'airbnb', 'airbus', 'alibaba', 'aliexpress', 'alphabet', 'amazon', 'amd',
    'amex', 'americanexpress', 'android', 'anthropic', 'apify', 'apple', 'atlassian',
    'audi', 'aws', 'baidu', 'bankofamerica', 'barclays', 'bbc', 'binance', 'bmw',
    'boeing', 'booking', 'bosch', 'box', 'burberry', 'bytedance', 'canva', 'cartier',
    'chanel', 'chase', 'chatgpt', 'chevron', 'cisco', 'citibank', 'claude', 'cloudflare',
    'cocacola', 'coca-cola', 'coinbase', 'costco', 'datadog', 'dell', 'dhl', 'discord',
    'disney', 'docker', 'dropbox', 'ebay', 'epicgames', 'ericsson', 'espn', 'etsy',
    'expedia', 'facebook', 'fedex', 'ferrari', 'figma', 'ford', 'fortinet', 'gemini',
    'github', 'gitlab', 'gmail', 'godaddy', 'google', 'gucci', 'heineken', 'hermes',
    'honda', 'hp', 'hsbc', 'huawei', 'hubspot', 'hyundai', 'ibm', 'icloud', 'ikea',
    'instagram', 'intel', 'intuit', 'iphone', 'jira', 'jpmorgan', 'kfc', 'kia',
    'kubernetes', 'lego', 'lenovo', 'levis', 'lg', 'linkedin', 'loreal', 'louisvuitton',
    'lyft', 'mastercard', 'mcdonalds', 'mercedes', 'meta', 'microsoft', 'morganstanley',
    'mozilla', 'nasa', 'netflix', 'nike', 'nintendo', 'nokia', 'notion', 'nvidia',
    'openai', 'oracle', 'palantir', 'paloalto', 'panasonic', 'paypal', 'pepsi',
    'pfizer', 'pinterest', 'playstation', 'porsche', 'prada', 'proton', 'qualcomm',
    'reddit', 'revolut', 'roblox', 'rolex', 'salesforce', 'samsung', 'sap', 'shopify',
    'siemens', 'signal', 'slack', 'snapchat', 'snowflake', 'sony', 'spacex', 'spotify',
    'squarespace', 'starbucks', 'steam', 'stripe', 'target', 'telegram', 'tesla',
    'tiktok', 'toyota', 'twitch', 'twitter', 'uber', 'unilever', 'ups', 'usps',
    'verisign', 'verizon', 'visa', 'volkswagen', 'volvo', 'walmart', 'wellsfargo',
    'whatsapp', 'wikipedia', 'wise', 'wix', 'wordpress', 'xbox', 'xiaomi', 'yahoo',
    'youtube', 'zara', 'zendesk', 'zoom',
}


def normalize_domain(raw: str) -> str | None:
    """Turn user input (URL, email, mixed case, IDN) into an ASCII domain, or None if invalid."""
    if not raw or not isinstance(raw, str):
        return None
    s = raw.strip().lower()
    s = re.sub(r'^[a-z][a-z0-9+.-]*://', '', s)
    s = s.split('@')[-1]
    s = re.split(r'[/?#:\s]', s)[0].strip('.')
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


def index_bootstrap(raw: dict) -> dict[str, str]:
    out: dict[str, str] = {}
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


def rdap_base_for(domain: str, bootstrap: dict[str, str]) -> str | None:
    """Find the RDAP base URL for a domain's TLD from the IANA bootstrap file (longest suffix match)."""
    labels = domain.split('.')
    for i in range(1, len(labels)):
        suffix = '.'.join(labels[i:])
        if suffix in bootstrap:
            return bootstrap[suffix]
    return None


def parse_rdap(j: dict, now: datetime | None = None) -> dict:
    now = now or datetime.now(timezone.utc)
    ev = {e.get('eventAction'): e.get('eventDate') for e in j.get('events', []) if isinstance(e, dict)}
    registrar = None
    for ent in j.get('entities', []) or []:
        if 'registrar' in (ent.get('roles') or []):
            vc = ent.get('vcardArray')
            if isinstance(vc, list) and len(vc) > 1:
                for f in vc[1]:
                    if isinstance(f, list) and len(f) >= 4 and f[0] == 'fn' and f[3]:
                        registrar = str(f[3]).strip()
                        break
                if not registrar:
                    for f in vc[1]:
                        if isinstance(f, list) and len(f) >= 4 and f[0] == 'org' and f[3]:
                            registrar = str(f[3]).strip()
                            break
            registrar = registrar or ent.get('handle')
            if registrar:
                break
    created = (ev.get('registration') or '')[:10] or None
    expiry = (ev.get('expiration') or '')[:10] or None
    age = None
    if created:
        try:
            dt = datetime.strptime(created, '%Y-%m-%d').replace(tzinfo=timezone.utc)
            age = round(max(0.0, (now - dt).days / 365.25), 2)
        except ValueError:
            created = None
    days_until_expiry = None
    if expiry:
        try:
            exp_dt = datetime.strptime(expiry, '%Y-%m-%d').replace(tzinfo=timezone.utc)
            days_until_expiry = (exp_dt.date() - now.date()).days
        except ValueError:
            expiry = None
    ns = [n.get('ldhName', '').lower().rstrip('.') for n in j.get('nameservers', []) or [] if n.get('ldhName')]
    return {
        'registrar': registrar,
        'createdDate': created,
        'expiryDate': expiry,
        'domainAgeYears': age,
        'daysUntilExpiry': days_until_expiry,
        'rdapStatus': j.get('status') or [],
        'rdapNameservers': ns,
    }


def detect_parked_ns(nameservers: list[str]) -> str | None:
    for ns in nameservers or []:
        for key, label in PARKING_NS.items():
            if ns == key or ns.endswith('.' + key):
                return label
    return None


def detect_ns_provider(nameservers: list[str]) -> str | None:
    if not nameservers:
        return None
    parked = detect_parked_ns(nameservers)
    if parked:
        return parked
    for ns in nameservers:
        for key, label in NS_PROVIDERS:
            if key.endswith('-') or key.endswith('.'):
                if key in ns:
                    return label
            elif ns == key or ns.endswith('.' + key):
                return label
    return 'Other / custom'


def unquote_txt(data: str) -> str:
    parts = re.findall(r'"((?:[^"\\]|\\.)*)"', data or '')
    return ''.join(parts) if parts else (data or '').strip('"')


def parse_mx(data_list: list[str]) -> list[dict]:
    out = []
    for d in data_list:
        bits = d.split()
        if len(bits) >= 2 and bits[0].isdigit() and bits[1].rstrip('.') != '':
            out.append({'priority': int(bits[0]), 'host': bits[1].rstrip('.').lower()})
    return sorted(out, key=lambda m: m['priority'])


def is_null_mx(data_list: list[str]) -> bool:
    return any(d.split()[1:2] == ['.'] for d in data_list if len(d.split()) >= 2)


def detect_email_provider(mx: list[dict], null_mx: bool = False) -> str | None:
    if null_mx:
        return 'Null MX (accepts no email)'
    for m in mx:
        for key, name in EMAIL_PROVIDERS:
            if m['host'] == key or m['host'].endswith('.' + key):
                return name
    return 'Other / self-hosted' if mx else None


def analyse_spf_basic(txts: list[str]) -> tuple[bool, str | None]:
    spfs = [t for t in txts if t.lower().startswith('v=spf1')]
    if not spfs:
        return False, None
    toks = spfs[0].split()[1:]
    allm = next((t for t in toks if re.match(r'^[+\-~?]?all$', t, re.I)), None)
    if allm:
        if allm[0] not in '+-~?':
            allm = '+' + allm
        return True, allm.lower()
    if any(t.lower().startswith('redirect=') for t in toks):
        return True, 'redirect'
    return True, None


def analyse_dmarc_basic(txts: list[str]) -> tuple[bool, str | None]:
    recs = [t for t in txts if t.lower().startswith('v=dmarc1')]
    if not recs:
        return False, None
    for part in recs[0].split(';'):
        if '=' in part:
            k, v = part.split('=', 1)
            if k.strip().lower() == 'p':
                pol = v.strip().lower()
                if pol in ('none', 'quarantine', 'reject'):
                    return True, pol
    return True, None


def extract_js_or_meta_redirect(html: str, base_url: str) -> str | None:
    """Detect lightweight JS location or meta-refresh landers (common on Afternic/GoDaddy parked pages)."""
    if not html or len(html) > 8000:
        return None
    m = re.search(r'<meta[^>]+http-equiv=["\']?refresh["\']?[^>]+content=["\'][^"\']*url=([^"\'>\s]+)', html, re.I)
    if m:
        return urljoin(base_url, html_lib.unescape(m.group(1).strip()))
    m = re.search(r'window\.location(?:\.href)?\s*=\s*["\']([^"\']+)["\']', html, re.I)
    if m:
        return urljoin(base_url, m.group(1).strip())
    return None


def _format_price(amount: str, currency: str | None = None) -> str:
    amt = amount.strip().rstrip('.')
    cur = (currency or '').upper()
    if cur == 'USD' or amount.strip().startswith('$'):
        return amt if amt.startswith('$') else f'${amt}'
    if cur == 'EUR' or amount.strip().startswith('€'):
        return amt if amt.startswith('€') else f'€{amt}'
    if cur == 'GBP' or amount.strip().startswith('£'):
        return amt if amt.startswith('£') else f'£{amt}'
    return f'{cur} {amt}'.strip() if cur else amt


def _extract_jsonld_offer_price(html: str) -> str | None:
    for m in re.finditer(r'<script[^>]+type=["\']application/ld\+json["\'][^>]*>(.*?)</script>', html, re.I | re.S):
        raw = m.group(1).strip()
        if not raw:
            continue
        try:
            data = json.loads(raw)
        except ValueError:
            continue
        objs = data if isinstance(data, list) else [data]
        for obj in objs:
            if not isinstance(obj, dict):
                continue
            offers = obj.get('offers')
            if isinstance(offers, dict):
                offers = [offers]
            if isinstance(offers, list):
                for off in offers:
                    if isinstance(off, dict) and off.get('price') not in (None, '', 0, '0'):
                        p = str(off['price'])
                        if re.match(r'^\d+(?:[.,]\d+)?$', p):
                            if '.' not in p and p.isdigit() and int(p) >= 1000:
                                p = f'{int(p):,}'
                            return _format_price(p, off.get('priceCurrency'))
    return None


def inspect_landing_html(final_url: str, html: str, domain: str) -> dict:
    """
    Inspect final URL and HTML for page title, marketplace/parked signals, and visible asking price.
    Only extracts an asking price when marketplace/for-sale evidence is present.
    """
    title = None
    m_title = re.search(r'<title[^>]*>(.*?)</title>', html or '', re.I | re.S)
    if m_title:
        title = re.sub(r'\s+', ' ', html_lib.unescape(m_title.group(1))).strip()[:200] or None

    meta_desc = ''
    m_desc = re.search(r'<meta[^>]+name=["\']description["\'][^>]+content=["\']([^"\']*)["\']', html or '', re.I)
    if not m_desc:
        m_desc = re.search(r'<meta[^>]+content=["\']([^"\']*)["\'][^>]+name=["\']description["\']', html or '', re.I)
    if m_desc:
        meta_desc = html_lib.unescape(m_desc.group(1))

    host = (urlparse(final_url).hostname or '').lower()
    host_no_www = host[4:] if host.startswith('www.') else host
    is_own_host = (host_no_www == domain or host_no_www.endswith('.' + domain))

    marketplace_name = None
    if not is_own_host:
        for key, name in MARKETPLACE_HOSTS.items():
            if host_no_www == key or host_no_www.endswith('.' + key):
                marketplace_name = name
                break

    snippet = f'{title or ""}\n{meta_desc}\n{(html or "")[:40000]}'
    lower = snippet.lower()

    for_sale_phrases = [
        'is for sale',
        'domain is for sale',
        'domain may be for sale',
        'buy this domain',
        'make an offer on this domain',
        'this domain is parked',
        'parked free, courtesy of',
        'sedoparking',
        'sedo domain parking',
        'hugedomains.com',
        'afternic.com',
        'dan.com',
        'bodis.com',
        'forsale.godaddy.com',
    ]
    matched_phrase = next((p for p in for_sale_phrases if p in lower), None)

    is_for_sale = bool(marketplace_name or matched_phrase)
    reason = None
    for_sale_url = None
    asking_price = None

    if marketplace_name:
        reason = f'Landing page redirects to {marketplace_name} ({host_no_www})'
        for_sale_url = final_url
    elif matched_phrase:
        reason = f'Landing page indicates parked/for-sale ("{matched_phrase}")'
        for_sale_url = final_url

    if is_for_sale:
        asking_price = _extract_jsonld_offer_price(html or '')
        if not asking_price:
            head_text = f'{title or ""} | {meta_desc}'
            pm = re.search(
                r'(?:buy(?:\s+now)?\s+for|for\s+sale[^$€£\d]{0,20}|own\s+it\s+today\s+for|price[:\s]+)'
                r'([\$€£]\s?\d[\d,]*(?:\.\d{2})?|(?:USD|EUR|GBP)\s?\d[\d,]*(?:\.\d{2})?)',
                head_text,
                re.I,
            )
            if not pm:
                pm = re.search(r'([\$€£]\s?\d[\d,]*(?:\.\d{2})?)', head_text)
            if pm:
                asking_price = re.sub(r'\s+', '', pm.group(1))

    return {
        'pageTitle': title,
        'pageForSale': is_for_sale,
        'pageReason': reason,
        'forSaleUrl': for_sale_url,
        'askingPrice': asking_price,
    }


def check_trademark_risk(domain: str) -> tuple[str, list[str], str]:
    """
    Honest, lightweight check against a small built-in list of famous brands.
    Never scrapes USPTO or claims legal completeness.
    """
    sld = domain.split('.')[0].lower()
    tokens = [t for t in sld.split('-') if t]
    exact_or_token = []
    substring_hits = []

    for brand in sorted(FAMOUS_BRANDS):
        clean_brand = brand.replace('-', '')
        if sld == brand or sld == clean_brand or brand in tokens or clean_brand in tokens:
            exact_or_token.append(brand)
        elif len(clean_brand) >= 5 and clean_brand in sld:
            substring_hits.append(brand)

    disclaimer = (
        'Automated check against a small built-in list of famous brands only; '
        'not a trademark search and not legal advice.'
    )
    if exact_or_token:
        return (
            'high',
            exact_or_token,
            f"Matches famous-brand token ({', '.join(exact_or_token)}). {disclaimer}",
        )
    if substring_hits:
        return (
            'possible',
            substring_hits,
            f"Contains famous-brand substring ({', '.join(substring_hits)}). {disclaimer}",
        )
    return ('none_detected', [], f'No match on built-in famous-brand list. {disclaimer}')


def compute_score_and_summary(row: dict) -> tuple[int, list[str], str]:
    """Compute a transparent 0-100 domain checkup score, reason list, and plain-English summary."""
    reasons: list[str] = []
    score = 0

    reg = row.get('registered')
    age = row.get('domainAgeYears')
    exp_days = row.get('daysUntilExpiry')
    parked = row.get('isParkedOrForSale')
    safety = row.get('safetyStatus')
    tm_risk = row.get('trademarkRisk')
    tm_matches = row.get('trademarkMatches') or []

    if reg is False:
        reasons.append('Domain is not registered (available)')
        if tm_risk in ('high', 'possible') and tm_matches:
            reasons.append(f"Trademark hint: contains famous-brand token ({', '.join(tm_matches)})")
        summary = f"{row['domain']} is not registered (available; confirmed via {row.get('rdapSource') or 'DNS'})"
        if tm_matches:
            summary += f" and matches famous-brand token '{tm_matches[0]}'"
        summary += ' (score 0/100).'
        return 0, reasons, summary

    if reg is True:
        score += 10
        reasons.append('Domain is registered (+10)')
    else:
        reasons.append('Registration status could not be confirmed (+0)')

    if age is not None:
        if age >= 10:
            score += 20
            reasons.append(f'Established domain age: {age} yrs (+20)')
        elif age >= 5:
            score += 15
            reasons.append(f'Mature domain age: {age} yrs (+15)')
        elif age >= 2:
            score += 10
            reasons.append(f'Moderate domain age: {age} yrs (+10)')
        elif age >= 1:
            score += 5
            reasons.append(f'Recent domain age: {age} yrs (+5)')
        else:
            reasons.append(f'Very young domain: {age} yrs (+0)')
    elif reg is True:
        reasons.append('Creation date unavailable from registry (+0)')

    if exp_days is not None:
        if exp_days >= 365:
            score += 5
            reasons.append(f'Expiry > 1 year away ({exp_days} days) (+5)')
        elif exp_days < 0:
            score -= 10
            reasons.append(f'Domain appears expired ({exp_days} days) (-10)')
        elif exp_days < 30:
            score -= 5
            reasons.append(f'Expires soon ({exp_days} days) (-5)')

    if row.get('hasNs'):
        score += 5
        reasons.append('Has active nameservers (+5)')
    else:
        reasons.append('No active nameservers (+0)')

    if row.get('hasA'):
        score += 5
        reasons.append('Resolves to IPv4 A record (+5)')

    if row.get('hasMx'):
        score += 5
        reasons.append('Has MX mail records (+5)')
    else:
        reasons.append('No MX mail records (+0)')

    if row.get('httpsValid') is True:
        score += 10
        reasons.append('Valid HTTPS website (+10)')
    elif row.get('httpStatus') is not None:
        score += 5
        reasons.append('HTTP responds without valid HTTPS (+5)')

    if parked:
        score -= 15
        reasons.append(f"Parked or listed for sale: {row.get('parkedOrForSaleReason')} (-15)")

    if row.get('hasSpf'):
        pol = row.get('spfPolicy')
        if pol in ('-all', '~all', 'redirect'):
            score += 10
            reasons.append(f'SPF configured ({pol}) (+10)')
        else:
            score += 5
            reasons.append(f"SPF present with weak/missing 'all' ({pol or 'none'}) (+5)")
    else:
        reasons.append('No SPF record (+0)')

    if row.get('hasDmarc'):
        dpol = row.get('dmarcPolicy')
        if dpol in ('reject', 'quarantine'):
            score += 10
            reasons.append(f'DMARC enforcing ({dpol}) (+10)')
        else:
            score += 5
            reasons.append(f"DMARC monitoring only ({dpol or 'unknown'}) (+5)")
    else:
        reasons.append('No DMARC record (+0)')

    if safety == 'not_flagged':
        score += 20
        reasons.append('Not flagged by Cloudflare Security DNS 1.1.1.2 (+20)')
    elif safety == 'flagged_malware_or_phishing':
        score -= 50
        reasons.append('Flagged by Cloudflare Security DNS 1.1.1.2 for malware/phishing (-50)')
    else:
        reasons.append('Safety not checked (+0)')

    if tm_risk == 'high':
        score -= 25
        reasons.append(f"Matches famous-brand token ({', '.join(tm_matches)}) (-25)")
    elif tm_risk == 'possible':
        score -= 10
        reasons.append(f"Contains famous-brand substring ({', '.join(tm_matches)}) (-10)")

    score = max(0, min(100, score))

    # Build one-line plain-English summary
    parts = []
    if reg is True:
        reg_bits = []
        if age is not None:
            reg_bits.append(f'{age} yrs old')
        if row.get('registrar'):
            reg_bits.append(row['registrar'])
        parts.append(f"registered ({', '.join(reg_bits)})" if reg_bits else 'registered')
    else:
        parts.append('status unknown')

    if parked:
        p_str = 'parked/for sale'
        if row.get('askingPrice'):
            p_str += f" ({row['askingPrice']})"
        parts.append(p_str)
    elif row.get('httpsValid'):
        parts.append('live HTTPS')
    elif row.get('hasA'):
        parts.append('resolves via A record')
    else:
        parts.append('no web host')

    if row.get('hasSpf') and row.get('hasDmarc'):
        parts.append('SPF & DMARC set')
    elif row.get('hasSpf') or row.get('hasDmarc'):
        parts.append('partial email auth')
    else:
        parts.append('no SPF/DMARC')

    if safety == 'flagged_malware_or_phishing':
        parts.append('FLAGGED by Cloudflare Security DNS')
    elif safety == 'not_flagged':
        parts.append('not flagged by Cloudflare Security DNS')
    else:
        parts.append('safety not checked')

    if tm_matches:
        parts.append(f"TM hint: {tm_matches[0]}")

    summary = f"{row['domain']} is " + ', '.join(parts) + f' (score {score}/100).'
    return score, reasons, summary
