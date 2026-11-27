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
import apify_baseline as baseline  # noqa: E402
import apify_changed as changed  # noqa: E402

NOW = datetime(2026, 11, 27, 6, 0, tzinfo=timezone.utc)
MEM = {"defaultRunOptions": {"memoryMbytes": 256}}
PRIVATE = {"wayback-domain-history", "bulk-pagespeed-checker", "ai-brand-mention-check"}
LIVE = {"bulk-domain-availability-checker", "sitemap-url-extractor", "broken-link-auditor", "domain-checkup-report"}


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
    assert guard.main(["wayback-domain-history"], fetch_fn=lambda n, t: {"id": "x", "name": n, "isPublic": True, **MEM}) == 1
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


def test_guard_private_path_rejects_live_and_unknown_actors(monkeypatch):
    monkeypatch.setenv("APIFY_TOKEN", "t")
    for n in ("sitemap-url-extractor", "broken-link-auditor", "domain-checkup-report", "not-an-actor"):
        assert guard.main([n], fetch_fn=lambda n, t: {}) == 2


def test_allow_lists():
    assert set(guard.PRIVATE) == PRIVATE
    assert set(guard.LIVE) == LIVE
    assert not set(guard.PRIVATE) & set(guard.LIVE)
    assert guard.LIVE_TIMEOUTS == {"broken-link-auditor": 7200}


# ---- live guard
PRICED = [{"pricingModel": "PAY_PER_EVENT", "pricingPerEvent": {"actorChargeEvents": {"result": {"eventPriceUsd": 0.5}}}}]
LISTING = {"isPublic": True, "title": "T", "description": "D", "seoTitle": "ST", "seoDescription": "SD",
           "categories": ["TOOLS"], "pricingInfos": PRICED}


def live_actor(name="sitemap-url-extractor", **over):
    opts = {"memoryMbytes": 256}
    if name == "broken-link-auditor":
        opts["timeoutSecs"] = 7200
    return {"id": "x", "name": name, **LISTING, "defaultRunOptions": opts, **over}


@pytest.mark.parametrize("name", sorted(LIVE))
def test_live_guard_passes_public_priced_actor(name):
    assert guard.live_problems(live_actor(name), guard.listing_view(live_actor(name)), name) == []


@pytest.mark.parametrize("over", [
    {"isPublic": False},
    {"pricingInfos": []},
    {"pricingInfos": [{"pricingModel": "FREE"}]},
    {"title": "other"}, {"description": "other"}, {"seoTitle": "o"}, {"seoDescription": "o"}, {"categories": ["SEO_TOOLS"]},
    {"actorPricing": {"x": 1}},
    {"defaultRunOptions": {"memoryMbytes": 4096}},
    {"defaultRunOptions": {}},
])
def test_live_guard_fails_on_change(over):
    base = guard.listing_view(live_actor())
    assert guard.live_problems(live_actor(**over), base, "sitemap-url-extractor")


@pytest.mark.parametrize("timeout", [3600, None])
def test_live_guard_requires_7200_for_site_migration_qa_only(timeout):
    opts = {"memoryMbytes": 256, **({"timeoutSecs": timeout} if timeout else {})}
    a = live_actor("broken-link-auditor", defaultRunOptions=opts)
    assert any("timeoutSecs" in p for p in guard.live_problems(a, guard.listing_view(a), "broken-link-auditor"))
    other = live_actor("sitemap-url-extractor", defaultRunOptions=opts)  # any timeout is kept for the others
    assert guard.live_problems(other, guard.listing_view(other), "sitemap-url-extractor") == []


