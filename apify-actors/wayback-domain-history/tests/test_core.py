import asyncio
import json
import pathlib
import sys

import httpx

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))
from src import core, runner  # noqa: E402
from src.polite import HostLimiter  # noqa: E402

CDX_MULTI = [["timestamp", "statuscode", "original"],
             ["20040101000000", "200", "http://x.com/"], ["20040601000000", "200", "http://x.com/"],
             ["20050101000000", "200", "http://x.com/"], ["20100101000000", "200", "http://x.com/"],
             ["20170101000000", "301", "https://x.com/"], ["20250301000000", "301", "https://x.com/"],
             ["20250401000000", "301", "https://x.com/"]]


def make_client(handler):
    return httpx.AsyncClient(transport=httpx.MockTransport(handler))


async def nosleep(_):
    return None


def drive(inp, handler, **kw):
    pushed = []

    async def push(row, charge):
        pushed.append((row, charge))
        return False

    async def status(_):
        return None

    async def go():
        async with make_client(handler) as c:
            return await runner.run(inp, client=c, push=push, set_status=status, sleep=nosleep,
                                    limiter=HostLimiter(0, sleep=nosleep), **kw)
    return asyncio.run(go()), pushed


def test_clean_domain():
    assert core.clean_domain("https://www.X.com/path") == "x.com"
    assert core.clean_domain("  Sub.Example.CO.UK:8080/a?b ") == "sub.example.co.uk"
    assert core.clean_domain("not a domain") is None and core.clean_domain("") is None and core.clean_domain(5) is None


def test_multi_year_stats_and_summary():
    rows, key = core.parse_cdx_page(CDX_MULTI)
    assert key is None and len(rows) == 7
    s = core.analyse(rows, 1)
    assert s["firstSeen"] == "2004-01-01" and s["lastSeen"] == "2025-04-01" and s["totalSnapshots"] == 7
    assert s["snapshotsPerYear"]["2004"] == 2 and s["statusCounts"]["3xx"] == 3 and s["statusCounts"]["2xx"] == 4
    assert s["yearsWithCaptures"] == [2004, 2005, 2010, 2017, 2025]
    assert s["sampleSnapshots"]["2025"] == ["https://web.archive.org/web/20250301000000/https://x.com/"]
    text = core.summarize(s)
    assert text.startswith("Archived 2004–2025, 7 captures, mostly 200") and "gap 2018–2024" in text and "recent captures redirect" in text


def test_sample_count():
    rows, _ = core.parse_cdx_page(CDX_MULTI)
    assert len(core.analyse(rows, 2)["sampleSnapshots"]["2004"]) == 2


def test_resume_key_paging():
    calls = []

    def handler(req):
        calls.append(dict(req.url.params))
        if req.url.host == "archive.org":
            return httpx.Response(200, json={})
        if "resumeKey" not in req.url.params:
            return httpx.Response(200, json=[["timestamp", "statuscode", "original"], ["20200101000000", "200", "http://a.com/"], [], ["KEY1"]])
        return httpx.Response(200, json=[["timestamp", "statuscode", "original"], ["20210101000000", "404", "http://a.com/"]])
    (ok, _), pushed = drive({"domains": ["a.com"]}, handler)
    assert ok and len(calls) == 2 and calls[1]["resumeKey"] == "KEY1"
    row, charge = pushed[0]
    assert row["totalSnapshots"] == 2 and row["statusCounts"]["4xx"] == 1 and charge


def test_zero_captures_is_a_charged_row():
    def handler(req):
        if req.url.host == "archive.org":
            return httpx.Response(200, json={"archived_snapshots": {}})
        return httpx.Response(200, json=[])
    (ok, _), pushed = drive({"domains": ["none.com"]}, handler)
    row, charge = pushed[0]
    assert ok and row["status"] == "no_snapshots" and row["totalSnapshots"] == 0 and charge


def test_availability_second_opinion():
    def handler(req):
        if req.url.host == "archive.org":
            return httpx.Response(200, json={"archived_snapshots": {"closest": {"available": True, "url": "http://web.archive.org/web/20190505000000/http://b.com/"}}})
        return httpx.Response(200, json=[])
    _, pushed = drive({"domains": ["b.com"]}, handler)
    assert pushed[0][0]["status"] == "ok" and pushed[0][0]["firstSeen"] == "2019-05-05"


def test_500_retries_then_uncharged_error_row():
    n = {"c": 0}

    def handler(req):
        n["c"] += 1
        return httpx.Response(500, text="boom")
    (ok, _), pushed = drive({"domains": ["down.com"]}, handler)
    row, charge = pushed[0]
    assert ok and n["c"] == 4 and row["status"] == "error" and "500" in row["error"] and charge is False


def test_429_then_success():
    n = {"c": 0}

    def handler(req):
        n["c"] += 1
        if n["c"] == 1:
            return httpx.Response(429, headers={"retry-after": "1"})
        return httpx.Response(200, json=CDX_MULTI)
    _, pushed = drive({"domains": ["x.com"]}, handler)
    assert pushed[0][0]["status"] == "ok" and pushed[0][1] is True


def test_timeout_row_not_charged():
    async def slow(*a, **k):
        await asyncio.sleep(5)
    orig = runner.check_domain
    runner.check_domain = slow
    try:
        _, pushed = drive({"domains": ["slow.com"]}, lambda r: httpx.Response(200), per_domain_timeout=0.05)
    finally:
        runner.check_domain = orig
    assert pushed[0][0]["error"] == "timeout" and pushed[0][1] is False


def test_empty_and_invalid_input_not_charged():
    for inp in ({}, {"domains": []}, {"domains": ["???", ""]}):
        (ok, msg), pushed = drive(inp, lambda r: httpx.Response(200, json=[]))
        assert not ok and "domain" in msg.lower() and pushed == []


def test_dedupe_and_invalid_skipped():
    (ok, msg), pushed = drive({"domains": ["https://www.a.com/x", "A.com", "bad bad"]}, lambda r: httpx.Response(200, json=[["timestamp", "statuscode", "original"], ["20200101000000", "200", "http://a.com/"]]))
    assert ok and len(pushed) == 1 and "1 invalid" in msg


def test_row_matches_dataset_schema():
    schema = json.loads((pathlib.Path(__file__).resolve().parents[1] / ".actor" / "dataset_schema.json").read_text())
    props = set(schema["fields"]["properties"])
    rows, _ = core.parse_cdx_page(CDX_MULTI)
    row = {"domain": "x.com", "status": "ok", "error": None, **core.public_row(core.analyse(rows)), "summary": "s", "checkedAt": "t"}
    assert set(row) <= props
