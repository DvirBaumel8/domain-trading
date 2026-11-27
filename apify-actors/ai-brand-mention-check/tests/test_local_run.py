"""Local fake providers: USE_FAKE_PROVIDERS=1 works offline and is refused on the platform."""
import asyncio

import httpx
import pytest

from helpers import inp
from src import config, providers, runner


def test_fake_switch_refused_at_home(monkeypatch):
    monkeypatch.setenv("USE_FAKE_PROVIDERS", "1")
    monkeypatch.setenv("APIFY_IS_AT_HOME", "1")
    with pytest.raises(config.ConfigError):
        config.use_fake_providers()
    monkeypatch.delenv("APIFY_IS_AT_HOME")
    assert config.use_fake_providers() is True
    monkeypatch.setenv("USE_FAKE_PROVIDERS", "0")
    assert config.use_fake_providers() is False


def test_prefill_input_with_fake_providers_gives_valid_rows_and_summary(monkeypatch):
    monkeypatch.setenv("USE_FAKE_PROVIDERS", "1")
    for k in ("OPENAI_API_KEY", "GEMINI_API_KEY", "ANTHROPIC_API_KEY"):
        monkeypatch.delenv(k)
    pushed, box = [], {}

    async def push(row, charge):
        pushed.append((row, charge))
        return False

    async def noop(_):
        return None

    async def summ(s):
        box["s"] = s

    async def go():
        async with httpx.AsyncClient(transport=providers.fake_transport()) as c:
            return await runner.run(inp(engines=["chatgpt", "gemini", "claude"], includeAnswerText=True), client=c, push=push,
                                    set_status=noop, set_summary=summ)
    ok, msg = asyncio.run(go())
    assert ok and len(pushed) == 9 and all(c and r["status"] == "ok" and r["mentioned"] and r["rank"] == 1 for r, c in pushed)
    assert box["s"]["overall"]["mentionRate"] == 1.0 and box["s"]["engines"]["gemini"]["rowsOk"] == 3
