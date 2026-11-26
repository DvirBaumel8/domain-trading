"""The three official AI APIs and the extractor, called with httpx. No vendor SDKs.

Safety: provider keys go only into request headers. Nothing from a provider error is kept: no body, no header, no message.
A failure becomes a `ProviderError` that carries an error code and the HTTP status, nothing else.
"""
from __future__ import annotations

import asyncio
import json
import re
from dataclasses import dataclass, field

import httpx

from . import config, extract, matching

OPENAI_URL = "https://api.openai.com/v1/responses"
ANTHROPIC_URL = "https://api.anthropic.com/v1/messages"
GEMINI_URL = "https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent"
ANTHROPIC_VERSION = "2023-06-01"
MAX_ANSWER_TOKENS = 1024
DATA_START, DATA_END = "<answer_data>", "</answer_data>"
QUOTA_HINTS = ("insufficient_quota", "exceeded your current quota", "credit balance", "billing", "quota exceeded",
               "out of credits", "daily limit")


class ProviderError(Exception):
    """`code` is one of the dataset errorCode values. The text is the code and the HTTP status only."""

    def __init__(self, code: str, status: int | None = None):
        super().__init__(f"{code}" + (f" (HTTP {status})" if status else ""))
        self.code, self.status = code, status


@dataclass
class Answer:
    text: str
    urls: list[str] = field(default_factory=list)
    search_used: bool = False


class _Timeout(Exception):
    pass


async def _with_timeout(make, secs: float, sleep):
    """Run `make()` and give up after `secs` on the injected clock (a fake clock in tests)."""
    task = asyncio.ensure_future(make())
    timer = asyncio.ensure_future(sleep(secs))
    try:
        await asyncio.wait({task, timer}, return_when=asyncio.FIRST_COMPLETED)
        if task.done():
            return task.result()
        task.cancel()
        await asyncio.gather(task, return_exceptions=True)
        raise _Timeout()
    finally:
        timer.cancel()
        if not task.done():
            task.cancel()


def _retry_after(resp: httpx.Response) -> float:
    try:
        return max(0.0, min(float(resp.headers.get("retry-after", "")), config.RETRY_AFTER_CAP_SECS))
    except ValueError:
        return float(config.RETRY_PAUSE_SECS)


def classify(resp: httpx.Response) -> str:
    """The error code for a non-2xx answer. The body is read here to spot a quota message and is not kept."""
    status = resp.status_code
    if status == 402:
        return "quota_exhausted"
    if status in (403, 429):
        try:
            body = resp.text.lower()
        except Exception:  # noqa: BLE001 - unreadable body: treat as no message
            body = ""
        if any(h in body for h in QUOTA_HINTS):
            return "quota_exhausted"
    if status == 429:
        return "rate_limited"
    return "provider_error"


def _urls(items) -> list[str]:
    out: list[str] = []
    for u in items:
        if isinstance(u, str) and u.startswith(("http://", "https://")) and u not in out:
            out.append(u)
    return out[:20]


def parse_openai(data: dict) -> Answer:
    texts, urls, search = [], [], False
    for item in data.get("output") or []:
        if item.get("type") == "web_search_call":
            search = True
        elif item.get("type") == "message":
            for part in item.get("content") or []:
                if part.get("type") == "output_text":
                    texts.append(part.get("text") or "")
                    urls += [a.get("url") for a in part.get("annotations") or [] if a.get("type") == "url_citation"]
    return Answer(matching.clean("\n".join(texts)).strip(), _urls(urls), search)


def parse_anthropic(data: dict) -> Answer:
    texts, urls = [], []
    searched = False
    for block in data.get("content") or []:
        if block.get("type") == "text":
            texts.append(block.get("text") or "")
            urls += [c.get("url") for c in block.get("citations") or []]
        elif block.get("type") == "server_tool_use":
            searched = True
    used = ((data.get("usage") or {}).get("server_tool_use") or {}).get("web_search_requests") or 0
    return Answer(matching.clean("".join(texts)).strip(), _urls(urls), bool(used) or searched)


def parse_gemini(data: dict) -> Answer:
    cand = (data.get("candidates") or [{}])[0]
    parts = (cand.get("content") or {}).get("parts") or []
    meta = cand.get("groundingMetadata") or {}
    urls = []
    for chunk in meta.get("groundingChunks") or []:
        web = chunk.get("web") or {}
        title = (web.get("title") or "").strip().lower()
        # Gemini cites a redirect link; its title is normally the site's host, which is what we compare with the domain.
        urls.append(f"https://{title}" if re.fullmatch(r"[a-z0-9.-]+\.[a-z]{2,}", title) else web.get("uri"))
    return Answer(matching.clean("".join(p.get("text") or "" for p in parts)).strip(), _urls(urls), bool(meta.get("webSearchQueries")))


def split_location(location: str) -> dict:
    """'Austin, US' -> {'city': 'Austin', 'country': 'US'}. Only a two-letter last part counts as the country."""
    parts = [p.strip() for p in (location or "").split(",") if p.strip()]
    out: dict = {}
    if parts:
        out["city"] = parts[0]
    if len(parts) > 1 and re.fullmatch(r"[A-Za-z]{2}", parts[-1]):
        out["country"] = parts[-1].upper()
    return out


