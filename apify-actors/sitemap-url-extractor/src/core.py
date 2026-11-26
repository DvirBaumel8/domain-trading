"""Sitemap parsing helpers (pure, testable)."""
from __future__ import annotations
import gzip
import re
from urllib.parse import urlparse, urljoin

from defusedxml import ElementTree as ET

COMMON_PATHS = ['/sitemap.xml', '/sitemap_index.xml', '/sitemap-index.xml', '/wp-sitemap.xml', '/sitemap/sitemap.xml']


def site_root(url: str) -> str:
    if not re.match(r'^https?://', url, re.I):
        url = 'https://' + url.strip()
    p = urlparse(url)
    return f'{p.scheme}://{p.netloc}'


def looks_like_sitemap(url: str) -> bool:
    path = urlparse(url if '://' in url else 'https://' + url).path.lower()
    return path.endswith(('.xml', '.xml.gz', '.gz')) or 'sitemap' in path


def sitemaps_from_robots(text: str, base: str) -> list[str]:
    out = []
    for line in (text or '').splitlines():
        m = re.match(r'^\s*sitemap\s*:\s*(\S+)', line, re.I)
        if m:
            out.append(urljoin(base + '/', m.group(1).strip()))
    return list(dict.fromkeys(out))


def maybe_gunzip(content: bytes) -> bytes:
    if content[:2] == b'\x1f\x8b':
        return gzip.decompress(content)
    return content


def _local(tag: str) -> str:
    return tag.rsplit('}', 1)[-1].lower() if isinstance(tag, str) else ''


def parse_sitemap(content: bytes):
    """Return ('index', [sitemap urls]) or ('urlset', [entries]) or ('text', [urls]) or ('invalid', [])."""
    content = maybe_gunzip(content)
    head = content[:1000].lstrip()
    if not head.startswith(b'<'):
        # plain-text sitemap: one URL per line
        urls = [l.strip() for l in content.decode('utf-8', 'ignore').splitlines() if re.match(r'^https?://', l.strip())]
        return ('text', [{'url': u} for u in urls]) if urls else ('invalid', [])
    try:
        root = ET.fromstring(content)
    except Exception:
        return 'invalid', []
    kind = _local(root.tag)
    if kind == 'sitemapindex':
        locs = []
        for sm in root:
            for c in sm:
                if _local(c.tag) == 'loc' and c.text:
                    locs.append(c.text.strip())
        return 'index', locs
    if kind == 'urlset':
        entries = []
        for u in root:
            if _local(u.tag) != 'url':
                continue
            e = {'url': None, 'lastmod': None, 'changefreq': None, 'priority': None, 'imageCount': 0, 'hreflang': []}
            for c in u:
                t = _local(c.tag)
                if t == 'loc' and c.text:
                    e['url'] = c.text.strip()
                elif t == 'lastmod' and c.text:
                    e['lastmod'] = c.text.strip()
                elif t == 'changefreq' and c.text:
                    e['changefreq'] = c.text.strip()
                elif t == 'priority' and c.text:
                    try:
                        e['priority'] = float(c.text.strip())
                    except ValueError:
                        pass
                elif t == 'image':
                    e['imageCount'] += 1
                elif t == 'link' and c.get('rel') == 'alternate' and c.get('href'):
                    e['hreflang'].append({'lang': c.get('hreflang'), 'url': c.get('href')})
            if e['url']:
                entries.append(e)
        return 'urlset', entries
    if kind in ('rss', 'feed'):
        urls = []
        for el in root.iter():
            t = _local(el.tag)
            if t == 'link':
                href = el.get('href') or (el.text or '').strip()
                if href.startswith('http'):
                    urls.append({'url': href})
        return 'text', urls
    return 'invalid', []


def passes_filters(entry: dict, include: re.Pattern | None, exclude: re.Pattern | None, since: str | None) -> bool:
    u = entry['url']
    if include and not include.search(u):
        return False
    if exclude and exclude.search(u):
        return False
    if since:
        lm = (entry.get('lastmod') or '')[:10]
        if not lm or lm < since:
            return False
    return True


def normalize_start(raw) -> str | None:
    """A start URL or bare host as https/http URL text, or None when it cannot be a website or sitemap address."""
    if not isinstance(raw, str):
        return None
    s = raw.strip()
    if not s or re.search(r'\s', s):
        return None
    if '://' not in s:
        if re.match(r'^[a-z][a-z0-9+.-]*:', s, re.I) and not re.match(r'^[^/]*\.[^/]*:\d+(/|$)', s):
            return None  # mailto:, javascript:, data: ...
        s = 'https://' + s
    p = urlparse(s)
    host = p.hostname or ''
    if p.scheme.lower() not in ('http', 'https') or not re.fullmatch(r'[a-z0-9-]+(\.[a-z0-9-]+)+|\[[0-9a-f:.]+\]', host.lower().rstrip('.')):
        return None
    return s


def valid_modified_since(text: str) -> bool:
    """Empty is fine; otherwise YYYY-MM-DD or a full ISO date-time."""
    from datetime import datetime
    t = (text or '').strip()
    if not t:
        return True
    if not re.match(r'^\d{4}-\d{2}-\d{2}', t):
        return False
    try:
        datetime.fromisoformat(t[:10] if len(t) == 10 else t.replace('Z', '+00:00'))
    except ValueError:
        return False
    return True


def failure_reason(exc: BaseException) -> str:
    """Plain words for a failed request, never the URL."""
    import socket
    import ssl
    chain, e = [], exc
    while e is not None and e not in chain:
        chain.append(e)
        e = e.__cause__ or e.__context__
    text = ' '.join(str(c).lower() for c in chain)
    if any(isinstance(c, socket.gaierror) for c in chain) or any(h in text for h in ('name or service not known', 'nodename nor servname', 'name resolution', 'no address associated', 'getaddrinfo')):
        return 'dns lookup failed'
    if any(isinstance(c, ssl.SSLError) for c in chain):
        return 'tls error'
    if any(isinstance(c, ConnectionRefusedError) for c in chain):
        return 'connection refused'
    if any(isinstance(c, ConnectionResetError) for c in chain):
        return 'connection reset'
    if 'timeout' in type(exc).__name__.lower():
        return 'timeout'
    return type(exc).__name__
