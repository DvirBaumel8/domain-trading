#!/usr/bin/env python3
"""Live acceptance run for the free check (not run in CI, free path only, no paid model).

AVC_BASE_URL and AVC_TEST_BYPASS_TOKEN come from the environment (never arguments, never printed).
Runs trades x cities through POST /api/check, polls free runs, prints one row per run and a summary.
Exit code 1 if any run is partial or failed (or the max runtime was hit), else 0.
"""
import argparse
import json
import os
import sys
import time
import urllib.error
import urllib.request

DEFAULT_TRADES = ["plumber", "hvac", "dentist", "personal_injury_lawyer", "roofing"]
DEFAULT_CITIES = ["Austin, TX", "Denver, CO", "Miami, FL"]
BUSINESS = "Acme Test Business"
POLL_EVERY_S = 5.0


def http_json(method, url, body=None, token="", timeout=30):
    """-> (status, dict). The token goes only in a header."""
    hdr = {"Content-Type": "application/json", "User-Agent": "avc-matrix"}
    if token:
        hdr["X-AVC-Test-Token"] = token
    data = json.dumps(body).encode() if body is not None else None
    try:
        with urllib.request.urlopen(urllib.request.Request(url, data=data, method=method, headers=hdr), timeout=timeout) as r:
            return r.status, json.loads(r.read().decode() or "{}")
    except urllib.error.HTTPError as e:
        try:
            return e.code, json.loads(e.read().decode() or "{}")
        except ValueError:
            return e.code, {}


def run_one(base, token, trade, city, http=http_json, sleep=time.sleep, clock=time.time, deadline=None):
    """One row dict. Never raises."""
    t0 = clock()
    row = {"trade": trade, "city": city, "path": "-", "answered": 0, "expected": 0, "names": 0, "matched": 0,
           "reasons": {}, "ok": False, "note": ""}
    try:
        st, j = http("POST", base + "/api/check", {"business": BUSINESS, "city": city, "niche": trade,
                                                    "consent": True}, token)
        if st != 200:
            row["note"] = f"http {st}"
            return finish(row, t0, clock)
        if j.get("status") == "queued":
            row["path"] = "free-run"
            job = str(j.get("id", ""))
            while True:
                if deadline is not None and clock() > deadline:
                    row["note"] = "max runtime"
                    return finish(row, t0, clock)
                sleep(POLL_EVERY_S)
                st, j = http("GET", base + "/api/check/" + job, None, "")
                if j.get("status") != "running":
                    break
        elif j.get("status") == "instant":
            row["path"] = "instant"
        else:
            row["note"] = str(j.get("status", "?"))
            return finish(row, t0, clock)
        n = j.get("names") or {}
        row["answered"] = j.get("answers", 0)
        row["expected"] = j.get("expected", j.get("answers", 0))
        row["names"] = len(n.get("names", []))
        row["matched"] = n.get("matched_count", 0)
        row["reasons"] = j.get("reasons", {})
        row["ok"] = j.get("status") in ("done", "instant") and row["names"] > 0
        row["note"] = "" if row["ok"] else (j.get("status") if j.get("status") not in ("done", "instant") else "no names")
    except Exception as e:      # a dead server is a failed row, not a crash
        row["note"] = type(e).__name__
    return finish(row, t0, clock)


def finish(row, t0, clock):
    row["elapsed"] = round(clock() - t0, 1)
    return row


def table(rows) -> str:
    head = f"{'trade':<24}{'city':<14}{'path':<9}{'answered':<10}{'names':>6}{'matched':>8}  {'reasons':<22}{'secs':>6}  note"
    out = [head, "-" * len(head)]
    for r in rows:
        rs = " ".join(f"{k}={v}" for k, v in sorted(r["reasons"].items())) or "-"
        out.append(f"{r['trade']:<24}{r['city']:<14}{r['path']:<9}{str(r['answered']) + ' of ' + str(r['expected']):<10}"
                   f"{r['names']:>6}{r['matched']:>8}  {rs:<22}{r['elapsed']:>6}  {r['note']}")
    return "\n".join(out)


def summary(rows):
    """-> (line, exit code)."""
    bad = [r for r in rows if not r["ok"]]
    line = f"SUMMARY runs={len(rows)} ok={len(rows) - len(bad)} partial_or_failed={len(bad)}"
    return line, (1 if bad else 0)


def load_matrix(path):
    if not path:
        return DEFAULT_TRADES, DEFAULT_CITIES
    d = json.load(open(path, encoding="utf-8"))
    return list(d["trades"]), list(d["cities"])


def main(argv=None, env=None, http=http_json, sleep=time.sleep, clock=time.time, out=sys.stdout):
    env = os.environ if env is None else env
    ap = argparse.ArgumentParser()
    ap.add_argument("--matrix", help="JSON file: {\"trades\": [...], \"cities\": [...]}")
    ap.add_argument("--pace", type=float, default=10.0, help="seconds between runs")
    ap.add_argument("--max-runtime", type=float, default=1800.0, help="stop after this many seconds")
    a = ap.parse_args(argv)
    base, token = (env.get("AVC_BASE_URL") or "").rstrip("/"), env.get("AVC_TEST_BYPASS_TOKEN") or ""
    if not base or not token:
        print("Set AVC_BASE_URL and AVC_TEST_BYPASS_TOKEN in the environment.", file=sys.stderr)
        return 2
    trades, cities = load_matrix(a.matrix)
    deadline = clock() + a.max_runtime
    rows = []
    for t in trades:
        for c in cities:
            if clock() > deadline:
                rows.append({"trade": t, "city": c, "path": "-", "answered": 0, "expected": 0, "names": 0,
                             "matched": 0, "reasons": {}, "ok": False, "note": "max runtime", "elapsed": 0.0})
                continue
            rows.append(run_one(base, token, t, c, http, sleep, clock, deadline))
            sleep(a.pace)
    print(table(rows), file=out)
    line, code = summary(rows)
    print(line, file=out)
    return code


if __name__ == "__main__":
    sys.exit(main())
