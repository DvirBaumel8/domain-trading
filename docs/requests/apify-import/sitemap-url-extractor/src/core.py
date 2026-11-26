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
