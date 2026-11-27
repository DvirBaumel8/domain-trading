"""MANUAL one-call live smoke check. Never run in CI, never imported by tests, never called by the Actor.

Usage (by hand, after Dvir's OK, with the key in the environment):  python scripts/live_smoke.py chatgpt

It makes ONE answer call through the Actor's own provider code and prints a status and a cost estimate. It prints no answer
text, no URLs, no key, no header and no provider error body.
"""
from __future__ import annotations

import asyncio
import pathlib
import sys

ROOT = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))


async def smoke(engine: str) -> str:
    import httpx
    from src import config
    from src.providers import Providers, ProviderError

    if engine not in config.ENGINES:
        return "status=bad_engine cost_estimate_usd=0"
    if not config.engine_key(engine):
        return "status=engine_not_configured cost_estimate_usd=0"
    async with httpx.AsyncClient(timeout=config.CALL_TIMEOUT_SECS + 10) as client:
        try:
            ans = await Providers(client, asyncio.sleep).ask(engine, "Which project management software would you recommend?", "")
        except ProviderError as e:
            return f"status={e.code} cost_estimate_usd=0"
        except Exception:  # noqa: BLE001 - never print exception text
            return "status=provider_error cost_estimate_usd=0"
    return f"status=ok answered={bool(ans.text)} search_used={ans.search_used} cost_estimate_usd={config.COST_ESTIMATE[engine]}"


if __name__ == "__main__":
    print(asyncio.run(smoke(sys.argv[1] if len(sys.argv) > 1 else "")))
