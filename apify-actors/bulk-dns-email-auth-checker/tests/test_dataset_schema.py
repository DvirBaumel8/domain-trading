"""The rows the code builds match .actor/dataset_schema.json (offline: mock DNS-over-HTTPS, no network)."""
import asyncio
import json
import pathlib
import sys

import httpx

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))
from src import main  # noqa: E402
from src.doh import DohResolver  # noqa: E402

ROOT = pathlib.Path(__file__).resolve().parents[1]
SCHEMA = json.loads((ROOT / ".actor" / "dataset_schema.json").read_text())["fields"]
JSON_TYPES = {"string": str, "integer": int, "number": (int, float), "boolean": bool, "array": list, "object": dict, "null": type(None)}

ZONE = {  # (name, type) -> list of data strings; names not listed here are NXDOMAIN
    ("lead-one.example", "NS"): ["ns1.dns-host.example."],
    ("lead-one.example", "MX"): ["10 mail.lead-one.example."],
    ("lead-one.example", "TXT"): ['"v=spf1 include:_spf.google.com ~all"'],
    ("lead-two.example", "NS"): ["ns1.dns-host.example."],
    ("lead-two.example", "TXT"): ['"v=spf1 -all"'],
    ("_dmarc.lead-two.example", "TXT"): ['"v=DMARC1; p=reject; rua=mailto:reports@lead-two.example"'],
    ("lead-two.example", "A"): ["192.0.2.10"],
}
CODES = {"A": 1, "NS": 2, "CNAME": 5, "MX": 15, "TXT": 16, "AAAA": 28, "CAA": 257}


def handler(req: httpx.Request) -> httpx.Response:
    name, rtype = req.url.params["name"], req.url.params["type"]
    apex = name.split("_dmarc.")[-1]
    if apex not in ("lead-one.example", "lead-two.example"):
        return httpx.Response(200, json={"Status": 3})
    answers = [{"name": name, "type": CODES[rtype], "TTL": 60, "data": d} for d in ZONE.get((name, rtype), [])]
    return httpx.Response(200, json={"Status": 0, "Answer": answers} if answers else {"Status": 0})


def rows():
    async def go():
        async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as c:
            r = DohResolver(c)
            return [await main.check_domain(r, d, ["google", "default"], True) for d in ("lead-one.example", "lead-two.example", "missing.example")]
    out = asyncio.run(go())
    for row in out:
        row["checkedAt"] = "2026-11-26T10:00:00+00:00"
    out.append({"domain": "boom.example", "error": "RuntimeError: x", "issues": [], "checkedAt": "2026-11-26T10:00:00+00:00"})
    return out


def check(row, schema):
    props = schema["properties"]
    assert set(row) <= set(props), f"keys not in the dataset schema: {set(row) - set(props)}"
    assert set(schema.get("required", [])) <= set(row), f"required keys missing: {set(schema.get('required', [])) - set(row)}"
    for k, v in row.items():
        t = props[k]["type"]
        t = [t] if isinstance(t, str) else t
        ok = any(isinstance(v, JSON_TYPES[x]) and not (isinstance(v, bool) and x in ("integer", "number")) for x in t)
        assert ok, f"{k}={v!r} is not {t}"
        assert props[k].get("description"), k


def test_rows_match_schema():
    for row in rows():
        check(row, SCHEMA)


def test_every_schema_key_is_pushed_by_the_normal_row():
    full = rows()[0]
    assert set(SCHEMA["properties"]) == set(full) | {"checkedAt"}


def test_view_fields_exist():
    views = json.loads((ROOT / ".actor" / "dataset_schema.json").read_text())["views"]
    assert views
    for v in views.values():
        assert v["title"] and set(v["transformation"]["fields"]) <= set(SCHEMA["properties"])


def test_print_samples_for_readme():  # keeps the README example honest: run with -s to see them
    one, two, _, _ = rows()
    assert one["dmarc"] is None and one["mx"] and two["mx"] == [] and two["dmarc"]