class Providers:
    def __init__(self, client: httpx.AsyncClient, sleep=asyncio.sleep):
        self.client, self.sleep = client, sleep

    async def _post(self, url: str, headers: dict, body: dict) -> dict:
        """One call with a 60 s limit and one retry for a timeout, a 429 or a 5xx. Raises ProviderError."""
        for attempt in (0, 1):
            wait = float(config.RETRY_PAUSE_SECS)
            try:
                resp = await _with_timeout(lambda: self.client.post(url, headers=headers, json=body), config.CALL_TIMEOUT_SECS, self.sleep)
            except (_Timeout, httpx.TimeoutException):
                code, status, retry = "timeout", None, True
            except httpx.HTTPError:
                raise ProviderError("provider_error") from None
            else:
                if resp.status_code < 300:
                    try:
                        data = resp.json()
                    except ValueError:
                        raise ProviderError("provider_error", resp.status_code) from None
                    if not isinstance(data, dict):
                        raise ProviderError("provider_error", resp.status_code)
                    return data
                code, status = classify(resp), resp.status_code
                retry = code == "rate_limited" or (code == "provider_error" and status >= 500)
                if code == "rate_limited":
                    wait = _retry_after(resp)
            if not retry or attempt == 1:
                raise ProviderError(code, status)
            await self.sleep(wait)
        raise ProviderError("provider_error")  # not reached

    async def ask(self, engine: str, prompt: str, location: str = "") -> Answer:
        key, model, loc = config.engine_key(engine), config.model_for(engine), split_location(location)
        if engine == "chatgpt":
            tool: dict = {"type": "web_search"}
            if loc:
                tool["user_location"] = {"type": "approximate", **loc}
            body = {"model": model, "input": prompt, "tools": [tool], "max_tool_calls": 1}
            data = await self._post(OPENAI_URL, {"Authorization": f"Bearer {key}"}, body)
            answer = parse_openai(data)
        elif engine == "claude":
            tool = {"type": "web_search_20250305", "name": "web_search", "max_uses": 1}
            if loc:
                tool["user_location"] = {"type": "approximate", **loc}
            body = {"model": model, "max_tokens": MAX_ANSWER_TOKENS, "messages": [{"role": "user", "content": prompt}], "tools": [tool]}
            data = await self._post(ANTHROPIC_URL, {"x-api-key": key, "anthropic-version": ANTHROPIC_VERSION}, body)
            answer = parse_anthropic(data)
        elif engine == "gemini":
            body = {"contents": [{"role": "user", "parts": [{"text": prompt}]}], "tools": [{"google_search": {}}]}
            data = await self._post(GEMINI_URL.format(model=model), {"x-goog-api-key": key}, body)
            answer = parse_gemini(data)
        else:
            raise ProviderError("engine_not_configured")
        if not answer.text:
            raise ProviderError("provider_error")
        return answer

    async def extract(self, brand: str, answer_text: str) -> tuple[list[dict], str | None]:
        """One small-model call, strict JSON, no tools. The answer is passed as data. Raises ProviderError or ValueError."""
        key = config.engine_key("chatgpt")
        if not key:
            raise ProviderError("engine_not_configured")
        body = {
            "model": config.model_for("extractor"),
            "instructions": extract.SYSTEM_INSTRUCTION,
            "input": f"Brand: {brand}\n\n{DATA_START}\n{answer_text}\n{DATA_END}",
            "text": {"format": {"type": "json_schema", "name": "answer_brands", "strict": True, "schema": extract.SCHEMA}},
        }
        data = await self._post(OPENAI_URL, {"Authorization": f"Bearer {key}"}, body)
        return extract.parse_extractor_output(parse_openai(data).text)


# ---- local fake providers (USE_FAKE_PROVIDERS=1, refused on the platform): no network, no keys ----
FAKE_ANSWER = (
    "Here are some options:\n\n1. **Asana** - flexible task and project views\n2. **Trello** - simple boards\n"
    "3. **Monday.com** - customisable workflows\n\nSources: https://asana.com/pricing"
)


def fake_transport() -> httpx.MockTransport:
    def handler(request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content or b"{}")
        host = request.url.host
        if host == "api.anthropic.com":
            return httpx.Response(200, json={"content": [{"type": "text", "text": FAKE_ANSWER, "citations": [{"url": "https://asana.com/pricing"}]}],
                                             "usage": {"server_tool_use": {"web_search_requests": 1}}})
        if host == "generativelanguage.googleapis.com":
            return httpx.Response(200, json={"candidates": [{"content": {"parts": [{"text": FAKE_ANSWER}]},
                                                             "groundingMetadata": {"webSearchQueries": ["fake"], "groundingChunks": [{"web": {"uri": "https://asana.com/pricing", "title": "asana.com"}}]}}]})
        if "tools" in body:
            return httpx.Response(200, json={"output": [{"type": "web_search_call"}, {"type": "message", "content": [
                {"type": "output_text", "text": FAKE_ANSWER, "annotations": [{"type": "url_citation", "url": "https://asana.com/pricing"}]}]}]})
        text = str(body.get("input", ""))
        answer = text.split(DATA_START, 1)[-1].split(DATA_END, 1)[0]
        out = json.dumps({"brands": extract.heuristic_brands(answer), "sentiment": "positive"})
        return httpx.Response(200, json={"output": [{"type": "message", "content": [{"type": "output_text", "text": out, "annotations": []}]}]})

    return httpx.MockTransport(handler)

