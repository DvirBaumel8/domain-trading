"""Free-check providers with live web search: Gemini (Google Search grounding), then OpenAI (web_search).

`FreeSearchProvider` is the one provider the free check uses. It tries Gemini first and falls back to OpenAI when
Gemini is not configured, errors, is out of quota or would pass its monthly cap. Both are capped per calendar month
(aivis/free_caps.py, prices in aivis/free_config.py). Keys come only from the environment and travel only in a
request header. PollinationsProvider is NOT part of this chain.

Failures carry a short reason code (never a URL, prompt, body or key):
  rate_limited, timeout, http_<status>, connection_error, empty_answer, parse_error  (as before)
  provider_not_configured  key missing or empty; no network call; permanent for that provider
  cap_reached              monthly cap hit or would be exceeded; permanent for that provider
  gemini_quota_exhausted   Gemini 429 with status RESOURCE_EXHAUSTED; permanent, no retry
  model_unavailable        404 / 403 naming the model; permanent for that provider
  grounding_missing        Gemini 200 without grounding metadata or without Search Suggestions HTML

One call per check: the prompt asks for the whole list of businesses as JSON ({"businesses": [...], "note": ""}) and
the provider turns that list into a numbered text answer for the audit pipeline. A reply that is empty, not that JSON
or has no names is empty_answer / parse_error (then the fallback, or a clean failure). Gemini has no documented
per-request cap on search queries, so the prompt asks for a single search and cost is bounded by the reservation
(3 searches) and the caps.

  daily_cap_reached        today's free-check USD limit would be passed; permanent for that provider (until tomorrow)

Live-only data (Gemini `searchEntryPoint.renderedContent`, OpenAI url_citation links) goes in `Answer.live` and is
never written anywhere by this module.
"""
import json
import os
import socket
import time
import urllib.error
import urllib.request

from .. import free_caps, free_config as fc
from .base import Answer, Provider, ProviderError
from .free import MAX_TRIES, BUDGET_S, RETRY_AFTER_CAP_S, BACKOFF_BASE_S, _Transient, _retry_after

FAIL_FAST_PERMANENT = 3             # permanent errors from one provider in one check before it is skipped
DEAD_REASONS = {"cap_reached", "daily_cap_reached", "provider_not_configured", "gemini_quota_exhausted", "model_unavailable"}
GEMINI_URL = "https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent"
OPENAI_URL = "https://api.openai.com/v1/responses"
MAX_LINKS = 12
MAX_NAMES = 15
FORMAT = (' Give the full list of specific business names a customer would be given, using one web search.'
          ' Reply with only JSON like {"businesses": ["Name One", "Name Two"], "note": ""}.'
          ' If you are not sure a business exists, say so in "note" instead of guessing;'
          ' if you find no specific business, return an empty list.')


def _names_from_text(text):
    """The business names in a structured reply, or None when it is not the requested JSON."""
    t = (text or "").strip()
    if t.startswith("```"):
        t = t.strip("`").strip()
        t = t[4:].strip() if t[:4].lower() == "json" else t
    a, b = t.find("{"), t.rfind("}")
    if a < 0 or b <= a:
        return None
    try:
        data = json.loads(t[a:b + 1])
    except ValueError:
        return None
    items = data.get("businesses") if isinstance(data, dict) else None
    if not isinstance(items, list):
        return None
    out = []
    for x in items:
        n = " ".join(x.split())[:120] if isinstance(x, str) else ""
        if n and n.lower() not in (o.lower() for o in out):
            out.append(n)
    return out[:MAX_NAMES]


def _as_list_text(names):
    return "\n".join(f"{i}. {n}" for i, n in enumerate(names, 1))


def _not_configured(name):
    return ProviderError(f"{name}: provider_not_configured", "provider_not_configured", "not_configured", permanent=True)


