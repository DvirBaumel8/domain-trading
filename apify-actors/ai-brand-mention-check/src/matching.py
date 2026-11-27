"""Deterministic brand matching. No AI decides whether a brand is mentioned.

Common-word list: `src/data/common_words.txt`, the 20,000 most frequent English words (lower-case letters only) taken from
the `wordfreq` package, version 3.x (https://github.com/rspeer/wordfreq) on 2026-11-26. Its code is Apache-2.0 and its word
data is licensed CC BY-SA 4.0 (attribution: Robyn Speer / wordfreq contributors; derived from public text corpora). The list
is used only to decide whether a one-word brand is also an everyday word. Share it under the same licence.

Rules (CR-134):
1. Names are the brand plus its aliases. Text is NFKC-normalised and zero-width characters are removed. Match on word
   boundaries.
2. A name matches case-insensitively when it has two or more words, contains a digit, dot or hyphen, or is not an ordinary
   English word.
3. An ambiguous name (one word that is also a common word) matches only an occurrence that is case-exact as typed AND sits
   in a structured spot (bold, list item, heading, table cell) or the brand's domain appears in the text or in a cited URL.
4. `brand_cited`: a cited URL whose host is the domain or a subdomain of it.
"""
from __future__ import annotations

import re
import unicodedata
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path
from urllib.parse import urlsplit

ZERO_WIDTH = dict.fromkeys(map(ord, "\u200b\u200c\u200d\u200e\u200f\u2060\u2061\u2062\u2063\ufeff\u00ad"))
WORDS_FILE = Path(__file__).parent / "data" / "common_words.txt"
SNIPPET_MAX = 300
LIST_LINE = re.compile(r"^\s*(?:[-*+•]\s+|\d{1,3}[.)]\s+|#{1,6}\s+|\|)")
BOLD = re.compile(r"(\*\*|__)(.+?)\1")


def clean(text: str) -> str:
    """NFKC and no zero-width characters. Everything downstream works on this form."""
    return unicodedata.normalize("NFKC", text or "").translate(ZERO_WIDTH)


def collapse(text: str) -> str:
    return " ".join(clean(text).split())


@lru_cache(maxsize=1)
def common_words() -> frozenset[str]:
    return frozenset(WORDS_FILE.read_text(encoding="utf-8").split())


@dataclass(frozen=True)
class Name:
    text: str
    ambiguous: bool
    pattern: re.Pattern

    @classmethod
    def build(cls, raw: str) -> "Name":
        text = collapse(raw)
        single = len(text.split()) == 1
        plain = single and not re.search(r"[\d.\-]", text)
        ambiguous = plain and text.lower() in common_words()
        body = r"\s+".join(re.escape(part) for part in text.split())
        flags = 0 if ambiguous else re.IGNORECASE
        return cls(text, ambiguous, re.compile(rf"(?<!\w){body}(?!\w)", flags))


def build_names(brand: str, aliases: list[str] | None = None) -> list[Name]:
    seen, names = set(), []
    for raw in [brand, *(aliases or [])]:
        n = Name.build(raw)
        if n.text and n.text not in seen:
            seen.add(n.text)
            names.append(n)
    return names


def host_matches(host: str, domain: str) -> bool:
    host = host.lower().rstrip(".")
    return bool(domain) and (host == domain or host.endswith("." + domain))


def url_host(url: str) -> str:
    try:
        return (urlsplit(url).hostname or "").lower()
    except ValueError:
        return ""


def brand_cited(urls: list[str], domain: str | None) -> bool:
    return bool(domain) and any(host_matches(url_host(u), domain) for u in urls)


def domain_in_text(text: str, domain: str | None) -> bool:
    return bool(domain) and re.search(rf"(?<![\w-]){re.escape(domain)}(?![\w-])", text, re.IGNORECASE) is not None


def _line_bounds(text: str, pos: int) -> tuple[int, int]:
    start = text.rfind("\n", 0, pos) + 1
    end = text.find("\n", pos)
    return start, len(text) if end < 0 else end


def is_structured(text: str, start: int, end: int) -> bool:
    """Is the occurrence in a list item, heading, table row or bold span?"""
    ls, le = _line_bounds(text, start)
    line = text[ls:le]
    if LIST_LINE.match(line):
        return True
    return any(m.start(2) + ls <= start and end <= m.end(2) + ls for m in BOLD.finditer(line))


@dataclass
class Mention:
    mentioned: bool
    mention_type: str          # listed | prose | none
    snippet: str | None


def _snippet(text: str, start: int, end: int, pattern: re.Pattern) -> str:
    ls, le = _line_bounds(text, start)
    line = " ".join(text[ls:le].split())
    if len(line) <= SNIPPET_MAX:
        return line
    m = pattern.search(line)
    at = m.start() if m else 0
    lo = max(0, min(at - (SNIPPET_MAX - (m.end() - at if m else 0)) // 2, len(line) - SNIPPET_MAX))
    return line[lo:lo + SNIPPET_MAX].strip()


def find_mention(text: str, names: list[Name], domain: str | None, cited_urls: list[str]) -> Mention:
    """Decide `mentioned` from the answer text with the rules above. `text` must already be `clean`."""
    domain_seen = domain_in_text(text, domain) or brand_cited(cited_urls, domain)
    first = None
    structured = False
    for name in names:
        for m in name.pattern.finditer(text):
            inside = is_structured(text, m.start(), m.end())
            if name.ambiguous and not (inside or domain_seen):
                continue
            if first is None or m.start() < first[0]:
                first = (m.start(), m.end(), name)
            structured = structured or inside
    if first is None:
        return Mention(False, "none", None)
    return Mention(True, "listed" if structured else "prose", _snippet(text, first[0], first[1], first[2].pattern))


def name_is_ours(candidate: str, names: list[Name]) -> bool:
    """Does an extracted list entry name our brand? Same word and case rules; a list entry is a structured spot."""
    cand = collapse(candidate)
    for name in names:
        if name.pattern.fullmatch(cand):
            return True
        # "Asana (project tool)" style entries: the name leads the entry
        lead = re.split(r"\s*[\(\[:,–—-]\s*", cand, maxsplit=1)[0].strip()
        if lead and lead != cand and name.pattern.fullmatch(lead):
            return True
    return False


def appears_in(text: str, name: str) -> bool:
    """Guard for extractor names: the name must appear in the answer (normalised, case-insensitive)."""
    n = collapse(name).lower()
    return bool(n) and n in " ".join(clean(text).lower().split())
