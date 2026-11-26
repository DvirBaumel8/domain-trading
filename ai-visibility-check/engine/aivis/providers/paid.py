"""Paid providers: written but DISABLED unless an API key is present AND the
caller passes allow_paid=True with a BudgetGuard. Nothing here has been run.

Per-call cost estimates (USD), list prices checked Nov 2026; see sources.md:
- OpenAI Responses API + web_search: measured $0.058/answer with chat-latest
  (querying.ai, 4 Oct 2026); $10 per 1,000 search calls + tokens.
- Perplexity Sonar (Agent API): $0.25/$2.50 per M tokens + $2.50 per 1,000
  web_search calls -> ~ $0.004/answer at ~2k in / 500 out tokens.
- Gemini 3.x Flash grounding: 5,000 free searches/month, then $14 per 1,000
  search queries; Flash tokens $0.75/$3.75 per M -> ~ $0.016/answer after the
  free quota, ~$0.003 inside it (tokens only). Needs a Google AI Studio key
  (sign-up). Free tier data is used to improve Google products.
- Claude web search: $10 per 1,000 searches + tokens (Haiku 4.5 $1/$5 per M)
  -> ~ $0.02/answer.
"""
import json
import os
import urllib.request

from .base import Answer, BudgetGuard, Provider, ProviderError

PAID_COST_PER_CALL = {
    "openai": 0.058,
    "perplexity": 0.004,
    "gemini": 0.016,
    "claude": 0.02,
}


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
        self.model = model or self.default_model
        self._open = opener or urllib.request.urlopen
        self.est_cost_per_call = PAID_COST_PER_CALL[self.name]

    def _post(self, url, payload, headers):
        self.budget.charge(self.est_cost_per_call)
        req = urllib.request.Request(url, data=json.dumps(payload).encode(), headers=headers, method="POST")
        try:
            with self._open(req, timeout=90) as r:
                return json.loads(r.read().decode())
        except Exception as e:
            code = getattr(e, "code", None)
            raise ProviderError(f"{self.name} call failed: {type(e).__name__}"
                                + (f" HTTP {code}" if isinstance(code, int) else "")) from None  # never echo headers


class OpenAIWebSearchProvider(_PaidBase):
    name, env_key, default_model = "openai", "OPENAI_API_KEY", "gpt-5-mini"

    def ask(self, prompt, city="", run=0):
        data = self._post("https://api.openai.com/v1/responses", {
            "model": self.model, "input": prompt,
            "tools": [{"type": "web_search", "user_location": {"type": "approximate", "country": "US", "city": city}}],
        }, {"Authorization": "Bearer " + os.environ[self.env_key], "Content-Type": "application/json"})
        text, cites = "", []
        for item in data.get("output", []):
            for c in item.get("content", []) or []:
                if c.get("type") == "output_text":
                    text += c.get("text", "")
                    cites += [a.get("url") for a in c.get("annotations", []) if a.get("url")]
        return Answer(self.name, self.model, prompt, text, cites, self.mode, self.est_cost_per_call, run)


class PerplexityProvider(_PaidBase):
    name, env_key, default_model = "perplexity", "PERPLEXITY_API_KEY", "sonar"

    def ask(self, prompt, city="", run=0):
        data = self._post("https://api.perplexity.ai/chat/completions", {
            "model": self.model, "messages": [{"role": "user", "content": prompt}],
        }, {"Authorization": "Bearer " + os.environ[self.env_key], "Content-Type": "application/json"})
        text = data.get("choices", [{}])[0].get("message", {}).get("content", "")
        return Answer(self.name, self.model, prompt, text, data.get("citations", []), self.mode,
                      self.est_cost_per_call, run)


class GeminiGroundedProvider(_PaidBase):
    name, env_key, default_model = "gemini", "GEMINI_API_KEY", "gemini-3.8-flash"

    def ask(self, prompt, city="", run=0):
        url = f"https://generativelanguage.googleapis.com/v1beta/models/{self.model}:generateContent"
        data = self._post(url, {"contents": [{"parts": [{"text": prompt}]}], "tools": [{"google_search": {}}]},
                          {"x-goog-api-key": os.environ[self.env_key], "Content-Type": "application/json"})
        cand = (data.get("candidates") or [{}])[0]
        text = "".join(p.get("text", "") for p in cand.get("content", {}).get("parts", []))
        chunks = cand.get("groundingMetadata", {}).get("groundingChunks", [])
        cites = [c.get("web", {}).get("uri") for c in chunks if c.get("web")]
        return Answer(self.name, self.model, prompt, text, cites, self.mode, self.est_cost_per_call, run)


class ClaudeWebSearchProvider(_PaidBase):
    name, env_key, default_model = "claude", "ANTHROPIC_API_KEY", "claude-haiku-4-5"

    def ask(self, prompt, city="", run=0):
        data = self._post("https://api.anthropic.com/v1/messages", {
            "model": self.model, "max_tokens": 1024, "messages": [{"role": "user", "content": prompt}],
            "tools": [{"type": "web_search_20250305", "name": "web_search", "max_uses": 2}],
        }, {"x-api-key": os.environ[self.env_key], "anthropic-version": "2023-06-01",
            "content-type": "application/json"})
        text, cites = "", []
        for block in data.get("content", []):
            if block.get("type") == "text":
                text += block.get("text", "")
                cites += [c.get("url") for c in block.get("citations", []) or [] if c.get("url")]
        return Answer(self.name, self.model, prompt, text, cites, self.mode, self.est_cost_per_call, run)
