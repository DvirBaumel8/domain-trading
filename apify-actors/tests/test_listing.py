"""Listing quality for the six in-scope actors (offline): text limits, README first screen, schemas, permissions, logo.

wayback-domain-history is on hold and deliberately not covered here.
"""
import json
import re
import struct
import zlib
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
IN_SCOPE = ["broken-link-auditor", "bulk-dns-email-auth-checker", "bulk-domain-availability-checker",
            "bulk-pagespeed-checker", "domain-checkup-report", "sitemap-url-extractor"]
PERMISSION_SENTENCE = "This Actor needs only limited permissions: it reads its input and writes to its own default dataset."
ALLOWED_ACTOR_CALLS = {"get_input", "push_data", "fail", "set_value", "set_status_message", "log"}
ALLOWED_ENV = {"PAGESPEED_API_KEY", "PAGESPEED_FALLBACK_ROW_CAP"}


def load(name, rel):
    return json.loads((ROOT / name / ".actor" / rel).read_text())


def readme(name):
    return (ROOT / name / "README.md").read_text()


@pytest.mark.parametrize("name", IN_SCOPE)
def test_seo_limits_and_titles(name):
    a = load(name, "actor.json")
    assert 0 < len(a["title"]) < 60, a["title"]
    assert 0 < len(a["seoTitle"]) <= 60, a["seoTitle"]
    assert 0 < len(a["seoDescription"]) <= 160, len(a["seoDescription"])
    assert a["description"].strip()


@pytest.mark.parametrize("name", IN_SCOPE)
def test_readme_title_matches_and_first_screen(name):
    a, text = load(name, "actor.json"), readme(name)
    assert text.splitlines()[0] == f"# {a['title']}"
    assert len(re.findall(r"(?m)^# ", text)) == 1
    first = text.split("\n## ", 1)[0]
    assert len(first.strip().splitlines()) <= 16
    assert "**Returns**" in first and "**Cost:**" in first and "Pricing tab" in first
    block = re.search(r"```json\n(.*?)\n```", first, re.S)
    assert block, "a JSON input example on the first screen"
    example = json.loads(block.group(1))
    assert set(example) <= set(load(name, "input_schema.json")["properties"])


@pytest.mark.parametrize("name", IN_SCOPE)
def test_returns_line_names_real_dataset_fields(name):
    first = readme(name).split("\n## ", 1)[0]
    returns = re.search(r"\*\*Returns\*\*(.*)", first).group(1)
    props = set(load(name, "dataset_schema.json")["fields"]["properties"])
    named = set(re.findall(r"`(\w+)`", returns))
    assert named and named <= props, named - props


@pytest.mark.parametrize("name", IN_SCOPE)
def test_readme_ends_with_permissions(name):
    text = readme(name)
    last = text.strip().split("\n## ")[-1]
    assert last.startswith("Permissions") and PERMISSION_SENTENCE in last


@pytest.mark.parametrize("name", IN_SCOPE)
def test_no_dollar_amounts_or_unsupported_claims(name):
    files = [ROOT / name / "README.md", ROOT / name / "CHANGELOG.md"] + list((ROOT / name / ".actor").glob("*.json"))
    for p in files:
        text = p.read_text()
        assert not re.search(r"\$\s?\d", text), f"dollar amount in {p}"
        assert not re.search(r"(?i)n8n|zapier|fastest|#1\b|\bbest\b(?!-)|guaranteed|\busers?\b.*\b\d[\d,]* (?:users|customers)", text), p


@pytest.mark.parametrize("name", IN_SCOPE)
def test_memory_is_256(name):
    a = load(name, "actor.json")
    assert a["minMemoryMbytes"] == 256 and a["defaultRunOptions"]["memoryMbytes"] == 256


@pytest.mark.parametrize("name", IN_SCOPE)
def test_dataset_schema_is_wired_and_has_a_view(name):
    a, d = load(name, "actor.json"), load(name, "dataset_schema.json")
    assert a["storages"]["dataset"] == "./dataset_schema.json" and a["output"] == "./output_schema.json"
    assert load(name, "output_schema.json")["properties"]["results"]
    assert d["views"] and all(v["display"]["component"] == "table" and v["title"] for v in d["views"].values())
    props = d["fields"]["properties"]
    assert d["fields"]["required"] and set(d["fields"]["required"]) <= set(props)
    for k, v in props.items():
        assert v.get("type") and v.get("description"), k


