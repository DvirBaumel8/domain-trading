import pytest

from helpers import CANARIES

ENV = ["APIFY_USER_IS_PAYING", "ACTOR_MAX_TOTAL_CHARGE_USD", "FREE_PLAN_MAX_ROWS", "MAX_PROVIDER_COST_PER_RUN_USD", "DISABLED_ENGINES",
       "MODEL_CHATGPT", "MODEL_GEMINI", "MODEL_CLAUDE", "MODEL_EXTRACTOR", "USE_FAKE_PROVIDERS", "APIFY_IS_AT_HOME"]


@pytest.fixture(autouse=True)
def env(monkeypatch):
    for k in ENV:
        monkeypatch.delenv(k, raising=False)
    for k, v in CANARIES.items():
        monkeypatch.setenv(k, v)
    monkeypatch.setenv("APIFY_USER_IS_PAYING", "1")
