"""GeminiFreeProvider: request shape, key isolation, reason codes, allow-list, daily cap, no leaks. Offline."""
import contextlib
import io
import json
import os
import re
import sys
import unittest
import urllib.error
from email.message import Message
from unittest import mock

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

import aivis.order as order
from aivis import config
from aivis.audit import run_audit
from aivis.niches import get_niche
from aivis.order import Order, OrderError, build_providers
from aivis.providers import REGISTRY, ProviderError
from aivis.providers import gemini_free as G
from aivis.providers.gemini_free import DailyCap, GeminiFreeProvider

FREE_KEY = "test-key-not-real-free"
PAID_KEY = "test-key-not-real-PAID-distinct"
SUGG = '<div class="container"><a class="chip" href="https://www.google.com/search?q=best+plumber">best plumber</a></div>'
TEXT = "1. **Alpha Plumbing**\n2. **Beta Pipes**"


def good(text=TEXT, rendered=SUGG, grounding=True):
    cand = {"content": {"role": "model", "parts": [{"text": text}]}}
    if grounding:
        cand["groundingMetadata"] = {"webSearchQueries": ["q"], "searchEntryPoint": {"renderedContent": rendered}}
    return json.dumps({"candidates": [cand]})


class Resp:
    status = 200
    def __init__(self, text): self.b = text.encode()
    def read(self): return self.b
    def __enter__(self): return self
    def __exit__(self, *a): return False


def http_err(code, body="", retry_after=None):
    h = Message()
    if retry_after is not None:
        h["Retry-After"] = str(retry_after)
    return urllib.error.HTTPError("https://x/?key=leak", code, "m", h, io.BytesIO(body.encode()))


DAY_429 = json.dumps({"error": {"code": 429, "status": "RESOURCE_EXHAUSTED", "details": [
    {"@type": "type.googleapis.com/google.rpc.QuotaFailure",
     "violations": [{"quotaId": "GenerateRequestsPerDayPerProjectPerModel-FreeTier"}]}]}})
MIN_429 = json.dumps({"error": {"code": 429, "status": "RESOURCE_EXHAUSTED", "details": [
    {"violations": [{"quotaId": "GenerateRequestsPerMinutePerProjectPerModel-FreeTier"}]}]}})


class Fake:
    def __init__(self, script):
        self.script, self.requests, self.t, self.sleeps = list(script), [], 1000.0, []

    def opener(self, req, timeout=0):
        self.requests.append(req)
        x = self.script.pop(0) if self.script else good()
        if isinstance(x, BaseException):
            raise x
        return Resp(x)

    def sleep(self, s): self.sleeps.append(s); self.t += s
    def clock(self): return self.t

    def provider(self, cap=None, **kw):
        return GeminiFreeProvider(opener=self.opener, sleep=self.sleep, clock=self.clock, min_interval_s=0,
                                  cap=cap or DailyCap(), **kw)


def hdrs(req):
    return {k.lower(): v for k, v in req.header_items()}


class Env(unittest.TestCase):
    def setUp(self):
        patcher = mock.patch.dict(os.environ, {}, clear=False)
        patcher.start(); self.addCleanup(patcher.stop)
        for k in ("GEMINI_FREE_API_KEY", "GEMINI_API_KEY", "AVC_GEMINI_MODEL", "AVC_GEMINI_DAILY_CALL_CAP",
                  "AIVIS_ALLOW_PAID", "AIVIS_MODEL_GEMINI"):
            os.environ.pop(k, None)
        os.environ["GEMINI_FREE_API_KEY"] = FREE_KEY

    def ask(self, f, **kw):
        err, out = io.StringIO(), io.StringIO()
        with contextlib.redirect_stderr(err), contextlib.redirect_stdout(out):
            p = f.provider(**kw)
            try:
                a = p.ask("Who is the best plumber in Austin, TX?")
                return "ok", a, err.getvalue() + out.getvalue()
            except ProviderError as e:
                return e.reason, e, err.getvalue() + out.getvalue()


