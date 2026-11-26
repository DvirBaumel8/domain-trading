"""Operator smoke test: one minimal call per paid engine. NEVER run in CI or tests.

    AIVIS_ALLOW_PAID=1 OPENAI_API_KEY=... python -m aivis smoke --engine all

Costs a few cents. Reports model-not-found (HTTP 404) clearly. Prints no keys or bodies.
"""
import os

from .order import ENV_KEYS, PAID_ENGINES
from .providers import REGISTRY, BudgetGuard, ProviderError

PROMPT = "Reply with the single word: ok"


def smoke(engines):
    """-> list of (engine, model, ok, message)."""
    if os.environ.get("CI"):
        raise SystemExit("smoke refuses to run in CI (it makes real, paid calls)")
    if os.environ.get("AIVIS_ALLOW_PAID") != "1":
        raise SystemExit("smoke is locked: set AIVIS_ALLOW_PAID=1 (it makes real, paid calls)")
    out = []
    for e in engines:
        if not os.environ.get(ENV_KEYS[e]):
            out.append((e, "", False, f"SKIPPED: {ENV_KEYS[e]} not set"))
            continue
        prov = REGISTRY[e](budget=BudgetGuard(0.25), allow_paid=True)
        try:
            ans = prov.ask(PROMPT, city="Austin")
            ok, msg = bool(ans.text.strip()), "ok" if ans.text.strip() else "EMPTY ANSWER"
        except ProviderError as err:
            ok, msg = False, str(err)
            if "HTTP 404" in msg:
                msg += f" -> MODEL NOT FOUND: check the model name {prov.model!r}"
            elif "HTTP 400" in msg:
                msg += f" -> request rejected: check the model name {prov.model!r} and its parameters"
            elif "HTTP 401" in msg or "HTTP 403" in msg:
                msg += " -> key rejected"
        out.append((e, prov.model, ok, msg))
    return out


def cmd_smoke(a):
    engines = list(PAID_ENGINES) if a.engine == "all" else [a.engine]
    res = smoke(engines)
    for e, model, ok, msg in res:
        print(f"{'PASS' if ok else 'FAIL'} {e:11s} {model:20s} {msg}")
    if not all(ok for _, _, ok, _ in res):
        raise SystemExit(1)
