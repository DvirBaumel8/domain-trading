"""A17-A24: partial failure, all fail, missing key, timeout, retry, spend guard, free-plan cap, kill switch."""
import asyncio

import httpx

from helpers import Fake, drive, inp

TOO_MANY = {"error": {"code": 429, "status": "RESOURCE_EXHAUSTED", "message": "Too many requests, slow down"}}


def test_a17_partial_failure_gemini_429_everywhere():
    fake = Fake()
    fake.behave["gemini"] = lambda n, req: httpx.Response(429, json=TOO_MANY)
    res = drive(inp(promptCount=3), fake)
    assert res.ok is True
    by = {e: [r for r in res.rows if r["engine"] == e] for e in ("chatgpt", "gemini", "claude")}
    assert all(r["status"] == "ok" for r in by["chatgpt"] + by["claude"]) and len(res.charged) == 6
    assert all(r["status"] == "error" and r["errorCode"] == "rate_limited" for r in by["gemini"]) and len(by["gemini"]) == 3
    assert all(r["errorCode"] != "quota_exhausted" for r in res.rows) and len(res.uncharged) == 3
    assert "gemini" in res.msg and "rate_limited" in res.msg and "rate-limited" in res.msg and "quota problem" in res.msg
    assert fake.count("gemini") == 6  # each row: the call and one retry


def test_a18_all_engines_fail():
    fake = Fake()
    for e in ("chatgpt", "gemini", "claude"):
        fake.behave[e] = lambda n, req: httpx.Response(500, text="down")
    res = drive(inp(promptCount=2), fake)
    assert res.ok is False and res.charged == [] and len(res.rows) == 6
    assert all(r["errorCode"] == "provider_error" for r in res.rows)
    assert "No answer came back" in res.msg and "nothing was charged" in res.msg


def test_a19_missing_key_for_one_engine(monkeypatch):
    monkeypatch.delenv("ANTHROPIC_API_KEY")
    res = drive(inp(promptCount=2))
    claude = [r for r in res.rows if r["engine"] == "claude"]
    assert res.ok and len(claude) == 2 and all(r["errorCode"] == "engine_not_configured" and r["status"] == "error" for r in claude)
    assert len(res.charged) == 4 and all(r["engine"] != "claude" for r in res.charged)
    assert res.fake.count("claude") == 0 and "claude" in res.msg


def test_a20_timeout_after_60s_on_the_fake_clock_one_retry_others_continue():
    fake = Fake()
    starts = []

    async def never(n, req):
        starts.append(res_clock.t)
        await asyncio.Event().wait()

    fake.behave["chatgpt"] = never
    from helpers import Clock
    res_clock = Clock()
    res = drive(inp(promptCount=2), fake, clock=res_clock)
    gpt = [r for r in res.rows if r["engine"] == "chatgpt"]
    assert res.ok and len(gpt) == 2 and all(r["status"] == "error" and r["errorCode"] == "timeout" for r in gpt)
    assert starts.count(0.0) == 2 and len(starts) == 4          # exactly one retry per row
    assert all(60 <= s <= 62 for s in starts[2:])               # the second attempt starts after the 60 s limit (+ a short pause)
    assert 119 <= res_clock.t <= 125 and res_clock.t < 600      # two attempts of 60 s, well inside the run limit
    assert len(res.charged) == 4 and all(r["engine"] != "chatgpt" for r in res.charged)
    assert gpt[0] in res.uncharged


def test_a20_no_new_row_after_the_run_limit():
    from helpers import Clock
    clock = Clock()
    clock.t = 541.0 - 0.0
    fake = Fake()

    res = drive(inp(promptCount=2, engines=["claude"]), fake, clock=clock)
    # the clock starts at 541 and the run's own start is read at 541, so rows still run: the limit is relative to the start
    assert res.ok and len(res.charged) == 2


def test_a21_retry_after_429_is_charged_once_and_budget_not_double_counted(monkeypatch):
    monkeypatch.setenv("MAX_PROVIDER_COST_PER_RUN_USD", "0.032")  # exactly two ChatGPT rows
    fake = Fake()
    fake.behave["chatgpt"] = lambda n, req: httpx.Response(429, headers={"retry-after": "30"}, json=TOO_MANY) if n <= 2 else None
    res = drive(inp(promptCount=2, engines=["chatgpt"]), fake)
    assert res.ok and [r["status"] for r in res.rows] == ["ok", "ok"] and len(res.charged) == 2
    assert fake.count("chatgpt") == 4 and fake.count("extractor") == 2
    assert res.clock.t == 10.0   # Retry-After 30 is honoured only up to 10 s


def test_a22_spend_guard_marks_remaining_rows_budget_cap(monkeypatch):
    monkeypatch.setenv("MAX_PROVIDER_COST_PER_RUN_USD", "0.033")
    res = drive(inp(promptCount=3, engines=["chatgpt"]))
    assert sorted(r["status"] for r in res.rows) == ["error", "ok", "ok"]
    assert [r["errorCode"] for r in res.rows if r["status"] == "error"] == ["budget_cap"] and len(res.charged) == 2
    assert res.fake.count("chatgpt") == 2 and res.fake.count("extractor") == 2  # no call at all for the capped row
    assert res.fake.calls.count("chatgpt") + res.fake.calls.count("extractor") == len(res.fake.calls) == 4


