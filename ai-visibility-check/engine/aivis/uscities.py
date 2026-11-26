"""Offline check that 'City, XX' is a real US place in state XX (US only; no network).

Data: data/us_places.csv.gz, built from the US Census Bureau 2023 Gazetteer "places" national file
(public domain), https://www2.census.gov/geo/docs/maps-data/data/gazetteer/2023_Gazetteer/2023_Gaz_place_national.zip
(downloaded 2026-11-26). Rebuild: python3 -m aivis.uscities <2023_Gaz_place_national.txt>.
Rows are "STATE,normalised name"; lines starting with '#' are comments.
"""
import csv
import gzip
import os
import re
import sys

DATA = os.path.join(os.path.dirname(os.path.abspath(__file__)), "data", "us_places.csv.gz")
_SUFFIXES = re.compile(
    r"\s+(?:\(balance\)|city and borough|city and county|consolidated government|metropolitan government|"
    r"metro government|unified government|urban county|city|town|village|borough|municipality|cdp|"
    r"plantation|comunidad|zona urbana)\b.*$", re.I)
_PLACES = None


def norm(name: str) -> str:
    """Case-insensitive, punctuation-light form: Saint->st, Ft->fort, Mt->mount, extra spaces collapsed."""
    s = str(name).lower().replace("’", "'")
    s = re.sub(r"[.'`]", "", s)
    s = re.sub(r"[-/]", " ", s)
    s = re.sub(r"\s+", " ", s).strip()
    words = [{"saint": "st", "ft": "fort", "mt": "mount", "sainte": "ste"}.get(w, w) for w in s.split(" ")]
    return " ".join(words)


def _names(raw: str):
    base = raw
    while True:                                  # strip stacked suffixes, e.g. "x city (balance)"
        new = _SUFFIXES.sub("", base)
        if new == base:
            break
        base = new
    out = {norm(base)}
    if base.lower().startswith("urban "):      # "Urban Honolulu"
        out.add(norm(base[6:]))
    for part in re.split(r"[/-]", base):         # "Nashville-Davidson", "Louisville/Jefferson County"
        if len(part.strip()) > 2:
            out.add(norm(part))
    return out


def build(src: str, dest: str = DATA):
    rows = set()
    with open(src, encoding="latin-1", newline="") as f:
        rd = csv.reader(f, delimiter="\t")
        next(rd)
        for r in rd:
            if len(r) > 4:
                for n in _names(r[3].strip()):
                    rows.add((r[0].strip(), n))
    with gzip.open(dest, "wt", encoding="utf-8", newline="") as f:
        f.write("# US Census 2023 Gazetteer places (public domain), fetched 2026-11-26\n"
                "# https://www2.census.gov/geo/docs/maps-data/data/gazetteer/2023_Gazetteer/2023_Gaz_place_national.zip\n")
        w = csv.writer(f, lineterminator="\n")
        for st, n in sorted(rows):
            w.writerow([st, n])
    return len(rows)


def _load():
    global _PLACES
    if _PLACES is None:
        d = {}
        with gzip.open(DATA, "rt", encoding="utf-8") as f:
            for row in csv.reader(l for l in f if not l.startswith("#")):
                if len(row) == 2:
                    d.setdefault(row[0], set()).add(row[1])
        _PLACES = d
    return _PLACES


def is_us_place(city: str, state: str) -> bool:
    """True if `city` is a Census place in `state` (2-letter code, case-insensitive)."""
    return norm(city) in _load().get(str(state).upper(), ())


if __name__ == "__main__":
    print(build(sys.argv[1]), "rows written to", DATA)
