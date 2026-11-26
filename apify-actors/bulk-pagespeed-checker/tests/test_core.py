import asyncio
import json
import logging
import pathlib
import sys

import httpx
import pytest

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))
from src import core, runner  # noqa: E402
from src.polite import HostLimiter  # noqa: E402

SECRET = "AIzaSECRETKEY123"


def lh(extra_cats=None):
    cats = {"performance": {"score": 0.87}}
    cats.update(extra_cats or {})
    return {"categories": cats, "audits": {
        "largest-contentful-paint": {"numericValue": 2412.6}, "cumulative-layout-shift": {"numericValue": 0.04567},
        "total-blocking-time": {"numericValue": 120.2}, "first-contentful-paint": {"numericValue": 1200.0},
        "speed-index": {"numericValue": 3100.4}, "interactive": {"numericValue": 4000.0}}}


FULL = {"lighthouseResult": lh({"seo": {"score": 1.0}}),
        "loadingExperience": {"overall_category": "FAST", "metrics": {
            "LARGEST_CONTENTFUL_PAINT_MS": {"percentile": 2100, "category": "FAST"},
            "INTERACTION_TO_NEXT_PAINT": {"percentile": 180, "category": "FAST"},
            "CUMULATIVE_LAYOUT_SHIFT_SCORE": {"percentile": 5, "category": "FAST"}}},
        "originLoadingExperience": {"overall_category": "AVERAGE", "metrics": {
            "LARGEST_CONTENTFUL_PAINT_MS": {"percentile": 3000, "category": "AVERAGE"}}}}
NO_FIELD = {"lighthouseResult": lh(), "loadingExperience": {"id": "x", "initial_url": "x"}}
ORIGIN_ONLY = {"lighthouseResult": lh(), "loadingExperience": {"origin_fallback": True, "overall_category": "SLOW", "metrics": {
    "LARGEST_CONTENTFUL_PAINT_MS": {"percentile": 5000, "category": "SLOW"}}}}


@pytest.fixture(autouse=True)
def _no_env_key(monkeypatch):
    monkeypatch.delenv("PAGESPEED_API_KEY", raising=False)


async def nosleep(_):
    return None


def drive(inp, handler):
    pushed, statuses = [], []

    async def push(row, charge):
        pushed.append((row, charge))
        return False

    async def status(m):
        statuses.append(m)

    async def go():
        async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as c:
            return await runner.run(inp, client=c, push=push, set_status=status, sleep=nosleep, limiter=HostLimiter(0, sleep=nosleep))
    return asyncio.run(go()), pushed, statuses


def test_full_fixture_with_field_data():
    (ok, _), pushed, _ = drive({"urls": ["ex.com"], "apiKey": SECRET, "strategies": ["mobile"], "categories": ["performance", "seo"]},
                               lambda r: httpx.Response(200, json=FULL))
    row, charge = pushed[0]
    assert ok and charge and row["status"] == "ok" and row["url"] == "https://ex.com" and row["strategy"] == "mobile"
    assert row["scores"] == {"performance": 87, "seo": 100}
    assert row["labMetrics"] == {"lcpMs": 2413, "cls": 0.046, "tbtMs": 120, "fcpMs": 1200, "speedIndexMs": 3100, "ttiMs": 4000}
    assert row["fieldDataPresent"] is True
    assert row["fieldData"]["lcpMs"] == {"value": 2100, "category": "FAST"} and row["fieldData"]["cls"]["value"] == 0.05
    assert row["fieldData"]["inpMs"]["value"] == 180 and row["fieldData"]["overallCategory"] == "FAST"
    assert row["originFieldData"]["lcpMs"]["category"] == "AVERAGE"


def test_without_field_data_is_still_charged_ok():
    _, pushed, _ = drive({"urls": ["https://ex.com"], "apiKey": SECRET, "strategies": ["desktop"]}, lambda r: httpx.Response(200, json=NO_FIELD))
    row, charge = pushed[0]
    assert row["status"] == "ok" and charge and row["fieldDataPresent"] is False and row["fieldData"] is None and row["originFieldData"] is None


