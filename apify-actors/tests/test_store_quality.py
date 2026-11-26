"""Store text, README first screen, schemas, permissions and logo checks for the in-scope actors (offline)."""
import re
import struct
import zlib

import pytest

from fakes import ROOT, load_json

IN_SCOPE = ["broken-link-auditor", "bulk-dns-email-auth-checker", "bulk-domain-availability-checker",
            "bulk-pagespeed-checker", "domain-checkup-report", "sitemap-url-extractor"]
ALL_ACTORS = sorted(p.parent.parent.name for p in ROOT.glob("*/.actor/actor.json"))
DOLLAR = re.compile(r"\$\s?\d")
BANNED = re.compile(r"fastest|#1\b|best-in-class|\bn8n\b|Zapier|\d+\s?%\s+accura", re.I)
PERMISSIONS = "This Actor needs only limited permissions: it reads its input and writes to its own default dataset."
# Properties of nested objects that the README "Returns" paragraph may name without being dataset columns.
NESTED = {"bulk-pagespeed-checker": {"lcpMs", "cls", "tbtMs", "fcpMs", "speedIndexMs", "ttiMs"}}


def actor(name):
    return load_json(ROOT / name / ".actor" / "actor.json")


def readme(name):
    return (ROOT / name / "README.md").read_text()


@pytest.mark.parametrize("name", ALL_ACTORS)
def test_memory_stays_256(name):
    a = actor(name)
    assert a["minMemoryMbytes"] == 256 and a["defaultRunOptions"]["memoryMbytes"] == 256


@pytest.mark.parametrize("name", IN_SCOPE)
def test_store_text_limits(name):
    a = actor(name)
    assert a["name"] == name
    assert len(a["title"]) < 60, len(a["title"])
    assert len(a["seoTitle"]) <= 60, len(a["seoTitle"])
    assert len(a["seoDescription"]) <= 160, len(a["seoDescription"])
    assert len(a["description"]) <= 300, len(a["description"])


def test_seo_limits_hold_for_every_actor():
    for name in ALL_ACTORS:
        a = actor(name)
        assert len(a.get("seoTitle", "")) <= 60 and len(a.get("seoDescription", "")) <= 160, name


@pytest.mark.parametrize("name", IN_SCOPE)
def test_titles_tell_the_same_story(name):
    a = actor(name)
    assert load_json(ROOT / name / ".actor" / "input_schema.json")["title"] == a["title"] + " input"
    assert load_json(ROOT / name / ".actor" / "output_schema.json")["title"] == a["title"] + " output"
    lines = readme(name).splitlines()
    assert lines[0] == "# " + a["title"], "README H1 must equal the actor title"
    assert sum(1 for l in lines if l.startswith("# ")) == 1


@pytest.mark.parametrize("name", IN_SCOPE)
def test_readme_first_screen(name):
    text = readme(name)
    head = text.split("\n## ", 1)[0]
    assert len(head.splitlines()) <= 30
    assert "**Returns**" in head and "**Cost:**" in head and "```json" in head
    assert "See the Pricing tab" in head
    # the Returns paragraph only names real output fields
    returns = re.search(r"\*\*Returns\*\*(.*?)\n\n", head, re.S).group(1)
    props = set(load_json(ROOT / name / ".actor" / "dataset_schema.json")["fields"]["properties"])
    named = set(re.findall(r"`([A-Za-z]+)`", returns))
    assert named and named <= props | NESTED.get(name, set()), sorted(named - props)


@pytest.mark.parametrize("name", IN_SCOPE)
def test_no_prices_or_big_claims_in_text(name):
    files = [ROOT / name / "README.md", *(ROOT / name / ".actor").glob("*.json")]
    for f in files:
        text = f.read_text()
        assert not DOLLAR.search(text), f"dollar amount in {f}"
        assert not BANNED.search(text), f"banned claim in {f}: {BANNED.search(text).group(0)}"


