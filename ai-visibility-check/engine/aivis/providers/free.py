"""Free, no-sign-up provider: Pollinations text API (https://text.pollinations.ai).

Mode is 'model-memory': it answers from an LLM's training data with NO live
web search, so it is not what a ChatGPT user sees (Paprik AI, Apr 2026: API
without search surfaced 135 unique brands vs 845 in the ChatGPT UI). Use it
only to smoke-test the pipeline and to show how often models invent
businesses. Never sell its output as 'what ChatGPT says'.

Failures carry a short reason code (rate_limited, timeout, http_<status> such as
http_403, connection_error, empty_answer, parse_error), never a URL, prompt or body.
HTTP codes also carry the family category http_error.
Transient ones are retried a few times with bounded backoff.
"""
import json
import os
import socket
import time
import urllib.error
import urllib.parse
import urllib.request

from .base import Answer, Provider, ProviderError

SUFFIX = (" Answer as a short list of specific business names."
          " If you are not sure a business exists, say so instead of guessing.")
MAX_TRIES = 3
BUDGET_S = 30.0            # total time one question may take, retries and waits included
RETRY_AFTER_CAP_S = 10.0   # never wait longer than this because a server asked us to
BACKOFF_BASE_S = 2.0       # waits 2 s, then 4 s
DEFAULT_PACING_S = 4.0


def pacing_from_env(default=DEFAULT_PACING_S) -> float:
    try:
        return max(0.0, float(os.environ.get("AVC_FREE_PACING_S", default)))
    except ValueError:
        return default


class _Transient(Exception):
    def __init__(self, reason, retry_after=None, category=None):
        super().__init__(reason)
        self.reason, self.retry_after = reason, retry_after
        self.category = category or reason


def _retry_after(headers):
    try:
        v = float((headers or {}).get("Retry-After", ""))
        return v if v >= 0 else None
    except (TypeError, ValueError, AttributeError):
        return None


class PollinationsProvider(Provider):
    name = "pollinations"
    mode = "model-memory"
    paid = False

    def __init__(self, model: str = "openai", min_interval_s: float = None, timeout_s: float = 25.0,
                 opener=None, sleep=None, clock=None, max_tries: int = MAX_TRIES, budget_s: float = BUDGET_S):
        self.model = model
        self.min_interval_s = pacing_from_env() if min_interval_s is None else min_interval_s
        self.timeout_s = timeout_s
        self.max_tries, self.budget_s = max_tries, budget_s
        self._sleep = sleep or time.sleep
        self._clock = clock or time.time
        self._last = None
        self._open = opener or urllib.request.urlopen

    def _once(self, url, timeout):
        try:
            with self._open(url, timeout=timeout) as r:
                text = r.read().decode("utf-8", "replace")
        except urllib.error.HTTPError as e:
            if e.code == 429:
                raise _Transient("rate_limited", _retry_after(e.headers))
            if e.code in (408, 425) or e.code >= 500:
                raise _Transient(f"http_{e.code}", _retry_after(e.headers), "http_error")
            raise ProviderError(f"pollinations: http_{e.code}", f"http_{e.code}", "http_error", permanent=True)  # no retry
        except (socket.timeout, TimeoutError):
            raise _Transient("timeout")
        except urllib.error.URLError as e:
            raise _Transient("timeout" if isinstance(e.reason, (socket.timeout, TimeoutError)) else "connection_error")
        except (ConnectionError, OSError):
            raise _Transient("connection_error")
        if not text.strip():
            raise _Transient("empty_answer")
        if text.lstrip()[:1] in "{<":       # a JSON error object or an HTML page, not an answer
            try:
                bad = isinstance(json.loads(text), dict) and "error" in json.loads(text)
            except ValueError:
                bad = text.lstrip().startswith("<")
            if bad:
                raise _Transient("parse_error")
        return text

    def ask(self, prompt: str, city: str = "", run: int = 0) -> Answer:
        if self._last is not None:
            wait = self.min_interval_s - (self._clock() - self._last)
            if wait > 0:
                self._sleep(wait)
        q = urllib.parse.quote(prompt + SUFFIX)
        url = f"https://text.pollinations.ai/{q}?model={urllib.parse.quote(self.model)}&seed={run}"
        start, reason, category = self._clock(), "error", "error"
        try:
            for attempt in range(1, self.max_tries + 1):
                left = self.budget_s - (self._clock() - start)
                if left <= 0:
                    break
                try:
                    text = self._once(url, min(self.timeout_s, left))
                    return Answer(self.name, self.model, prompt, text, [], self.mode, 0.0, run)
                except _Transient as t:
                    reason, category = t.reason, t.category
                    if attempt == self.max_tries:
                        break
                    wait = min(t.retry_after, RETRY_AFTER_CAP_S) if t.retry_after is not None \
                        else BACKOFF_BASE_S * 2 ** (attempt - 1)
                    if wait >= self.budget_s - (self._clock() - start):
                        break
                    self._sleep(wait)
        finally:
            self._last = self._clock()
        raise ProviderError(f"pollinations: {reason}", reason, category)
