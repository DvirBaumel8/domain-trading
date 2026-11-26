"""Offline fakes: run an actor's real main() with a fake Actor and a mock HTTP world. No network."""
from __future__ import annotations

import asyncio
import importlib
import importlib.util
import json
import logging
import sys
from pathlib import Path

import httpx

ROOT = Path(__file__).resolve().parents[1]

DOH_HOSTS = {"cloudflare-dns.com", "security.cloudflare-dns.com", "dns.google"}
RDAP_JSON = {
    "events": [{"eventAction": "registration", "eventDate": "2015-03-01T00:00:00Z"},
               {"eventAction": "expiration", "eventDate": "2030-03-01T00:00:00Z"}],
    "entities": [{"roles": ["registrar"], "vcardArray": ["vcard", [["fn", {}, "text", "Example Registrar, Inc."]]]}],
    "status": ["client transfer prohibited"],
    "nameservers": [{"ldhName": "ns1.dns-host.test"}],
}
URLSET = """<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">
<url><loc>https://example.test/</loc><lastmod>2026-01-01</lastmod><priority>0.8</priority></url>
<url><loc>https://example.test/blog/post</loc><lastmod>2026-02-01</lastmod><changefreq>weekly</changefreq>
<xhtml:link rel="alternate" hreflang="de" href="https://example.test/de/blog/post"/></url>
</urlset>"""
PSI = {"lighthouseResult": {"categories": {"performance": {"score": 0.87}},
                            "audits": {"largest-contentful-paint": {"numericValue": 2412.6},
                                       "cumulative-layout-shift": {"numericValue": 0.0457},
                                       "total-blocking-time": {"numericValue": 120.2},
                                       "first-contentful-paint": {"numericValue": 1200.0},
                                       "speed-index": {"numericValue": 3100.4},
                                       "interactive": {"numericValue": 4000.0}}},
       "loadingExperience": {"overall_category": "FAST", "metrics": {
           "LARGEST_CONTENTFUL_PAINT_MS": {"percentile": 2100, "category": "FAST"},
           "INTERACTION_TO_NEXT_PAINT": {"percentile": 180, "category": "FAST"},
           "CUMULATIVE_LAYOUT_SHIFT_SCORE": {"percentile": 5, "category": "FAST"}}}}
HTML = "<html><head><title>Example</title></head><body><a href='/old'>Old page</a> <a href='/missing'>Gone</a></body></html>"


def _doh(request: httpx.Request) -> httpx.Response:
    name = request.url.params.get("name", "")
    rtype = request.url.params.get("type", "A")
    if name.startswith("quietbluefalcon"):  # a name nobody owns
        return httpx.Response(200, json={"Status": 3})
    codes = {"A": 1, "NS": 2, "CNAME": 5, "MX": 15, "TXT": 16, "AAAA": 28}
    data = None
    if rtype == "NS":
        data = "ns1.dns-host.test."
    elif rtype == "MX":
        data = "10 aspmx.l.google.com."
    elif rtype == "A":
        data = "93.184.216.34"
    elif rtype == "TXT":
        if name.startswith("_dmarc."):
            data = '"v=DMARC1; p=none; rua=mailto:reports@example.test"'
        elif name.count(".") == 1 or name.startswith("www."):
            data = '"v=spf1 include:_spf.google.com ~all"'
    if data is None or rtype not in codes:
        return httpx.Response(200, json={"Status": 0})
    return httpx.Response(200, json={"Status": 0, "Answer": [{"name": name, "type": codes[rtype], "TTL": 60, "data": data}]})


