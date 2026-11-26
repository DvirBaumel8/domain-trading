"""Customer orders: intake -> cost estimate -> capped run -> report files.

Modes
- 'free'  : Pollinations (no key, no cost, model memory only). For the free
            self-check and for dry runs. Report is labelled accordingly.
- 'paid'  : OpenAI / Gemini / Claude with live web search.
            NEVER runs unless ALL hold: env AIVIS_ALLOW_PAID=1, the engine's
            API key is in env, and the estimated cost <= the order's cap.
            Every call is charged against a BudgetGuard set to the cap, so a
            run can never spend more than the cap. Untested live (no keys yet).
- 'mock'  : simulated answers for tests and demos.

No secret is ever printed: errors carry only the exception type.
"""
import datetime as _dt
import ipaddress
import json
import os
import re
import sys
import zlib
from dataclasses import dataclass, field, asdict

from .audit import run_audit, SpendCapExceeded
from . import signals as _signals
from .niches import NICHES, get_niche
from .parse import match_name
from . import config
from .uscities import is_us_place
from .providers import REGISTRY, BudgetGuard, Business, MockProvider, PollinationsProvider, ProviderError

PAID_ENGINES = config.PAID_ENGINES
ENV_KEYS = config.ENV_KEYS
DEFAULT_CAP_USD = config.order_cap_usd()    # 12.00; AIVIS_ORDER_CAP_USD overrides

FREE_FAIL_FAST_AFTER = 3        # permanent HTTP errors in one free job before the remaining questions are skipped
FREE_MIN_ANSWERS = 6            # the free check shows numbers only when at least this many of its 8 questions answered
MIN_ANSWER_SHARE = 0.8          # every engine must reach this share of its expected answers
TIERS = {                        # prompts x repeats per engine
    "check": (30, 2),            # $149 report: 60 answers per engine
    "lean": (20, 1),             # cheapest useful run
    "free": (8, 1),              # free self-check
}


US_STATES = frozenset("AL AK AZ AR CA CO CT DE FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY "
                      "NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY DC".split())   # 50 states + DC
US_ONLY_MSG = ("This check covers US businesses only. Enter your city as 'City, XX' with a US state code "
               "(or DC) for a real US city, for example 'Austin, TX'.")


class OrderError(RuntimeError):
    pass


def city_is_us(city: str) -> bool:
    """True only for 'City, XX' where XX is a US state code or DC (upper case) and the city is a real
    US place in that state (offline Census Gazetteer list, case-insensitive; St./Saint, Ft./Fort handled)."""
    m = re.fullmatch(r"([^,]+),\s*([A-Z]{2})", (city or "").strip())
    return bool(m) and m.group(2) in US_STATES and is_us_place(m.group(1), m.group(2))


_LOCAL_SUFFIXES = ("localhost", "local", "localdomain", "internal", "intranet", "lan", "home", "corp", "private",
                   "arpa")


def _public_host(host: str) -> bool:
    """A public host name: not an IP address (any spelling), not a localhost-style or internal name."""
    h = host.lower()
    try:
        ipaddress.ip_address(h)
        return False
    except ValueError:
        pass
    labels = h.split(".")
    tld = labels[-1]
    if not (re.fullmatch(r"[a-z]{2,63}", tld) or re.fullmatch(r"xn--[a-z0-9-]{1,59}", tld)):
        return False            # numeric or hex last label: 127.1, 0x7f.1, 10.0.0.1 and so on
    if tld in _LOCAL_SUFFIXES:
        return False
    return all(0 < len(x) <= 63 and not x.startswith("-") and not x.endswith("-") for x in labels)


def normalize_website(raw) -> str:
    """'' stays ''. Adds https:// when the scheme is missing. Raises ValueError for obviously invalid values."""
    w = str(raw or "").strip()
    if not w:
        return ""
    if not re.match(r"[A-Za-z][A-Za-z0-9+.-]*://", w):
        w = "https://" + w
    m = re.fullmatch(r"https?://([A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+)(?::\d{1,5})?(?:[/?#]\S*)?", w)
    if not m or len(w) > 200 or not _public_host(m.group(1)):
        raise ValueError("That website doesn't look right. Enter it like https://www.example.com (or leave it empty).")
    return w


