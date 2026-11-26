"""Find which businesses an answer names, and match them to a known roster.

Names not on the roster are kept as 'unverified' (could be real businesses
we don't have, or made up: model-memory answers often invent names).
"""
import re
from dataclasses import dataclass
from difflib import SequenceMatcher

SUFFIXES = r"\b(dds|dmd|md|pllc|pplc|plc|dba|llc|l\.l\.c|inc|pc|p\.c|pa|p\.a|ltd|co|corp|llp|esq|dvm)\b"
TITLES = r"^(dr\.?|doctor|the)\s+"
GENERIC = {"here are some options", "good options include", "note", "tips", "summary", "conclusion",
           "always check recent reviews", "why", "pros", "cons", "location", "phone", "website",
           "services", "reviews", "address", "hours", "key features", "highlights", "price", "pricing"}
LEAD = re.compile(r"^\s*(?:\d+[.)]|[-*•–]|#{1,4})\s+")
BOLD = re.compile(r"\*\*([^*]{2,80})\*\*")


@dataclass
class Mention:
    raw: str
    position: int
    roster_name: str = None     # None = unverified

    @property
    def verified(self):
        return self.roster_name is not None


def normalize(name: str) -> str:
    s = name.lower().replace("&", " and ").replace("’", "'")
    s = re.sub(r"[\u2013\u2014]", " ", s)
    s = re.sub(TITLES, "", s.strip())
    s = re.sub(SUFFIXES, " ", s)
    s = re.sub(r"[^a-z0-9' ]+", " ", s)
    s = re.sub(r"\s+", " ", s).strip()
    return s


def _clean_candidate(s: str) -> str:
    s = s.strip().strip("*_`\"' ")
    s = re.split(r"\s+[–—-]\s+|:\s|\s\(|,\s(?=[a-z])|\s\|\s", s, maxsplit=1)[0]
    s = s.strip().strip("*_`\"'.:; ")
    return s


def extract_candidates(text: str) -> list:
    """Ordered, de-duplicated business-name candidates from list/bold structure."""
    out = []
    for line in text.splitlines():
        if not line.strip():
            continue
        bolds = BOLD.findall(line)
        if bolds:
            out.extend(_clean_candidate(b) for b in bolds)
        elif LEAD.match(line):
            out.append(_clean_candidate(LEAD.sub("", line)))
    seen, res = set(), []
    for c in out:
        n = normalize(c)
        if not n or n in GENERIC or len(n) < 3 or len(c) > 80 or n in seen:
            continue
        if len(n.split()) > 9:      # a sentence, not a name
            continue
        seen.add(n)
        res.append(c)
    return res


GENERIC_WORDS = {
    "and", "of", "the", "at", "in", "for", "a", "by", "on", "to", "dr",
    # trade words (all niches)
    "dental", "dentistry", "dentist", "dentists", "orthodontics", "orthodontic", "orthodontist", "endodontics",
    "periodontics", "smile", "smiles", "family", "cosmetic", "implant", "implants", "pediatric", "kids", "teeth",
    "care", "center", "centre", "clinic", "clinics", "associates", "group", "practice", "office", "studio", "spa",
    "health", "premier", "modern", "advanced", "professional", "professionals", "services", "service", "company",
    "co", "law", "firm", "lawyers", "lawyer", "attorneys", "attorney", "injury", "personal", "legal", "offices",
    "hvac", "air", "heating", "cooling", "conditioning", "plumbing", "plumber", "roofing", "roofers", "roof",
    "electric", "electrical", "med", "medical", "aesthetics", "aesthetic", "wellness", "beauty", "laser",
    "chiropractic", "chiropractor", "veterinary", "vet", "animal", "hospital", "garage", "door", "doors",
    "repair", "home", "homes", "realty", "real", "estate", "team", "solar", "auto", "partners", "llp",
    # places / directions
    "north", "south", "east", "west", "central", "downtown", "midtown", "uptown", "city", "texas", "tx",
}


def _distinctive_tokens(n: str, extra_stop=frozenset()) -> frozenset:
    return frozenset(t for t in n.split() if t not in GENERIC_WORDS and t not in extra_stop and len(t) > 1)


def match_name(candidate: str, roster_names, threshold: float = 0.9, city: str = ""):
    """Return the roster name that candidate refers to, or None.

    Strict on purpose: the first live run showed loose fuzzy matching maps
    'Austin Dental Clinic' onto 'Austin Dental Associates'. Rules:
    1) equal after normalising (suffixes, Dr., punctuation) -> match;
    2) otherwise both names must share the same NON-generic tokens (city and
       trade words removed), and those tokens must exist;
    3) plus a string-similarity floor to avoid odd collisions.
    """
    c = normalize(candidate)
    if not c:
        return None
    city_stop = frozenset(normalize(city.split(",")[0]).split()) if city else frozenset()
    cd = _distinctive_tokens(c, city_stop)
    best, best_score = None, 0.0
    for r in roster_names:
        n = normalize(r)
        if not n:
            continue
        if c == n:
            return r
        nd = _distinctive_tokens(n, city_stop)
        if not cd or not nd or cd != nd:
            continue
        if (len(cd) == 1 or len(nd) == 1) and len(cd & nd) < 2:
            continue    # one distinctive token only: needs exact equality (handled above) or 2+ shared
        score = max(SequenceMatcher(None, c, n).ratio(), 0.9 if (c in n or n in c) else 0.0)
        score = max(score, 0.9)  # same distinctive tokens is strong evidence
        if score > best_score:
            best, best_score = r, score
    return best if best_score >= threshold else None


def find_mentions(text: str, roster_names=(), city: str = "") -> list:
    """Structured candidates first; then roster names that appear in prose."""
    mentions, used = [], set()
    for i, cand in enumerate(extract_candidates(text), 1):
        r = match_name(cand, roster_names, city=city) if roster_names else None
        if r and r in used:
            continue
        if r:
            used.add(r)
        mentions.append(Mention(cand, i, r))
    low = " " + normalize(text) + " "
    pos = len(mentions)
    for r in roster_names:
        if r in used:
            continue
        n = normalize(r)
        if len(n) >= 5 and f" {n} " in low:
            pos += 1
            used.add(r)
            mentions.append(Mention(r, pos, r))
    return mentions