class _SearchProvider(Provider):
    mode = "web-search"
    paid = False                    # not the paid report pipeline: capped, free-check only
    key_env = ""

    def __init__(self, model="", timeout_s=40.0, opener=None, sleep=None, clock=None, ledger=None,
                 max_tries=MAX_TRIES, budget_s=BUDGET_S):
        self.model = model or self.default_model()
        self.timeout_s, self.max_tries, self.budget_s = timeout_s, max_tries, budget_s
        self._open = opener or urllib.request.urlopen
        self._sleep = sleep or time.sleep
        self._clock = clock or time.time
        self._ledger = ledger

    @property
    def ledger(self):
        return self._ledger or free_caps.LEDGER

    def configured(self) -> bool:
        return bool(os.environ.get(self.key_env, "").strip())

    # -- one HTTP attempt ------------------------------------------------------------------------
    def _request(self, key, prompt, city):  # pragma: no cover
        raise NotImplementedError

    def _parse(self, data, prompt):  # pragma: no cover
        raise NotImplementedError

    def _http_error(self, e):
        """HTTPError -> an exception. Reads the body only to classify it; nothing from it is kept."""
        if e.code == 429:
            if self._quota_exhausted(e):
                return ProviderError(f"{self.name}: gemini_quota_exhausted", "gemini_quota_exhausted", "quota", permanent=True)
            return _Transient("rate_limited", _retry_after(e.headers))
        if e.code in (403, 404) and self._names_model(e):
            return ProviderError(f"{self.name}: model_unavailable", "model_unavailable", "model_unavailable", permanent=True)
        if e.code in (408, 425) or e.code >= 500:
            return _Transient(f"http_{e.code}", _retry_after(e.headers), "http_error")
        return ProviderError(f"{self.name}: http_{e.code}", f"http_{e.code}", "http_error", permanent=True)

    def _quota_exhausted(self, e):
        return False

    def _body_text(self, e):
        try:
            return e.read().decode("utf-8", "replace")
        except Exception:
            return ""

    def _names_model(self, e):
        return self.model.lower() in self._body_text(e).lower()

    def _once(self, key, prompt, city, timeout):
        """-> (answer, kept_reservation). Raises _Transient / ProviderError; `release` says the call was not billed."""
        req = self._request(key, prompt, city)
        try:
            with self._open(req, timeout=timeout) as r:
                raw = r.read().decode("utf-8", "replace")
        except urllib.error.HTTPError as e:
            err = self._http_error(e)
            err.billed = False
            raise err
        except (socket.timeout, TimeoutError):
            t = _Transient("timeout"); t.billed = True; raise t
        except urllib.error.URLError as e:
            t = _Transient("timeout" if isinstance(e.reason, (socket.timeout, TimeoutError)) else "connection_error")
            t.billed = t.reason == "timeout"
            raise t
        except (ConnectionError, OSError):
            t = _Transient("connection_error"); t.billed = False; raise t
        try:
            data = json.loads(raw)
            if not isinstance(data, dict):
                raise ValueError
        except ValueError:
            t = _Transient("parse_error"); t.billed = True; raise t
        return data

    # -- the question ----------------------------------------------------------------------------
    def ask(self, prompt: str, city: str = "", run: int = 0) -> Answer:
        key = os.environ.get(self.key_env, "").strip()
        if not key:
            raise _not_configured(self.name)
        led, reserve = self.ledger, fc.reserve_usd(self.name)
        start, reason, category = self._clock(), "error", "error"
        for attempt in range(1, self.max_tries + 1):
            left = self.budget_s - (self._clock() - start)
            if left <= 0:
                break
            why = led.reserve_reason(self.name, reserve)
            if why:
                raise ProviderError(f"{self.name}: {why}", why, "cap", permanent=True)
            try:
                data = self._once(key, prompt, city, min(self.timeout_s, left))
            except (_Transient, ProviderError) as e:
                if getattr(e, "billed", True):
                    led.settle(self.name, reserve, None)
                else:
                    led.release(self.name, reserve)
                if isinstance(e, ProviderError):
                    raise
                reason, category = e.reason, e.category
                retry_after = e.retry_after
            else:
                try:
                    ans, usage = self._parse(data, prompt)
                except (_Transient, ProviderError) as e:
                    led.settle(self.name, reserve, self._cost(getattr(e, "usage", None)), **self._counts(getattr(e, "usage", None)))
                    if isinstance(e, ProviderError):
                        raise
                    reason, category, retry_after = e.reason, e.category, None
                else:
                    cost = self._cost(usage)
                    led.settle(self.name, reserve, cost, **self._counts(usage))
                    ans.run = run
                    ans.usage = {**usage, "cost_usd": cost}
                    return ans
            if attempt == self.max_tries:
                break
            wait = min(retry_after, RETRY_AFTER_CAP_S) if retry_after is not None else BACKOFF_BASE_S * 2 ** (attempt - 1)
            if wait >= self.budget_s - (self._clock() - start):
                break
            self._sleep(wait)
        raise ProviderError(f"{self.name}: {reason}", reason, category)

    def _cost(self, usage):
        u = usage or {"input_tokens": fc.EST_INPUT_TOKENS, "output_tokens": fc.EST_OUTPUT_TOKENS,
                      "searches": fc.EST_SEARCHES[self.name]}
        return fc.cost_usd(self.name, u["input_tokens"], u["output_tokens"], u["searches"])

    def _counts(self, usage):
        u = usage or {"input_tokens": fc.EST_INPUT_TOKENS, "output_tokens": fc.EST_OUTPUT_TOKENS,
                      "searches": fc.EST_SEARCHES[self.name]}
        return {"searches": u["searches"], "input_tokens": u["input_tokens"], "output_tokens": u["output_tokens"]}


