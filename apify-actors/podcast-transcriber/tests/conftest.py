import pytest

from src import net

ENV = ["GROQ_API_KEY", "ASSEMBLYAI_API_KEY", "GEMINI_API_KEY", "OPENAI_API_KEY", "STT_ENGINE_ORDER", "SUMMARY_MODEL",
       "OPERATOR_USER_IDS", "APIFY_USER_IS_PAYING", "APIFY_USER_ID", "ACTOR_DEFAULT_KEY_VALUE_STORE_ID", "LIVE_TESTS", "LIVE_SPEND_OK"]


@pytest.fixture(autouse=True)
def clean_env(monkeypatch):
    for k in ENV:
        monkeypatch.delenv(k, raising=False)
    monkeypatch.setattr(net, "_ALLOW_LOOPBACK_FOR_TESTS", False)


def pytest_configure(config):
    config.addinivalue_line("markers", "live: real network and keys; skipped unless LIVE_TESTS=1")
