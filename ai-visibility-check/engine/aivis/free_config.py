"""Free-check provider settings: models, prices, monthly spend caps. Never put keys here.

Separate from config.py on purpose: the paid report pipeline (PAID_ENGINES, DEFAULT_MODELS, AIVIS_ALLOW_PAID)
is not touched. The free check only READS the two vendor keys that the host already has.

Env (all optional): AVC_GEMINI_MODEL (default gemini-3.5-flash-lite), AVC_OPENAI_MODEL (default gpt-4o-mini).
Keys: GEMINI_API_KEY and OPENAI_API_KEY, set in the host dashboard only.

Prices, checked against the official pages on 27 Nov 2026 (the pages now redirect, 301, to
aistudio.google.com/docs/... and developers.openai.com/api/docs/...); re-verify before changing a number:
- Gemini 3.5 Flash-Lite, paid tier: $0.30 / 1M input, $2.50 / 1M output (thinking counts as output).
  Grounding with Google Search: 5,000 free requests a month shared by ALL Gemini 3+ models on the project
  (the paid report pipeline uses the same pool), then $14 per 1,000; 1,500 a day cap. One prompt can run
  several search queries and each is billed; webSearchQueries is "for attribution and debugging, not billing".
  https://ai.google.dev/gemini-api/docs/models/gemini-3.5-flash-lite and /docs/pricing
- OpenAI gpt-4o-mini: $0.15 / 1M input, $0.60 / 1M output. Responses API web_search tool: $10.00 per 1,000 calls
  plus search content tokens; for gpt-4o-mini with the non-preview tool that is a fixed block of 8,000 input tokens
  per call. https://platform.openai.com/docs/pricing and /docs/guides/tools-web-search

Conservative choice: every free-check Gemini search is counted at the paid $14 / 1,000 rate, even though the first
5,000 a month may be free, because that pool is shared with the paid pipeline and is not ours to assume.
"""
import os

GEMINI_KEY_ENV = "GEMINI_API_KEY"
OPENAI_KEY_ENV = "OPENAI_API_KEY"
DEFAULT_GEMINI_MODEL = "gemini-3.5-flash-lite"
DEFAULT_OPENAI_MODEL = "gpt-4o-mini"

# Hard monthly caps, free-check usage only (calendar month, UTC).
CAP_USD = {"gemini": 10.00, "openai": 5.00}

# USD per 1M input tokens, per 1M output tokens, per 1,000 searches, tokens billed per OpenAI search call.
RATES = {
    "gemini": {"in": 0.30, "out": 2.50, "search": 14.00, "search_tokens": 0},
    "openai": {"in": 0.15, "out": 0.60, "search": 10.00, "search_tokens": 8000},
}

# Conservative stand-ins when a response lacks a count, and the pre-call reservation.
EST_INPUT_TOKENS = 1000
EST_OUTPUT_TOKENS = 3000        # Gemini output includes thinking tokens
EST_SEARCHES = {"gemini": 3, "openai": 3}
MIN_BILLED_SEARCHES = {"gemini": 2, "openai": 1}    # a grounded Gemini answer is billed at least this many

QUESTIONS_PER_CHECK = 8


def gemini_model() -> str:
    return os.environ.get("AVC_GEMINI_MODEL", "").strip() or DEFAULT_GEMINI_MODEL


def openai_model() -> str:
    return os.environ.get("AVC_OPENAI_MODEL", "").strip() or DEFAULT_OPENAI_MODEL


def cost_usd(provider: str, input_tokens: int, output_tokens: int, searches: int) -> float:
    r = RATES[provider]
    tokens_in = input_tokens + searches * r["search_tokens"]
    return round(tokens_in * r["in"] / 1e6 + output_tokens * r["out"] / 1e6 + searches * r["search"] / 1000, 6)


def reserve_usd(provider: str) -> float:
    """Worst-case-ish cost of one call, held back before the call is made."""
    return cost_usd(provider, EST_INPUT_TOKENS, EST_OUTPUT_TOKENS, EST_SEARCHES[provider])


def check_usd(provider: str) -> float:
    """Conservative cost of one whole free check on this provider."""
    return round(reserve_usd(provider) * QUESTIONS_PER_CHECK, 6)
