"""Known businesses in a niche + city. Used to verify names in AI answers
and later as the prospect list.

Sources:
- NPPES NPI Registry API (CMS, free, no key): health niches (dentists,
  chiropractors, orthodontists). Returns practice name, address, phone.
  No emails. https://npiregistry.cms.hhs.gov/api-page
- CSV file: name,website,phone,email,source (e.g. state license-board
  exports or a paid Maps list, only after Dvir approves the spend).
"""
import csv
import json
import urllib.parse
import urllib.request
from dataclasses import dataclass


@dataclass
class RosterEntry:
    name: str
    city: str = ""
    state: str = ""
    phone: str = ""
    website: str = ""
    email: str = ""
    source: str = ""
    npi: str = ""


def title_case(s: str) -> str:
    small = {"and", "of", "the", "at", "in", "pllc", "llc", "pc", "pa", "dds", "dmd"}
    out = []
    for i, w in enumerate(s.lower().split()):
        if w in small and i:
            out.append(w.upper() if w in {"pllc", "llc", "pc", "pa", "dds", "dmd"} else w)
        else:
            out.append(w[:1].upper() + w[1:])
    return " ".join(out)


def from_nppes(taxonomy: str, city: str, state: str, limit: int = 200, opener=None) -> list:
    """Organizations (NPI-2) only: practices, not individual clinicians."""
    op = opener or urllib.request.urlopen
    out, skip = [], 0
    while len(out) < limit:
        q = urllib.parse.urlencode({"version": "2.1", "taxonomy_description": taxonomy, "city": city,
                                    "state": state, "enumeration_type": "NPI-2", "limit": 200, "skip": skip})
        with op("https://npiregistry.cms.hhs.gov/api/?" + q, timeout=30) as r:
            data = json.loads(r.read().decode())
        res = data.get("results", [])
        for x in res:
            b = x.get("basic", {})
            name = b.get("organization_name") or ""
            loc = next((a for a in x.get("addresses", []) if a.get("address_purpose") == "LOCATION"), {})
            if name:
                out.append(RosterEntry(title_case(name), loc.get("city", city).title(), state,
                                       loc.get("telephone_number", ""), source="NPPES", npi=str(x.get("number", ""))))
        if len(res) < 200 or skip >= 1000:
            break
        skip += 200
    # de-duplicate by name (chains file one NPI per location)
    seen, uniq = set(), []
    for e in out:
        if e.name.lower() not in seen:
            seen.add(e.name.lower())
            uniq.append(e)
    return uniq[:limit]


def from_csv(path: str) -> list:
    with open(path, newline="", encoding="utf-8") as f:
        return [RosterEntry(**{k: (row.get(k) or "").strip() for k in
                               ("name", "city", "state", "phone", "website", "email", "source")})
                for row in csv.DictReader(f) if (row.get("name") or "").strip()]
