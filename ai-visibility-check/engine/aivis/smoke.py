"""Smoke test: one minimal call per paid engine. Real money (cents): run by hand, never in CI or tests.

Needs AIVIS_ALLOW_PAID=1 and the engine's key in env. Prints model, ok/error and usage; never keys."""
import os

from . import config
from .providers import REGISTRY, BudgetGuard, ProviderError

SMOKE_PROMPT = "Name one well-known plumber in Columbus, OH."
SMOKE_CAP_USD = 0.50


def run_smoke(engines=None, opener=None):
    engines = list(engines or config.PAID_ENGINES)
    allow = os.environ.get("AIVIS_ALLOW_PAID") == "1"
    rows = []
    for e in engines:
        row = {"engine": e, "model": "", "ok": False, "error": "", "usage": {}}
        rows.append(row)
        if e not in config.PAID_ENGINES:
            row["error"] = "not a paid engine"
            continue
        row["model"] = config.model_for(e)
        if not allow:
            row["error"] = "AIVIS_ALLOW_PAID=1 not set"
            continue
        try:
            kw = {"opener": opener} if opener else {}
            ans = REGISTRY[e](budget=BudgetGuard(SMOKE_CAP_USD), allow_paid=True, **kw).ask(SMOKE_PROMPT, city="Columbus, OH")
            row.update(ok=bool(ans.text.strip()), usage=ans.usage, error="" if ans.text.strip() else "empty answer")
        except ProviderError as ex:
            row["error"] = str(ex)
    return rows


def format_smoke(rows) -> str:
    out = []
    for r in rows:
        u = r["usage"]
        use = (f"in={u.get('input_tokens', 0)} out={u.get('output_tokens', 0)} searches={u.get('searches', 0)} "
               f"cost=${u.get('cost_usd', 0):.4f}") if u else "-"
        out.append(f"{r['engine']:8s} {r['model']:20s} {'ok' if r['ok'] else 'ERROR: ' + r['error']:8s} {use}")
    return "\n".join(out)
