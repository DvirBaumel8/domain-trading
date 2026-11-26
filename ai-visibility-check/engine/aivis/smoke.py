"""`python -m aivis smoke`: one minimal call per paid engine; prints model, ok/error, usage.
Spends a few cents of real money. Needs AIVIS_ALLOW_PAID=1 and the engine keys. Refuses in CI."""
import os

from . import config
from .providers import REGISTRY, BudgetGuard, ProviderError

SMOKE_CAP_USD = 1.00
SMOKE_PROMPT = "Name one well-known dentist in Austin, Texas. Answer in one short sentence."


def run_smoke(engines=None, out=print, registry=None) -> int:
    if os.environ.get("CI"):
        out("smoke refused: never run in CI (it makes real, paid calls)")
        return 2
    if os.environ.get("AIVIS_ALLOW_PAID") != "1":
        out("smoke refused: set AIVIS_ALLOW_PAID=1 (real, paid calls)")
        return 2
    registry = registry or REGISTRY
    guard, bad = BudgetGuard(SMOKE_CAP_USD), 0
    for e in engines or config.ENGINES:
        if e not in config.ENGINES:
            out(f"{e}: unknown engine")
            bad += 1
            continue
        model = config.model_for(e)
        try:
            ans = registry[e](budget=guard, allow_paid=True).ask(SMOKE_PROMPT, city="Austin, TX")
            u = ans.usage
            out(f"{e}: model={ans.model} ok in={u.get('input_tokens', 0)} out={u.get('output_tokens', 0)} "
                f"searches={u.get('searches', 0)} cost=${u.get('cost_usd', 0):.4f} citations={len(ans.citations)}")
        except ProviderError as err:      # messages carry no keys or headers
            out(f"{e}: model={model} ERROR {err}")
            bad += 1
    return 1 if bad else 0