class Request(Env):
    def test_success_shape_key_header_and_answer(self):
        f = Fake([good()])
        r, a, _ = self.ask(f)
        self.assertEqual(r, "ok")
        self.assertEqual((a.provider, a.mode, a.model, a.cost_usd), ("gemini-free", "web-search", "gemini-2.5-flash-lite", 0.0))
        self.assertEqual(a.text, TEXT)
        self.assertEqual(a.suggestions_html, SUGG)
        req = f.requests[0]
        self.assertEqual(req.full_url, "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-lite:generateContent")
        self.assertEqual(hdrs(req)["x-goog-api-key"], FREE_KEY)
        self.assertNotIn(FREE_KEY, req.full_url)
        body = json.loads(req.data)
        self.assertEqual(body["tools"], [{"google_search": {}}])
        self.assertIn(G.SUFFIX.strip(), body["contents"][0]["parts"][0]["text"])
        from aivis.parse import find_mentions
        self.assertEqual([m.raw for m in find_mentions(a.text, [], city="Austin, TX")], ["Alpha Plumbing", "Beta Pipes"])

    def test_provider_is_free_and_registered(self):
        self.assertEqual((GeminiFreeProvider.name, GeminiFreeProvider.paid, GeminiFreeProvider.mode),
                         ("gemini-free", False, "web-search"))
        self.assertIs(REGISTRY["gemini-free"], GeminiFreeProvider)
        os.environ["AIVIS_ALLOW_PAID"] = "1"
        p, guard = build_providers(Order("FREE-12345678", "Zed Co", "Denver, CO", "plumber", plan="free"), "free", 0.0)
        self.assertEqual([type(x) for x in p], [GeminiFreeProvider]); self.assertIsNone(guard)

    def test_every_call_goes_to_generate_content_of_the_configured_model(self):
        os.environ["AVC_GEMINI_MODEL"] = "gemini-2.5-flash"
        f = Fake([http_err(500), http_err(429), good()])
        self.ask(f)
        self.assertEqual(len(f.requests), 3)
        for r in f.requests:
            self.assertEqual(r.full_url, "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent")


class Reasons(Env):
    def test_quota_exhausted_is_permanent_and_blocks_next_check(self):
        cap = DailyCap(clock=lambda: 1_700_000_000)
        f = Fake([http_err(429, DAY_429), good()])
        r, e, _ = self.ask(f, cap=cap)
        self.assertEqual((r, len(f.requests), e.permanent), ("gemini_quota_exhausted", 1, True))
        self.assertFalse(cap.reserve(8, cap=450))

    def test_plain_429_uses_rate_limited_retry_path(self):
        for body in ("", MIN_429, "not json"):
            f = Fake([http_err(429, body)] * 5)
            r, _, _ = self.ask(f)
            self.assertEqual((r, len(f.requests), f.sleeps), ("rate_limited", 3, [2.0, 4.0]), body)

    def test_model_unavailable_and_other_http(self):
        for err, want, n in ((http_err(404, "models/gemini-2.5-flash-lite is not found"), "model_unavailable", 1),
                             (http_err(403, "no access to model gemini-2.5-flash-lite"), "model_unavailable", 1),
                             (http_err(403, "API key not valid"), "http_403", 1),
                             (http_err(400, "bad"), "http_400", 1),
                             (http_err(503), "http_503", 3)):
            f = Fake([err] * 3)
            r, e, _ = self.ask(f)
            self.assertEqual((r, len(f.requests)), (want, n), want)

    def test_timeout_connection_malformed_empty(self):
        import socket
        self.assertEqual(self.ask(Fake([socket.timeout()] * 3))[0], "timeout")
        self.assertEqual(self.ask(Fake([urllib.error.URLError("x")] * 3))[0], "connection_error")
        self.assertEqual(self.ask(Fake(["{not json"] * 3))[0], "parse_error")
        self.assertEqual(self.ask(Fake([json.dumps({"candidates": []})] * 3))[0], "empty_answer")
        self.assertEqual(self.ask(Fake([good(text="  ")] * 3))[0], "empty_answer")

    def test_grounding_missing_cases(self):
        for body in (good(grounding=False), good(rendered=""), good(rendered="   "),
                     json.dumps({"candidates": [{"content": {"parts": [{"text": "x"}]}, "groundingMetadata": {"webSearchQueries": ["q"]}}]})):
            f = Fake([body] * 3)
            r, e, _ = self.ask(f)
            self.assertEqual(r, "grounding_missing")
            self.assertNotIn(TEXT, str(e))

    def test_grounding_missing_is_not_counted_as_an_answer(self):
        f = Fake([good(grounding=False)] * 24)
        p = f.provider()
        res = run_audit(get_niche("plumber"), "Austin, TX", "Zed Co", [], [p], n_prompts=8, repeats=1, fail_fast_after=3)
        self.assertEqual(res.score.total_answers, 0)
        self.assertEqual(res.reason_counts(), {"grounding_missing": 8})