@dataclass
class Order:
    order_id: str
    business_name: str
    city: str                    # "Austin, TX"
    niche: str                   # key in NICHES
    email: str = ""              # buyer email; stored locally only, never in reports
    website: str = ""
    plan: str = "check"          # check | lean | free
    engines: list = field(default_factory=lambda: list(PAID_ENGINES))
    paid_ref: str = ""           # payment reference (Polar order id), filled by the operator
    competitors: list = field(default_factory=list)
    paid: bool = False           # set by the Polar webhook (site/server.py); paid mode refuses unless true
    paid_at: str = ""
    target_reviews: int = None         # Google review counts, when the buyer gave them
    competitor_reviews: list = None

    @staticmethod
    def from_dict(d):
        o = Order(**{k: d[k] for k in d if k in Order.__dataclass_fields__})
        o.validate()
        return o

    def validate(self):
        if not re.fullmatch(r"[A-Za-z0-9_-]{3,40}", self.order_id or ""):
            raise OrderError("order_id must be 3-40 letters, digits, - or _")
        if not self.business_name.strip():
            raise OrderError("business_name is required")
        if not city_is_us(self.city):
            raise OrderError("city must be a real US place written like 'Austin, TX' (US only; "
                             f"'{self.city}' is not a US city in that state)")
        try:
            self.website = normalize_website(self.website)
        except ValueError as e:
            raise OrderError(str(e))
        if self.niche not in NICHES:
            raise OrderError(f"unknown niche {self.niche!r}; choose one of {sorted(NICHES)}")
        if self.plan not in TIERS:
            raise OrderError(f"plan must be one of {sorted(TIERS)}")
        bad = [e for e in self.engines if e not in PAID_ENGINES]
        if bad:
            raise OrderError(f"unknown engines {bad}")


def estimate_cost(order: Order, engines=None) -> float:
    n, r = TIERS[order.plan]
    return round(sum(config.cost_per_call(e) * n * r for e in (engines or order.engines)), 4)


def paid_readiness(engines) -> dict:
    """Which engines could run right now. Reports only presence, never values."""
    allow = os.environ.get("AIVIS_ALLOW_PAID") == "1"
    return {e: {"allow_paid": allow, "key_present": bool(os.environ.get(ENV_KEYS[e]))} for e in engines}


def build_providers(order: Order, mode: str, cap_usd: float, roster=None, seed=0):
    if mode == "free":
        return [PollinationsProvider()], None
    if mode == "mock":
        names = roster or [order.business_name]
        strength = {n: 1.0 + (zlib.crc32(n.encode()) % 7) for n in names}
        strength[order.business_name] = 0.5
        return [MockProvider([Business(n, strength.get(n, 1.0)) for n in names], seed=seed,
                             referees=get_niche(order.niche).referees)], None
    if mode != "paid":
        raise OrderError("mode must be free, paid or mock")
    if os.environ.get("AIVIS_ALLOW_PAID") != "1":
        raise OrderError("paid mode is locked: set AIVIS_ALLOW_PAID=1 only after Dvir approves and the order is paid")
    missing = [e for e in order.engines if not os.environ.get(ENV_KEYS[e])]
    if missing:
        raise OrderError("missing API keys for: " + ", ".join(missing) + " (names only; values never shown)")
    est = estimate_cost(order)
    if est > cap_usd + 1e-9:
        raise OrderError(f"estimated cost ${est:.2f} exceeds the order cap ${cap_usd:.2f}; nothing was called")
    guard = BudgetGuard(cap_usd)
    return [REGISTRY[e](budget=guard, allow_paid=True) for e in order.engines], guard


def usage_report(records) -> dict:
    """Real vendor usage per call plus totals (per engine and overall). Counts and USD only."""
    calls, per = [], {}
    for a, _, _ in records:
        u = a.usage
        if not u:
            continue
        calls.append({"engine": a.provider, "model": a.model, "repeat": a.run, **u})
        t = per.setdefault(a.provider, {"model": a.model, "calls": 0, "input_tokens": 0, "output_tokens": 0,
                                        "searches": 0, "cost_usd": 0.0})
        t["calls"] += 1
        for k in ("input_tokens", "output_tokens", "searches"):
            t[k] += u.get(k, 0)
        t["cost_usd"] = round(t["cost_usd"] + u.get("cost_usd", 0.0), 6)
    total = {k: sum(t[k] for t in per.values()) for k in ("calls", "input_tokens", "output_tokens", "searches")}
    total["cost_usd"] = round(sum(t["cost_usd"] for t in per.values()), 6)
    return {"calls": calls, "by_engine": per, "total": total}


class AnswerShortfall(OrderError):
    """The run happened but too few answers came back (vendor outage); spent = what the run cost."""
    spent = 0.0
    reasons: dict = {}
    expected = 0


class CapExceeded(OrderError):
    """Real usage went over the order cap mid-run; no report; spent = real usage so far."""
    spent = 0.0