def test_live_guard_main(monkeypatch, tmp_path, capsys):
    monkeypatch.setenv("APIFY_TOKEN", "sekret-token")
    monkeypatch.chdir(tmp_path)
    bl = tmp_path / "bl.json"
    bl.write_text(json.dumps({"sitemap-url-extractor": guard.listing_view(live_actor())}))
    assert guard.main(["--live", "--baseline", str(bl), "sitemap-url-extractor"], fetch_fn=lambda n, t: live_actor()) == 0
    assert (tmp_path / "dom-to-gavriel-line.md").read_text().count("rebuilt LIVE") == 1
    assert guard.main(["--live", "--baseline", str(bl), "sitemap-url-extractor"],
                      fetch_fn=lambda n, t: live_actor(isPublic=False)) == 1
    assert "sekret-token" not in capsys.readouterr().err
    # not on the live list, or no baseline: fail closed
    assert guard.main(["--live", "--baseline", str(bl), "wayback-domain-history"], fetch_fn=lambda n, t: {}) == 2
    assert guard.main(["--live", "sitemap-url-extractor"], fetch_fn=lambda n, t: live_actor()) == 2
    assert guard.main(["--live", "--baseline", str(bl), "broken-link-auditor"], fetch_fn=lambda n, t: live_actor()) == 2


def test_baseline_records_listing_and_rejects_private(monkeypatch, tmp_path):
    monkeypatch.setenv("APIFY_TOKEN", "t")
    out = tmp_path / "b.json"
    assert baseline.main([str(out), "sitemap-url-extractor"], fetch_fn=lambda n, t: live_actor()) == 0
    assert json.loads(out.read_text())["sitemap-url-extractor"] == guard.listing_view(live_actor())
    assert baseline.main([str(out), "sitemap-url-extractor"], fetch_fn=lambda n, t: live_actor(isPublic=False)) == 1
    assert baseline.main([str(out), "wayback-domain-history"], fetch_fn=lambda n, t: {}) == 2


# ---- change detection (merge to main)
def test_select_only_changed_live_actor():
    assert changed.select(["apify-actors/sitemap-url-extractor/src/core.py", "README.md"]) == ["sitemap-url-extractor"]


def test_select_private_or_other_changes_select_nothing():
    assert changed.select(["apify-actors/wayback-domain-history/src/core.py", "apify-actors/ai-brand-mention-check/x.py"]) == []
    assert changed.select([".github/workflows/apify-push.yml", "apify-actors/tools/apify_guard.py", "src/app.ts"]) == []
    assert changed.select(["apify-actors/sitemap-url-extractor-evil/x.py"]) == []


def test_select_several_in_allow_list_order():
    files = ["apify-actors/broken-link-auditor/a", "apify-actors/bulk-domain-availability-checker/b", "apify-actors/wayback-domain-history/c"]
    assert changed.select(files) == ["bulk-domain-availability-checker", "broken-link-auditor"]


def test_changed_files_from_a_real_fake_main(tmp_path):
    import subprocess

    def git(*a):
        return subprocess.run(["git", "-c", "user.name=t", "-c", "user.email=t@t", *a], cwd=tmp_path, check=True,
                              capture_output=True, text=True).stdout.strip()

    git("init", "-q")
    for d in ("sitemap-url-extractor", "wayback-domain-history"):
        (tmp_path / "apify-actors" / d).mkdir(parents=True)
        (tmp_path / "apify-actors" / d / "f.py").write_text("1")
    git("add", "."), git("commit", "-qm", "base")
    base = git("rev-parse", "HEAD")
    (tmp_path / "apify-actors" / "sitemap-url-extractor" / "f.py").write_text("2")
    git("commit", "-qam", "live only")
    live = git("rev-parse", "HEAD")
    (tmp_path / "apify-actors" / "wayback-domain-history" / "f.py").write_text("2")
    git("commit", "-qam", "private only")
    head = git("rev-parse", "HEAD")
    cwd = Path.cwd()
    import os
    os.chdir(tmp_path)
    try:
        assert changed.select(changed.changed_files(base, live)) == ["sitemap-url-extractor"]
        assert changed.select(changed.changed_files(live, head)) == []
        assert changed.select(changed.changed_files(changed.ZERO, live)) == ["sitemap-url-extractor"]  # new-branch fallback
    finally:
        os.chdir(cwd)


