"""Each in-scope actor's real main() runs offline; every row it pushes must match its dataset schema.

Checks per row: keys are a subset of the schema properties, every schema property is present (the schema has no
optional properties: error rows are built from the same template), and each value has a type the schema declares.
Also runs the actor on the prefilled and example inputs from its input schema, which must work.
"""
import pytest

from fakes import ROOT, load_json, run_actor, type_ok

IN_SCOPE = ["broken-link-auditor", "bulk-dns-email-auth-checker", "bulk-domain-availability-checker",
            "bulk-pagespeed-checker", "domain-checkup-report", "sitemap-url-extractor"]

# Extra inputs per actor, on top of the prefilled input, to reach other code paths. (label, overrides)
VARIANTS = {
    "broken-link-auditor": [("list", {}), ("crawl", {"mode": "crawl", "maxDepth": 1, "checkExternal": True}),
                            ("sitemap", {"mode": "sitemap", "startUrls": ["https://apify.com"]})],
    "bulk-dns-email-auth-checker": [("prefill", {}), ("nxdomain", {"domains": ["quietbluefalcon.com", "example.com"], "includeRecords": False})],
    "bulk-domain-availability-checker": [("domains", {}), ("keywords", {"domains": [], "keywords": ["rentguitar"], "tlds": ["com", "io"], "prefixes": ["get"]}),
                                         ("rdap-for-taken", {"lookupRegistered": True}), ("only-available", {"onlyAvailable": True})],
    "bulk-pagespeed-checker": [("prefill", {})],
    "domain-checkup-report": [("prefill", {}), ("dns-only", {"lookupRdap": False, "fetchLandingPage": False})],
    "sitemap-url-extractor": [("prefill", {}), ("status", {"checkStatus": True})],
}


def input_schema(name):
    return load_json(ROOT / name / ".actor" / "input_schema.json")


def base_input(name):
    """The input Console would start with: every prefill value."""
    return {k: v["prefill"] for k, v in input_schema(name)["properties"].items() if "prefill" in v}


def cases():
    for name in IN_SCOPE:
        for label, extra in VARIANTS[name]:
            yield pytest.param(name, {**base_input(name), **extra}, id=f"{name}:{label}")


@pytest.mark.parametrize("name,inp", list(cases()))
def test_rows_match_dataset_schema(name, inp, monkeypatch):
    fake = run_actor(name, inp, monkeypatch)
    assert fake.failed is None, fake.failed
    props = load_json(ROOT / name / ".actor" / "dataset_schema.json")["fields"]["properties"]
    assert fake.rows, "the run produced no rows"
    for row in fake.rows:
        keys = set(row)
        assert keys <= set(props), f"keys missing from dataset schema: {sorted(keys - set(props))}"
        assert set(props) <= keys, f"schema properties missing from the row: {sorted(set(props) - keys)}"
        for k, v in row.items():
            assert type_ok(v, props[k]["type"]), f"{name}.{k}: {v!r} is not {props[k]['type']}"


@pytest.mark.parametrize("name", IN_SCOPE)
def test_input_examples_work(name, monkeypatch):
    """The `example` values of the input schema (on top of the prefill) must start a run that does not fail."""
    schema = input_schema(name)
    inp = base_input(name)
    inp.update({k: v["example"] for k, v in schema["properties"].items() if "example" in v})
    if name == "bulk-domain-availability-checker":
        inp["domains"] = inp.get("domains", [])
    fake = run_actor(name, inp, monkeypatch)
    assert fake.failed is None, fake.failed


def test_every_variant_table_covers_all_actors():
    assert set(VARIANTS) == set(IN_SCOPE)
