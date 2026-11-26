#!/usr/bin/env python3
"""One-call smoke test of the free check's Gemini setup. Run it rarely, by hand, after a deploy.

It makes exactly ONE grounded generateContent request (Google Search tool) to AVC_GEMINI_MODEL
(default gemini-2.5-flash-lite) using GEMINI_FREE_API_KEY from the environment (header x-goog-api-key only).
It never reads GEMINI_API_KEY. That one call counts against the free daily Search quota (500 requests a day,
shared by 2.5 Flash and 2.5 Flash-Lite). Its purpose: settle whether the free-tier project can call
gemini-2.5-flash-lite at all (Google says access to the 2.5 models is limited to users who used them before).

Prints only: model, HTTP status, a reason code and whether grounding metadata was present. Exit 0 only on
reason `ok`. It never prints the key, the prompt, the response text, Search Suggestions HTML or a URL.

    GEMINI_FREE_API_KEY=... python3 scripts/gemini_free_smoke.py
"""
import json
import os
import socket
import sys
import urllib.error
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "engine"))
from aivis.providers import gemini_free as G    # noqa: E402

PROMPT = "Name one well-known plumbing company in Austin, TX."


def run(env=None, opener=None):
    """-> (exit_code, lines). `env` and `opener` are injectable for tests."""
    env = os.environ if env is None else env
    model = (env.get(G.MODEL_ENV) or "").strip() or G.DEFAULT_MODEL
    status, reason, grounded = 0, "error", False
    key = (env.get(G.KEY_ENV) or "").strip()
    if not key:
        reason = "provider_not_configured"
    elif model not in G.FREE_SEARCH_MODELS:
        reason = "model_no_free_search"
    else:
        req = urllib.request.Request(
            G.ENDPOINT.format(model=model), method="POST", headers={"Content-Type": "application/json", "x-goog-api-key": key},
            data=json.dumps({"contents": [{"parts": [{"text": PROMPT}]}], "tools": [{"google_search": {}}]}).encode())
        try:
            with (opener or urllib.request.urlopen)(req, timeout=30) as r:
                status = getattr(r, "status", 200) or 200
                try:
                    cand = json.loads(r.read().decode("utf-8", "replace"))["candidates"][0]
                    grounded = bool(cand.get("groundingMetadata"))
                    reason = "ok" if grounded else "grounding_missing"
                except (ValueError, KeyError, IndexError, TypeError, AttributeError):
                    reason = "parse_error"
        except urllib.error.HTTPError as e:
            status = e.code
            try:
                raw = e.read(G.MAX_ERROR_BODY) if e.fp is not None else b""
            except Exception:
                raw = b""
            if e.code == 429 and G._quota_is_per_day(raw):
                reason = "gemini_quota_exhausted"
            elif e.code == 404 or (e.code == 403 and G._names_model(raw, model)):
                reason = "model_unavailable"
            else:
                reason = f"http_{e.code}"
        except (socket.timeout, TimeoutError):
            reason = "timeout"
        except (urllib.error.URLError, OSError):
            reason = "connection_error"
    lines = [f"model={model}", f"http_status={status}", f"reason={reason}", f"grounding_metadata={str(grounded).lower()}"]
    return (0 if reason == "ok" else 1), lines


if __name__ == "__main__":
    code, out = run()
    print("\n".join(out))
    sys.exit(code)
