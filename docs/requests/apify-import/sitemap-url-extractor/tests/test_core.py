import gzip, re, sys, pathlib
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))
from src.core import parse_sitemap, sitemaps_from_robots, site_root, looks_like_sitemap, passes_filters

URLSET = b'''<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:image="http://www.google.com/schemas/sitemap-image/1.1" xmlns:xhtml="http://www.w3.org/1999/xhtml">
<url><loc>https://ex.com/a</loc><lastmod>2026-11-01</lastmod><changefreq>daily</changefreq><priority>0.8</priority>
<image:image><image:loc>https://ex.com/i.png</image:loc></image:image>
<xhtml:link rel="alternate" hreflang="de" href="https://ex.com/de/a"/></url>
<url><loc>https://ex.com/blog/b</loc><lastmod>2025-01-01T10:00:00+00:00</lastmod></url>
</urlset>'''
INDEX = b'<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><sitemap><loc>https://ex.com/s1.xml</loc></sitemap><sitemap><loc>https://ex.com/s2.xml.gz</loc></sitemap></sitemapindex>'

def test_urlset():
    kind, e = parse_sitemap(URLSET)
    assert kind == 'urlset' and len(e) == 2
    assert e[0]['priority'] == 0.8 and e[0]['imageCount'] == 1 and e[0]['hreflang'][0]['lang'] == 'de'

def test_index_and_gzip():
    assert parse_sitemap(INDEX) == ('index', ['https://ex.com/s1.xml', 'https://ex.com/s2.xml.gz'])
    assert parse_sitemap(gzip.compress(URLSET))[0] == 'urlset'

def test_text_and_invalid():
    assert parse_sitemap(b'https://a.com/x\nhttps://a.com/y\n')[1][1]['url'] == 'https://a.com/y'
    assert parse_sitemap(b'<html><body>nope</body></html>')[0] == 'invalid'
    # XML bomb / entity expansion must be rejected safely
    bomb = b'<?xml version="1.0"?><!DOCTYPE l [<!ENTITY a "aaaa"><!ENTITY b "&a;&a;&a;">]><urlset><url><loc>&b;</loc></url></urlset>'
    assert parse_sitemap(bomb)[0] == 'invalid'

def test_robots_and_helpers():
    r = 'User-agent: *\nDisallow: /x\nSitemap: https://ex.com/sitemap.xml\nsitemap: /news.xml\n'
    assert sitemaps_from_robots(r, 'https://ex.com') == ['https://ex.com/sitemap.xml', 'https://ex.com/news.xml']
    assert site_root('ex.com/path') == 'https://ex.com'
    assert looks_like_sitemap('https://ex.com/sitemap.xml') and not looks_like_sitemap('https://ex.com/')

def test_filters():
    e = {'url': 'https://ex.com/blog/b', 'lastmod': '2025-01-01T10:00:00+00:00'}
    assert passes_filters(e, re.compile('/blog/'), None, None)
    assert not passes_filters(e, None, re.compile('blog'), None)
    assert not passes_filters(e, None, None, '2026-01-01') and passes_filters(e, None, None, '2024-12-31')