def world(request: httpx.Request) -> httpx.Response:
    host, path = request.url.host, request.url.path
    if host in DOH_HOSTS:
        return _doh(request)
    if host == "data.iana.org":
        return httpx.Response(200, json={"services": [[["com", "net", "org", "io", "ai", "co"], ["https://rdap.test/"]]]})
    if host == "rdap.test":
        return httpx.Response(404) if "quietbluefalcon" in path else httpx.Response(200, json=RDAP_JSON)
    if host == "www.googleapis.com":
        return httpx.Response(200, json=PSI)
    if path == "/robots.txt":
        if host == "apify.com":
            return httpx.Response(200, text="User-agent: *\nSitemap: https://apify.com/sitemap.xml\n")
        return httpx.Response(404)
    if path.endswith("sitemap.xml"):
        return httpx.Response(200, text=URLSET, headers={"content-type": "application/xml"})
    if path == "/old":
        return httpx.Response(301, headers={"location": "/new"})
    if path == "/missing":
        return httpx.Response(404, text="gone")
    return httpx.Response(200, text=HTML, headers={"content-type": "text/html; charset=utf-8"})


class FakeActor:
    """Just enough of apify.Actor for the adapters: input in, pushed rows and stored values out."""

    log = logging.getLogger("fake-actor")

    def __init__(self, inp: dict):
        self.inp, self.rows, self.values, self.failed, self.status = inp, [], {}, None, None

    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc):
        return False

    async def get_input(self):
        return self.inp

    async def push_data(self, data, charged_event_name=None):
        self.rows.extend(data if isinstance(data, list) else [data])

    async def fail(self, status_message=None, **kw):
        self.failed = status_message

    async def set_status_message(self, msg, **kw):
        self.status = msg

    async def set_value(self, key, value, **kw):
        self.values[key] = value


def load_main(name: str):
    """Import <actor>/src as its own package (all actors call theirs `src`), return the package alias."""
    alias = "actor_" + name.replace("-", "_")
    if alias not in sys.modules:
        src = ROOT / name / "src"
        spec = importlib.util.spec_from_file_location(alias, src / "__init__.py", submodule_search_locations=[str(src)])
        mod = importlib.util.module_from_spec(spec)
        sys.modules[alias] = mod
        spec.loader.exec_module(mod)
    return alias


def run_actor(name: str, inp: dict, monkeypatch) -> FakeActor:
    """Run the real main() of an actor against the mock world and return the FakeActor with its rows."""
    alias = load_main(name)
    main_mod = importlib.import_module(alias + ".main")
    fake = FakeActor(inp)
    monkeypatch.setattr(main_mod, "Actor", fake)
    real_client = httpx.AsyncClient

    def client(*a, **kw):
        kw.pop("transport", None)
        return real_client(*a, transport=httpx.MockTransport(world), **kw)
    monkeypatch.setattr(httpx, "AsyncClient", client)

    async def nosleep(*_a, **_kw):
        return None
    monkeypatch.setattr(asyncio, "sleep", nosleep)
    monkeypatch.setenv("PAGESPEED_API_KEY", "test-key-not-real")
    if hasattr(main_mod, "RDAP_MIN_INTERVAL"):
        monkeypatch.setattr(main_mod, "RDAP_MIN_INTERVAL", 0)
    runner = sys.modules.get(alias + ".runner")
    if runner is not None and hasattr(runner, "HostLimiter"):
        real_limiter = runner.HostLimiter
        monkeypatch.setattr(runner, "HostLimiter", lambda interval, **kw: real_limiter(0, sleep=nosleep))
    asyncio.run(main_mod.main())
    return fake


def json_types(schema_type) -> list[str]:
    return list(schema_type) if isinstance(schema_type, list) else [schema_type]


def type_ok(value, schema_type) -> bool:
    checks = {"string": lambda v: isinstance(v, str), "boolean": lambda v: isinstance(v, bool),
              "integer": lambda v: isinstance(v, int) and not isinstance(v, bool),
              "number": lambda v: isinstance(v, (int, float)) and not isinstance(v, bool),
              "array": lambda v: isinstance(v, list), "object": lambda v: isinstance(v, dict), "null": lambda v: v is None}
    return any(checks[t](value) for t in json_types(schema_type))


def load_json(path: Path):
    return json.loads(path.read_text())
