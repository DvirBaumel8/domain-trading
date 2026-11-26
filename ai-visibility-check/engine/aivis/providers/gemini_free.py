"""Free-check provider: Gemini API free tier with Google Search grounding (mode 'web-search').

Hard rule: zero spend. This module reads ONLY GEMINI_FREE_API_KEY (a key of a Google project with NO billing
account linked). It never reads GEMINI_API_KEY (the paid pipeline's key), never falls back to another model or
provider, and never checks billing state. Only the allow-listed 2.5 models have free Search grounding.

Failures carry a short reason code, never a URL, prompt, response body or key:
rate_limited, timeout, http_<status>, connection_error, empty_answer, parse_error (as for Pollinations), plus
provider_not_configured, gemini_quota_exhausted, model_no_free_search, model_unavailable, grounding_missing.

Gemini Additional Terms (Grounding with Google Search): grounded text and Search Suggestions are shown only
live to the visitor who asked, unmodified, together, and are not stored. `Answer.suggestions_html` therefore
lives in memory only; callers must not persist it or the answer text.
"""
import datetime as _dt
import json
import os
import socket
import sys
import threading
import time
import urllib.error
import urllib.request

from .base import Answer, Provider, ProviderError
from .free import (BACKOFF_BASE_S, BUDGET_S, MAX_TRIES, RETRY_AFTER_CAP_S, SUFFIX, _Transient, _retry_after,
                   pacing_from_env)

NAME = "gemini-free"
KEY_ENV = "GEMINI_FREE_API_KEY"             # the only key this module reads
MODEL_ENV = "AVC_GEMINI_MODEL"
CAP_ENV = "AVC_GEMINI_DAILY_CALL_CAP"
DEFAULT_MODEL = "gemini-2.5-flash-lite"
FREE_SEARCH_MODELS = ("gemini-2.5-flash-lite", "gemini-2.5-flash")   # the one allow-list; 3.x and newer have no free Search
DEPRECATING_MODELS = ("gemini-2.5-flash",)  # routes to a paid model on 2026-12-01
DEFAULT_DAILY_CAP = 450                     # 90% of the documented 500 requests per day
CALLS_PER_CHECK = 8
ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent"
PACIFIC = "America/Los_Angeles"             # Google's daily quota resets at midnight Pacific
MAX_ERROR_BODY = 65536


def daily_cap_from_env() -> int:
    try:
        n = int(str(os.environ.get(CAP_ENV, "")).strip())
    except ValueError:
        return DEFAULT_DAILY_CAP
    return n if n > 0 else DEFAULT_DAILY_CAP


def _pacific_tz():
    try:
        from zoneinfo import ZoneInfo
        return ZoneInfo(PACIFIC)
    except Exception:                       # no tz database on the host: fixed UTC-8 (resets one hour late in summer)
        return _dt.timezone(_dt.timedelta(hours=-8))


class DailyCap:
    """Gemini calls per Pacific-time day. In memory (Render free has an ephemeral disk, so a restart resets it;
    the real quota error still maps to gemini_quota_exhausted). Thread-safe."""

    def __init__(self, clock=None):
        self._clock = clock or time.time
        self._lock = threading.Lock()
        self._tz = _pacific_tz()
        self._day, self.used, self._exhausted = None, 0, False

    def _roll(self):
        day = _dt.datetime.fromtimestamp(self._clock(), self._tz).date()
        if day != self._day:
            self._day, self.used, self._exhausted = day, 0, False

    def reserve(self, n=CALLS_PER_CHECK, cap=None) -> bool:
        """Reserve n calls for one check; False (nothing reserved) when it would pass the cap."""
        cap = daily_cap_from_env() if cap is None else cap
        with self._lock:
            self._roll()
            if self._exhausted or self.used + n > cap:
                return False
            self.used += n
            return True

    def settle(self, reserved, actual):
        """End of a check: replace the reservation with the attempts really made (retries included)."""
        with self._lock:
            self._roll()
            self.used = max(0, self.used - reserved + actual)

    def mark_exhausted(self):
        with self._lock:
            self._roll()
            self._exhausted = True


CAP = DailyCap()                            # shared by the server's free checks


def warn(msg):
    print("[gemini-free] " + msg, file=sys.stderr)


def model_from_env() -> str:
    return (os.environ.get(MODEL_ENV) or "").strip() or DEFAULT_MODEL


def _quota_is_per_day(body: bytes) -> bool:
    """True for a 429 whose JSON error is RESOURCE_EXHAUSTED with a per-day quota detail."""
    try:
        err = json.loads(body.decode("utf-8", "replace"))["error"]
        if err.get("status") != "RESOURCE_EXHAUSTED":
            return False
        blob = json.dumps(err.get("details", [])).lower()
    except (ValueError, KeyError, AttributeError, TypeError):
        return False
    return "perday" in blob or "per day" in blob or "per_day" in blob


def _names_model(body: bytes, model: str) -> bool:
    return model.lower() in body.decode("utf-8", "replace").lower()


