"""The rows the code builds match .actor/dataset_schema.json (offline, mock transport)."""
import asyncio
import json
import pathlib
import socket
import sys

import httpx

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))
from src import runner  # noqa: E402
from src.polite import HostLimiter  # noqa: E402

ROOT = pathlib.Path(__file__).resolve().parents[1]
FULL = json.loads((ROOT / ".actor" / "dataset_schema.json").read_text())
SCHEMA = FULL["fields"]
JSON_TYPES = {"string": str, "integer": int, "number": (int, float), "boolean": bool, "array": list, "object": dict, "null": type(None)}


async def nosleep(_):
    return None


def handler(req: httpx.Request) -> httpx.Response:
    p, host = req.url.path, req.url.host
    if host == "dead.example":
        e = httpx.ConnectError("x")
        e.__cause__ = socket.gaierror(-2, "Name or service not known")
        raise e
    if p == "/robots.txt":
        return httpx.Response(200, text="User-agent: *\nDisallow: /private\n")
    if p == "/old":
        return httpx.Response(301, headers={"location": "/new"})
    if p == "/new":
        return httpx.Response(200, headers={"content-type": "text/html"}, text='<a href="/gone">g</a>')
    return httpx.Response(404)


def rows():
    out = []

    async def push(row, charge):
        out.append(row)
        return False

    async def status(_):
        return None

    async def go(inp):
        async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as c:
            await runner.run(inp, client=c, push=push, set_status=status, sleep=nosleep, limiter=HostLimiter(0, sleep=nosleep))
    asyncio.run(go({"startUrls": ["https://ex.com/old", "https://ex.com/private", "https://ex.com/missing", "https://dead.example/"]}))
    asyncio.run(go({"startUrls": ["https://ex.com/new"], "mode": "crawl"}))
    return out


def test_rows_match_schema():
    out = rows()
    assert {r["category"] for r in out} >= {"redirect", "robots_blocked", "4xx", "error", "ok"}
    props = SCHEMA["properties"]
    for row in out:
        assert set(row) <= set(props), set(row) - set(props)
        assert set(SCHEMA["required"]) <= set(row)
        for k, v in row.items():
            t = props[k]["type"]
            t = [t] if isinstance(t, str) else t
            assert any(isinstance(v, JSON_TYPES[x]) and not (isinstance(v, bool) and x in ("integer", "number")) for x in t), f"{k}={v!r} is not {t}"
            assert props[k].get("description"), k
    assert set(props) == set(out[0])  # every key the code pushes is described, and no other


def test_view_fields_exist():
    for v in FULL["views"].values():
        assert v["title"] and set(v["transformation"]["fields"]) <= set(SCHEMA["properties"])