# ---- push workflow (static)
def read_workflow(name):
    """Installed copy in .github/workflows first, then apify-actors/ci; fail if neither exists."""
    for p in (ROOT.parent / ".github" / "workflows" / name, ROOT / "ci" / name):
        if p.is_file():
            return p.read_text()
    pytest.fail(f"workflow {name} not found in .github/workflows or apify-actors/ci")


WF = read_workflow("apify-push.yml")


def test_push_workflow_triggers_manual_and_main_merge_only():
    on_block = WF.split("\non:")[1].split("\npermissions:")[0]
    assert "schedule" not in WF and "pull_request" not in WF
    assert "workflow_dispatch" in WF
    if re.search(r"^ +push *:", on_block, re.M):  # the installed copy may still be the old manual-only file
        assert "branches: [main]" in on_block
        staged = (ROOT / "ci" / "apify-push.yml").read_text().split("\non:")[1].split("\npermissions:")[0]
        for n in LIVE:  # the staged copy is the source; the installed one may lag until installed
            assert f"'apify-actors/{n}/**'" in staged
        assert not any(f"'apify-actors/{n}/**'" in on_block for n in PRIVATE)


def _options(text):
    return set(re.findall(r"^\s+- ([\w-]+)\s*$", text.split("options:")[1].split("permissions:")[0], re.M))


def test_push_workflow_allow_list_exactly_live_and_private_actors():
    # The ci/ copy is the source; the installed copy may lag behind but must never list anything else.
    assert _options((ROOT / "ci" / "apify-push.yml").read_text()) == LIVE | PRIVATE | {"all-new"}
    assert _options(WF) <= LIVE | PRIVATE | {"all-new"}


def test_ci_workflow_selects_changed_live_actors_and_fails_closed():
    wf = (ROOT / "ci" / "apify-push.yml").read_text()
    assert "apify_changed.py" in wf and "actor not allowed" in wf
    assert wf.index("python -m pytest") < wf.index("apify push")  # pytest before any push
    assert wf.index("apify_baseline.py") < wf.index("apify push")  # live baseline before the push
    assert "--live" in wf and "secrets.APIFY_TOKEN" in wf


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
    assert guard.main(["wayback-domain-history"], fetch_fn=lambda n, t: bad) == 1
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


def test_memory_live_sets_7200_for_site_migration_qa_only(monkeypatch):
    monkeypatch.setenv("APIFY_TOKEN", "t")
    fetch_fn, put_fn, calls = _mock({"build": "latest", "timeoutSecs": 3600, "memoryMbytes": 4096})
    assert memory.main(["--live", "broken-link-auditor"], fetch_fn=fetch_fn, put_fn=put_fn) == 0
    assert calls[-1][1] == {"defaultRunOptions": {"build": "latest", "timeoutSecs": 7200, "memoryMbytes": 256}}
    assert memory.main(["--live", "sitemap-url-extractor"], fetch_fn=fetch_fn, put_fn=put_fn) == 0
    assert calls[-1][1] == {"defaultRunOptions": {"build": "latest", "timeoutSecs": 3600, "memoryMbytes": 256}}  # kept


def test_memory_live_fails_if_timeout_not_applied(monkeypatch):
    monkeypatch.setenv("APIFY_TOKEN", "t")
    fetch_fn, _, _ = _mock({})
    assert memory.main(["--live", "broken-link-auditor"], fetch_fn=fetch_fn,
                       put_fn=lambda p, t, b: {"defaultRunOptions": {"memoryMbytes": 256, "timeoutSecs": 3600}}) == 1