class GeminiFreeProvider(Provider):
    name = NAME
    mode = "web-search"
    paid = False

    def __init__(self, model: str = None, min_interval_s: float = None, timeout_s: float = 25.0,
                 opener=None, sleep=None, clock=None, max_tries: int = MAX_TRIES, budget_s: float = BUDGET_S, cap=None):
        self.cap = cap or CAP
        self.model = (model or model_from_env()).strip()
        self.min_interval_s = pacing_from_env() if min_interval_s is None else min_interval_s
        self.timeout_s, self.max_tries, self.budget_s = timeout_s, max_tries, budget_s
        self._sleep = sleep or time.sleep
        self._clock = clock or time.time
        self._last = None
        self._open = opener or urllib.request.urlopen
        self.attempts = 0                   # every HTTP attempt, retries included
        self.model_ok = self.model in FREE_SEARCH_MODELS
        if not self.model_ok:
            warn("configured model is not on the free Search allow-list "
                 f"({', '.join(FREE_SEARCH_MODELS)}); free checks fail with model_no_free_search and make no calls")
        elif self.model in DEPRECATING_MODELS:
            warn("gemini-2.5-flash routes to a paid model on 2026-12-01 (no free Search there); "
                 "switch AVC_GEMINI_MODEL to gemini-2.5-flash-lite")

    def _once(self, key, prompt, timeout):
        url = ENDPOINT.format(model=self.model)
        body = json.dumps({"contents": [{"parts": [{"text": prompt + SUFFIX}]}],
                           "tools": [{"google_search": {}}]}).encode()
        req = urllib.request.Request(url, data=body, method="POST", headers={
            "Content-Type": "application/json", "x-goog-api-key": key})
        self.attempts += 1
        try:
            with self._open(req, timeout=timeout) as r:
                text = r.read().decode("utf-8", "replace")
        except urllib.error.HTTPError as e:
            try:
                raw = e.read(MAX_ERROR_BODY) if e.fp is not None else b""
            except Exception:
                raw = b""
            if e.code == 429:
                if _quota_is_per_day(raw):
                    raise ProviderError("gemini-free: gemini_quota_exhausted", "gemini_quota_exhausted", permanent=True)
                raise _Transient("rate_limited", _retry_after(e.headers))
            if e.code == 404 or (e.code == 403 and _names_model(raw, self.model)):
                raise ProviderError("gemini-free: model_unavailable", "model_unavailable", permanent=True)
            if e.code in (408, 425) or e.code >= 500:
                raise _Transient(f"http_{e.code}", _retry_after(e.headers), "http_error")
            raise ProviderError(f"gemini-free: http_{e.code}", f"http_{e.code}", "http_error", permanent=True)
        except (socket.timeout, TimeoutError):
            raise _Transient("timeout")
        except urllib.error.URLError as e:
            raise _Transient("timeout" if isinstance(e.reason, (socket.timeout, TimeoutError)) else "connection_error")
        except (ConnectionError, OSError):
            raise _Transient("connection_error")
        try:
            data = json.loads(text)
        except ValueError:
            raise _Transient("parse_error")
        try:
            cand = data["candidates"][0]
        except (KeyError, IndexError, TypeError):
            raise _Transient("empty_answer")        # for example a blocked prompt: no candidates
        try:
            answer = "".join(p.get("text", "") for p in cand["content"]["parts"]).strip()
        except (KeyError, TypeError, AttributeError):
            answer = ""
        if not answer:
            raise _Transient("empty_answer")
        try:
            html = cand["groundingMetadata"]["searchEntryPoint"]["renderedContent"]
        except (KeyError, TypeError):
            html = ""
        if not isinstance(html, str) or not html.strip():
            raise _Transient("grounding_missing")   # never show ungrounded text, or grounded text without Suggestions
        return answer, html

    def ask(self, prompt: str, city: str = "", run: int = 0) -> Answer:
        if not self.model_ok:
            raise ProviderError("gemini-free: model_no_free_search", "model_no_free_search", permanent=True)
        key = (os.environ.get(KEY_ENV) or "").strip()
        if not key:
            raise ProviderError("gemini-free: provider_not_configured", "provider_not_configured", permanent=True)
        if self._last is not None:
            wait = self.min_interval_s - (self._clock() - self._last)
            if wait > 0:
                self._sleep(wait)
        start, reason, category = self._clock(), "error", "error"
        try:
            for attempt in range(1, self.max_tries + 1):
                left = self.budget_s - (self._clock() - start)
                if left <= 0:
                    break
                try:
                    text, html = self._once(key, prompt, min(self.timeout_s, left))
                    return Answer(self.name, self.model, prompt, text, [], self.mode, 0.0, run, {}, html)
                except _Transient as t:
                    reason, category = t.reason, t.category
                    if attempt == self.max_tries:
                        break
                    wait = min(t.retry_after, RETRY_AFTER_CAP_S) if t.retry_after is not None \
                        else BACKOFF_BASE_S * 2 ** (attempt - 1)
                    if wait >= self.budget_s - (self._clock() - start):
                        break
                    self._sleep(wait)
                except ProviderError as e:
                    if e.reason == "gemini_quota_exhausted":
                        self.cap.mark_exhausted()
                    raise
        finally:
            self._last = self._clock()
        raise ProviderError(f"gemini-free: {reason}", reason, category)