def _num(v, default):
    return int(v) if isinstance(v, (int, float)) and not isinstance(v, bool) and v >= 0 else default


class GeminiSearchProvider(_SearchProvider):
    name, key_env = "gemini", fc.GEMINI_KEY_ENV

    @staticmethod
    def default_model():
        return fc.gemini_model()

    def _request(self, key, prompt, city):
        body = {"contents": [{"parts": [{"text": prompt + FORMAT}]}], "tools": [{"google_search": {}}],
                "generationConfig": {"maxOutputTokens": fc.EST_OUTPUT_TOKENS}}
        return urllib.request.Request(GEMINI_URL.format(model=self.model), data=json.dumps(body).encode(), method="POST",
                                      headers={"x-goog-api-key": key, "Content-Type": "application/json"})

    def _quota_exhausted(self, e):
        try:
            return json.loads(self._body_text(e)).get("error", {}).get("status") == "RESOURCE_EXHAUSTED"
        except (ValueError, AttributeError):
            return False

    def _parse(self, data, prompt):
        cand = (data.get("candidates") or [{}])[0]
        cand = cand if isinstance(cand, dict) else {}
        parts = (cand.get("content") or {}).get("parts") or []
        text = "".join(p.get("text", "") for p in parts if isinstance(p, dict) and not p.get("thought")).strip()
        meta = cand.get("groundingMetadata") if isinstance(cand.get("groundingMetadata"), dict) else {}
        queries = meta.get("webSearchQueries") if isinstance(meta.get("webSearchQueries"), list) else []
        um = data.get("usageMetadata") if isinstance(data.get("usageMetadata"), dict) else {}
        out_tok = _num(um.get("candidatesTokenCount"), 0) + _num(um.get("thoughtsTokenCount"), 0)
        usage = {"input_tokens": _num(um.get("promptTokenCount"), fc.EST_INPUT_TOKENS),
                 "output_tokens": out_tok if um and out_tok else fc.EST_OUTPUT_TOKENS,
                 # webSearchQueries is not a billing count, so never bill fewer than the documented minimum
                 "searches": max(len(queries), fc.MIN_BILLED_SEARCHES["gemini"])}

        def fail(reason):
            e = _Transient(reason); e.usage = usage
            return e
        if not text:
            raise fail("empty_answer")
        names = _names_from_text(text)
        if names is None:
            raise fail("parse_error")
        if not names:
            raise fail("empty_answer")
        text = _as_list_text(names)
        rendered = (meta.get("searchEntryPoint") or {}).get("renderedContent") if isinstance(meta.get("searchEntryPoint"), dict) else None
        if not isinstance(rendered, str) or not rendered.strip():
            raise fail("grounding_missing")     # no grounding, or Grounded Results without their Search Suggestions
        return Answer(self.name, self.model, prompt, text, [], self.mode, 0.0, 0, {}, {"suggestions": rendered}), usage


