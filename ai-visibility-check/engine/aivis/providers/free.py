"""Free, no-sign-up provider: Pollinations text API (https://text.pollinations.ai).

Mode is 'model-memory': it answers from an LLM's training data with NO live
web search, so it is not what a ChatGPT user sees (Paprik AI, Apr 2026: API
without search surfaced 135 unique brands vs 845 in the ChatGPT UI). Use it
only to smoke-test the pipeline and to show how often models invent
businesses. Never sell its output as 'what ChatGPT says'.
"""
import time
import urllib.parse
import urllib.request

from .base import Answer, Provider, ProviderError


class PollinationsProvider(Provider):
    name = "pollinations"
    mode = "model-memory"
    paid = False

    def __init__(self, model: str = "openai", min_interval_s: float = 4.0, timeout_s: float = 60.0,
                 opener=None):
        self.model = model
        self.min_interval_s = min_interval_s
        self.timeout_s = timeout_s
        self._last = 0.0
        self._open = opener or urllib.request.urlopen

    def ask(self, prompt: str, city: str = "", run: int = 0) -> Answer:
        wait = self.min_interval_s - (time.time() - self._last)
        if wait > 0:
            time.sleep(wait)
        q = urllib.parse.quote(prompt + " Answer as a short list of specific business names.")
        url = f"https://text.pollinations.ai/{q}?model={urllib.parse.quote(self.model)}&seed={run}"
        try:
            with self._open(url, timeout=self.timeout_s) as r:
                text = r.read().decode("utf-8", "replace")
        except Exception as e:  # network errors become provider errors
            raise ProviderError(f"pollinations failed: {e}") from e
        finally:
            self._last = time.time()
        return Answer(self.name, self.model, prompt, text, [], self.mode, 0.0, run)
