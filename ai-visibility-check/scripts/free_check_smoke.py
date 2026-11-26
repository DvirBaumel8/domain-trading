#!/usr/bin/env python3
"""MANUAL smoke test of the free check's two providers. Never run from CI, unittest or any workflow.

Makes exactly ONE live call per provider (no retries). A provider whose key is unset is skipped with
provider_not_configured and is not called. Keys come from the environment (GEMINI_API_KEY, OPENAI_API_KEY).

Prints only: provider, model, status, reason code and counts (tokens, searches). Never a key, the prompt, the
answer text, Suggestions HTML, citations or a URL. Exit 0 only if at least one provider returned ok.

    GEMINI_API_KEY=... OPENAI_API_KEY=... python3 scripts/free_check_smoke.py
"""
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "engine"))

from aivis.free_caps import CapLedger                                            # noqa: E402
from aivis.providers.base import ProviderError                                   # noqa: E402
from aivis.providers.free_search import GeminiSearchProvider, OpenAISearchProvider  # noqa: E402

PROMPT = "Who are well-reviewed plumbers in Columbus, OH?"
CITY = "Columbus, OH"


def smoke_one(cls, opener=None):
    """-> dict with only safe fields."""
    p = cls(opener=opener, max_tries=1, ledger=CapLedger(), sleep=lambda s: None)
    row = {"provider": p.name, "model": p.model, "status": "error", "reason": "", "tokens_in": "-", "tokens_out": "-",
           "searches": "-"}
    if not p.configured():
        return {**row, "status": "skipped", "reason": "provider_not_configured"}
    try:
        ans = p.ask(PROMPT, city=CITY)
    except ProviderError as e:
        return {**row, "reason": str(getattr(e, "reason", "error"))[:40]}
    except Exception as e:      # never print the message: it could carry request details
        return {**row, "reason": type(e).__name__}
    u = ans.usage or {}
    return {**row, "status": "ok", "tokens_in": u.get("input_tokens", 0), "tokens_out": u.get("output_tokens", 0),
            "searches": u.get("searches", 0)}


def main(out=print, opener=None):
    rows = [smoke_one(c, opener) for c in (GeminiSearchProvider, OpenAISearchProvider)]
    for r in rows:
        out(f"provider={r['provider']} model={r['model']} status={r['status']} reason={r['reason'] or '-'} "
            f"tokens_in={r['tokens_in']} tokens_out={r['tokens_out']} searches={r['searches']}")
    return 0 if any(r["status"] == "ok" for r in rows) else 1


if __name__ == "__main__":
    sys.exit(main())