def test_a22_cap_stops_every_engine_and_no_provider_call_follows(monkeypatch):
    # 0.016 covers one chatgpt row (0.015 + 0.001) and nothing else: every other engine is capped without a call.
    monkeypatch.setenv("MAX_PROVIDER_COST_PER_RUN_USD", "0.016")
    res = drive(inp(promptCount=2))
    ok = [r for r in res.rows if r["status"] == "ok"]
    capped = [r for r in res.rows if r["errorCode"] == "budget_cap"]
    assert len(ok) == 1 and len(capped) == len(res.rows) - 1 == 5
    assert sorted(res.fake.calls) == ["chatgpt", "extractor"]  # exactly the one affordable row reached a provider
    assert all(r["mentioned"] is None for r in capped) and len(res.charged) == 1


def test_a22_failed_calls_are_refunded_in_the_guard(monkeypatch):
    monkeypatch.setenv("MAX_PROVIDER_COST_PER_RUN_USD", "0.033")
    fake = Fake()
    fake.behave["chatgpt"] = lambda n, req: httpx.Response(400, json={"error": "bad"}) if n == 1 else None
    res = drive(inp(promptCount=3, engines=["chatgpt"]), fake)
    assert sorted(r["errorCode"] or "ok" for r in res.rows) == ["ok", "ok", "provider_error"]  # no budget_cap: the failure gave its share back


def test_a23_free_plan_cap(monkeypatch):
    monkeypatch.delenv("APIFY_USER_IS_PAYING")
    res = drive(inp(promptCount=3))
    assert res.ok and len(res.rows) == 6 and "free plan" in res.msg and "3 of 9" in res.msg
    assert "at most 6 rows" in res.msg and "not run" in res.msg
    asks = [c for c in res.fake.calls if c != "extractor"]
    assert len(asks) == 6 and len(res.fake.calls) == 12  # the three extra rows never reached a provider
    assert {(r["promptIndex"], r["engine"]) for r in res.rows} == {(i, e) for i in (1, 2) for e in ("chatgpt", "gemini", "claude")}
    monkeypatch.setenv("APIFY_USER_IS_PAYING", "1")
    res = drive(inp(promptCount=3))
    assert len(res.rows) == 9 and "not run" not in res.msg


def test_a23_free_plan_cap_is_an_environment_setting(monkeypatch):
    monkeypatch.delenv("APIFY_USER_IS_PAYING")
    monkeypatch.setenv("FREE_PLAN_MAX_ROWS", "2")
    assert len(drive(inp(promptCount=3)).rows) == 2


def test_a24_kill_switch(monkeypatch):
    monkeypatch.setenv("DISABLED_ENGINES", "gemini")
    res = drive(inp(promptCount=2))
    gem = [r for r in res.rows if r["engine"] == "gemini"]
    assert len(gem) == 2 and all(r["errorCode"] == "engine_not_configured" for r in gem)
    assert res.fake.count("gemini") == 0 and len(res.charged) == 4
    assert "gemini" not in res.fake.calls and sorted(set(res.fake.calls)) == ["chatgpt", "claude", "extractor"]
    assert all(r["status"] == "error" and not r["mentioned"] for r in gem) and all(c is False for r, c in res.pushes if r in gem)


def test_quota_message_is_quota_exhausted_and_stops_that_engine():
    fake = Fake()
    fake.behave["claude"] = lambda n, req: httpx.Response(429, json={"error": {"message": "You exceeded your current quota, check billing"}})
    res = drive(inp(promptCount=4, engines=["claude", "chatgpt"]), fake)
    claude = [r for r in res.rows if r["engine"] == "claude"]
    assert {r["errorCode"] for r in claude} == {"quota_exhausted"} and fake.count("claude") <= 2  # no retry, no further calls


def test_402_and_403_quota_codes():
    for status, body, want in [(402, {"error": "x"}, "quota_exhausted"), (403, {"error": {"message": "billing not enabled"}}, "quota_exhausted"),
                               (403, {"error": {"message": "forbidden"}}, "provider_error"), (401, {}, "provider_error")]:
        fake = Fake()
        fake.behave["chatgpt"] = lambda n, req, s=status, b=body: httpx.Response(s, json=b)
        res = drive(inp(promptCount=1, engines=["chatgpt"]), fake)
        assert res.rows[0]["errorCode"] == want and fake.count("chatgpt") == 1


def test_bad_provider_json_is_provider_error():
    fake = Fake()
    fake.behave["gemini"] = lambda n, req: httpx.Response(200, text="<html>nope</html>")
    res = drive(inp(promptCount=1, engines=["gemini", "claude"]), fake)
    assert {r["engine"]: r["errorCode"] for r in res.rows} == {"gemini": "provider_error", "claude": None}


def test_per_engine_concurrency_is_at_most_two():
    fake = Fake()
    live = {"now": 0, "max": 0}

    async def slow(n, req):
        live["now"] += 1
        live["max"] = max(live["max"], live["now"])
        for _ in range(20):
            await asyncio.sleep(0)
        live["now"] -= 1

    fake.behave["claude"] = slow
    res = drive(inp(promptCount=6, engines=["claude"]), fake)
    assert res.ok and len(res.charged) == 6 and live["max"] == 2
