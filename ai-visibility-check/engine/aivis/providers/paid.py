"""Paid providers: DISABLED unless an API key is present AND the caller passes
allow_paid=True with a BudgetGuard. Model ids, thinking level, cost estimates and
rates live in ../config.py (env overrides allowed); see its dated sources.

Each call records the vendor's real usage (tokens, search count when given, cost
computed from the config rates) on Answer.usage. Keys and headers are never
logged or echoed; errors carry only the exception type.
"""
import json
import os
import urllib.request

from .. import config
from ..config import PAID_COST_PER_CALL  # noqa: F401  (re-exported defaults)
from .base import Answer, BudgetGuard, Provider, ProviderError


def _int(v):
    return v if isinstance(v, int) and not isinstance(v, bool) else 0


class _PaidBase(Provider):
    paid = True
    mode = "web-search"
    env_key = ""
    key_name = ""

    def __init__(self, budget: BudgetGuard = None, allow_paid: bool = False, model: str = "", opener=None):
        if not allow_paid:
            raise ProviderError(f"{self.name}: paid provider disabled (needs Dvir's yes + allow_paid=True)")
        if budget is None:
            raise ProviderError(f"{self.name}: a BudgetGuard is required")
        if not os.environ.get(self.env_key):
            raise ProviderError(f"{self.name}: env {self.env_key} not set")
        self.budget = budget
        self.model = model or config.model_for(self.name)
        self._open = opener or urllib.request.urlopen
        self.est_cost_per_call = config.cost_per_call(self.name)

    def _post(self, url, payload, headers):
        self.budget.charge(self.est_cost_per_call)
        req = urllib.request.Request(url, data=json.dumps(payload).encode(), headers=headers, method="POST")
        try:
            with self._open(req, timeout=90) as r:
                return json.loads(r.read().decode())
        except Exception as e:
            raise ProviderError(f"{self.name} call failed: {type(e).__name__}") from None  # never echo headers

    def _usage(self, input_tokens, output_tokens, searches):
        i, o, s = _int(input_tokens), _int(output_tokens), _int(searches)
        return {"model": self.model, "input_tokens": i, "output_tokens": o, "searches": s,
                "cost_usd": config.usage_cost(self.name, i, o, s)}

    def _answer(self, prompt, text, cites, run, usage):
        return Answer(self.name, self.model, prompt, text, cites, self.mode, self.est_cost_per_call, run, usage)


def _output_text(data):
    """Responses-style output (OpenAI, Perplexity Agent): text, citation urls, count of search items."""
    text, cites, searches = "", [], 0
    for item in data.get("output", []) or []:
        t = item.get("type", "")
        if t in ("web_search_call", "search_results"):
            searches += 1
            for r in item.get("results", []) or []:
                if r.get("url"):
                    cites.append(r["url"])
        for c in item.get("content", []) or []:
            if c.get("type") == "output_text":
                text += c.get("text", "")
                cites += [a.get("url") for a in c.get("annotations", []) or [] if a.get("url")]
    return text, cites, searches


class OpenAIWebSearchProvider(_PaidBase):
    name, env_key = "openai", "OPENAI_API_KEY"

    def ask(self, prompt, city="", run=0):
        data = self._post("https://api.openai.com/v1/responses", {
            "model": self.model, "input": prompt,
            "tools": [{"type": "web_search", "user_location": {"type": "approximate", "country": "US", "city": city}}],
        }, {"Authorization": "Bearer " + os.environ[self.env_key], "Content-Type": "application/json"})
        text, cites, searches = _output_text(data)
        u = data.get("usage") or {}
        return self._answer(prompt, text, cites, run,
                            self._usage(u.get("input_tokens"), u.get("output_tokens"), searches))


class PerplexityProvider(_PaidBase):
    """Agent API (Chat Completions ended 27 Sep 2026). Always sends an explicit model."""
    name, env_key = "perplexity", "PERPLEXITY_API_KEY"

    def ask(self, prompt, city="", run=0):
        data = self._post("https://api.perplexity.ai/v1/agent", {
            "model": self.model, "input": prompt, "tools": [{"type": "web_search"}],
        }, {"Authorization": "Bearer " + os.environ[self.env_key], "Content-Type": "application/json"})
        text, cites, searches = _output_text(data)
        for r in data.get("search_results", []) or []:      # top-level list, when the API returns one
            if isinstance(r, dict) and r.get("url"):
                cites.append(r["url"])
        cites = list(dict.fromkeys(cites))
        if not text:
            text = data.get("output_text", "") or ""
        u = data.get("usage") or {}
        return self._answer(prompt, text, cites, run,
                            self._usage(u.get("input_tokens"), u.get("output_tokens"), searches))


class GeminiGroundedProvider(_PaidBase):
    name, env_key = "gemini", "GEMINI_API_KEY"

    def ask(self, prompt, city="", run=0):
        url = f"https://generativelanguage.googleapis.com/v1beta/models/{self.model}:generateContent"
        data = self._post(url, {
            "contents": [{"parts": [{"text": prompt}]}], "tools": [{"google_search": {}}],
            "generationConfig": {"thinkingConfig": {"thinkingLevel": config.gemini_thinking()}},
        }, {"x-goog-api-key": os.environ[self.env_key], "Content-Type": "application/json"})
        cand = (data.get("candidates") or [{}])[0]
        meta = cand.get("groundingMetadata") or {}
        chunks = meta.get("groundingChunks") or []
        if not chunks and not meta.get("webSearchQueries"):
            raise ProviderError("gemini: Google Search grounding did not run. Operator: use a paid-tier "
                                "AI Studio key (free-tier keys get no grounding); answer discarded")
        text = "".join(p.get("text", "") for p in cand.get("content", {}).get("parts", []) if not p.get("thought"))
        cites = [c.get("web", {}).get("uri") for c in chunks if c.get("web")]
        u = data.get("usageMetadata") or {}
        out = _int(u.get("candidatesTokenCount")) + _int(u.get("thoughtsTokenCount"))   # thinking is billed as output
        return self._answer(prompt, text, cites, run,
                            self._usage(u.get("promptTokenCount"), out, len(meta.get("webSearchQueries") or [])))


class ClaudeWebSearchProvider(_PaidBase):
    name, env_key = "claude", "ANTHROPIC_API_KEY"

    def ask(self, prompt, city="", run=0):
        tool = {"type": "web_search_20250305", "name": "web_search", "max_uses": 2}
        parts = [x.strip() for x in (city or "").split(",")]
        if len(parts) == 2 and parts[0] and parts[1]:
            tool["user_location"] = {"type": "approximate", "city": parts[0], "region": parts[1], "country": "US"}
        data = self._post("https://api.anthropic.com/v1/messages", {
            "model": self.model, "max_tokens": 1024, "messages": [{"role": "user", "content": prompt}],
            "tools": [tool],
        }, {"x-api-key": os.environ[self.env_key], "anthropic-version": "2023-06-01",
            "content-type": "application/json"})
        text, cites = "", []
        for block in data.get("content", []):
            if block.get("type") == "text":
                text += block.get("text", "")
                cites += [c.get("url") for c in block.get("citations", []) or [] if c.get("url")]
        u = data.get("usage") or {}
        searches = (u.get("server_tool_use") or {}).get("web_search_requests")
        return self._answer(prompt, text, cites, run,
                            self._usage(u.get("input_tokens"), u.get("output_tokens"), searches))
