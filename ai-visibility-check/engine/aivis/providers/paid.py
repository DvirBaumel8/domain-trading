"""Paid providers: DISABLED unless an API key is present AND the caller passes
allow_paid=True with a BudgetGuard. Model ids, thinking level and cost
estimates live in aivis/config.py (with dated source comments). Nothing here
has been run against the live APIs.
"""
import json
import os
import urllib.request

from .. import config
from .base import Answer, BudgetGuard, Provider, ProviderError

PAID_COST_PER_CALL = config.PAID_COST_PER_CALL


class _PaidBase(Provider):
    paid = True
    mode = "web-search"
    env_key = ""

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

    def _answer(self, prompt, text, cites, run, input_tokens, output_tokens, searches):
        """Build the Answer with real usage from the vendor response (counts only, never headers/keys)."""
        usage = {"input_tokens": int(input_tokens or 0), "output_tokens": int(output_tokens or 0),
                 "searches": int(searches or 0)}
        usage["cost_usd"] = config.usage_cost(self.name, usage["input_tokens"], usage["output_tokens"], usage["searches"])
        return Answer(self.name, self.model, prompt, text, cites, self.mode, self.est_cost_per_call, run, usage)

    def _post(self, url, payload, headers):
        self.budget.charge(self.est_cost_per_call)
        req = urllib.request.Request(url, data=json.dumps(payload).encode(), headers=headers, method="POST")
        try:
            with self._open(req, timeout=90) as r:
                return json.loads(r.read().decode())
        except Exception as e:
            self.budget.refund(self.est_cost_per_call)    # failed calls do not count toward the cap
            raise ProviderError(f"{self.name} call failed: {type(e).__name__}") from None  # never echo headers


class OpenAIWebSearchProvider(_PaidBase):
    name, env_key = "openai", "OPENAI_API_KEY"

    def ask(self, prompt, city="", run=0):
        data = self._post("https://api.openai.com/v1/responses", {
            "model": self.model, "input": prompt,
            "tools": [{"type": "web_search", "user_location": {"type": "approximate", "country": "US", "city": city}}],
        }, {"Authorization": "Bearer " + os.environ[self.env_key], "Content-Type": "application/json"})
        text, cites, searches = "", [], 0
        for item in data.get("output", []):
            if item.get("type") == "web_search_call":
                searches += 1
            for c in item.get("content", []) or []:
                if c.get("type") == "output_text":
                    text += c.get("text", "")
                    cites += [a.get("url") for a in c.get("annotations", []) if a.get("url")]
        u = data.get("usage") or {}
        return self._answer(prompt, text, cites, run, u.get("input_tokens"), u.get("output_tokens"), searches)


class GeminiGroundedProvider(_PaidBase):
    name, env_key = "gemini", "GEMINI_API_KEY"

    def ask(self, prompt, city="", run=0):
        url = f"https://generativelanguage.googleapis.com/v1beta/models/{self.model}:generateContent"
        data = self._post(url, {"contents": [{"parts": [{"text": prompt}]}], "tools": [{"google_search": {}}],
                           "generationConfig": {"thinkingConfig": {"thinkingLevel": config.gemini_thinking()}}},
                          {"x-goog-api-key": os.environ[self.env_key], "Content-Type": "application/json"})
        cand = (data.get("candidates") or [{}])[0]
        text = "".join(p.get("text", "") for p in cand.get("content", {}).get("parts", []))
        meta = cand.get("groundingMetadata") or {}
        chunks = meta.get("groundingChunks", [])
        queries = meta.get("webSearchQueries", [])
        if not chunks and not queries:
            raise ProviderError("gemini: Google Search grounding did not run (operator: the key is probably on the "
                                "free tier; use a paid AI Studio key). Answer discarded.")
        cites = [c.get("web", {}).get("uri") for c in chunks if c.get("web")]
        u = data.get("usageMetadata") or {}
        out_tok = (u.get("candidatesTokenCount") or 0) + (u.get("thoughtsTokenCount") or 0)   # thinking bills as output
        return self._answer(prompt, text, cites, run, u.get("promptTokenCount"), out_tok, len(queries) or 1)


class ClaudeWebSearchProvider(_PaidBase):
    name, env_key = "claude", "ANTHROPIC_API_KEY"

    def ask(self, prompt, city="", run=0):
        data = self._post("https://api.anthropic.com/v1/messages", {
            "model": self.model, "max_tokens": 1024, "messages": [{"role": "user", "content": prompt}],
            "tools": [{"type": "web_search_20250305", "name": "web_search", "max_uses": config.CLAUDE_WEB_SEARCH_MAX_USES}],
        }, {"x-api-key": os.environ[self.env_key], "anthropic-version": "2023-06-01",
            "content-type": "application/json"})
        text, cites = "", []
        for block in data.get("content", []):
            if block.get("type") == "text":
                text += block.get("text", "")
                cites += [c.get("url") for c in block.get("citations", []) or [] if c.get("url")]
        u = data.get("usage") or {}
        searches = (u.get("server_tool_use") or {}).get("web_search_requests", 0)
        return self._answer(prompt, text, cites, run, u.get("input_tokens"), u.get("output_tokens"), searches)
