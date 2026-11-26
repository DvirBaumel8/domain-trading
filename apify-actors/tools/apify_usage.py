#!/usr/bin/env python3
"""Daily read-only Apify usage report (CR-127 Part B). GET-only.

Writes <out>/DATE.json (DATE in Asia/Jerusalem) with, per actor: users, our runs vs others' runs,
reviews, issues, live prices (current vs pending, every tier) and day-over-day deltas against the
latest earlier file in --prev. Nothing is written unless every call succeeded (no partial file).
Earnings are not in the Apify API: the file says so and never guesses. Prices are read live, never hard-coded.
Token: APIFY_TOKEN env only; never printed, and errors never echo a URL.
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

BASE = "https://api.apify.com"
TZ = ZoneInfo("Asia/Jerusalem")
PAGE = 1000
RETRIES = 4
EARNINGS_NOTE = ("Earnings and other users' charged events are not available through the official Apify API; "
                 "none are reported. Source: Console > Insights > Analytics and Payouts.")


class UsageError(Exception):
    """A call failed for good (401, 429 after backoff, 5xx, bad body). No file is written."""


def http_get(path: str, token: str) -> tuple[int, object]:
    req = urllib.request.Request(BASE + path, method="GET",
                                 headers={"Authorization": f"Bearer {token}", "Accept": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            status, raw = r.status, r.read()
    except urllib.error.HTTPError as e:
        status, raw = e.code, e.read()
    except Exception as e:
        raise UsageError(f"request failed: {type(e).__name__}") from None
    try:
        return status, json.loads(raw.decode("utf-8"))
    except Exception:
        return status, None


def get(path: str, token: str, http=http_get, sleep=time.sleep, soft=False):
    """Returns the `data` of a 200. 401 fails at once; 429/5xx back off then fail. soft: other 4xx -> None."""
    for attempt in range(RETRIES):
        status, body = http(path, token)
        if status == 200:
            return body.get("data") if isinstance(body, dict) and "data" in body else body
        if status == 401:
            raise UsageError("HTTP 401 from Apify: token rejected")
        if status == 429 or status >= 500:
            if attempt < RETRIES - 1:
                sleep(2 ** attempt)
                continue
            raise UsageError(f"HTTP {status} from Apify after {RETRIES} tries")
        if soft:
            return None
        raise UsageError(f"HTTP {status} from Apify")
    raise UsageError("unreachable")


def paginate(path: str, token: str, **kw) -> tuple[list, int]:
    sep = "&" if "?" in path else "?"
    items, offset, total = [], 0, None
    while True:
        page = get(f"{path}{sep}limit={PAGE}&offset={offset}", token, **kw) or {}
        batch = page.get("items") or []
        total = page.get("total", total)
        items.extend(batch)
        if not batch or len(items) >= (total if total is not None else len(items)):
            break
        offset += len(batch)
    return items, (total if total is not None else len(items))


def _parse(ts: str | None) -> datetime:
    if not ts:
        return datetime.min.replace(tzinfo=timezone.utc)
    return datetime.fromisoformat(ts.replace("Z", "+00:00"))


def _events(info: dict) -> dict:
    out = {}
    for name, ev in ((info.get("pricingPerEvent") or {}).get("actorChargeEvents") or {}).items():
        if ev.get("eventTieredPricingUsd"):
            out[name] = {t: (v or {}).get("tieredEventPriceUsd") for t, v in ev["eventTieredPricingUsd"].items()}
        else:
            out[name] = ev.get("eventPriceUsd")
    return out


def price_view(actor: dict, now: datetime) -> dict:
    """current = entry with the latest startedAt at or before now; later entries are listed as pending."""
    infos = sorted(actor.get("pricingInfos") or [], key=lambda i: _parse(i.get("startedAt")))
    past = [i for i in infos if _parse(i.get("startedAt")) <= now]
    future = [i for i in infos if _parse(i.get("startedAt")) > now]

    def view(i):
        return {"pricingModel": i.get("pricingModel"), "events": _events(i), "startedAt": i.get("startedAt")}

    return {"current": view(past[-1]) if past else None, "pending": [view(i) for i in future]}


def actor_report(item: dict, token: str, now: datetime, our_id, **kw) -> dict:
    actor = get(f"/v2/acts/{item['id']}", token, **kw) or {}
    stats = actor.get("stats") or {}
    runs, runs_total = paginate(f"/v2/acts/{item['id']}/runs?desc=1", token, **kw)
    reviews, reviews_total = paginate(f"/v2/acts/{item['id']}/reviews", token, **kw)
    issues_data = get(f"/v2/acts/{item['id']}/issues?limit=1", token, soft=True, **kw)
    issues_total = None if issues_data is None else issues_data.get("total", len(issues_data.get("items") or []))
    total_runs = stats.get("totalRuns") or 0
    by_status: dict = {}
    for r in runs:
        by_status[r.get("status") or "UNKNOWN"] = by_status.get(r.get("status") or "UNKNOWN", 0) + 1
    return {
        "id": actor.get("id"), "name": actor.get("name"), "isPublic": actor.get("isPublic"),
        "prices": price_view(actor, now),
        "users": {"total_includes_owner": stats.get("totalUsers"), "active_7d": stats.get("totalUsers7Days"),
                  "active_30d": stats.get("totalUsers30Days"), "active_90d": stats.get("totalUsers90Days")},
        "runs": {"total": total_runs, "ours": runs_total, "others_all_time": max(0, total_runs - runs_total),
                 "ours_by_status": by_status, "last_started_at": runs[0].get("startedAt") if runs else None},
        "reviews": {"total": reviews_total, "rating": stats.get("actorReviewRating")},
        "issues": {"total": issues_total},
        "earnings": "unavailable",
    }


def deltas(prev: dict | None, cur: dict) -> dict:
    """Per actor id: new users, new runs by others, new reviews, new issues vs the earlier file (None if unknown)."""
    prev_by = {a["id"]: a for a in (prev or {}).get("actors", [])}

    def diff(new, old):
        return None if new is None or old is None else new - old

    out = {}
    for a in cur["actors"]:
        p = prev_by.get(a["id"])
        out[a["id"]] = {
            "new_users": diff(a["users"]["total_includes_owner"], p and p["users"]["total_includes_owner"]),
            "new_runs_by_others": diff(a["runs"]["others_all_time"], p and p["runs"]["others_all_time"]),
            "new_reviews": diff(a["reviews"]["total"], p and p["reviews"]["total"]),
            "new_issues": diff(a["issues"]["total"], p and p["issues"]["total"]),
        }
    return out


def collect(token: str, now: datetime, prev: dict | None = None, **kw) -> dict:
    me = get("/v2/users/me", token, **kw) or {}
    usage = get("/v2/users/me/usage/monthly", token, soft=True, **kw) or {}
    items, _ = paginate("/v2/acts?my=1", token, **kw)
    report = {
        "date": now.astimezone(TZ).strftime("%Y-%m-%d"),
        "generatedAt": now.astimezone(TZ).isoformat(timespec="seconds"),
        "account": {"username": me.get("username"), "plan": (me.get("plan") or {}).get("id")},
        "our_platform_usage_usd_this_cycle": usage.get("totalUsageCreditsUsdAfterVolumeDiscount"),
        "earnings_note": EARNINGS_NOTE,
        "actors": [actor_report(i, token, now, me.get("id"), **kw) for i in items],
    }
    report["deltas"] = deltas(prev, report)
    return report


def latest_before(prev_dir: Path, date: str) -> dict | None:
    files = sorted(p for p in prev_dir.glob("????-??-??.json") if p.stem < date) if prev_dir.is_dir() else []
    return json.loads(files[-1].read_text()) if files else None


def run(token: str, out: Path, prev_dir: Path, now: datetime | None = None, **kw) -> Path:
    now = now or datetime.now(timezone.utc)
    date = now.astimezone(TZ).strftime("%Y-%m-%d")
    report = collect(token, now, latest_before(prev_dir, date), **kw)  # raises before anything is written
    out.mkdir(parents=True, exist_ok=True)
    path = out / f"{date}.json"
    path.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n")
    return path


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", required=True, type=Path)
    ap.add_argument("--prev", type=Path, default=None, help="folder with earlier DATE.json files (default: --out)")
    a = ap.parse_args(argv)
    token = os.environ.get("APIFY_TOKEN", "")
    if not token:
        print("APIFY_TOKEN is not set", file=sys.stderr)
        return 2
    try:
        path = run(token, a.out, a.prev or a.out)
    except UsageError as e:
        print(f"usage job failed: {e}; no file written", file=sys.stderr)
        return 1
    print(f"wrote {path.name}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