def test_origin_fallback_is_not_url_field_data():
    _, pushed, _ = drive({"urls": ["https://ex.com"], "apiKey": SECRET, "strategies": ["mobile"]}, lambda r: httpx.Response(200, json=ORIGIN_ONLY))
    row, _ = pushed[0]
    assert row["fieldDataPresent"] is False and row["fieldData"] is None and row["originFieldData"]["lcpMs"]["category"] == "SLOW"


def test_default_both_strategies_and_params():
    seen = []

    def h(req):
        seen.append(req.url.params)
        return httpx.Response(200, json=NO_FIELD)
    _, pushed, _ = drive({"urls": ["https://ex.com"], "apiKey": SECRET}, h)
    assert sorted(p["strategy"] for p in seen) == ["desktop", "mobile"] and seen[0].get_list("category") == ["PERFORMANCE"]
    assert seen[0]["key"] == SECRET and len(pushed) == 2


def test_429_then_success():
    n = {"c": 0}

    def h(req):
        n["c"] += 1
        return httpx.Response(429) if n["c"] == 1 else httpx.Response(200, json=FULL)
    _, pushed, _ = drive({"urls": ["https://ex.com"], "apiKey": SECRET, "strategies": ["mobile"]}, h)
    assert n["c"] == 2 and pushed[0][0]["status"] == "ok" and pushed[0][1] is True


def test_500_is_uncharged_error_row():
    _, pushed, _ = drive({"urls": ["https://ex.com"], "apiKey": SECRET, "strategies": ["mobile"]}, lambda r: httpx.Response(500, json={"error": {"message": "x"}}))
    row, charge = pushed[0]
    assert row["status"] == "error" and "500" in row["error"] and charge is False and row["scores"] == {}


def test_lighthouse_runtime_error_is_uncharged():
    bad = {"lighthouseResult": {"runtimeError": {"code": "FAILED_DOCUMENT_REQUEST"}}}
    _, pushed, _ = drive({"urls": ["https://ex.com"], "apiKey": SECRET, "strategies": ["mobile"]}, lambda r: httpx.Response(200, json=bad))
    assert pushed[0][0]["status"] == "error" and "FAILED_DOCUMENT_REQUEST" in pushed[0][0]["error"] and pushed[0][1] is False


def test_timeout_error_row_not_charged():
    def h(req):
        raise httpx.ReadTimeout("slow")
    _, pushed, _ = drive({"urls": ["https://ex.com"], "apiKey": SECRET, "strategies": ["mobile"]}, h)
    assert pushed[0][0]["error"] == "timeout" and pushed[0][1] is False


def test_key_never_in_logs_rows_or_status(caplog):
    caplog.set_level(logging.DEBUG)
    for code in (200, 500):
        caplog.clear()
        (ok, msg), pushed, statuses = drive({"urls": ["https://ex.com"], "strategies": ["mobile"], "apiKey": SECRET},
                                            lambda r: httpx.Response(code, json=FULL))
        blob = caplog.text + json.dumps(pushed) + msg + " ".join(statuses)
        assert SECRET not in blob
    # the key is really sent to Google
    seen = []
    drive({"urls": ["https://ex.com"], "strategies": ["mobile"], "apiKey": SECRET}, lambda r: (seen.append(r.url.params.get("key")), httpx.Response(200, json=FULL))[1])
    assert seen == [SECRET]


def test_key_not_in_transport_error_row():
    def h(req):
        raise httpx.ConnectError(f"failed {req.url}")
    _, pushed, _ = drive({"urls": ["https://ex.com"], "strategies": ["mobile"], "apiKey": SECRET}, h)
    assert SECRET not in json.dumps(pushed)


def test_api_key_is_optional_in_schema_and_missing_everywhere_fails():
    root = pathlib.Path(__file__).resolve().parents[1]
    schema = json.loads((root / ".actor" / "input_schema.json").read_text())
    assert schema["required"] == ["urls"] and schema["properties"]["apiKey"]["isSecret"] is True
    text = (json.dumps(schema) + (root / "README.md").read_text() + (root / "src" / "runner.py").read_text()).lower()
    assert "keyless" not in text and "without a key" not in text and "without it" not in text
    for inp in ({"urls": ["https://ex.com"]}, {"urls": ["https://ex.com"], "apiKey": "  "}):
        calls = []
        (ok, msg), pushed, _ = drive(inp, lambda r: (calls.append(1), httpx.Response(200, json=FULL))[1])
        assert not ok and "API key" in msg and pushed == [] and calls == []


