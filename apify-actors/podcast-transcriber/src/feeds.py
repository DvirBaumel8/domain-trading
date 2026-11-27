"""Resolve a source: RSS/Atom feed (streamed, safe parser), Apple Podcasts link (feed lookup only) or direct file (spec §4.1-§4.2)."""
from __future__ import annotations

import json
import re
import xml.etree.ElementTree as ET
from dataclasses import dataclass, field
from datetime import date, datetime, timezone
from email.utils import parsedate_to_datetime
from urllib.parse import parse_qs, urljoin, urlsplit

from defusedxml import DefusedXmlException
from defusedxml.ElementTree import DefusedXMLParser

from . import config
from .net import Net, SourceError

MEDIA_EXT = (".mp3", ".m4a", ".aac", ".wav", ".ogg", ".oga", ".opus", ".flac", ".mp4", ".m4v", ".webm", ".mov", ".m4p")
APPLE = re.compile(r"^https?://podcasts\.apple\.com/(?:[a-z]{2}/)?podcast/(?:[^/]+/)?id(\d+)", re.I)
TRANSCRIPT_PREF = {"text/vtt": 0, "application/x-subrip": 1, "application/srt": 1, "text/srt": 1, "application/json": 2, "text/plain": 3}


@dataclass
class Episode:
    source: str
    audio_url: str | None
    title: str | None = None
    guid: str | None = None
    url: str | None = None
    published: datetime | None = None
    transcripts: list[dict] = field(default_factory=list)
    license: str | None = None
    feed_url: str | None = None
    feed_title: str | None = None
    position: int = 0


@dataclass
class Feed:
    url: str
    title: str | None
    language_tag: str | None
    episodes: list[Episode]


def local(tag: str) -> str:
    return tag.rsplit("}", 1)[-1] if isinstance(tag, str) else ""


def ns(tag: str) -> str:
    return tag[1:].split("}", 1)[0] if isinstance(tag, str) and tag.startswith("{") else ""


def parse_date(text: str | None) -> datetime | None:
    if not text or not text.strip():
        return None
    t = text.strip()
    try:
        d = parsedate_to_datetime(t)
    except (TypeError, ValueError, IndexError):
        d = None
    if d is None:
        try:
            d = datetime.fromisoformat(t.replace("Z", "+00:00"))
        except ValueError:
            return None
    return d if d.tzinfo else d.replace(tzinfo=timezone.utc)


def is_media_url(url: str) -> bool:
    return urlsplit(url).path.lower().endswith(MEDIA_EXT)


class FeedParser:
    """Incremental: elements are dropped as soon as each item is read, so a 20 MB feed is never held as a tree."""

    def __init__(self, base_url: str):
        self.base = base_url
        self.pull = ET.XMLPullParser(events=("start", "end"), _parser=DefusedXMLParser(target=ET.TreeBuilder(), forbid_dtd=False))
        self.items: list[Episode] = []
        self.title: str | None = None
        self.language: str | None = None
        self.root: str | None = None
        self.depth = 0
        self.stack: list[ET.Element] = []

    def feed(self, data: bytes) -> None:
        try:
            self.pull.feed(data)
            self._drain()
        except DefusedXmlException:
            raise SourceError("feed_parse_error", "The feed uses XML entities or a DTD that are not allowed.") from None
        except ET.ParseError:
            raise SourceError("feed_parse_error", "The feed is not valid XML.") from None

    def close(self) -> None:
        try:
            self.pull.close()
            self._drain()
        except DefusedXmlException:
            raise SourceError("feed_parse_error", "The feed uses XML entities or a DTD that are not allowed.") from None
        except ET.ParseError:
            raise SourceError("feed_parse_error", "The feed is not valid XML (it may be cut off).") from None

    def _drain(self) -> None:
        for event, el in self.pull.read_events():
            name = local(el.tag)
            if event == "start":
                if self.root is None:
                    self.root = name
                    if name not in ("rss", "feed", "RDF"):
                        raise SourceError("not_a_feed", "The URL does not return an RSS or Atom feed.")
                self.stack.append(el)
                continue
            self.stack.pop()
            parent = local(self.stack[-1].tag) if self.stack else ""
            if name in ("item", "entry"):
                self.items.append(self._item(el, len(self.items)))
                el.clear()
                if self.stack:
                    try:
                        self.stack[-1].remove(el)
                    except ValueError:
                        pass
            elif parent in ("channel", "feed") and name == "title" and self.title is None:
                self.title = (el.text or "").strip() or None
            elif parent in ("channel", "feed") and name == "language" and self.language is None:
                self.language = (el.text or "").strip() or None

    def _item(self, el: ET.Element, pos: int) -> Episode:
        title = guid = link = date_text = lic = None
        audio = None
        transcripts = []
        for c in el:
            n, space = local(c.tag), ns(c.tag)
            if n == "title" and title is None and not space.endswith("itunes.com/dtds/podcast-1.0.dtd"):
                title = (c.text or "").strip() or None
            elif n in ("guid", "id") and guid is None:
                guid = (c.text or "").strip() or None
            elif n == "link" and not space.startswith("http://www.w3.org/2005/Atom") and c.text:
                link = link or c.text.strip()
            elif n in ("pubDate", "published", "updated") and date_text is None:
                date_text = c.text
            elif n == "enclosure" and audio is None:
                t = (c.get("type") or "").lower()
                if c.get("url") and (t.startswith(("audio/", "video/")) or (not t and is_media_url(c.get("url")))):
                    audio = urljoin(self.base, c.get("url").strip())
            elif n == "link" and c.get("rel") == "enclosure" and audio is None:
                t = (c.get("type") or "").lower()
                if c.get("href") and (t.startswith(("audio/", "video/")) or not t):
                    audio = urljoin(self.base, c.get("href").strip())
            elif n == "link" and c.get("href") and c.get("rel", "alternate") == "alternate":
                link = link or c.get("href")
            elif n == "transcript" and "podcastindex" in space and c.get("url"):
                transcripts.append({"url": urljoin(self.base, c.get("url").strip()), "type": (c.get("type") or "").lower(),
                                    "rel": c.get("rel"), "language": c.get("language")})
            elif n == "license" and "podcastindex" in space:
                lic = (c.text or "").strip() or c.get("url")
        return Episode(source=self.base, audio_url=audio, title=title, guid=guid, url=link, published=parse_date(date_text),
                       transcripts=transcripts, license=lic, position=pos)


