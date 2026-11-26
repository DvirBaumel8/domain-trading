"""Pure logic for Wayback Domain History: input cleanup, CDX parsing, statistics, summary."""
from __future__ import annotations

import re
from collections import Counter

DOMAIN_RE = re.compile(r"^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9-]{2,63}$")
CDX_URL = "https://web.archive.org/cdx/search/cdx"
AVAILABLE_URL = "https://archive.org/wayback/available"


def clean_domain(raw) -> str | None:
    """'https://www.X.com/path?q' -> 'x.com'. None if it is not a plausible domain."""
    if not isinstance(raw, str):
        return None
    s = raw.strip().lower()
    s = re.sub(r"^[a-z][a-z0-9+.-]*://", "", s)
    s = re.split(r"[/?#]", s, maxsplit=1)[0]
    s = s.rsplit("@", 1)[-1].split(":", 1)[0].strip(".")
    if s.startswith("www."):
        s = s[4:]
    try:
        s = s.encode("idna").decode("ascii")
    except UnicodeError:
        return None
    return s if DOMAIN_RE.match(s) else None


def cdx_params(domain: str, include_subdomains: bool, from_year=None, to_year=None, resume_key=None, limit=5000) -> dict:
    p = {"url": domain, "matchType": "domain" if include_subdomains else "host", "output": "json",
         "fl": "timestamp,statuscode,original", "collapse": "timestamp:8",  # one capture per day
         "limit": str(limit), "showResumeKey": "true"}
    if from_year:
        p["from"] = str(from_year)
    if to_year:
        p["to"] = str(to_year)
    if resume_key:
        p["resumeKey"] = resume_key
    return p


def parse_cdx_page(data) -> tuple[list[tuple[str, str, str]], str | None]:
    """CDX JSON page -> ([(timestamp, statuscode, original)], resume_key or None)."""
    if not isinstance(data, list):
        raise ValueError("unexpected CDX response")
    rows, key = [], None
    for i, r in enumerate(data):
        if not isinstance(r, list):
            raise ValueError("unexpected CDX row")
        if i == 0 and r[:1] == ["timestamp"]:
            continue
        if not r:  # blank row: the next row holds the resume key
            if i + 1 < len(data) and data[i + 1]:
                key = str(data[i + 1][0])
            break
        if len(r) >= 3:
            rows.append((str(r[0]), str(r[1]), str(r[2])))
    return rows, key


def status_class(code: str) -> str:
    return f"{code[0]}xx" if code[:1] in "2345" and len(code) == 3 else "other"


def snapshot_url(ts: str, original: str) -> str:
    return f"https://web.archive.org/web/{ts}/{original}"


def pick_evenly(items: list, n: int) -> list:
    if len(items) <= n:
        return list(items)
    return [items[(i * len(items)) // n] for i in range(n)]


def analyse(rows: list[tuple[str, str, str]], samples_per_year: int = 1) -> dict:
    by_year: dict[str, list] = {}
    classes = Counter({"2xx": 0, "3xx": 0, "4xx": 0, "5xx": 0, "other": 0})
    codes = Counter()
    for ts, code, orig in sorted(rows):
        by_year.setdefault(ts[:4], []).append((ts, code, orig))
        classes[status_class(code)] += 1
        codes[code] += 1
    years = sorted(by_year)
    return {
        "firstSeen": _date(min(r[0] for r in rows)) if rows else None,
        "lastSeen": _date(max(r[0] for r in rows)) if rows else None,
        "totalSnapshots": len(rows),
        "snapshotsPerYear": {y: len(by_year[y]) for y in years},
        "statusCounts": dict(classes),
        "yearsWithCaptures": [int(y) for y in years],
        "sampleSnapshots": {y: [snapshot_url(t, o) for t, _, o in pick_evenly(by_year[y], samples_per_year)] for y in years},
        "_topCode": codes.most_common(1)[0][0] if codes else None,
        "_lastYearClasses": Counter(status_class(c) for _, c, _ in by_year[years[-1]]) if years else Counter(),
    }


def _date(ts: str) -> str:
    return f"{ts[:4]}-{ts[4:6]}-{ts[6:8]}"


def longest_gap(years: list[int]) -> tuple[int, int] | None:
    best = None
    for a, b in zip(years, years[1:]):
        if b - a > 1 and (best is None or b - a > best[1] - best[0] + 2):
            best = (a + 1, b - 1)
    return best


def summarize(stats: dict) -> str:
    n = stats["totalSnapshots"]
    if not n:
        return "No captures in the Internet Archive."
    years = stats["yearsWithCaptures"]
    parts = [f"Archived {years[0]}–{years[-1]}" if years[0] != years[-1] else f"Archived {years[0]}", f"{n:,} captures"]
    parts.append(f"mostly {stats['_topCode']}")
    gap = longest_gap(years)
    if gap:
        parts.append(f"gap {gap[0]}–{gap[1]}" if gap[0] != gap[1] else f"gap {gap[0]}")
    last = stats["_lastYearClasses"]
    top = last.most_common(1)[0][0] if last else None
    if top == "3xx":
        parts.append("recent captures redirect")
    elif top in ("4xx", "5xx"):
        parts.append("recent captures return errors")
    return ", ".join(parts)


def public_row(stats: dict) -> dict:
    return {k: v for k, v in stats.items() if not k.startswith("_")}


def parse_available(data) -> str | None:
    """Availability API -> closest snapshot URL or None."""
    try:
        snap = data["archived_snapshots"]["closest"]
        return snap["url"] if snap.get("available") else None
    except (KeyError, TypeError, AttributeError):
        return None
