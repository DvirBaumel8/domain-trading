"""Pure logic for the Broken Link Auditor."""
from __future__ import annotations

import gzip
import re
from html.parser import HTMLParser
from urllib.parse import urldefrag, urljoin, urlsplit, urlunsplit
from urllib.robotparser import RobotFileParser

from defusedxml import ElementTree as ET
from defusedxml.common import DefusedXmlException

UA = "BrokenLinkAuditor/0.1 (Apify actor; polite)"
ROBOT_TOKEN = "BrokenLinkAuditor"
MAX_REDIRECTS = 10
MAX_SOURCES = 20


def normalize_url(raw, base: str | None = None) -> str | None:
    """Absolute http(s) URL without fragment, lowercase scheme and host. None for anything else."""
    if not isinstance(raw, str) or not raw.strip():
        return None
    s = raw.strip()
    if re.match(r"(?i)(mailto|tel|javascript|data|sms):", s):
        return None
    if base is None and "://" not in s:
        s = "https://" + s
    try:
        u = urldefrag(urljoin(base, s) if base else s)[0]
        p = urlsplit(u)
    except ValueError:
        return None
    if p.scheme.lower() not in ("http", "https") or not p.hostname:
        return None
    if re.search(r"[\s<>\"{}|\\^`]", p.hostname) or p.hostname.startswith(".") or ".." in p.hostname:
        return None  # "not a url" must not become https://not a url/
    path = p.path or "/"
    return urlunsplit((p.scheme.lower(), p.netloc.lower(), path, p.query, ""))


def host_key(url: str) -> str:
    h = (urlsplit(url).hostname or "").lower()
    return h[4:] if h.startswith("www.") else h


def same_site(a: str, b: str) -> bool:
    return host_key(a) == host_key(b)


def origin(url: str) -> str:
    p = urlsplit(url)
    return f"{p.scheme}://{p.netloc}"


def robots_allows(parser: RobotFileParser | None, url: str) -> bool:
    return True if parser is None else parser.can_fetch(ROBOT_TOKEN, url)


def parse_robots(text: str) -> RobotFileParser:
    p = RobotFileParser()
    p.parse(text.splitlines())
    return p


def robots_sitemaps(text: str, root: str) -> list[str]:
    out = []
    for line in text.splitlines():
        m = re.match(r"\s*sitemap\s*:\s*(\S+)", line, re.I)
        if m:
            u = normalize_url(m.group(1), root + "/")
            if u:
                out.append(u)
    return out


class _Links(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.links: list[tuple[str, str]] = []
        self._href, self._text = None, []

    def handle_starttag(self, tag, attrs):
        if tag == "a":
            self._flush()
            self._href, self._text = dict(attrs).get("href"), []

    def handle_data(self, data):
        if self._href is not None:
            self._text.append(data)

    def handle_endtag(self, tag):
        if tag == "a":
            self._flush()

    def _flush(self):
        if self._href:
            self.links.append((self._href, " ".join("".join(self._text).split())[:200]))
        self._href = None


def extract_links(html: str, base: str) -> list[tuple[str, str]]:
    """[(absolute url, anchor text)] for every http(s) <a href>."""
    p = _Links()
    try:
        p.feed(html)
        p.close()
    except Exception:  # noqa: BLE001 - broken HTML must not stop the audit
        pass
    p._flush()
    out = []
    for href, text in p.links:
        u = normalize_url(href, base)
        if u:
            out.append((u, text))
    return out


def parse_sitemap(body: bytes) -> tuple[str, list[str]]:
    """('index'|'urlset'|'invalid', urls). Handles gz, nested indexes and plain-text sitemaps."""
    if body[:2] == b"\x1f\x8b":
        try:
            body = gzip.decompress(body)[: 60 * 1024 * 1024]
        except (OSError, EOFError):
            return "invalid", []
    head = body.lstrip()[:1]
    if head != b"<":
        urls = [u for u in (normalize_url(l) for l in body.decode("utf-8", "ignore").splitlines() if l.strip().startswith("http")) if u]
        return ("urlset", urls) if urls else ("invalid", [])
    try:
        root = ET.fromstring(body)
    except (ET.ParseError, DefusedXmlException):
        return "invalid", []
    tag = root.tag.rsplit("}", 1)[-1]
    locs = [(e.text or "").strip() for e in root.iter() if e.tag.rsplit("}", 1)[-1] == "loc"]
    urls = [u for u in (normalize_url(l) for l in locs) if u]
    if tag == "sitemapindex":
        return "index", urls
    return ("urlset", urls) if tag == "urlset" else ("invalid", [])


def categorize(status: int | None, chain: list, loop: bool) -> str:
    if loop or status is None:
        return "error"
    if status >= 500:
        return "5xx"
    if status >= 400:
        return "4xx"
    return "redirect" if chain else "ok"


def chargeable(row: dict) -> bool:
    """An HTTP answer or a redirect loop is a finding. DNS failures, timeouts and robots skips are not charged."""
    if row.get("category") == "robots_blocked":
        return False
    return row.get("statusCode") is not None or bool(row.get("redirectLoop"))
