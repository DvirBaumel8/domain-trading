"""CR-130 contract (offline): private-only push guard, push workflow shape, CR-127 Part B usage job."""
import importlib.util
import json
import re
import sys
from datetime import datetime, timezone
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "tools"))
import apify_guard as guard  # noqa: E402
import apify_usage as usage  # noqa: E402
import apify_memory as memory  # noqa: E402

NOW = datetime(2026, 11, 27, 6, 0, tzinfo=timezone.utc)
MEM = {"defaultRunOptions": {"memoryMbytes": 256}}
NEW = {"wayback-domain-history", "broken-link-auditor", "bulk-pagespeed-checker"}


# ---- post-push guard
def test_guard_ok_for_private_unpriced():
    assert guard.problems({"id": "a", "isPublic": False, "pricingInfos": [], **MEM}) == []


def test_guard_fails_on_public():
    assert guard.problems({"isPublic": True, **MEM})


@pytest.mark.parametrize("extra", [
    {"pricingInfos": [{"pricingModel": "FREE"}]},
    {"pricingInfos": [{"pricingModel": "PAY_PER_EVENT"}]},
    {"actorPricing": {"x": 1}},
])
def test_guard_fails_on_any_pricing(extra):
    assert guard.problems({"isPublic": False, **MEM, **extra})


def test_guard_main_fails_without_leaking_token(monkeypatch, capsys):
    monkeypatch.setenv("APIFY_TOKEN", "sekret-token")
    assert guard.main(["broken-link-auditor"], fetch_fn=lambda n, t: {"id": "x", "name": n, "isPublic": True, **MEM}) == 1
    out = capsys.readouterr()
    assert "sekret-token" not in out.out + out.err


def _http404(url):
    import urllib.error
    return urllib.error.HTTPError(url, 404, "Not Found", {}, None)


def test_guard_fetch_falls_back_to_username_on_404():
    calls = []

    def fake_get(path, token):
        calls.append(path)
        if path.startswith("/v2/acts/me~"):
            raise _http404(path)
        if path == "/v2/users/me":
            return {"username": "someuser"}
        return {"id": "x", "isPublic": False}

    assert guard.fetch("broken-link-auditor", "tok", get_fn=fake_get)["id"] == "x"
    assert calls == ["/v2/acts/me~broken-link-auditor", "/v2/users/me", "/v2/acts/someuser~broken-link-auditor"]


def test_guard_fetch_does_not_mask_other_errors():
    import urllib.error

    def fake_get(path, token):
        raise urllib.error.HTTPError(path, 500, "boom", {}, None)

    with pytest.raises(urllib.error.HTTPError):
        guard.fetch("broken-link-auditor", "tok", get_fn=fake_get)


def test_guard_rejects_old_actors(monkeypatch):
    monkeypatch.setenv("APIFY_TOKEN", "t")
    assert guard.main(["sitemap-url-extractor"], fetch_fn=lambda n, t: {}) == 2


def test_guard_allow_list_is_the_three_new():
    assert set(guard.ALLOWED) == NEW


# ---- push workflow (static)
def read_workflow(name):
    """Installed copy in .github/workflows first, then apify-actors/ci; fail if neither exists."""
    for p in (ROOT.parent / ".github" / "workflows" / name, ROOT / "ci" / name):
        if p.is_file():
            return p.read_text()
    pytest.fail(f"workflow {name} not found in .github/workflows or apify-actors/ci")


WF = read_workflow("apify-push.yml")


def test_push_workflow_manual_only():
    on_block = WF.split("\non:")[1].split("\npermissions:")[0]
    assert not re.search(r"^ +push *:", on_block, re.M)
    assert "schedule" not in WF and "pull_request" not in WF
    assert "workflow_dispatch" in WF


def test_push_workflow_allow_list_exactly_new_actors():
    opts = set(re.findall(r"^\s+- ([\w-]+)\s*$", WF.split("options:")[1].split("permissions:")[0], re.M))
    assert opts == NEW | {"all-new"}


def test_push_workflow_never_publishes_or_prices():
    assert not re.search(r"isPublic|categories|pricing|--publish|apify (call|publish)", WF, re.I)
    assert "echo $APIFY_TOKEN" not in WF and "set -x" not in WF


def test_usage_workflow_shape():
    wf = read_workflow("apify-usage.yml")
    assert "cron: '0 6 * * *'" in wf and "workflow_dispatch" in wf and "apify-usage" in wf


