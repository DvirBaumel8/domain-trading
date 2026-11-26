import asyncio
import json
import logging
import pathlib
import sys

import httpx

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
    (ok, _), pushed, _ = drive({"urls": ["ex.com"], "strategies": ["mobile"], "categories": ["performance", "seo"]},
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
    _, pushed, _ = drive({"urls": ["https://ex.com"], "strategies": ["desktop"]}, lambda r: httpx.Response(200, json=NO_FIELD))
    row, charge = pushed[0]
    assert row["status"] == "ok" and charge and row["fieldDataPresent"] is False and row["fieldData"] is None and row["originFieldData"] is None


def test_origin_fallback_is_not_url_field_data():
    _, pushed, _ = drive({"urls": ["https://ex.com"], "strategies": ["mobile"]}, lambda r: httpx.Response(200, json=ORIGIN_ONLY))
    row, _ = pushed[0]
    assert row["fieldDataPresent"] is False and row["fieldData"] is None and row["originFieldData"]["lcpMs"]["category"] == "SLOW"


def test_default_both_strategies_and_params():
    seen = []

    def h(req):
        seen.append(req.url.params)
        return httpx.Response(200, json=NO_FIELD)
    _, pushed, _ = drive({"urls": ["https://ex.com"]}, h)
    assert sorted(p["strategy"] for p in seen) == ["desktop", "mobile"] and seen[0].get_list("category") == ["PERFORMANCE"]
    assert "key" not in seen[0] and len(pushed) == 2


def test_429_then_success():
    n = {"c": 0}

    def h(req):
        n["c"] += 1
        return httpx.Response(429) if n["c"] == 1 else httpx.Response(200, json=FULL)
    _, pushed, _ = drive({"urls": ["https://ex.com"], "strategies": ["mobile"]}, h)
    assert n["c"] == 2 and pushed[0][0]["status"] == "ok" and pushed[0][1] is True


def test_500_is_uncharged_error_row():
    _, pushed, _ = drive({"urls": ["https://ex.com"], "strategies": ["mobile"]}, lambda r: httpx.Response(500, json={"error": {"message": "x"}}))
    row, charge = pushed[0]
    assert row["status"] == "error" and "500" in row["error"] and charge is False and row["scores"] == {}


def test_lighthouse_runtime_error_is_uncharged():
    bad = {"lighthouseResult": {"runtimeError": {"code": "FAILED_DOCUMENT_REQUEST"}}}
    _, pushed, _ = drive({"urls": ["https://ex.com"], "strategies": ["mobile"]}, lambda r: httpx.Response(200, json=bad))
    assert pushed[0][0]["status"] == "error" and "FAILED_DOCUMENT_REQUEST" in pushed[0][0]["error"] and pushed[0][1] is False


def test_timeout_error_row_not_charged():
    def h(req):
        raise httpx.ReadTimeout("slow")
    _, pushed, _ = drive({"urls": ["https://ex.com"], "strategies": ["mobile"]}, h)
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


def test_status_message_mentions_keyless():
    _, _, st = drive({"urls": ["https://ex.com"], "strategies": ["mobile"]}, lambda r: httpx.Response(200, json=NO_FIELD))
    assert "keyless" in st[0].lower()
    _, _, st = drive({"urls": ["https://ex.com"], "strategies": ["mobile"], "apiKey": SECRET}, lambda r: httpx.Response(200, json=NO_FIELD))
    assert "keyless" not in st[0].lower() and SECRET not in st[0]


def test_empty_and_invalid_input_fails_without_charge():
    for inp in ({}, {"urls": []}, {"urls": ["", "mailto:a@b.c", "localhost"]}):
        (ok, msg), pushed, _ = drive(inp, lambda r: httpx.Response(200, json=FULL))
        assert not ok and "URL" in msg and pushed == []


def test_row_matches_dataset_schema():
    schema = json.loads((pathlib.Path(__file__).resolve().parents[1] / ".actor" / "dataset_schema.json").read_text())
    _, pushed, _ = drive({"urls": ["https://ex.com"], "strategies": ["mobile"]}, lambda r: httpx.Response(200, json=FULL))
    assert set(pushed[0][0]) <= set(schema["fields"]["properties"])