@pytest.mark.parametrize("name", IN_SCOPE)
def test_cost_is_described_without_numbers(name):
    text = readme(name)
    assert "pay per result" in text.lower() or "pay per" in text.lower()
    assert "See the Pricing tab" in text


@pytest.mark.parametrize("name", IN_SCOPE)
def test_permissions_section(name):
    text = readme(name)
    headings = [l for l in text.splitlines() if l.startswith("## ")]
    assert headings[-1] == "## Permissions", "Permissions is the last section"
    assert PERMISSIONS in text.split("\n## Permissions\n", 1)[1]


def test_pagespeed_readme_states_the_real_cap():
    from_code = (ROOT / "bulk-pagespeed-checker" / "src" / "runner.py").read_text()
    cap = re.search(r"DEFAULT_FALLBACK_ROW_CAP\s*=\s*(\d+)", from_code).group(1)
    text = readme("bulk-pagespeed-checker")
    assert f"at most {cap} URL/strategy rows" in text
    desc = load_json(ROOT / "bulk-pagespeed-checker" / ".actor" / "input_schema.json")["properties"]["apiKey"]["description"]
    assert f"at most {cap} URL/strategy rows" in desc


# --- limited permissions: the code uses only the default dataset and key-value store -----------------------------------

ALLOWED_ACTOR_CALLS = {"get_input", "push_data", "fail", "charge", "set_status_message", "set_value", "log"}
FORBIDDEN_IN_SRC = [r"ApifyClient", r"apify_client", r"new_client", r"open_dataset", r"open_key_value_store",
                    r"open_request_queue", r"get_value\(", r"APIFY_[A-Z_]*TOKEN", r"api_token|auth_token|access_token|bearer", r"Actor\.config",
                    r"store_id", r"dataset_id", r"\.call\(", r"\.start\(", r"Actor\.metamorph", r"Actor\.reboot"]


@pytest.mark.parametrize("name", IN_SCOPE)
def test_src_uses_only_default_storages_and_basic_actor_calls(name):
    for f in sorted((ROOT / name / "src").glob("*.py")):
        text = f.read_text()
        for pat in FORBIDDEN_IN_SRC:
            assert not re.search(pat, text, re.I), f"{f.name}: forbidden use of {pat}"
        used = set(re.findall(r"\bActor\.([A-Za-z_]+)", text))
        assert used <= ALLOWED_ACTOR_CALLS, f"{f.name}: unexpected Actor calls {sorted(used - ALLOWED_ACTOR_CALLS)}"


def test_every_charge_goes_through_push_data():
    for name in IN_SCOPE:
        src = (ROOT / name / "src" / "main.py").read_text()
        assert "Actor.charge(" not in src, "charging happens only through push_data(charged_event_name=...)"


# --- schemas ----------------------------------------------------------------------------------------------------------

@pytest.mark.parametrize("name", IN_SCOPE)
def test_actor_json_wires_the_schemas(name):
    a = actor(name)
    assert a["storages"]["dataset"] == "./dataset_schema.json"
    assert a["output"] == "./output_schema.json" and a["input"] == "./input_schema.json"
    out = load_json(ROOT / name / ".actor" / "output_schema.json")
    assert "apiDefaultDatasetUrl" in out["properties"]["results"]["template"]


@pytest.mark.parametrize("name", IN_SCOPE)
def test_dataset_schema_is_described_and_has_a_table_view(name):
    ds = load_json(ROOT / name / ".actor" / "dataset_schema.json")
    props = ds["fields"]["properties"]
    for key, p in props.items():
        assert p.get("type") and len(p.get("description", "")) >= 15, f"{key} needs a type and a description"
    view = ds["views"]["overview"]
    fields = view["transformation"]["fields"]
    assert view["title"] and set(fields) <= set(props)
    assert view["display"]["component"] == "table"
    assert set(view["display"]["properties"]) == set(fields)
    assert all(v["label"] for v in view["display"]["properties"].values())


