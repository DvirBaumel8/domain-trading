"""Constants and environment switches. Keys are read only here, only from the environment, and never logged."""
from __future__ import annotations

import os

UA = "PodcastTranscriberActor/0.1 (Apify Actor)"

FEED_CAP_BYTES = 40 * 1024 * 1024
TRANSCRIPT_CAP_BYTES = 10 * 1024 * 1024
LOOKUP_CAP_BYTES = 2 * 1024 * 1024
MAX_DOWNLOAD_MB = 700
MAX_REDIRECTS = 5
CHUNK_SECONDS = 20 * 60
SILENCE_WINDOW = 60
HARD_CUT_OVERLAP = 2.0
ENGINE_TIMEOUT_SECS = 600.0
ENGINE_TRIES = 3
EPISODE_CONCURRENCY = 3
DOWNLOADS_PER_HOST = 2
HOST_INTERVAL = 1.0
APPLE_LOOKUPS_PER_MINUTE = 20
FREE_PLAN_MINUTES = 15
FREE_PLAN_MESSAGE = "Free-plan runs transcribe up to 15 minutes. Upgrade your Apify plan to transcribe full episodes."
ALL_FAILED_MESSAGE = "No episode could be processed. See the dataset for the reason per source."

KEY_ENV = {"groq": "GROQ_API_KEY", "assemblyai": "ASSEMBLYAI_API_KEY", "gemini": "GEMINI_API_KEY", "openai": "OPENAI_API_KEY"}
DEFAULT_ENGINE_ORDER = ("groq", "assemblyai", "gemini")
SPEAKER_ENGINES = ("assemblyai", "gemini")
DEFAULT_SUMMARY_MODELS = ("openai:gpt-6-luna", "gemini:gemini-3.5-flash-lite")


def key(engine: str) -> str:
    return os.environ.get(KEY_ENV[engine], "").strip() if engine in KEY_ENV else ""


def all_keys() -> list[str]:
    return [v for v in (os.environ.get(n, "").strip() for n in KEY_ENV.values()) if v]


def engine_order() -> list[str]:
    raw = os.environ.get("STT_ENGINE_ORDER", "").strip()
    order = [e.strip().lower() for e in raw.split(",") if e.strip()] if raw else list(DEFAULT_ENGINE_ORDER)
    return list(dict.fromkeys(order))


def summary_models() -> list[str]:
    raw = os.environ.get("SUMMARY_MODEL", "").strip()
    return [m.strip() for m in raw.split(",") if m.strip()] if raw else list(DEFAULT_SUMMARY_MODELS)


def is_paying() -> bool:
    if os.environ.get("APIFY_USER_IS_PAYING", "").strip() == "1":
        return True
    user = os.environ.get("APIFY_USER_ID", "").strip()
    operators = {u.strip() for u in os.environ.get("OPERATOR_USER_IDS", "").split(",") if u.strip()}
    return bool(user) and user in operators


def kv_store_id() -> str:
    return os.environ.get("ACTOR_DEFAULT_KEY_VALUE_STORE_ID", "").strip()
