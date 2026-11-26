"""The rows the code builds match .actor/dataset_schema.json (offline: mock DoH, RDAP and landing page)."""
import asyncio
import json
import pathlib
import sys

import httpx

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))
from src import main  # noqa: E402
from src.doh import DohResolver  # noqa: E402

ROOT = pathlib.Path(__file__).resolve().parents[1]
DATASET = json.loads((ROOT / ".actor" / "dataset_schema.json").read_text())
SCHEMA = DATASET["fields"]
JSON_TYPES = {"string": str, "integer": int, "number": (int, float), "boolean": bool, "array": list, "object": dict, "null": type(None)}
CODES = {"A": 1, "NS": 2, "MX": 15, "TXT": 16}
ZONE = {("parked.test", "NS"): ["ns1.afternic.com."], ("parked.test", "A"): ["192.0.2.1"], ("parked.test", "MX"): ["10 mail.parked.test."],
        ("parked.test", "TXT"): ['"v=spf1 -all"'], ("_dmarc.parked.test", "TXT"): ['"v=DMARC1; p=reject"']}
RDAP = {"events": [{"eventAction": "registration", "eventDate": "2020-08-19T00:00:00Z"}, {"eventAction": "expiration", "eventDate": "2031-08-19T00:00:00Z"}],
        "entities": [{"roles": ["registrar"], "vcardArray": ["vcard", [["fn", {}, "text", "Example Registrar"]]]}], "status": ["client transfer prohibited"],
        "nameservers": [{"ldhName": "ns1.afternic.com"}]}


def handler(req: httpx.Request) -> httpx.Response:
    url = str(req.url)
    if url.startswith("https://rdap.test/"):
        return httpx.Response(200, json=RDAP) if "parked.test" in url else httpx.Response(404)
    if "name" in req.url.params:
        name, t = req.url.params["name"], req.url.params["type"]
        if name.endswith("parked.test"):
            ans = [{"name": name, "type": CODES[t], "TTL": 1, "data": d} for d in ZONE.get((name, t), [])]
            return httpx.Response(200, json={"Status": 0, "Answer": ans} if ans else {"Status": 0})
        return httpx.Response(200, json={"Status": 3})
    return httpx.Response(200, headers={"content-type": "text/html"}, text="<html><title>Parked</title><body>Hello</body></html>")


def built_rows():
    async def go():
        async with httpx.AsyncClient(transport=httpx.MockTransport(handler), follow_redirects=True) as c:
            kw = dict(resolver=DohResolver(c), client=c, throttle=main.HostThrottle(0), bootstrap={"test": "https://rdap.test/"},
                      lookup_rdap=True, fetch_page=True)
            return [await main.check_one(d, **kw) for d in ("parked.test", "free.test")]
    return asyncio.run(go())


def fallback_row(monkeypatch):
    pushed = []

    class FakeActor:
        log = type("L", (), {"info": staticmethod(lambda *a: None), "warning": staticmethod(lambda *a: None)})()

        async def __aenter__(self):
            return self

        async def __aexit__(self, *a):
            return False

        async def get_input(self):
            return {"domains": ["parked.test"]}

        async def push_data(self, row, charged_event_name=None):
            pushed.append((row, charged_event_name))

        async def set_value(self, k, v):
            pass

        async def set_status_message(self, m):
            pass

    async def boom(*a, **k):
        raise RuntimeError("x")
    monkeypatch.setattr(main, "Actor", FakeActor())
    monkeypatch.setattr(main, "check_one", boom)
    real = httpx.AsyncClient
    monkeypatch.setattr(main.httpx, "AsyncClient", lambda **kw: real(transport=httpx.MockTransport(handler), **kw))
    asyncio.run(main.main())
    return pushed


def check(row):
    props = SCHEMA["properties"]
    assert set(row) <= set(props), set(row) - set(props)
    assert set(SCHEMA["required"]) <= set(row), set(SCHEMA["required"]) - set(row)
    for k, v in row.items():
        t = props[k]["type"]
        t = [t] if isinstance(t, str) else t
        assert any(isinstance(v, JSON_TYPES[x]) and not (isinstance(v, bool) and x in ("integer", "number")) for x in t), f"{k}={v!r} is not {t}"
        assert props[k].get("description"), k


def test_rows_match_schema():
    parked, free = built_rows()
    assert parked["status"] == "registered" and parked["isParkedOrForSale"] is True and parked["registrar"] == "Example Registrar"
    assert free["status"] == "available"
    for row in (parked, free):
        row["checkedAt"] = "2026-11-26T10:00:00+00:00"  # added by main() in the real run
        check(row)
    assert set(SCHEMA["properties"]) == set(parked)


def test_failure_row_matches_schema_and_is_charged_once(monkeypatch):
    (row, event), = fallback_row(monkeypatch)
    check(row)
    assert event == "report"


def test_view_fields_exist():
    for v in DATASET["views"].values():
        assert v["title"] and set(v["transformation"]["fields"]) <= set(SCHEMA["properties"])
