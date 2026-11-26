"""One place for paid-engine settings: model ids, Gemini thinking level, per-call
cost estimates, token/search rates, and the default order cap.

Every value can be overridden by an environment variable (read at call time, so
tests and the operator can change it without editing code):
  AIVIS_MODEL_<ENGINE>      e.g. AIVIS_MODEL_CLAUDE=claude-opus-5-5
  AIVIS_COST_<ENGINE>       per-call cost estimate in USD, e.g. AIVIS_COST_GEMINI=0.03
  AIVIS_GEMINI_THINKING     minimal | low | medium | high   (default medium)
  AIVIS_ORDER_CAP_USD       default per-order cap in USD    (default 12.00)
Nothing here ever holds a key.

Sources (official, checked 26 Nov 2026; plan: docs/requests/avc-mock-run/model-plan.md):
- OpenAI gpt-6.2-sol $2/$10 per M; web search $10 per 1,000 calls (+ content tokens at input rate).
  https://platform.openai.com/docs/pricing
- Perplexity perplexity/sonar $0.25/$2.50 per M; web_search $2.50 per 1,000 calls.
  https://docs.perplexity.ai/docs/agent-api/models , https://docs.perplexity.ai/guides/pricing
- Gemini gemini-4-hydrogen $1.50/$7.50 per M (thinking tokens count as output); Search grounding
  $14 per 1,000 queries after 5,000 free a month (paid tier only). https://ai.google.dev/gemini-api/docs/pricing
- Claude claude-sonnet-5-5 $2/$10 per M; web search $10 per 1,000 searches (+ results as input).
  https://platform.claude.com/docs/en/about-claude/pricing
The per-call estimates are mid cases from the plan (section 4, 1 search, ~5k search-content tokens, 500 out);
revise them from the real usage in order-log.json after the first paid run.
"""
import os

ENGINES = ("openai", "perplexity", "gemini", "claude")

DEFAULT_MODELS = {                      # consumer-matched, plan section 5 (26 Nov 2026)
    "openai": "gpt-6.2-sol",            # no gpt-5-mini fallback: it shuts down 11 Dec 2026
    "perplexity": "perplexity/sonar",   # always explicit, never a bare effort-only call
    "gemini": "gemini-4-hydrogen",
    "claude": "claude-sonnet-5-5",
}

DEFAULT_COST_PER_CALL = {               # mid estimates, USD, 26 Nov 2026 (plan section 4 / 6 item 6)
    "openai": 0.025,
    "perplexity": 0.004,
    "gemini": 0.018,                    # after the free grounding quota; ~0.004 inside it
    "claude": 0.025,
}
PAID_COST_PER_CALL = DEFAULT_COST_PER_CALL   # defaults; use cost_per_call() to honour env overrides

RATES = {                               # USD: per-million input tokens, per-million output tokens, per search
    "openai": {"in_per_m": 2.00, "out_per_m": 10.00, "per_search": 0.010},
    "perplexity": {"in_per_m": 0.25, "out_per_m": 2.50, "per_search": 0.0025},
    "gemini": {"in_per_m": 1.50, "out_per_m": 7.50, "per_search": 0.014},
    "claude": {"in_per_m": 2.00, "out_per_m": 10.00, "per_search": 0.010},
}

THINKING_LEVELS = ("minimal", "low", "medium", "high")
DEFAULT_GEMINI_THINKING = "medium"      # Hydrogen's own default is high, which is what inflates cost
DEFAULT_CAP_USD = 12.00                 # per order (was 8.00); see plan section 5


def _env(name):
    return (os.environ.get(name) or "").strip()


def model_for(engine: str) -> str:
    return _env("AIVIS_MODEL_" + engine.upper()) or DEFAULT_MODELS[engine]


def cost_per_call(engine: str) -> float:
    raw = _env("AIVIS_COST_" + engine.upper())
    if raw:
        try:
            v = float(raw)
            if v >= 0:
                return v
        except ValueError:
            pass
    return DEFAULT_COST_PER_CALL[engine]


def gemini_thinking() -> str:
    v = _env("AIVIS_GEMINI_THINKING").lower()
    return v if v in THINKING_LEVELS else DEFAULT_GEMINI_THINKING


def default_cap_usd() -> float:
    raw = _env("AIVIS_ORDER_CAP_USD")
    if raw:
        try:
            v = float(raw)
            if v > 0:
                return v
        except ValueError:
            pass
    return DEFAULT_CAP_USD


def usage_cost(engine: str, input_tokens: int, output_tokens: int, searches: int) -> float:
    r = RATES[engine]
    return round(input_tokens * r["in_per_m"] / 1e6 + output_tokens * r["out_per_m"] / 1e6
                 + searches * r["per_search"], 6)