def test_http_errors_get_plain_reasons():
    want = {400: "Bad API key or bad URL", 403: "not enabled for this API key", 500: "HTTP 500"}
    for code, text in want.items():
        _, pushed, _ = drive({"urls": ["https://ex.com"], "apiKey": SECRET, "strategies": ["mobile"]},
                             lambda r, c=code: httpx.Response(c, json={"error": {"message": f"bad key {SECRET}"}}))
        row, charge = pushed[0]
        assert row["status"] == "error" and text in row["error"] and charge is False and SECRET not in json.dumps(row)


def test_quota_429_stops_run_at_once(caplog):
    caplog.set_level(logging.DEBUG)
    n = {"c": 0}

    def h(req):
        n["c"] += 1
        return httpx.Response(429, json={"error": {"message": f"Quota exceeded {req.url}"}})
    urls = [f"https://ex{i}.com" for i in range(6)]
    (ok, msg), pushed, statuses = drive({"urls": urls, "apiKey": SECRET}, h)
    assert not ok and "Quota exceeded" in msg
    assert n["c"] <= 4 * 3 and len(pushed) <= 3  # only tests already in flight; the rest never start
    assert all(r["status"] == "error" and "Quota exceeded" in r["error"] and c is False for r, c in pushed)
    blob = caplog.text + json.dumps(pushed) + msg + " ".join(statuses)
    assert SECRET not in blob and "googleapis.com" not in blob


def test_quota_after_some_success_ends_with_status_not_failure():
    n = {"c": 0}

    def h(req):
        n["c"] += 1
        return httpx.Response(200, json=FULL) if n["c"] == 1 else httpx.Response(429)
    (ok, msg), pushed, _ = drive({"urls": [f"https://ex{i}.com" for i in range(8)], "apiKey": SECRET, "strategies": ["mobile"]}, h)
    assert ok and "Quota exceeded" in msg and pushed[0][1] is True and len(pushed) < 8


def test_empty_and_invalid_input_fails_without_charge():
    for inp in ({}, {"urls": []}, {"urls": ["", "mailto:a@b.c", "localhost"]}):
        (ok, msg), pushed, _ = drive(inp, lambda r: httpx.Response(200, json=FULL))
        assert not ok and "URL" in msg and pushed == []


def test_row_matches_dataset_schema():
    schema = json.loads((pathlib.Path(__file__).resolve().parents[1] / ".actor" / "dataset_schema.json").read_text())
    _, pushed, _ = drive({"urls": ["https://ex.com"], "apiKey": SECRET, "strategies": ["mobile"]}, lambda r: httpx.Response(200, json=FULL))
    assert set(pushed[0][0]) <= set(schema["fields"]["properties"])


ENV_KEY = "AIzaENVKEY456"
URL_INP = {"urls": ["https://ex.com"], "strategies": ["mobile"]}


def keys_sent(inp):
    seen = []
    res = drive(inp, lambda r: (seen.append(r.url.params.get("key")), httpx.Response(200, json=FULL))[1])
    return seen, res


def test_env_key_used_when_input_missing(monkeypatch):
    monkeypatch.setenv("PAGESPEED_API_KEY", ENV_KEY)
    seen, ((ok, _), _, _) = keys_sent(dict(URL_INP))
    assert ok and seen == [ENV_KEY]


@pytest.mark.parametrize("blank", ["", "   ", "\t\n", None])
def test_env_key_used_when_input_blank(monkeypatch, blank):
    monkeypatch.setenv("PAGESPEED_API_KEY", f"  {ENV_KEY} ")
    seen, ((ok, _), _, _) = keys_sent({**URL_INP, "apiKey": blank})
    assert ok and seen == [ENV_KEY]


def test_input_key_overrides_env(monkeypatch):
    monkeypatch.setenv("PAGESPEED_API_KEY", ENV_KEY)
    seen, ((ok, _), _, _) = keys_sent({**URL_INP, "apiKey": SECRET})
    assert ok and seen == [SECRET]