def test_memory_rejects_wrong_path_and_unknown_actors(monkeypatch):
    monkeypatch.setenv("APIFY_TOKEN", "t")
    fetch_fn, put_fn, calls = _mock({})
    assert memory.main(["sitemap-url-extractor"], fetch_fn=fetch_fn, put_fn=put_fn) == 2  # live actor on the private path
    assert memory.main(["--live", "wayback-domain-history"], fetch_fn=fetch_fn, put_fn=put_fn) == 2
    assert memory.main(["--live", "not-an-actor"], fetch_fn=fetch_fn, put_fn=put_fn) == 2
    assert calls == []


def test_memory_requires_token(monkeypatch):
    monkeypatch.delenv("APIFY_TOKEN", raising=False)
    assert memory.main(["wayback-domain-history"]) == 2


def test_memory_failure_exit_1_without_leaking_token(monkeypatch, capsys):
    monkeypatch.setenv("APIFY_TOKEN", "sekret-token")

    def boom(path, token, body):
        raise RuntimeError(f"https://x/?token={token}")

    fetch_fn, _, _ = _mock({})
    assert memory.main(["wayback-domain-history"], fetch_fn=fetch_fn, put_fn=boom) == 1
    out = capsys.readouterr()
    assert "sekret-token" not in out.out + out.err


def test_memory_fails_if_apify_reports_other_value(monkeypatch):
    monkeypatch.setenv("APIFY_TOKEN", "t")
    fetch_fn, _, _ = _mock({})
    assert memory.main(["wayback-domain-history"], fetch_fn=fetch_fn,
                       put_fn=lambda p, t, b: {"defaultRunOptions": {"memoryMbytes": 4096}}) == 1


def test_memory_put_body_never_has_forbidden_fields():
    src = (ROOT / "tools" / "apify_memory.py").read_text()
    assert '{"defaultRunOptions": options}' in src
    assert "isPublic" not in src.split('"""', 2)[2]


def test_push_workflow_sets_memory_before_guard():
    wf = (ROOT / "ci" / "apify-push.yml").read_text()
    assert "apify_memory.py" in wf and wf.index("apify_memory.py") < wf.index("apify_guard.py")


# ---- domain-checkup-report is LIVE (U2)
def test_select_domain_checkup_report():
    assert changed.select(["apify-actors/domain-checkup-report/src/main.py"]) == ["domain-checkup-report"]


def test_staged_push_workflow_includes_domain_checkup_report():
    wf = (ROOT / "ci" / "apify-push.yml").read_text()
    on_block = wf.split("\non:")[1].split("\npermissions:")[0]
    assert "'apify-actors/domain-checkup-report/**'" in on_block
    live_case = [ln for ln in wf.splitlines() if 'echo "MODE=live"' in ln and "case" not in ln and ")" in ln]
    assert any("|domain-checkup-report)" in ln for ln in live_case)
    assert _options(wf) == LIVE | PRIVATE | {"all-new"}


def test_memory_live_domain_checkup_report_sets_memory_only(monkeypatch):
    monkeypatch.setenv("APIFY_TOKEN", "t")
    fetch_fn, put_fn, calls = _mock({"build": "latest", "memoryMbytes": 4096})
    assert memory.main(["--live", "domain-checkup-report"], fetch_fn=fetch_fn, put_fn=put_fn) == 0
    body = calls[-1][1]["defaultRunOptions"]
    assert body["memoryMbytes"] == 256 and "timeoutSecs" not in body


def test_live_guard_domain_checkup_report_listing_unchanged_and_changed():
    a = live_actor("domain-checkup-report")
    base = guard.listing_view(a)
    assert guard.live_problems(a, base, "domain-checkup-report") == []
    for field, value in (("title", "x"), ("description", "x"), ("seoTitle", "x"), ("seoDescription", "x"),
                         ("categories", ["OTHER"]), ("pricingInfos", [])):
        assert guard.live_problems(live_actor("domain-checkup-report", **{field: value}), base, "domain-checkup-report")
