#!/usr/bin/env python3
"""Read-only Apify usage report for the looped_kite public Actors.

Prints, per Actor: user counts, our runs vs other users' runs, reviews,
issues, and list prices. Revenue/earnings are not exposed by the official
API; the script states that clearly and only reports our own platform
usage cost (what we spent, not what we earned).

Authentication: reads the token from /home/box/.apify-token and sends it
in the Authorization header. The token is never printed.

Change nothing on Apify. GET requests only.
"""
from __future__ import annotations

import json
import sys
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

TOKEN_PATH = Path("/home/box/.apify-token")
BASE = "https://api.apify.com"
TZ = ZoneInfo("Asia/Jerusalem")
OUR_USERNAME = "looped_kite"


def load_token() -> str:
    token = TOKEN_PATH.read_text().strip()
    if not token:
        raise SystemExit(f"empty token file: {TOKEN_PATH}")
    return token


def api_get(token: str, path: str, timeout: int = 30):
    url = BASE + path if path.startswith("/") else path
    req = urllib.request.Request(
        url,
        headers={
            "Authorization": f"Bearer {token}",
            "Accept": "application/json",
            "User-Agent": "looped-kite-usage-report/1.0",
        },
        method="GET",
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            status = resp.status
            raw = resp.read()
    except urllib.error.HTTPError as e:
        raw = e.read()
        status = e.code
    except Exception as e:
        # Never include the token if an exception string ever echoed a URL.
        raise SystemExit(f"request failed for {path}: {type(e).__name__}") from None
    try:
        body = json.loads(raw.decode("utf-8"))
    except Exception:
        body = None
    return status, body


def data(body):
    if isinstance(body, dict) and "data" in body:
        return body["data"]
    return body


def iso_to_il(value: str | None) -> str:
    if not value:
        return "n/a"
    dt = datetime.fromisoformat(value.replace("Z", "+00:00"))
    return dt.astimezone(TZ).strftime("%Y-%m-%d %H:%M:%S") + " Asia/Jerusalem"


def price_map(actor: dict) -> dict:
    infos = actor.get("pricingInfos") or []
    if not infos:
        return {"pricingModel": None, "events": {}}
    last = infos[-1]
    events = ((last.get("pricingPerEvent") or {}).get("actorChargeEvents")) or {}
    out = {}
    for name, ev in events.items():
        if ev.get("eventPriceUsd") is not None:
            out[name] = ev["eventPriceUsd"]
        elif ev.get("eventTieredPricingUsd"):
            out[name] = {
                tier: (info or {}).get("tieredEventPriceUsd")
                for tier, info in ev["eventTieredPricingUsd"].items()
            }
    return {
        "pricingModel": last.get("pricingModel"),
        "events": out,
        "apifyMarginPercentage": last.get("apifyMarginPercentage"),
    }


def list_our_runs(token: str, actor_id: str) -> dict:
    offset = 0
    limit = 1000
    items = []
    total = None
    while True:
        path = f"/v2/actors/{actor_id}/runs?desc=1&limit={limit}&offset={offset}"
        status, body = api_get(token, path)
        if status != 200:
            return {"error": f"HTTP {status}", "items": items, "total": total}
        page = data(body) or {}
        total = page.get("total", total)
        batch = page.get("items") or []
        items.extend(batch)
        if not batch or len(items) >= (total or 0):
            break
        offset += len(batch)
    user_ids = sorted({i.get("userId") for i in items if i.get("userId")})
    by_status = {}
    for i in items:
        by_status[i.get("status") or "UNKNOWN"] = by_status.get(i.get("status") or "UNKNOWN", 0) + 1
    last = items[0]["startedAt"] if items else None
    return {
        "total": total if total is not None else len(items),
        "items": items,
        "user_ids": user_ids,
        "by_status": by_status,
        "last_started_at": last,
    }


def paginated_count(token: str, path: str) -> dict:
    status, body = api_get(token, path)
    if status != 200:
        return {"ok": False, "status": status, "total": None, "items": []}
    page = data(body) or {}
    return {
        "ok": True,
        "status": status,
        "total": page.get("total", len(page.get("items") or [])),
        "items": page.get("items") or [],
    }


def fmt_money(n) -> str:
    if n is None:
        return "n/a"
    return f"${n:.6f}".rstrip("0").rstrip(".") if abs(n) < 0.01 else f"${n:.4f}".rstrip("0").rstrip(".")


def main() -> int:
    token = load_token()
    now = datetime.now(TZ).strftime("%Y-%m-%d %H:%M:%S") + " Asia/Jerusalem"
    print(f"Apify usage report  {now}")
    print("Read-only. Revenue is not available through the official API.\n")

    st, me_body = api_get(token, "/v2/users/me")
    if st != 200:
        print(f"GET /v2/users/me failed: HTTP {st}", file=sys.stderr)
        return 1
    me = data(me_body) or {}
    our_user_id = me.get("id")
    print(f"Account: {me.get('username')}  plan={(me.get('plan') or {}).get('id')}  paying={me.get('isPaying')}")
    print(f"Account email (payout/notice mail would go here): {me.get('email')}")
    print(f"User id: {our_user_id}")

    st, usage_body = api_get(token, "/v2/users/me/usage/monthly")
    usage = data(usage_body) if st == 200 else None
    if usage:
        cycle = usage.get("usageCycle") or {}
        spent = usage.get("totalUsageCreditsUsdAfterVolumeDiscount")
        print(
            "Our platform usage this cycle "
            f"{cycle.get('startAt')} → {cycle.get('endAt')}: {fmt_money(spent)} "
            "(this is what we spent, not earnings)"
        )
    else:
        print(f"GET /v2/users/me/usage/monthly failed: HTTP {st}")

    st, acts_body = api_get(token, "/v2/actors?my=1&limit=100")
    if st != 200:
        print(f"GET /v2/actors?my=1 failed: HTTP {st}", file=sys.stderr)
        return 1
    actors = (data(acts_body) or {}).get("items") or []
    print(f"Owned Actors: {len(actors)}\n")

    for item in actors:
        st, actor_body = api_get(token, f"/v2/actors/{item['id']}")
        if st != 200:
            print(f"- {item.get('name')}  GET failed HTTP {st}\n")
            continue
        actor = data(actor_body) or {}
        stats = actor.get("stats") or {}
        prices = price_map(actor)
        our_runs = list_our_runs(token, actor["id"])
        issues = paginated_count(token, f"/v2/actors/{actor['id']}/issues")
        reviews = paginated_count(token, f"/v2/actors/{actor['id']}/reviews")

        total_runs = stats.get("totalRuns") or 0
        our_run_count = our_runs.get("total") or 0
        other_runs_all_time = max(0, total_runs - our_run_count)
        public_30 = stats.get("publicActorRunStats30Days") or {}
        other_runs_30d = public_30.get("TOTAL")
        total_users = stats.get("totalUsers")
        # Docs: totalUsers includes the owner. 7d/30d are "active users" and
        # do not say whether the owner is included. Empirically, when both we
        # and one other user ran yesterday, 7d/30d stayed at 1, so they likely
        # exclude the owner. Report the raw API numbers either way.
        users_7d = stats.get("totalUsers7Days")
        users_30d = stats.get("totalUsers30Days")
        other_users_all_time = None if total_users is None else max(0, total_users - 1)

        store_url = f"https://apify.com/{actor.get('username')}/{actor.get('name')}"
        print(f"- {actor.get('title')}")
        print(f"  {store_url}")
        print(f"  id={actor.get('id')}  public={actor.get('isPublic')}  model={prices.get('pricingModel')}")
        print(f"  list prices: {prices.get('events')}")
        print(
            f"  users: total={total_users} (includes owner)  "
            f"other users all-time≈{other_users_all_time}  "
            f"active 7d={users_7d}  30d={users_30d}  90d={stats.get('totalUsers90Days')}"
        )
        print(
            f"  runs: total={total_runs}  ours={our_run_count}  "
            f"other users all-time={other_runs_all_time}  "
            f"other users last 30d={public_30}"
        )
        print(f"  our runs by status: {our_runs.get('by_status')}  last ours: {iso_to_il(our_runs.get('last_started_at'))}")
        if our_runs.get("user_ids") and set(our_runs["user_ids"]) - {our_user_id}:
            print(f"  unexpected other userId on our run list: {our_runs['user_ids']}")
        else:
            print("  other users' run-level details (userId, charged events, identity): not visible via the API")
        print(
            f"  reviews: {reviews.get('total') if reviews.get('ok') else 'HTTP ' + str(reviews.get('status'))}  "
            f"rating={stats.get('actorReviewRating')}  bookmarks={stats.get('bookmarkCount')}"
        )
        if reviews.get("items"):
            for rev in reviews["items"][:10]:
                # Show only non-secret identity-ish fields if present.
                who = rev.get("username") or rev.get("userName") or rev.get("user", {}).get("username") if isinstance(rev.get("user"), dict) else rev.get("user")
                print(f"    review: user={who} rating={rev.get('rating') or rev.get('stars')} keys={list(rev.keys())}")
        print(f"  open issues: {issues.get('total') if issues.get('ok') else 'HTTP ' + str(issues.get('status'))}")
        print("  revenue / earnings / charged events of other users: not available via the official API")
        print(f"  last run started (any user, from stats): {iso_to_il(stats.get('lastRunStartedAt'))}")
        print()

    print("Revenue source: Apify Console → Development → Insights → Analytics (JSON export)")
    print("and Insights → Payouts (monthly invoices, issued on the 11th).")
    print("There is no official payouts/analytics API endpoint (all candidates returned 404).")
    return 0


if __name__ == "__main__":
    sys.exit(main())
