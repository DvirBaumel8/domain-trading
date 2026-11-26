"""The rows the code pushes match .actor/dataset_schema.json (offline, fake Actor, mock transport)."""
import json
import pathlib
import sys

import httpx

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))
from test_validation import run_main  # noqa: E402

ROOT = pathlib.Path(__file__).resolve().parents[1]
DATASET = json.loads((ROOT / ".actor" / "dataset_schema.json").read_text())
SCHEMA = DATASET["fields"]
JSON_TYPES = {"string": str, "integer": int, "number": (int, float), "boolean": bool, "array": list, "object": dict, "null": type(None)}
SITEMAP = b'''<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:image="http://www.google.com/schemas/sitemap-image/1.1" xmlns:xhtml="http://www.w3.org/1999/xhtml">
<url><loc>https://ex.com/a</loc><lastmod>2026-03-04</lastmod><priority>0.8</priority><image:image><image:loc>https://ex.com/i.png</image:loc></image:image>
<xhtml:link rel="alternate" hreflang="de" href="https://ex.com/de/a"/></url><url><loc>https://ex.com/b</loc></url></urlset>'''


def pushed_rows(monkeypatch, check_status):
    def h(req):
        return httpx.Response(200, content=SITEMAP) if req.url.path.endswith(".xml") else httpx.Response(200)
    fake, _ = run_main(monkeypatch, {"startUrls": ["https://ex.com/sitemap.xml"], "checkStatus": check_status}, h)
    return [r for batch, _ in fake.pushed for r in batch]


def test_rows_match_schema(monkeypatch):
    props = SCHEMA["properties"]
    for check in (False, True):
        out = pushed_rows(monkeypatch, check)
        assert len(out) == 2
        for row in out:
            assert set(row) <= set(props) and set(SCHEMA["required"]) <= set(row)
            for k, v in row.items():
                t = props[k]["type"]
                t = [t] if isinstance(t, str) else t
                assert any(isinstance(v, JSON_TYPES[x]) and not (isinstance(v, bool) and x in ("integer", "number")) for x in t), f"{k}={v!r} is not {t}"
                assert props[k].get("description"), k
            assert set(props) == set(row)


def test_view_fields_exist():
    for v in DATASET["views"].values():
        assert v["title"] and set(v["transformation"]["fields"]) <= set(SCHEMA["properties"])