def _valid_value(spec, value):
    t = spec["type"]
    if t == "array":
        assert isinstance(value, list) and all(isinstance(x, str) for x in value)
        enum = spec.get("items", {}).get("enum")
        if enum:
            assert set(value) <= set(enum)
    elif t == "string":
        assert isinstance(value, str)
        if "enum" in spec:
            assert value in spec["enum"]
    elif t == "boolean":
        assert isinstance(value, bool)
    elif t == "integer":
        assert isinstance(value, int) and not isinstance(value, bool)
        assert spec.get("minimum", value) <= value <= spec.get("maximum", value)


@pytest.mark.parametrize("name", IN_SCOPE)
def test_input_schema_properties_are_documented(name):
    schema = load_json(ROOT / name / ".actor" / "input_schema.json")
    assert len(schema["description"]) >= 40
    for key, spec in schema["properties"].items():
        assert spec.get("title") and len(spec.get("description", "")) >= 40, f"{key}: needs a title and a real description"
        if spec.get("isSecret"):
            assert "example" not in spec and "prefill" not in spec and "default" not in spec, "no sample secret"
            continue
        samples = [spec[k] for k in ("prefill", "example", "default") if k in spec]
        assert samples, f"{key}: needs a prefill, example or default"
        for v in samples:
            _valid_value(spec, v)
    for key in schema.get("required", []):
        assert "prefill" in schema["properties"][key], f"required field {key} needs a working prefill"


@pytest.mark.parametrize("name", IN_SCOPE)
def test_readme_input_example_uses_real_input_fields(name):
    import json
    schema = load_json(ROOT / name / ".actor" / "input_schema.json")
    blocks = re.findall(r"```json\n(.*?)```", readme(name), re.S)
    first = json.loads(blocks[0])
    assert set(first) <= set(schema["properties"]) and set(schema.get("required", [])) <= set(first)
    for b in blocks:
        try:
            data = json.loads(b)
        except ValueError:
            continue
        if isinstance(data, dict) and set(data) & set(schema["properties"]):
            assert set(data) <= set(schema["properties"]) | set(load_json(ROOT / name / ".actor" / "dataset_schema.json")["fields"]["properties"]), b
            if set(data) <= set(schema["properties"]):
                for k, v in data.items():
                    _valid_value(schema["properties"][k], v)


# --- logos ------------------------------------------------------------------------------------------------------------

def png_size(path):
    data = path.read_bytes()
    assert data[:8] == b"\x89PNG\r\n\x1a\n", "not a PNG"
    pos, size, seen = 8, None, []
    while pos < len(data):
        n, tag = struct.unpack(">I4s", data[pos:pos + 8])
        body = data[pos + 8:pos + 8 + n]
        assert zlib.crc32(tag + body) & 0xFFFFFFFF == struct.unpack(">I", data[pos + 8 + n:pos + 12 + n])[0], f"bad CRC in {tag!r}"
        seen.append(tag)
        if tag == b"IHDR":
            size = struct.unpack(">II", body[:8])
        pos += 12 + n
    assert seen[0] == b"IHDR" and seen[-1] == b"IEND" and b"IDAT" in seen
    return size


LOGO_ACTORS = [n for n in IN_SCOPE if (ROOT / n / "logo.png").exists() or n == "broken-link-auditor"]


@pytest.mark.parametrize("name", LOGO_ACTORS)
def test_logo_is_a_square_png_of_at_least_256px(name):
    w, h = png_size(ROOT / name / "logo.png")
    assert w == h and w >= 256


def test_broken_link_logo_is_512px():
    assert "broken-link-auditor" in LOGO_ACTORS
    assert png_size(ROOT / "broken-link-auditor" / "logo.png") == (512, 512)


def test_actor_requirements_have_no_image_library():
    for name in IN_SCOPE:
        reqs = (ROOT / name / "requirements.txt").read_text().lower()
        assert "pillow" not in reqs and "pil" not in reqs.split()