def _check_answers(res, order, expected, log):
    """No report from a subset: every engine must reach MIN_ANSWER_SHARE of its expected answers."""
    got = {}
    for ans, _, _ in res.records:
        got[ans.provider] = got.get(ans.provider, 0) + 1
    if res.score.total_answers == 0:
        raise AnswerShortfall(f"order {order.order_id}: no AI answers at all ({len(res.errors)} errors); no report written")
    if log["mode"] != "paid":
        return
    for e in order.engines:
        if got.get(e, 0) < MIN_ANSWER_SHARE * expected:
            raise AnswerShortfall(f"order {order.order_id}: engine {e} returned {got.get(e, 0)} of {expected} expected "
                             f"answers (minimum {MIN_ANSWER_SHARE:.0%}); no report written")


def run_order(order: Order, mode: str = "free", cap_usd: float = DEFAULT_CAP_USD, roster=None,
              out_dir="orders", seed=0, render=None, dry_run=False, providers=None,
              unpaid_override=False):
    """Run one order. Returns (result, log dict). `providers` lets tests inject fakes."""
    order.validate()
    if mode == "paid" and not dry_run and order.paid is not True and not unpaid_override:
        raise OrderError(f"order {order.order_id} is not marked paid (paid:true); paid mode refuses it")
    n, r = TIERS["free"] if mode == "free" else TIERS[order.plan]
    est = 0.0 if mode in ("free", "mock") else estimate_cost(order)
    log = {"order_id": order.order_id, "mode": mode, "plan": order.plan, "prompts": n, "repeats": r,
           "engines": order.engines if mode == "paid" else [mode], "estimated_usd": est, "cap_usd": cap_usd,
           "started": _dt.datetime.now().isoformat(timespec="seconds"), "dry_run": dry_run,
           "paid": bool(order.paid), "unpaid_override": bool(unpaid_override)}
    if dry_run:
        log["readiness"] = paid_readiness(order.engines)
        return None, log
    guard = None
    if providers is None:
        providers, guard = build_providers(order, mode, cap_usd, roster, seed)
    site = None
    if order.website.strip():
        url = order.website.strip()
        if not re.match(r"https?://", url, re.I):
            url = "https://" + url
        site = _signals.fetch_and_analyze(url, order.city)
        if getattr(site, "error", ""):
            log["site_error"] = site.error
            print(f"[operator] order {order.order_id}: website check failed ({site.error}); "
                  f"site findings skipped", file=sys.stderr)
    names = list(roster or [])
    for c in order.competitors:         # competitors the buyer watches are tracked by name
        c = c.strip()
        if not c or match_name(c, [order.business_name], city=order.city) or match_name(c, names, city=order.city):
            continue                    # empty, the target itself, or already tracked
        names.append(c)
    try:
        res = run_audit(get_niche(order.niche), order.city, order.business_name, names, providers,
                        n_prompts=n, repeats=r, seed=seed, signals=site,
                        target_reviews=order.target_reviews, competitor_reviews=order.competitor_reviews,
                        real_cap_usd=cap_usd if mode == "paid" else None,
                        fail_fast_after=FREE_FAIL_FAST_AFTER if mode == "free" else None)
    except SpendCapExceeded as e:       # same no-partial path as engine failures: nothing is written
        print(f"[operator] ALERT order {order.order_id}: real usage ${e.spent:.4f} went over the order cap "
              f"${e.cap:.2f}; run stopped, no report", file=sys.stderr)
        err = CapExceeded(f"order {order.order_id}: {e}; run stopped, no report written")
        err.spent = e.spent
        raise err from None
    log["usage"] = usage_report(res.records)
    log["reasons"], log["expected"] = res.reason_counts(), n * r
    real_spent = log["usage"]["total"]["cost_usd"] if log["usage"]["calls"] else (guard.spent if guard else res.cost_usd)
    try:
        _check_answers(res, order, n * r, log)
    except AnswerShortfall as e:
        e.spent = real_spent
        e.reasons, e.expected = res.reason_counts(), n * r
        raise
    log.update({"finished": _dt.datetime.now().isoformat(timespec="seconds"),
                "answers": res.score.total_answers, "errors": len(res.errors),
                "spent_usd": round(real_spent, 4), "score": res.score.score})
    folder = os.path.join(out_dir, order.order_id)
    os.makedirs(folder, exist_ok=True)
    if render:
        with open(os.path.join(folder, "report.html"), "w", encoding="utf-8") as f:
            f.write(render(res))
    raw = [{"provider": a.provider, "mode": a.mode, "prompt": a.prompt, "intent": i, "repeat": a.run,
            "text": a.text, "citations": a.citations,
            "usage": a.usage, "mentions": [[m.raw, m.position, m.roster_name] for m in ms]} for a, ms, i in res.records]
    with open(os.path.join(folder, "answers.json"), "w", encoding="utf-8") as f:
        json.dump(raw, f, indent=1)
    with open(os.path.join(folder, "order-log.json"), "w", encoding="utf-8") as f:
        json.dump({**log, "order": {k: v for k, v in asdict(order).items() if k != "email"}}, f, indent=1)
    return res, log
