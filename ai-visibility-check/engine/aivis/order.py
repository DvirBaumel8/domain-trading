"""Customer orders: intake -> cost estimate -> capped run -> report files.

Modes
- 'free'  : Pollinations (no key, no cost, model memory only). For the free
            self-check and for dry runs. Report is labelled accordingly.
- 'paid'  : OpenAI / Perplexity / Gemini / Claude with live web search.
            NEVER runs unless ALL hold: env AIVIS_ALLOW_PAID=1, the engine's
            API key is in env, and the estimated cost <= the order's cap.
            Every call is charged against a BudgetGuard set to the cap, so a
            run can never spend more than the cap. Untested live (no keys yet).
- 'mock'  : simulated answers for tests and demos.

No secret is ever printed: errors carry only the exception type.
"""
import datetime as _dt
import json
import os
import re
import sys
import zlib
from dataclasses import dataclass, field, asdict

from .audit import run_audit
from . import signals as _signals
from .niches import NICHES, get_niche
from .providers import (REGISTRY, BudgetGuard, Business, MockProvider, PAID_COST_PER_CALL,
                        PollinationsProvider, ProviderError)

PAID_ENGINES = ("openai", "perplexity", "gemini", "claude")
ENV_KEYS = {"openai": "OPENAI_API_KEY", "perplexity": "PERPLEXITY_API_KEY",
            "gemini": "GEMINI_API_KEY", "claude": "ANTHROPIC_API_KEY"}
DEFAULT_CAP_USD = 8.00          # per order; a $149 order leaves > $135 after the cap
TIERS = {                        # prompts x repeats per engine
    "check": (30, 2),            # $149 report: 60 answers per engine
    "lean": (20, 1),             # cheapest useful run
    "free": (8, 1),              # free self-check
}


US_STATES = frozenset(
    "AL AK AZ AR CA CO CT DE FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK "
    "OR PA RI SC SD TN TX UT VT VA WA WV WI WY DC".split())
US_ONLY_MSG = ("The check covers US businesses only: enter the city like 'Austin, TX' "
               "(a US state code or DC after the comma).")


class OrderError(RuntimeError):
    pass


def split_us_city(city, any_case=False):
    """'Austin, TX' -> ('Austin', 'TX') if it ends with a US state code or DC, else None.
    Lower-case codes only count with any_case=True (intake form); stored orders must be upper-case."""
    m = re.fullmatch(r"([^,]{2,60}),\s*([A-Za-z]{2})", (city or "").strip())
    if not m or (m.group(2) if not any_case else m.group(2).upper()) not in US_STATES:
        return None
    return m.group(1).strip(), m.group(2).upper()


def normalize_website(raw):
    """'' stays ''. Adds https:// when the scheme is missing. Raises ValueError on obviously invalid input."""
    w = str(raw or "").strip()
    if not w:
        return ""
    if re.match(r"^[A-Za-z][A-Za-z0-9+.-]*://", w):
        if not re.match(r"^https?://", w, re.I):
            raise ValueError("The website must start with http:// or https:// (or just be like example.com).")
    else:
        w = "https://" + w
    m = re.fullmatch(r"https?://([^/?#\s:@]+)(:\d{1,5})?([/?#]\S*)?", w, re.I)
    host = m.group(1) if m else ""
    if not m or len(w) > 200 or "." not in host or not re.fullmatch(r"[A-Za-z0-9.-]+", host) \
            or host.startswith((".", "-")) or host.endswith((".", "-")) or ".." in host:
        raise ValueError("That website doesn't look right. Enter it like example.com or https://example.com.")
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
    paid: bool = False           # set by the Polar webhook; paid runs are refused unless True
    paid_at: str = ""
    competitors: list = field(default_factory=list)

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
        if split_us_city(self.city) is None:
            raise OrderError(US_ONLY_MSG)
        if self.niche not in NICHES:
            raise OrderError(f"unknown niche {self.niche!r}; choose one of {sorted(NICHES)}")
        if self.plan not in TIERS:
            raise OrderError(f"plan must be one of {sorted(TIERS)}")
        bad = [e for e in self.engines if e not in PAID_ENGINES]
        if bad:
            raise OrderError(f"unknown engines {bad}")


def estimate_cost(order: Order, engines=None) -> float:
    n, r = TIERS[order.plan]
    return round(sum(PAID_COST_PER_CALL[e] * n * r for e in (engines or order.engines)), 4)


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


def run_order(order: Order, mode: str = "free", cap_usd: float = DEFAULT_CAP_USD, roster=None,
              out_dir="orders", seed=0, render=None, dry_run=False, providers=None, allow_unpaid=False):
    """Run one order. Returns (result, log dict). `providers` lets tests inject fakes.
    Paid mode refuses unless order.paid is True, or the operator passes allow_unpaid (logged)."""
    order.validate()
    if mode == "paid" and not dry_run and not order.paid:
        if not allow_unpaid:
            raise OrderError("order is not marked paid (paid:true missing); nothing was called. "
                             "Operator override: --allow-unpaid")
        print(f"WARNING: --allow-unpaid override used: running paid mode for unpaid order {order.order_id}",
              file=sys.stderr)
    n, r = TIERS["free"] if mode == "free" else TIERS[order.plan]
    est = 0.0 if mode in ("free", "mock") else estimate_cost(order)
    log = {"order_id": order.order_id, "mode": mode, "plan": order.plan, "prompts": n, "repeats": r,
           "engines": order.engines if mode == "paid" else [mode], "estimated_usd": est, "cap_usd": cap_usd,
           "started": _dt.datetime.now().isoformat(timespec="seconds"), "dry_run": dry_run}
    if dry_run:
        log["readiness"] = paid_readiness(order.engines)
        return None, log
    guard = None
    if providers is None:
        providers, guard = build_providers(order, mode, cap_usd, roster, seed)
    site = _signals.fetch_and_analyze(order.website, order.city) if order.website.strip() else None
    names = list(roster or [])
    low = {x.lower() for x in names}
    for c in order.competitors:         # competitors the buyer watches are tracked by name
        if c.strip() and c.strip().lower() not in low:
            names.append(c.strip())
            low.add(c.strip().lower())
    res = run_audit(get_niche(order.niche), order.city, order.business_name, names, providers,
                    n_prompts=n, repeats=r, seed=seed, signals=site)
    log.update({"finished": _dt.datetime.now().isoformat(timespec="seconds"),
                "answers": res.score.total_answers, "errors": len(res.errors),
                "spent_usd": round(guard.spent if guard else res.cost_usd, 4), "score": res.score.score})
    folder = os.path.join(out_dir, order.order_id)
    os.makedirs(folder, exist_ok=True)
    if render:
        with open(os.path.join(folder, "report.html"), "w", encoding="utf-8") as f:
            f.write(render(res))
    raw = [{"provider": a.provider, "mode": a.mode, "prompt": a.prompt, "intent": i, "repeat": a.run,
            "text": a.text, "citations": a.citations,
            "mentions": [[m.raw, m.position, m.roster_name] for m in ms]} for a, ms, i in res.records]
    with open(os.path.join(folder, "answers.json"), "w", encoding="utf-8") as f:
        json.dump(raw, f, indent=1)
    with open(os.path.join(folder, "order-log.json"), "w", encoding="utf-8") as f:
        json.dump({**log, "order": {k: v for k, v in asdict(order).items() if k != "email"}}, f, indent=1)
    return res, log
