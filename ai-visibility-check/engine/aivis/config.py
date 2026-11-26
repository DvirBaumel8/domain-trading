"""One place for the paid engines: model ids, thinking level, cost estimates, rates, order cap.

Env overrides (all optional, read at call time):
  AIVIS_MODEL_OPENAI / _GEMINI / _CLAUDE   model id
  AIVIS_GEMINI_THINKING                    low | medium | high (default medium)
  AIVIS_COST_OPENAI / _GEMINI / _CLAUDE    estimated USD per call
  AIVIS_ORDER_CAP_USD                      per-order spend cap (default 12.00)
Never put keys here.

Sources (official, checked 26 Nov 2026; docs/requests/avc-mock-run/model-plan.md):
- OpenAI gpt-6.2-sol: $2 / $10 per 1M tokens in/out, web search $10 per 1,000 calls.
  https://platform.openai.com/docs/pricing
- Gemini gemini-4-hydrogen: $1.50 / $7.50 per 1M (thinking tokens count as output); grounding
  $14 per 1,000 queries after the monthly free quota. https://ai.google.dev/gemini-api/docs/pricing
- Claude claude-sonnet-5-5: $2 / $10 per 1M, web search $10 per 1,000.
  https://platform.claude.com/docs/en/about-claude/pricing
- Mid estimates per call (1 search, mid token sizes, model-plan.md section 4 and 6):
  OpenAI 0.025, Gemini 0.018 (after free quota), Claude 0.025.
"""
import os

# Engines in a paid report by default. Perplexity was dropped (owner decision, 26 Nov 2026).
PAID_ENGINES = ("openai", "gemini", "claude")
DISABLED_ENGINES = ("perplexity",)      # listed only so nobody re-adds it by accident

ENV_KEYS = {"openai": "OPENAI_API_KEY", "gemini": "GEMINI_API_KEY", "claude": "ANTHROPIC_API_KEY"}

DEFAULT_MODELS = {"openai": "gpt-6.2-sol", "gemini": "gemini-4-hydrogen", "claude": "claude-sonnet-5-5"}
DEFAULT_GEMINI_THINKING = "medium"
CLAUDE_WEB_SEARCH_MAX_USES = 2

PAID_COST_PER_CALL = {"openai": 0.025, "gemini": 0.018, "claude": 0.025}

# USD per 1M input tokens, per 1M output tokens, per 1,000 searches.
RATES = {
    "openai": {"in": 2.00, "out": 10.00, "search": 10.00},
    "gemini": {"in": 1.50, "out": 7.50, "search": 14.00},
    "claude": {"in": 2.00, "out": 10.00, "search": 10.00},
}

DEFAULT_CAP_USD = 12.00     # 3-engine high case is about $9 (model-plan.md)


def _num(env_name, default):
    raw = os.environ.get(env_name, "").strip()
    if not raw:
        return default
    try:
        v = float(raw)
    except ValueError:
        raise ValueError(f"{env_name} must be a number")
    if v < 0:
        raise ValueError(f"{env_name} must not be negative")
    return v


def model_for(engine: str) -> str:
    return os.environ.get(f"AIVIS_MODEL_{engine.upper()}", "").strip() or DEFAULT_MODELS[engine]


def gemini_thinking() -> str:
    level = os.environ.get("AIVIS_GEMINI_THINKING", "").strip().lower() or DEFAULT_GEMINI_THINKING
    if level not in ("low", "medium", "high"):
        raise ValueError("AIVIS_GEMINI_THINKING must be low, medium or high")
    return level


def cost_per_call(engine: str) -> float:
    return _num(f"AIVIS_COST_{engine.upper()}", PAID_COST_PER_CALL[engine])


def order_cap_usd() -> float:
    return _num("AIVIS_ORDER_CAP_USD", DEFAULT_CAP_USD)


def usage_cost(engine: str, input_tokens: int, output_tokens: int, searches: int) -> float:
    r = RATES[engine]
    return round(input_tokens * r["in"] / 1e6 + output_tokens * r["out"] / 1e6 + searches * r["search"] / 1000, 6)