async def fetch_feed(net: Net, url: str, first: bytes | None = None, response=None) -> Feed:
    """Stream the feed into the incremental parser; stop at 40 MB without reading the rest."""

    async def consume(r, first_chunk: bytes | None):
        if r.status_code >= 400:
            raise SourceError(f"feed_http_{r.status_code}", f"The feed URL answered HTTP {r.status_code}.")
        p, total = FeedParser(getattr(r, "final_url", url)), 0
        started = False
        if first_chunk is not None:
            chunks = [first_chunk]
        else:
            chunks = []
        async def it():
            for c in chunks:
                yield c
            async for c in r.aiter_bytes():
                yield c
        async for chunk in it():
            total += len(chunk)
            if total > config.FEED_CAP_BYTES:
                raise SourceError("feed_too_large", "The feed is larger than 40 MB.")
            if not started:
                head = chunk.lstrip()[:512].lower()
                if head.startswith(b"<!doctype html") or head.startswith(b"<html"):
                    raise SourceError("not_a_feed", "The URL returns a web page, not an RSS feed. Paste the feed URL itself.")
                started = bool(chunk.strip())
            p.feed(chunk)
        if not started:
            raise SourceError("not_a_feed", "The URL returned an empty answer.")
        p.close()
        return p

    if response is not None:
        p = await consume(response, first)
    else:
        async with net.stream(url) as r:
            p = await consume(r, None)
    eps = p.items
    for e in eps:
        e.feed_url, e.feed_title, e.source = url, p.title, url
    return Feed(url=url, title=p.title, language_tag=p.language, episodes=eps)


def pick(episodes: list[Episode], max_n: int, after: date | None) -> list[Episode]:
    """Newest first by pubDate when every item has a date; otherwise feed order. Filters run before any download."""
    eps = [e for e in episodes if e.audio_url or e.transcripts]
    if after:
        eps = [e for e in eps if e.published is None or e.published.date() >= after]
    if eps and all(e.published for e in eps):
        eps = sorted(eps, key=lambda e: (-e.published.timestamp(), e.position))
    return eps[:max_n]


def best_transcript(ep: Episode) -> dict | None:
    cands = [t for t in ep.transcripts if t["type"] in TRANSCRIPT_PREF]
    return min(cands, key=lambda t: TRANSCRIPT_PREF[t["type"]]) if cands else None


class AppleResolver:
    """One iTunes lookup per show, cached; nothing else from Apple is used."""

    def __init__(self, net: Net):
        self.net = net
        self.cache: dict[str, dict] = {}

    async def lookup(self, show_id: str, with_episodes: bool) -> dict:
        if show_id in self.cache:
            return self.cache[show_id]
        await self.net.apple.wait()
        entity = "podcastEpisode&limit=200" if with_episodes else "podcast"
        _r, body = await self.net.get_bytes(f"https://itunes.apple.com/lookup?id={show_id}&entity={entity}", config.LOOKUP_CAP_BYTES)
        try:
            data = json.loads(body)
        except ValueError:
            raise SourceError("apple_lookup_failed", "The Apple Podcasts lookup did not answer.") from None
        self.cache[show_id] = data
        return data

    async def resolve(self, url: str) -> tuple[str, dict | None]:
        m = APPLE.match(url)
        if not m:
            raise SourceError("invalid_input", "Not an Apple Podcasts show link.")
        track = (parse_qs(urlsplit(url).query).get("i") or [None])[0]
        data = await self.lookup(m.group(1), bool(track))
        results = data.get("results") or []
        feed = next((r.get("feedUrl") for r in results if r.get("feedUrl")), None)
        if not feed:
            raise SourceError("apple_no_feed", "Apple Podcasts lists no public RSS feed for this show.")
        hint = None
        if track:
            ep = next((r for r in results if str(r.get("trackId")) == str(track)), None)
            hint = {"url": ep.get("episodeUrl"), "title": ep.get("trackName"), "guid": ep.get("episodeGuid")} if ep else {"missing": True}
        return feed, hint


def match_hint(episodes: list[Episode], hint: dict) -> list[Episode]:
    """The episode an Apple `?i=` link points at: by guid, then enclosure URL, then exact title."""
    if hint.get("missing"):
        return []
    for key, attr in (("guid", "guid"), ("url", "audio_url"), ("title", "title")):
        want = hint.get(key)
        if want:
            hit = [e for e in episodes if getattr(e, attr) == want]
            if hit:
                return hit[:1]
    return []