# ---- usage job (recorded fixtures, no network)
def fake_api(acts, *, fail=None, runs_total=None):
    """acts: {id: {actor, runs, reviews, issues}}; fail: (path-substring, status)."""
    calls = []

    def http(path, token):
        calls.append(path)
        if fail and fail[0] in path:
            return fail[1], {"error": {}}
        if path == "/v2/users/me":
            return 200, {"data": {"id": "U1", "username": "me", "plan": {"id": "FREE"}, "email": "x@y"}}
        if path.startswith("/v2/users/me/usage"):
            return 200, {"data": {"totalUsageCreditsUsdAfterVolumeDiscount": 1.5}}
        if path.startswith("/v2/acts?my=1"):
            return 200, {"data": {"total": len(acts), "items": [{"id": i} for i in acts]}}
        m = re.match(r"/v2/acts/(\w+)(?:/(\w+))?", path)
        aid, kind = m.group(1), m.group(2)
        limit = (re.search(r"limit=(\d+)", path) or [None, None])[1]
        off = (re.search(r"offset=(\d+)", path) or [None, None])[1]
        a = acts[aid]
        if kind is None:
            return 200, {"data": a["actor"]}
        rows = a[kind]
        o, l = int(off or 0), int(limit or 1000)
        return 200, {"data": {"total": len(rows), "items": rows[o:o + l]}}

    return http, calls


def actor(aid, total_runs=0, users=1, infos=()):
    return {"id": aid, "name": f"n-{aid}", "isPublic": True,
            "stats": {"totalRuns": total_runs, "totalUsers": users}, "pricingInfos": list(infos)}


def test_pagination_collects_all_runs(monkeypatch):
    monkeypatch.setattr(usage, "PAGE", 2)
    runs = [{"status": "SUCCEEDED", "startedAt": f"2026-11-0{i}T00:00:00Z"} for i in range(1, 6)]
    http, calls = fake_api({"A": {"actor": actor("A", 7), "runs": runs, "reviews": [], "issues": []}})
    rep = usage.collect("t", NOW, http=http)
    a = rep["actors"][0]
    assert a["runs"]["ours"] == 5 and a["runs"]["others_all_time"] == 2
    assert sum("/runs" in c for c in calls) == 3  # 2 + 2 + 1


def test_actor_with_zero_runs():
    http, _ = fake_api({"A": {"actor": actor("A"), "runs": [], "reviews": [], "issues": []}})
    a = usage.collect("t", NOW, http=http)["actors"][0]
    assert a["runs"] == {"total": 0, "ours": 0, "others_all_time": 0, "ours_by_status": {}, "last_started_at": None}


@pytest.mark.parametrize("status", [401, 429])
def test_failure_writes_no_file(tmp_path, status):
    http, _ = fake_api({"A": {"actor": actor("A"), "runs": [], "reviews": [], "issues": []}}, fail=("/reviews", status))
    sleeps = []
    with pytest.raises(usage.UsageError):
        usage.run("t", tmp_path / "usage", tmp_path / "usage", NOW, http=http, sleep=sleeps.append)
    assert not (tmp_path / "usage").exists()
    assert (len(sleeps) == usage.RETRIES - 1) if status == 429 else sleeps == []  # backoff only on 429


def test_earnings_note_and_no_email(tmp_path):
    http, _ = fake_api({"A": {"actor": actor("A"), "runs": [], "reviews": [], "issues": []}})
    p = usage.run("t", tmp_path, tmp_path, NOW, http=http)
    rep = json.loads(p.read_text())
    assert "not available" in rep["earnings_note"] and rep["actors"][0]["earnings"] == "unavailable"
    assert "x@y" not in p.read_text() and p.name == "2026-11-27.json"


def test_prices_current_vs_pending_tiers():
    infos = [
        {"startedAt": "2026-01-01T00:00:00Z", "pricingModel": "PAY_PER_EVENT",
         "pricingPerEvent": {"actorChargeEvents": {"result": {"eventPriceUsd": 0.5}}}},
        {"startedAt": "2026-11-20T00:00:00Z", "pricingModel": "PAY_PER_EVENT",
         "pricingPerEvent": {"actorChargeEvents": {"result": {"eventTieredPricingUsd": {
             "FREE": {"tieredEventPriceUsd": 0.4}, "GOLD": {"tieredEventPriceUsd": 0.2}}}}}},
        {"startedAt": "2026-12-01T00:00:00Z", "pricingModel": "PAY_PER_EVENT",
         "pricingPerEvent": {"actorChargeEvents": {"result": {"eventPriceUsd": 0.1}}}},
    ]
    v = usage.price_view({"pricingInfos": infos}, NOW)
    assert v["current"]["events"] == {"result": {"FREE": 0.4, "GOLD": 0.2}}
    assert len(v["pending"]) == 1 and v["pending"][0]["startedAt"] == "2026-12-01T00:00:00Z"
    assert v["pending"][0]["events"] == {"result": 0.1}