class OpenAISearchProvider(_SearchProvider):
    name, key_env = "openai", fc.OPENAI_KEY_ENV

    @staticmethod
    def default_model():
        return fc.openai_model()

    def _request(self, key, prompt, city):
        tool = {"type": "web_search", "user_location": {"type": "approximate", "country": "US", "city": city}} if city \
            else {"type": "web_search"}
        body = {"model": self.model, "input": prompt + FORMAT, "tools": [tool], "max_output_tokens": 1500}
        return urllib.request.Request(OPENAI_URL, data=json.dumps(body).encode(), method="POST",
                                      headers={"Authorization": "Bearer " + key, "Content-Type": "application/json"})

    def _parse(self, data, prompt):
        text, links, calls = "", [], 0
        for item in data.get("output") or []:
            if not isinstance(item, dict):
                continue
            if item.get("type") == "web_search_call":
                calls += 1
            for c in item.get("content") or []:
                if isinstance(c, dict) and c.get("type") == "output_text":
                    text += c.get("text", "") if isinstance(c.get("text"), str) else ""
                    for a in c.get("annotations") or []:
                        url = a.get("url") if isinstance(a, dict) and a.get("type") == "url_citation" else None
                        if isinstance(url, str) and url.startswith(("https://", "http://")) \
                                and all(l["url"] != url for l in links):
                            links.append({"url": url, "title": str(a.get("title") or "")[:200]})
        u = data.get("usage") if isinstance(data.get("usage"), dict) else {}
        usage = {"input_tokens": _num(u.get("input_tokens"), fc.EST_INPUT_TOKENS),
                 "output_tokens": _num(u.get("output_tokens"), fc.EST_OUTPUT_TOKENS),
                 "searches": max(calls, fc.MIN_BILLED_SEARCHES["openai"])}

        def fail(reason):
            e = _Transient(reason); e.usage = usage
            return e
        if not text.strip():
            raise fail("empty_answer")
        names = _names_from_text(text)
        if names is None:
            raise fail("parse_error")
        if not names:
            raise fail("empty_answer")
        if not calls and not links:
            raise fail("grounding_missing")     # an answer from model memory is not web-search output
        text = _as_list_text(names)
        return Answer(self.name, self.model, prompt, text.strip(), [l["url"] for l in links], self.mode, 0.0, 0, {},
                      {"citations": links[:MAX_LINKS]}), usage


class FreeSearchProvider(Provider):
    """Gemini first, OpenAI as the fallback. One instance per free check (it remembers which provider is out)."""
    name = "ai-search"
    mode = "web-search"
    paid = False

    def __init__(self, members=None, ledger=None):
        self.members = members if members is not None else [GeminiSearchProvider(), OpenAISearchProvider()]
        self._ledger = ledger
        self.failures = {}                  # provider -> {reason: n}; includes failures a fallback answer hid
        self._perm = {}
        self._dead = {}
        self.model = "+".join(m.model for m in self.members)

    @property
    def ledger(self):
        return self._ledger or free_caps.LEDGER

    def preflight(self):
        """None when the check can start, else the reason code. A provider whose cap cannot cover a whole check is
        skipped for this check (and its first refusal of the month alerts)."""
        capped = False
        for m in self.members:
            if not m.configured():
                self._dead[m.name] = "provider_not_configured"
            elif not self.ledger.can_afford(m.name, fc.check_usd(m.name)):
                self._dead[m.name] = "cap_reached"
                self.ledger.refuse_check(m.name)
                capped = True
            elif not self.ledger.daily_room(m.name, fc.check_usd(m.name)):
                self._dead[m.name] = "daily_cap_reached"
        if len(self._dead) < len(self.members):
            return None
        if "daily_cap_reached" in self._dead.values():
            self.ledger.daily_refused("usd")
            return "daily_cap_reached"
        return "cap_reached" if capped else "provider_not_configured"

    def _note(self, name, reason):
        self.failures.setdefault(name, {})
        self.failures[name][reason] = self.failures[name].get(reason, 0) + 1

    def ask(self, prompt, city="", run=0):
        last = None
        for m in self.members:
            if m.name in self._dead:
                continue
            try:
                ans = m.ask(prompt, city=city, run=run)
            except ProviderError as e:
                last = e
                self._note(m.name, e.reason)
                if e.permanent:
                    self._perm[m.name] = self._perm.get(m.name, 0) + 1
                    if e.reason in DEAD_REASONS or self._perm[m.name] >= FAIL_FAST_PERMANENT:
                        self._dead[m.name] = e.reason
                continue
            vendor = ans.provider
            ans.usage = {**ans.usage, "vendor": vendor}
            ans.provider = self.name
            return ans
        if last is None:        # every provider was already out
            reasons = list(self._dead.values())
            reason = "daily_cap_reached" if "daily_cap_reached" in reasons else \
                "cap_reached" if "cap_reached" in reasons else (reasons[-1] if reasons else "error")
            raise ProviderError(f"{self.name}: {reason}", reason, "cap" if "cap" in reason else reason, permanent=True)
        out = len(self._dead) >= len(self.members)
        raise ProviderError(f"{self.name}: {last.reason}", last.reason, last.category, permanent=out)

    def finish(self):
        """End of the check: write the counters once."""
        self.ledger.flush()
