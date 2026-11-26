"""Settings in one place: model ids, provider cost estimates, limits, and the environment switches.

Everything here is read from environment variables or plain constants. Provider keys are read only here (`engine_key`)
and are never logged, returned or stored. The cost numbers are estimates of what one provider call costs us; they are
not Apify prices (no price is set in this repo).
"""
from __future__ import annotations

import os
from decimal import Decimal, InvalidOperation

ENGINES = ("chatgpt", "gemini", "claude")

# Model ids. Source: the task brief of 2026-11-26 (CR-134); each can be overridden by an environment variable.
DEFAULT_MODELS = {
    "chatgpt": "gpt-6-luna",                # OpenAI Responses API, checked 2026-11-26
    "gemini": "gemini-3.5-flash-lite",      # Gemini generateContent, checked 2026-11-26
    "claude": "claude-haiku-5-5",           # Anthropic Messages API, checked 2026-11-26
    "extractor": "gpt-6-luna",              # OpenAI Responses API, no tools, checked 2026-11-26
}
MODEL_ENV = {"chatgpt": "MODEL_CHATGPT", "gemini": "MODEL_GEMINI", "claude": "MODEL_CLAUDE", "extractor": "MODEL_EXTRACTOR"}
KEY_ENV = {"chatgpt": "OPENAI_API_KEY", "gemini": "GEMINI_API_KEY", "claude": "ANTHROPIC_API_KEY"}

# Estimated provider cost of one call, from measurements (2026-11-26). Used only by the run spend guard.
COST_ESTIMATE = {"chatgpt": Decimal("0.015"), "gemini": Decimal("0.035"), "claude": Decimal("0.015"), "extractor": Decimal("0.001")}
DEFAULT_MAX_PROVIDER_COST = Decimal("3.00")
DEFAULT_FREE_PLAN_MAX_ROWS = 6
PAID_MAX_ROWS = 60

CALL_TIMEOUT_SECS = 60       # one provider call
ENGINE_CONCURRENCY = 2       # at most this many calls at once per engine
RETRY_AFTER_CAP_SECS = 10    # Retry-After is honoured up to this
RETRY_PAUSE_SECS = 1         # pause before the one retry of a timeout or 5xx
RUN_LIMIT_SECS = 540         # the Actor run limit is 600 s; no new row starts after this
START_EVENT = "apify-actor-start"
RESULT_EVENT = "result"


class ConfigError(ValueError):
    """A bad environment (for example the fake providers switched on at home). The message is plain and has no secrets."""


def _decimal(name: str) -> Decimal | None:
    raw = os.environ.get(name, "").strip()
    try:
        value = Decimal(raw)
    except InvalidOperation:
        return None
    return value if value.is_finite() else None


def use_fake_providers() -> bool:
    """USE_FAKE_PROVIDERS=1 is for local runs only and is refused on the Apify platform."""
    if os.environ.get("USE_FAKE_PROVIDERS", "").strip() != "1":
        return False
    if os.environ.get("APIFY_IS_AT_HOME", "").strip():
        raise ConfigError("USE_FAKE_PROVIDERS is for local runs only and is not allowed on the Apify platform.")
    return True


def engine_key(engine: str) -> str:
    """The provider key for an engine, or empty. In fake mode a placeholder (no network is used)."""
    if use_fake_providers():
        return "fake"
    return os.environ.get(KEY_ENV[engine], "").strip()


def model_for(engine: str) -> str:
    return os.environ.get(MODEL_ENV[engine], "").strip() or DEFAULT_MODELS[engine]


def disabled_engines() -> set[str]:
    return {e.strip().lower() for e in os.environ.get("DISABLED_ENGINES", "").split(",") if e.strip()}


def is_paying() -> bool:
    return os.environ.get("APIFY_USER_IS_PAYING", "") == "1"


def free_plan_max_rows() -> int:
    try:
        n = int(os.environ.get("FREE_PLAN_MAX_ROWS", "").strip())
    except ValueError:
        return DEFAULT_FREE_PLAN_MAX_ROWS
    return n if n >= 1 else DEFAULT_FREE_PLAN_MAX_ROWS


def max_rows() -> int:
    return PAID_MAX_ROWS if is_paying() else free_plan_max_rows()


def max_provider_cost() -> Decimal:
    value = _decimal("MAX_PROVIDER_COST_PER_RUN_USD")
    return value if value is not None and value >= 0 else DEFAULT_MAX_PROVIDER_COST


def max_total_charge_usd() -> Decimal | None:
    """The user's maximum total charge for the run, from the platform's environment; None when not set."""
    return _decimal("ACTOR_MAX_TOTAL_CHARGE_USD")
