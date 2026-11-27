"""Input checks and normalisation (spec §2). No network here."""
from __future__ import annotations

import re
from dataclasses import dataclass, field
from datetime import date
from urllib.parse import urlsplit, urlunsplit

ADDONS = ("summary", "chapters", "keyQuotes")
FORMATS = ("txt", "srt", "vtt", "json")
BARE_HOST = re.compile(r"^[A-Za-z0-9.-]+\.[A-Za-z]{2,}(?::\d+)?(?:[/?#].*)?$")


class InputError(Exception):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code, self.message = code, message


@dataclass
class Options:
    sources: list[str]
    invalid: list[dict] = field(default_factory=list)
    max_episodes: int = 3
    published_after: date | None = None
    language: str = "auto"
    prefer_publisher: bool = True
    addons: list[str] = field(default_factory=list)
    speakers: bool = False
    words: bool = False
    formats: list[str] = field(default_factory=lambda: ["txt", "srt"])
    max_episode_minutes: int = 240
    max_total_minutes: int = 600
    stall_seconds: int = 30
    episode_timeout_minutes: int = 45


def normalise_url(line: str) -> str | None:
    s = line.strip()
    if not s:
        return None
    if "://" not in s:
        if s.lower().startswith(("javascript:", "data:", "mailto:", "file:")) or " " in s or not BARE_HOST.match(s):
            return None
        s = "https://" + s
    p = urlsplit(s)
    if p.scheme.lower() not in ("http", "https") or not p.hostname:
        return None
    return urlunsplit((p.scheme.lower(), p.netloc.lower(), p.path or "/", p.query, ""))


def _int(raw: dict, name: str, default: int, lo: int, hi: int) -> int:
    v = raw.get(name, default)
    if v is None:
        return default
    if isinstance(v, bool) or not isinstance(v, int):
        raise InputError("invalid_input", f"{name} must be a whole number between {lo} and {hi}.")
    return max(lo, min(hi, v))


def parse(raw: dict) -> Options:
    """Raises InputError for an empty source list or missing rights confirmation (no network has happened yet)."""
    lines = raw.get("sources") or []
    if isinstance(lines, str):
        lines = lines.splitlines()
    lines = [str(x) for x in lines if str(x).strip()]
    if not lines:
        raise InputError("no_sources", "Add at least one source: a podcast RSS feed, an Apple Podcasts link or an audio file URL.")
    if raw.get("confirmRights") is not True:
        raise InputError("rights_not_confirmed", "Tick 'confirmRights' to confirm you may transcribe these recordings.")
    seen, sources, invalid = set(), [], []
    for line in lines:
        url = normalise_url(line)
        if url is None:
            invalid.append({"input": line.strip()[:300], "reason": "Not an http or https URL."})
            continue
        if url not in seen:
            seen.add(url)
            sources.append(url)
    after = None
    if raw.get("publishedAfter"):
        try:
            after = date.fromisoformat(str(raw["publishedAfter"]).strip())
        except ValueError:
            raise InputError("invalid_input", "publishedAfter must be a date like 2026-01-31.") from None
    lang = str(raw.get("language") or "auto").strip().lower()
    if lang != "auto" and not re.fullmatch(r"[a-z]{2}", lang):
        raise InputError("invalid_input", "language must be 'auto' or a two-letter ISO 639-1 code.")
    addons = [a for a in (raw.get("addOns") or []) if a in ADDONS]
    formats = [f for f in (raw.get("outputFormats") or ["txt", "srt"]) if f in FORMATS] or ["txt", "srt"]
    return Options(
        sources=sources, invalid=invalid,
        max_episodes=_int(raw, "maxEpisodesPerFeed", 3, 1, 100), published_after=after, language=lang,
        prefer_publisher=raw.get("preferPublisherTranscript", True) is not False, addons=list(dict.fromkeys(addons)),
        speakers=raw.get("speakerLabels") is True, words=raw.get("wordTimestamps") is True, formats=list(dict.fromkeys(formats)),
        max_episode_minutes=_int(raw, "maxAudioMinutesPerEpisode", 240, 1, 600),
        max_total_minutes=_int(raw, "maxTotalAudioMinutes", 600, 1, 6000),
        stall_seconds=_int(raw, "downloadStallSeconds", 30, 5, 120),
        episode_timeout_minutes=_int(raw, "episodeTimeoutMinutes", 45, 5, 180),
    )