def _type_ok(value, t):
    return {"array": isinstance(value, list), "string": isinstance(value, str), "boolean": isinstance(value, bool),
            "integer": isinstance(value, int) and not isinstance(value, bool), "object": isinstance(value, dict)}[t]


@pytest.mark.parametrize("name", IN_SCOPE)
def test_input_schema_descriptions_and_working_prefill(name):
    schema = load(name, "input_schema.json")
    props = schema["properties"]
    for k, p in props.items():
        assert p.get("title") and len(p.get("description", "")) >= 40, f"{k}: needs a real description"
        for key in ("default", "prefill"):
            if key in p:
                assert _type_ok(p[key], p["type"]), f"{k}.{key} has the wrong type"
                if p["type"] == "integer":
                    assert p.get("minimum", p[key]) <= p[key] <= p.get("maximum", p[key]), f"{k}.{key} out of range"
                if "enum" in p:
                    assert p[key] in p["enum"]
                if p["type"] == "array" and "enum" in p.get("items", {}):
                    assert set(p[key]) <= set(p["items"]["enum"])
    prefill = {k: p["prefill"] for k, p in props.items() if "prefill" in p}
    assert set(schema.get("required", [])) <= set(prefill), "every required input needs a prefill"
    assert prefill


@pytest.mark.parametrize("name", IN_SCOPE)
def test_code_uses_only_default_storages_and_no_token(name):
    for p in (ROOT / name / "src").glob("*.py"):
        text = p.read_text()
        assert set(re.findall(r"\bActor\.(\w+)", text)) <= ALLOWED_ACTOR_CALLS, (p, set(re.findall(r"\bActor\.(\w+)", text)))
        assert not re.search(r"apify_client|ApifyClient|new_client|open_dataset|open_key_value_store|open_request_queue|store_name|APIFY_TOKEN|APIFY_API|\.token\b|get_global_configuration", text), p
        env = set(re.findall(r"environ(?:\.get)?\(?\[?[\"'](\w+)[\"']", text)) | set(re.findall(r"getenv\([\"'](\w+)[\"']", text))
        assert env <= ALLOWED_ENV, (p, env)


def test_pagespeed_key_is_not_an_apify_permission():
    assert "not an Apify permission" in readme("bulk-pagespeed-checker")


def png_size(path: Path):
    data = path.read_bytes()
    assert data[:8] == b"\x89PNG\r\n\x1a\n"
    pos, size, idat, end = 8, None, b"", False
    while pos < len(data):
        n, tag = struct.unpack(">I4s", data[pos:pos + 8])
        body = data[pos + 8:pos + 8 + n]
        assert struct.unpack(">I", data[pos + 8 + n:pos + 12 + n])[0] == zlib.crc32(tag + body) & 0xFFFFFFFF, f"bad CRC in {tag}"
        if tag == b"IHDR":
            size = struct.unpack(">II", body[:8])
        elif tag == b"IDAT":
            idat += body
        elif tag == b"IEND":
            end = True
        pos += 12 + n
    assert end and size and zlib.decompress(idat)
    return size


def test_broken_link_auditor_logo():
    path = ROOT / "broken-link-auditor" / "logo.png"
    w, h = png_size(path)
    assert w == h and w >= 256
    for other in ("bulk-dns-email-auth-checker", "sitemap-url-extractor"):
        assert (ROOT / other / "logo.png").exists()  # same place as the other actors keep theirs


def test_logo_generator_reproduces_the_committed_file(tmp_path):
    import importlib.util
    spec = importlib.util.spec_from_file_location("logo", ROOT / "tools" / "make_broken_link_logo.py")
    m = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(m)
    assert m.png(m.render()) == (ROOT / "broken-link-auditor" / "logo.png").read_bytes()


def test_requirements_unchanged_and_no_pillow():
    for name in IN_SCOPE:
        assert "pillow" not in (ROOT / name / "requirements.txt").read_text().lower()


def test_sync_store_meta_text_keys_and_ids_unchanged():
    text = (ROOT / "tools" / "sync-store-meta.py").read_text()
    assert 'TEXT_KEYS = ("title", "description", "seoTitle", "seoDescription")' in text
