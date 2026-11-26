"""The rows the code builds match .actor/dataset_schema.json (offline: mock DoH + RDAP, no network)."""
import asyncio
import json
import pathlib
import sys

import httpx

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))
from src import main  # noqa: E402
from src.core import bundled_tlds  # noqa: E402
from src.doh import DohResolver  # noqa: E402

ROOT = pathlib.Path(__file__).resolve().parents[1]
FULL = json.loads((ROOT / ".actor" / "dataset_schema.json").read_text())
SCHEMA = FULL["fields"]
JSON_TYPES = {"string": str, "integer": int, "number": (int, float), "boolean": bool, "array": list, "object": dict, "null": type(None)}
RDAP = {"events": [{"eventAction": "registration", "eventDate": "2001-02-03T00:00:00Z"}, {"eventAction": "expiration", "eventDate": "2030-02-03T00:00:00Z"}],
        "entities": [{"roles": ["registrar"], "vcardArray": ["vcard", [["fn", {}, "text", "Example Registrar"]]]}], "status": ["client transfer prohibited"]}


def handler(req: httpx.Request) -> httpx.Response:
    url = str(req.url)
    if url.startswith("https://rdap.test/com/domain/"):
        return httpx.Response(200, json=RDAP) if "registered-by-rdap" in url else httpx.Response(404)
    if "dns-query" in url or "resolve" in url:
        name = req.url.params["name"]
        if name.startswith("taken."):
            return httpx.Response(200, json={"Status": 0, "Answer": [{"name": name, "type": 2, "TTL": 1, "data": "ns1.afternic.com."}]})
        if name.startswith("registered-by-rdap"):
            return httpx.Response(200, json={"Status": 0})  # no NS at all, so RDAP is asked
        return httpx.Response(200, json={"Status": 3})
    return httpx.Response(404)


def rows():
    async def go():
        async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as c:
            kw = dict(resolver=DohResolver(c), client=c, throttle=main.HostThrottle(0), bootstrap={"com": "https://rdap.test/com/"},
                      valid_tlds=bundled_tlds(), lookup_registered=True)
            return [await main.check_domain(d, k, **kw) for d, k in
                    [("taken.com", None), ("registered-by-rdap.com", "kw"), ("free-name.com", "free"), ("name.museum", None), ("name.zz", None)]]
    return asyncio.run(go())


def check(row, schema):
    props = schema["properties"]
    assert set(row) <= set(props), f"keys not in the dataset schema: {set(row) - set(props)}"
    assert set(schema.get("required", [])) <= set(row), f"required keys missing: {set(schema.get('required', [])) - set(row)}"
    for k, v in row.items():
        t = props[k]["type"]
        t = [t] if isinstance(t, str) else t
        assert any(isinstance(v, JSON_TYPES[x]) and not (isinstance(v, bool) and x in ("integer", "number")) for x in t), f"{k}={v!r} is not {t}"
        assert props[k].get("description"), k


def test_rows_match_schema_and_cover_every_status():
    out = rows()
    assert [r["status"] for r in out] == ["registered", "registered", "available", "likely_available", "invalid_tld"]
    for row in out:
        check(row, SCHEMA)
    assert set(SCHEMA["properties"]) == set(out[0])  # every key the code pushes is described


def test_status_description_lists_every_status():
    d = SCHEMA["properties"]["status"]["description"]
    for s in ("available", "likely_available", "registered", "unknown", "invalid_tld"):
        assert s in d


def test_view_fields_exist():
    for v in FULL["views"].values():
        assert v["title"] and set(v["transformation"]["fields"]) <= set(SCHEMA["properties"])
