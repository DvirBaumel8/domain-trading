"""The rows the code builds match .actor/dataset_schema.json (offline, mock transport)."""
import asyncio
import json
import pathlib
import sys

import httpx

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))
from src import runner  # noqa: E402
from src.polite import HostLimiter  # noqa: E402
from test_core import FULL, NO_FIELD  # noqa: E402

ROOT = pathlib.Path(__file__).resolve().parents[1]
DATASET = json.loads((ROOT / ".actor" / "dataset_schema.json").read_text())
SCHEMA = DATASET["fields"]
JSON_TYPES = {"string": str, "integer": int, "number": (int, float), "boolean": bool, "array": list, "object": dict, "null": type(None)}


async def nosleep(_):
    return None


def rows():
    out = []

    def handler(req):
        url = req.url.params["url"]
        if "bad" in url:
            return httpx.Response(400)
        return httpx.Response(200, json=NO_FIELD if "nofield" in url else FULL)

    async def push(row, charge):
        out.append(row)
        return False

    async def status(_):
        return None

    async def go():
        async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as c:
            await runner.run({"urls": ["https://ex.com/", "https://ex.com/nofield", "https://ex.com/bad"], "apiKey": "k", "strategies": ["mobile"],
                              "categories": ["performance", "seo"]}, client=c, push=push, set_status=status, sleep=nosleep,
                             limiter=HostLimiter(0, sleep=nosleep))
    asyncio.run(go())
    return out


def test_rows_match_schema():
    out = rows()
    assert {r["status"] for r in out} == {"ok", "error"}
    props = SCHEMA["properties"]
    for row in out:
        assert set(row) <= set(props) and set(SCHEMA["required"]) <= set(row)
        for k, v in row.items():
            t = props[k]["type"]
            t = [t] if isinstance(t, str) else t
            assert any(isinstance(v, JSON_TYPES[x]) and not (isinstance(v, bool) and x in ("integer", "number")) for x in t), f"{k}={v!r} is not {t}"
            assert props[k].get("description"), k
    assert set(props) == set(out[0])


def test_view_fields_exist():
    for v in DATASET["views"].values():
        assert v["title"] and set(v["transformation"]["fields"]) <= set(SCHEMA["properties"])


def test_readme_cap_matches_code():
    assert runner.DEFAULT_FALLBACK_ROW_CAP == 50
    readme = (ROOT / "README.md").read_text()
    assert "50 URL/strategy rows per run" in readme