class KeyIsolation(Env):
    def test_missing_or_empty_key_makes_no_call_even_with_paid_key_set(self):
        os.environ["GEMINI_API_KEY"] = PAID_KEY
        for val in (None, "", "   "):
            if val is None:
                os.environ.pop("GEMINI_FREE_API_KEY")
            else:
                os.environ["GEMINI_FREE_API_KEY"] = val
            f = Fake([good()])
            r, e, text = self.ask(f)
            self.assertEqual((r, f.requests, e.permanent), ("provider_not_configured", [], True))
            self.assertNotIn(PAID_KEY, text + str(e))

    def test_three_unconfigured_trigger_fail_fast(self):
        os.environ.pop("GEMINI_FREE_API_KEY"); os.environ["GEMINI_API_KEY"] = PAID_KEY
        f = Fake([])
        res = run_audit(get_niche("plumber"), "Austin, TX", "Zed Co", [], [f.provider()], n_prompts=8, repeats=1, fail_fast_after=3)
        self.assertEqual(res.reason_counts(), {"provider_not_configured": 3, "skipped_after_permanent_errors": 5})
        self.assertEqual(f.requests, [])

    def test_paid_key_never_appears_anywhere(self):
        os.environ["GEMINI_API_KEY"] = PAID_KEY
        f = Fake([http_err(500), good()])
        _, a, text = self.ask(f)
        for r in f.requests:
            self.assertNotIn(PAID_KEY, r.full_url + json.dumps(hdrs(r)) + r.data.decode())
        self.assertNotIn(PAID_KEY, text)

    def test_source_never_reads_the_paid_key(self):
        src = open(G.__file__, encoding="utf-8").read()
        self.assertIsNone(re.search(r"environ[^\n]*GEMINI_API_KEY|getenv[^\n]*GEMINI_API_KEY", src))
        self.assertNotIn("AIVIS_MODEL_GEMINI", src)
        self.assertNotIn("gemini-4-hydrogen", src)

    def test_free_key_never_leaks_on_errors(self):
        import socket
        for err in (http_err(429), http_err(500, "k=" + FREE_KEY), http_err(403, FREE_KEY), socket.timeout(),
                    "{malformed " + FREE_KEY, urllib.error.URLError(FREE_KEY)):
            f = Fake([err] * 3)
            r, e, text = self.ask(f)
            self.assertNotIn(FREE_KEY, text + str(e) + repr(e) + r + json.dumps(vars(e) if hasattr(e, "reason") else {}, default=str))
            for rq in f.requests:
                self.assertNotIn(FREE_KEY, rq.full_url)
        res = run_audit(get_niche("plumber"), "Austin, TX", "Zed Co", [], [Fake([http_err(500, FREE_KEY)] * 30).provider()],
                        n_prompts=8, repeats=1, fail_fast_after=3)
        self.assertNotIn(FREE_KEY, json.dumps(res.outcomes) + "".join(res.errors))

    def test_paid_mode_stays_locked_and_unchanged(self):
        o = Order("PAID-12345678", "Zed Co", "Denver, CO", "plumber", paid=True)
        os.environ["GEMINI_API_KEY"] = PAID_KEY
        with self.assertRaises(OrderError) as c:
            build_providers(o, "paid", 12.0)
        self.assertIn("locked", str(c.exception))
        os.environ["GEMINI_FREE_API_KEY"] = FREE_KEY
        os.environ.pop("GEMINI_API_KEY")
        with self.assertRaises(OrderError) as c:
            build_providers(o, "paid", 12.0)
        self.assertIn("locked", str(c.exception))
        os.environ["AIVIS_ALLOW_PAID"] = "1"          # unlocked, but the free key does not satisfy the engines' keys
        with self.assertRaises(OrderError) as c:
            build_providers(o, "paid", 12.0)
        self.assertIn("missing API keys", str(c.exception))
        self.assertEqual(config.PAID_ENGINES, ("openai", "gemini", "claude"))
        self.assertEqual(config.DEFAULT_MODELS, {"openai": "gpt-6.2-sol", "gemini": "gemini-4-hydrogen", "claude": "claude-sonnet-5-5"})

    def test_paid_key_alone_does_not_satisfy_the_free_check(self):
        os.environ.pop("GEMINI_FREE_API_KEY"); os.environ["GEMINI_API_KEY"] = PAID_KEY
        f = Fake([good()])
        self.assertEqual(self.ask(f)[0], "provider_not_configured")
        self.assertEqual(f.requests, [])