@pytest.mark.parametrize("env", [None, "", "  "])
def test_both_missing_keeps_existing_error(monkeypatch, env):
    if env is not None:
        monkeypatch.setenv("PAGESPEED_API_KEY", env)
    seen, ((ok, msg), pushed, _) = keys_sent({**URL_INP, "apiKey": "  "})
    assert not ok and msg == runner.KEY_MISSING and pushed == [] and seen == []


def test_env_and_input_keys_never_leak(monkeypatch, caplog):
    caplog.set_level(logging.DEBUG)
    monkeypatch.setenv("PAGESPEED_API_KEY", ENV_KEY)
    for inp in (dict(URL_INP), {**URL_INP, "apiKey": SECRET}):
        for code in (200, 500):
            caplog.clear()
            (ok, msg), pushed, statuses = drive(inp, lambda r: httpx.Response(code, json=FULL))
            blob = caplog.text + json.dumps(pushed) + msg + " ".join(statuses)
            assert ENV_KEY not in blob and SECRET not in blob

    def h(req):
        raise httpx.ConnectError(f"failed {req.url}")
    _, pushed, statuses = drive(dict(URL_INP), h)
    assert ENV_KEY not in json.dumps(pushed) + " ".join(statuses) + caplog.text


def rows_inp(n, **extra):
    return {"urls": [f"https://ex{i}.com" for i in range(n)], "strategies": ["mobile"], **extra}


def test_fallback_run_over_cap_processes_first_50_with_message(monkeypatch, caplog):
    caplog.set_level(logging.DEBUG)
    monkeypatch.setenv("PAGESPEED_API_KEY", ENV_KEY)
    seen, ((ok, msg), pushed, statuses) = keys_sent(rows_inp(60))
    assert ok and len(seen) == 50 and len(pushed) == 50
    assert "Free runs check up to 50 URL/strategy rows" in msg and "apiKey field to check more" in msg
    assert ENV_KEY not in msg + json.dumps(pushed) + " ".join(statuses) + caplog.text


@pytest.mark.parametrize("n", [1, 50])
def test_fallback_run_within_cap_has_no_message(monkeypatch, n):
    monkeypatch.setenv("PAGESPEED_API_KEY", ENV_KEY)
    seen, ((ok, msg), pushed, _) = keys_sent(rows_inp(n))
    assert ok and len(pushed) == n and "Free runs" not in msg


def test_blank_input_key_is_fallback_and_capped(monkeypatch):
    monkeypatch.setenv("PAGESPEED_API_KEY", ENV_KEY)
    seen, ((ok, msg), pushed, _) = keys_sent(rows_inp(60, apiKey="  "))
    assert len(pushed) == 50 and "Free runs" in msg


def test_own_key_has_no_cap(monkeypatch, caplog):
    caplog.set_level(logging.DEBUG)
    monkeypatch.setenv("PAGESPEED_API_KEY", ENV_KEY)
    seen, ((ok, msg), pushed, statuses) = keys_sent(rows_inp(60, apiKey=SECRET))
    assert ok and len(pushed) == 60 and set(seen) == {SECRET} and "Free runs" not in msg
    assert SECRET not in msg + json.dumps(pushed) + " ".join(statuses) + caplog.text


def test_cap_env_override_and_bad_values(monkeypatch):
    monkeypatch.setenv("PAGESPEED_API_KEY", ENV_KEY)
    monkeypatch.setenv("PAGESPEED_FALLBACK_ROW_CAP", "5")
    _, ((ok, msg), pushed, _) = keys_sent(rows_inp(8))
    assert len(pushed) == 5 and "up to 5 URL/strategy rows" in msg
    monkeypatch.setenv("PAGESPEED_FALLBACK_ROW_CAP", "junk")
    assert runner.fallback_row_cap() == 50
    monkeypatch.setenv("PAGESPEED_FALLBACK_ROW_CAP", "0")
    assert runner.fallback_row_cap() == 50


def test_cap_is_not_an_input_field():
    schema = json.loads((pathlib.Path(__file__).resolve().parents[1] / ".actor/input_schema.json").read_text())
    assert not any("cap" in k.lower() for k in schema["properties"])
