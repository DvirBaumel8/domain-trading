"""Repo-wide contract for every actor (offline): charging, empty input, row shape, no prices, store sync."""
import importlib.util
import json
import re
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
ACTORS = sorted(p.parent.parent.name for p in ROOT.glob("*/.actor/actor.json"))
PRICE = re.compile(r"(?<!\\)\$\s?\d|eventTieredPricingUsd|pricePerUnit|pricingPerEvent")


@pytest.mark.parametrize("name", ACTORS)
def test_charge_once_per_row_and_empty_input_fails(name):
    src = (ROOT / name / "src" / "main.py").read_text()
    assert len(re.findall(r"charged_event_name=", src)) == 1, "one charged push_data call"
    assert re.search(r"charged_event_name='(result|report)'", src)
    assert "Actor.fail(" in src and "status_message=" in src, "empty input fails with a message"


@pytest.mark.parametrize("name", ACTORS)
def test_json_files_valid_and_schema_links(name):
    d = ROOT / name / ".actor"
    actor = json.loads((d / "actor.json").read_text())
    for key in ("name", "title", "description", "version"):
        assert actor.get(key), key
    for f in ("input_schema.json", "dataset_schema.json", "output_schema.json"):
        json.loads((d / f).read_text())
    assert (ROOT / name / "CHANGELOG.md").exists() or actor["version"] != "0.1.0" or name in OLD


OLD = {"domain-checkup-report", "bulk-dns-email-auth-checker", "sitemap-url-extractor", "bulk-domain-availability-checker"}


@pytest.mark.parametrize("name", ACTORS)
def test_no_hard_coded_prices(name):
    for p in list((ROOT / name / "src").glob("*.py")) + list((ROOT / name / ".actor").glob("*.json")):
        text = p.read_text()
        assert not PRICE.search(text), f"price literal in {p}"


def _load_sync():
    spec = importlib.util.spec_from_file_location("sync_store_meta", ROOT / "tools" / "sync-store-meta.py")
    m = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(m)
    return m


def test_sync_store_meta_sends_only_text_keys():
    m = _load_sync()
    calls = []
    store = {}

    def http(method, path, token, body=None):
        calls.append((method, path, body))
        if method == "PUT":
            store.update(body)
        return dict(store, pricingInfos=[{"x": 1}], isPublic=False)

    name = "sitemap-url-extractor"
    assert m.sync(name, "ID1", "tok", http) == []
    put = [c for c in calls if c[0] == "PUT"][0]
    assert set(put[2]) <= set(m.TEXT_KEYS)
    assert not {"pricingInfos", "isPublic", "isDeprecated", "pricingModel"} & set(put[2])


def test_sync_store_meta_detects_difference():
    m = _load_sync()
    assert m.sync("sitemap-url-extractor", "ID1", "tok", lambda me, p, t, b=None: {"title": "other"}) != []


def _load_guard():
    spec = importlib.util.spec_from_file_location("guard", ROOT / "tools" / "bot-text-guard.py")
    m = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(m)
    return m


def test_bot_guard_allows_text_only():
    g = _load_guard()
    old = json.dumps({"title": "a", "version": "0.1.0", "properties": {"x": {"type": "string", "title": "t", "prefill": "1"}}})
    new = json.dumps({"title": "b", "version": "0.1.0", "properties": {"x": {"type": "string", "title": "u", "prefill": "2"}}})
    shows = lambda p, w: old if w == "old" else new  # noqa: E731
    assert g.check_files(["apify-actors/a/README.md", "docs/requests/x.md", "apify-actors/a/.actor/input_schema.json"], shows) == []


def test_bot_guard_blocks_code_and_non_text_keys():
    g = _load_guard()
    old = json.dumps({"version": "0.1.0", "properties": {"x": {"type": "string"}}})
    new = json.dumps({"version": "0.2.0", "properties": {"x": {"type": "integer"}}})
    shows = lambda p, w: old if w == "old" else new  # noqa: E731
    out = g.check_files(["apify-actors/a/src/main.py", "src/app.ts", "apify-actors/a/.actor/actor.json"], shows)
    assert "apify-actors/a/src/main.py" in out and "src/app.ts" in out
    assert any("version" in o for o in out) and any("type" in o for o in out)


def test_polite_copies_identical():
    ref = (ROOT / "shared" / "polite.py").read_text()
    for p in ROOT.glob("*/src/polite.py"):
        assert p.read_text() == ref, p