class AllowList(Env):
    def test_disallowed_models_make_no_call_and_warn(self):
        for m in ("gemini-3.5-flash-lite", "gemini-4-hydrogen", "gemini-3.6-flash", "whatever"):
            os.environ["AVC_GEMINI_MODEL"] = m
            f = Fake([good()])
            r, e, text = self.ask(f)
            self.assertEqual((r, f.requests, e.permanent), ("model_no_free_search", [], True), m)
            self.assertIn("allow-list", text)
            self.assertNotIn(FREE_KEY, text)

    def test_flash_runs_with_december_warning(self):
        os.environ["AVC_GEMINI_MODEL"] = "gemini-2.5-flash"
        f = Fake([good()])
        r, _, text = self.ask(f)
        self.assertEqual((r, len(f.requests)), ("ok", 1))
        self.assertIn("2026-12-01", text)

    def test_default_model_has_no_warning(self):
        r, _, text = self.ask(Fake([good()]))
        self.assertEqual((r, text), ("ok", ""))

    def test_allow_list_constant(self):
        self.assertEqual(G.FREE_SEARCH_MODELS, ("gemini-2.5-flash-lite", "gemini-2.5-flash"))


class NoFallback(Env):
    def test_no_other_provider_after_failure(self):
        class Boom:
            def __init__(self, *a, **k): raise AssertionError("must not be constructed")
        with mock.patch.object(order, "PollinationsProvider", Boom), mock.patch.dict(REGISTRY, {"openai": Boom, "gemini": Boom}):
            os.environ["GEMINI_API_KEY"] = PAID_KEY
            provs, _ = build_providers(Order("FREE-12345678", "Zed Co", "Denver, CO", "plumber", plan="free"), "free", 0.0)
            self.assertEqual(len(provs), 1)
            f = Fake([http_err(429, DAY_429)])
            for kind in (http_err(500), http_err(403), http_err(429, DAY_429)):
                f = Fake([kind] * 3)
                self.assertNotEqual(self.ask(f)[0], "ok")
                self.assertTrue(all("generateContent" in r.full_url for r in f.requests))


class Cap(Env):
    def test_cap_env_parsing(self):
        for val in (None, "", "abc", "0", "-5", " ", "1.5"):
            if val is None:
                os.environ.pop("AVC_GEMINI_DAILY_CALL_CAP", None)
            else:
                os.environ["AVC_GEMINI_DAILY_CALL_CAP"] = val
            self.assertEqual(G.daily_cap_from_env(), 450, val)
        os.environ["AVC_GEMINI_DAILY_CALL_CAP"] = "16"
        self.assertEqual(G.daily_cap_from_env(), 16)

    def test_two_checks_then_refused_then_pacific_midnight_resets(self):
        os.environ["AVC_GEMINI_DAILY_CALL_CAP"] = "16"
        t = [1_800_000_000.0]               # 2027-01-15 08:00 UTC = 00:00 Pacific that day
        cap = DailyCap(clock=lambda: t[0])
        self.assertTrue(cap.reserve(8)); self.assertTrue(cap.reserve(8))
        self.assertFalse(cap.reserve(8))
        t[0] += 23 * 3600 + 3599            # one second before the next Pacific midnight
        self.assertFalse(cap.reserve(8))
        t[0] += 1
        self.assertTrue(cap.reserve(8))

    def test_utc_midnight_does_not_reset(self):
        cap = DailyCap(clock=lambda: 1_800_000_000.0 + 16 * 3600 - 60)    # 23:59 UTC, 15:59 Pacific
        self.assertTrue(cap.reserve(8, cap=8)); self.assertFalse(cap.reserve(8, cap=8))

    def test_retries_count_toward_the_cap(self):
        cap = DailyCap(clock=lambda: 1_800_000_000.0)
        self.assertTrue(cap.reserve(8, cap=16))
        cap.settle(8, 12)                   # 12 attempts really made
        self.assertFalse(cap.reserve(8, cap=16))
        cap2 = DailyCap(clock=lambda: 1_800_000_000.0)
        cap2.reserve(8, cap=16); cap2.settle(8, 0)      # nothing called: the reservation is given back
        self.assertTrue(cap2.reserve(8, cap=16)); self.assertTrue(cap2.reserve(8, cap=16))

    def test_provider_counts_every_attempt(self):
        f = Fake([http_err(500), http_err(429), good()])
        p = f.provider()
        with contextlib.redirect_stderr(io.StringIO()):
            p.ask("q")
        self.assertEqual(p.attempts, 3)


if __name__ == "__main__":
    unittest.main()
