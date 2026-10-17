#!/usr/bin/env python3
"""Reference calculator for the pricing rules, settings v2 (Dvir: adopted 2026-10-05 00:46 IDT; v2 decisions 09:17 IDT:
$500 walk-away floor, one geo drop $499->$399 at M12, final push = BIN to the floor rounded up to x95).

NOT service code. It lets scouts/Gavriel fill the buy card's "Sell plan (computed)" line before the API
exists, and it is the source of the test vectors in repo-handoff test-plan.md (PR-*). The API's
GET /pricing/preview must return exactly the same numbers. Integer cents only, no floats.

Usage:
  pricing_calc.py --category trend --bin 1995 [--listed-on 2026-10-12 --drop-date 2028-10-04]
  pricing_calc.py --category geo --grade strong [...]
  pricing_calc.py --category trend --bin 1995 --walkaway 950   # approved exception (D-001)
"""
import argparse, calendar, datetime as dt, json

# pricing_settings version 2 (Dvir, 2026-10-05 09:17 IDT). v1 (00:46) is superseded: the version label is
# bumped whenever any output rule changes, so a card computed under old rules can never claim the new version.
SETTINGS_V2 = {
    "version": 2,
    "geo_bin_strong_cents": 49900, "geo_bin_weaker_cents": 39900,
    "geo_bin_min_cents": 29900, "geo_bin_max_cents": 49900,  # range for MANUAL geo changes only
    "geo_drops_enabled": True,
    "geo_drops": [{"after_months": 12, "from_cents": 49900, "to_cents": 39900}],  # at most one geo drop; $399 never drops
    "floor_bps": 6500, "floor_min_cents": 75000,
    "walkaway_bps": 4800, "walkaway_min_cents": 50000,  # private walk-away never below $500 (also after drops), never above floor
    "hybrid_min_offer_cents": 10000,  # marketplace min offer on non-geo listings (Dvir 2026-10-05 01:03 IDT); walk-away is private
    "drops": [{"after_months": 6, "pct_bps": 2000}, {"after_months": 18, "pct_bps": 2000}],
    "final_push_days_before_drop": 90, "final_push_mode": "bin_to_floor_ceil95",  # hybrid only; geo has no final push
    "delist_days_before_drop": 7, "headsup_days_before": 7,
    "comps_min": 2, "comps_max": 3, "public_lto": False,
}
AFTERNIC_MIN_OFFER_CENTS = 2000