def test_day_over_day_deltas(tmp_path):
    def make(users, runs, reviews):
        return {"a": {"actor": actor("A", runs, users), "runs": [], "reviews": [{}] * reviews, "issues": []}}

    yesterday = datetime(2026, 11, 26, 6, 0, tzinfo=timezone.utc)
    h1, _ = fake_api({"A": make(1, 0, 0)["a"]})
    usage.run("t", tmp_path, tmp_path, yesterday, http=h1)
    h2, _ = fake_api({"A": make(3, 4, 2)["a"]})
    rep = json.loads(usage.run("t", tmp_path, tmp_path, NOW, http=h2).read_text())
    assert rep["deltas"]["A"] == {"new_users": 2, "new_runs_by_others": 4, "new_reviews": 2, "new_issues": 0}


def test_no_hard_coded_prices_in_new_scripts():
    pat = re.compile(r"(?<!\\)\$\s?\d")
    for f in ("apify_usage.py", "apify_guard.py"):
        assert not pat.search((ROOT / "tools" / f).read_text()), f


# ---- memory: guard check
@pytest.mark.parametrize("opts", [{"defaultRunOptions": {"memoryMbytes": 4096}}, {"defaultRunOptions": {}}, {}])
def test_guard_fails_when_memory_not_256(opts):
    assert any("memoryMbytes" in p for p in guard.problems({"isPublic": False, **opts}))


def test_guard_main_fails_on_4096(monkeypatch, capsys):
    monkeypatch.setenv("APIFY_TOKEN", "sekret-token")
    bad = {"id": "x", "name": "n", "isPublic": False, "defaultRunOptions": {"memoryMbytes": 4096}}
    assert guard.main(["broken-link-auditor"], fetch_fn=lambda n, t: bad) == 1
    assert "sekret-token" not in capsys.readouterr().err


# ---- memory: setter with mocked HTTP
def _mock(current):
    calls = []

    def put_fn(path, token, body):
        calls.append((path, body))
        return {"defaultRunOptions": body["defaultRunOptions"]}

    return (lambda n, t: {"id": "ID1", "isPublic": False, "defaultRunOptions": current}), put_fn, calls


def test_memory_put_sends_only_run_options_and_keeps_others(monkeypatch):
    monkeypatch.setenv("APIFY_TOKEN", "sekret-token")
    fetch_fn, put_fn, calls = _mock({"build": "latest", "timeoutSecs": 3600, "memoryMbytes": 4096})
    assert memory.main(["wayback-domain-history"], fetch_fn=fetch_fn, put_fn=put_fn) == 0
    assert calls == [("/v2/acts/ID1", {"defaultRunOptions": {"build": "latest", "timeoutSecs": 3600, "memoryMbytes": 256}})]


def test_memory_rejects_old_and_unknown_actors(monkeypatch):
    monkeypatch.setenv("APIFY_TOKEN", "t")
    fetch_fn, put_fn, calls = _mock({})
    assert memory.main(["sitemap-url-extractor"], fetch_fn=fetch_fn, put_fn=put_fn) == 2
    assert calls == []


def test_memory_requires_token(monkeypatch):
    monkeypatch.delenv("APIFY_TOKEN", raising=False)
    assert memory.main(["broken-link-auditor"]) == 2


def test_memory_failure_exit_1_without_leaking_token(monkeypatch, capsys):
    monkeypatch.setenv("APIFY_TOKEN", "sekret-token")

    def boom(path, token, body):
        raise RuntimeError(f"https://x/?token={token}")

    fetch_fn, _, _ = _mock({})
    assert memory.main(["broken-link-auditor"], fetch_fn=fetch_fn, put_fn=boom) == 1
    out = capsys.readouterr()
    assert "sekret-token" not in out.out + out.err


def test_memory_fails_if_apify_reports_other_value(monkeypatch):
    monkeypatch.setenv("APIFY_TOKEN", "t")
    fetch_fn, _, _ = _mock({})
    assert memory.main(["broken-link-auditor"], fetch_fn=fetch_fn,
                       put_fn=lambda p, t, b: {"defaultRunOptions": {"memoryMbytes": 4096}}) == 1


def test_memory_put_body_never_has_forbidden_fields():
    src = (ROOT / "tools" / "apify_memory.py").read_text()
    assert '{"defaultRunOptions": options}' in src
    assert "isPublic" not in src.split('"""', 2)[2]


def test_push_workflow_sets_memory_before_guard():
    wf = (ROOT / "ci" / "apify-push.yml").read_text()
    assert "apify_memory.py" in wf and wf.index("apify_memory.py") < wf.index("apify_guard.py")
