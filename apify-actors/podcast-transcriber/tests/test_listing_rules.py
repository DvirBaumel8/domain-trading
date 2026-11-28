"""U-28 to U-30 for this Actor (the repo-wide tests in apify-actors/tests cover the shared listing rules too)."""
import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DRAFT = ROOT.parents[1] / "docs" / "requests" / "podcast-transcriber" / "listing"


def load(rel):
    return json.loads((ROOT / ".actor" / rel).read_text())


def test_u28_listing_text_lengths_and_first_screen():
    a = load("actor.json")
    assert (len(a["title"]), len(a["seoTitle"]), len(a["seoDescription"])) == (55, 53, 140)
    text = (ROOT / "README.md").read_text()
    first = text.split("\n## ", 1)[0]
    assert len(first.strip().splitlines()) == 11
    assert "**Returns**" in first and "**Cost:**" in first and "Pricing tab" in first
    sections = text.strip().split("\n## ")
    assert sections[-1].startswith("Permissions") or sections[-1].startswith("Deploying from the repo")


def test_u28_bot_drafts_copied_unchanged():
    if not DRAFT.exists():
        return
    draft = (DRAFT / "README.draft.md").read_text()
    readme = (ROOT / "README.md").read_text()
    assert readme.startswith(draft)
    extra = readme[len(draft):]
    assert not extra.strip() or extra.lstrip().startswith("## Deploying from the repo")
    a = load("actor.json")
    for k, v in json.loads((DRAFT / "actor-text.json").read_text()).items():
        if k == "description":  # the draft is 414 characters; Apify takes at most 300, so DOM shortened it (told Gavriel)
            assert len(a[k]) <= 300
            continue
        assert a[k] == v, k
    prefill = {k: p["prefill"] for k, p in load("input_schema.json")["properties"].items() if "prefill" in p}
    assert prefill == json.loads((DRAFT / "example-input.json").read_text())


def test_u28_schemas():
    i = load("input_schema.json")
    assert set(i["required"]) == {"sources", "confirmRights"}
    assert i["properties"]["sources"]["editor"] == "stringList"
    d = load("dataset_schema.json")["fields"]
    assert set(d["required"]) == {"source", "status"}
    assert load("output_schema.json")["properties"]["results"]
    a = load("actor.json")
    assert a["minMemoryMbytes"] == 512 and a["defaultRunOptions"] == {"memoryMbytes": 1024, "timeoutSecs": 7200}
    assert a["maxMemoryMbytes"] == 4096


def test_u29_no_price_anywhere_in_the_folder():
    price = re.compile(r"(?<!\\)\$\s?\d|eventTieredPricingUsd|pricePerUnit|pricingPerEvent")
    for p in [ROOT / "README.md", ROOT / "CHANGELOG.md", *ROOT.glob("src/*.py"), *ROOT.glob(".actor/*.json")]:
        assert not price.search(p.read_text()), p


def test_u30_dockerfile():
    d = (ROOT / "Dockerfile").read_text()
    assert d.startswith("FROM apify/actor-python:3.13")
    assert re.search(r"apt-get install[^\n]*\bffmpeg\b", d) and "ffprobe -version" in d
    assert d.index("USER root") < d.index("ffmpeg") < d.index("USER myuser")
    assert "compileall -q src/" in d
    assert "pillow" not in (ROOT / "requirements.txt").read_text().lower()


def test_version_and_changelog():
    assert load("actor.json")["version"] == "0.1"
    assert "## 0.1.0" in (ROOT / "CHANGELOG.md").read_text()


def test_actor_json_references_assemblyai_secret_by_name_only():
    a = load("actor.json")
    assert a["environmentVariables"] == {"ASSEMBLYAI_API_KEY": "@assemblyaiApiKey"}
    raw = (ROOT / ".actor" / "actor.json").read_text()
    assert not re.search(r"AIza|sk-[A-Za-z0-9]|gsk_|[0-9a-f]{32}|[A-Za-z0-9_-]{40,}", raw)
    assert raw.count("@") == 1