def nearest_ending(c, ending_cents):
    """Nearest whole-dollar price whose last two dollar digits == ending (95 or 99). Ties go DOWN."""
    shift = 10000 - ending_cents          # e.g. 95 -> +$5 so that x95 becomes a multiple of $100
    n = c + shift
    lo = (n // 10000) * 10000
    hi = lo + 10000
    pick = lo if (n - lo) <= (hi - n) else hi
    return max(pick - shift, ending_cents)

def nice95(c): return nearest_ending(c, 9500)
def nice99(c): return nearest_ending(c, 9900)
def round5(c):  # nearest $5, ties UP
    return ((c + 250) // 500) * 500
def pct(c, bps):  # exact integer cents of c * bps/10000, rounded half up to the cent
    return (c * bps + 5000) // 10000

def ceil95(c):  # smallest whole-dollar price ending in 95 that is >= c
    m = (c // 10000) * 10000 + 9500
    return m if m >= c else m + 10000

def is_nice95(c): return c % 10000 == 9500
def hybrid_bin_min(s): # smallest price ending in 95 that is >= floor_min
    c = s["floor_min_cents"]
    m = (c // 10000) * 10000 + 9500
    return m if m >= c else m + 10000

def initial_plan(category, bin_cents=None, grade=None, s=SETTINGS_V2, walkaway_override=None, floor_override=None):
    if category == "geo":
        b = s["geo_bin_strong_cents"] if grade == "strong" else s["geo_bin_weaker_cents"]
        if grade not in ("strong", "weaker"): raise ValueError("GEO_GRADE_REQUIRED")
        return {"mode": "bin", "bin": b, "floor": b, "walkaway": b, "min_offer": b, "source": "formula"}
    if bin_cents is None: raise ValueError("BIN_REQUIRED")
    if not is_nice95(bin_cents): raise ValueError("BIN_NOT_NICE")
    if bin_cents < hybrid_bin_min(s): raise ValueError("BIN_BELOW_FLOOR_MIN")
    floor = min(bin_cents, max(round5(pct(bin_cents, s["floor_bps"])), s["floor_min_cents"]))
    walk = min(floor, max(round5(pct(bin_cents, s["walkaway_bps"])), s["walkaway_min_cents"], AFTERNIC_MIN_OFFER_CENTS))
    plan = {"mode": "hybrid", "bin": bin_cents, "floor": floor, "walkaway": walk, "min_offer": min(s["hybrid_min_offer_cents"], walk), "source": "formula",
            "formula_floor": floor, "formula_walkaway": walk}
    if floor_override is not None or walkaway_override is not None:
        f = floor_override if floor_override is not None else floor
        w = walkaway_override if walkaway_override is not None else walk
        if not (AFTERNIC_MIN_OFFER_CENTS <= w <= f <= bin_cents): raise ValueError("HYBRID_PRICES_INVALID")
        if w < s["walkaway_min_cents"]: raise ValueError("WALKAWAY_BELOW_MIN")
        plan.update(floor=f, walkaway=w, min_offer=min(s["hybrid_min_offer_cents"], w), source="approved_exception")
    return plan

def apply_drop(p, pct_bps, s=SETTINGS_V2):
    keep = 10000 - pct_bps
    if p["mode"] == "bin": raise ValueError("geo uses apply_geo_drop")
    b = max(nice95(pct(p["bin"], keep)), hybrid_bin_min(s))
    if b >= p["bin"]: return dict(p), "skipped_at_minimum"
    f = min(b, max(round5(pct(p["floor"], keep)), s["floor_min_cents"]))
    w = min(f, max(round5(pct(p["walkaway"], keep)), s["walkaway_min_cents"], AFTERNIC_MIN_OFFER_CENTS))
    return {**p, "bin": b, "floor": f, "walkaway": w, "min_offer": min(p["min_offer"], w)}, "planned"

def apply_geo_drop(p, d, s=SETTINGS_V2):
    if not s["geo_drops_enabled"]: return dict(p), "skipped_disabled"
    if p["bin"] != d["from_cents"]: return dict(p), "not_applicable"
    b = d["to_cents"]
    return {**p, "bin": b, "floor": b, "walkaway": b, "min_offer": b}, "planned"

def apply_final_push(p, s=SETTINGS_V2):
    # Hybrid only (operating-model §3a: "BIN drops to the floor"). New BIN = the floor rounded UP to x95, so the
    # BIN never falls below the floor; floor and the private walk-away (>= $500) stay as they are.
    b = min(p["bin"], max(ceil95(p["floor"]), hybrid_bin_min(s)))
    f = min(p["floor"], b)
    w = min(f, p["walkaway"])
    if (b, f, w) == (p["bin"], p["floor"], p["walkaway"]): return dict(p), "skipped_no_change"
    return {**p, "bin": b, "floor": f, "walkaway": w, "min_offer": min(p["min_offer"], w)}, "planned"

def add_months(d, n):
    y, m = divmod(d.month - 1 + n, 12)
    y += d.year; m += 1
    return dt.date(y, m, min(d.day, calendar.monthrange(y, m)[1]))

def schedule(plan, listed_on=None, drop_date=None, s=SETTINGS_V2):
    rows, cur = [], dict(plan)
    final_push_on = drop_date - dt.timedelta(days=s["final_push_days_before_drop"]) if drop_date else None
    if plan["mode"] == "bin":  # geo: at most one drop ($499 -> $399 at month 12); no final push; never $299
        for d in s["geo_drops"]:
            due = add_months(listed_on, d["after_months"]) if listed_on else None
            nxt, st = apply_geo_drop(cur, d, s)
            if st == "not_applicable": continue
            if due and final_push_on and due >= final_push_on: st, nxt = "superseded_by_final_push", cur
            rows.append({"event": f"geo_drop_m{d['after_months']}", "due_on": str(due) if due else f"listed+{d['after_months']}mo", "status": st, **pick(nxt)})
            cur = nxt
        rows.append({"event": "delist", "due_on": str(drop_date - dt.timedelta(days=s['delist_days_before_drop'])) if drop_date else f"drop-{s['delist_days_before_drop']}d", "status": "planned"})
        return rows
    for i, d in enumerate(s["drops"], 1):
        due = add_months(listed_on, d["after_months"]) if listed_on else None
        if due and final_push_on and due >= final_push_on:
            rows.append({"event": f"drop{i}_m{d['after_months']}", "due_on": str(due), "status": "superseded_by_final_push"})
            continue
        nxt, st = apply_drop(cur, d["pct_bps"], s)
        rows.append({"event": f"drop{i}_m{d['after_months']}", "due_on": str(due) if due else f"listed+{d['after_months']}mo", "status": st, **pick(nxt)})
        cur = nxt
    nxt, st = apply_final_push(cur, s)
    rows.append({"event": "final_push", "due_on": str(final_push_on) if final_push_on else f"drop-{s['final_push_days_before_drop']}d", "status": st, **pick(nxt)})
    rows.append({"event": "delist", "due_on": str(drop_date - dt.timedelta(days=s['delist_days_before_drop'])) if drop_date else f"drop-{s['delist_days_before_drop']}d", "status": "planned"})
    return rows

def pick(p): return {k: p[k] for k in ("bin", "floor", "walkaway")}
def usd(c): return f"${c//100:,}" if c % 100 == 0 else f"${c/100:,.2f}"
def net15(c): return c - max(pct(c, 1500), 1500)

def sell_plan_line(plan, rows, s=SETTINGS_V2):
    p = plan
    if p["mode"] == "bin":
        head = f"bin · BIN {usd(p['bin'])} (no offers, no negotiation)" + ("" if any(r["event"].startswith("geo_drop") for r in rows) else " · never drops")
    else:
        head = (f"hybrid · BIN {usd(p['bin'])} · floor (auto-accept) {usd(p['floor'])} · walk-away (private) {usd(p['walkaway'])} · min offer {usd(p['min_offer'])}"
                + (" [approved exception]" if p["source"] == "approved_exception" else ""))
    steps = []
    for r in rows:
        if r["event"] == "delist": steps.append(f"delist {r['due_on']}")
        elif r["status"] == "planned":
            v = (usd(r['bin']) if p["mode"] == "bin" else f"{usd(r['bin'])}/{usd(r['floor'])}/{usd(r['walkaway'])}")
            steps.append(f"{r['event']} {r['due_on']} {v}")
        else: steps.append(f"{r['event']} {r['due_on']} ({r['status']})")
    return f"{head} · LTO off · " + " · ".join(steps) + f" · settings v{s['version']}"

if __name__ == "__main__":
    a = argparse.ArgumentParser()
    a.add_argument("--category", required=True); a.add_argument("--bin", type=int); a.add_argument("--grade")
    a.add_argument("--walkaway", type=int); a.add_argument("--floor", type=int)
    a.add_argument("--listed-on"); a.add_argument("--drop-date"); a.add_argument("--json", action="store_true")
    x = a.parse_args()
    plan = initial_plan(x.category, x.bin * 100 if x.bin else None, x.grade,
                        walkaway_override=x.walkaway * 100 if x.walkaway else None,
                        floor_override=x.floor * 100 if x.floor else None)
    lo = dt.date.fromisoformat(x.listed_on) if x.listed_on else None
    dd = dt.date.fromisoformat(x.drop_date) if x.drop_date else None
    rows = schedule(plan, lo, dd)
    if x.json: print(json.dumps({"plan": plan, "schedule": rows}, indent=1))
    else:
        print(sell_plan_line(plan, rows))
        for r in rows: print("  ", r)
        print("   net at 15%: BIN", usd(net15(plan["bin"])), "| floor", usd(net15(plan["floor"])), "| walk-away", usd(net15(plan["walkaway"])))
