"""Paid-report correctness, driven by fake vendor APIs (no network, no keys). One test per BUGS.md item."""
import os
import sys
import tempfile
import unittest
import urllib.error
import urllib.request
from unittest import mock

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
sys.path.insert(0, os.path.dirname(__file__))

import fake_apis
from aivis import signals
from aivis.audit import run_audit
from aivis.niches import get_niche
from aivis.order import Order, OrderError, TIERS, run_order
from aivis.providers import BudgetGuard, ProviderError
from aivis.providers.base import Provider
from aivis.report_pro import render

HOSTS = {"openai": "api.openai.com", "perplexity": "api.perplexity.ai",
         "gemini": "generativelanguage.googleapis.com", "claude": "api.anthropic.com"}
KEYS = ("OPENAI_API_KEY", "PERPLEXITY_API_KEY", "GEMINI_API_KEY", "ANTHROPIC_API_KEY")
POOL = ["Columbus Plumbing Pros", "Buckeye Drain & Rooter", "Olentangy Plumbing Co", "Capital City Plumbing",
        "Grandview Pipe Works"]


class _Garbage:
    def __enter__(self): return self
    def __exit__(self, *a): return False
    def read(self): return b"<html>gateway</html>"


def _order(oid, **k):
    return Order(**{**dict(order_id=oid, business_name="DrainMaster", city="Columbus, OH", niche="plumber",
                           plan="check", paid_ref="x", paid=True), **k})


class FakeVendors(unittest.TestCase):
    def setUp(self):
        fake_apis.POOLS["cur"] = POOL
        fake_apis.TARGET["name"] = "DrainMaster"
        fake_apis.CALLS.clear()
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        env = {k: "FAKE" for k in KEYS}
        env["AIVIS_ALLOW_PAID"] = "1"
        p = mock.patch.dict(os.environ, env)
        p.start()
        self.addCleanup(p.stop)

    def run_paid(self, order, fail=None, cap=8.0, roster=None):
        fail = fail or {}

        def op(req, timeout=None, *a, **k):
            host = req.full_url.split("/")[2]
            for eng, code in fail.items():
                if host == HOSTS[eng]:
                    if code == "garbage":
                        return _Garbage()
                    raise urllib.error.HTTPError(req.full_url, code, "x", {}, None)
            return fake_apis.fake_urlopen(req, timeout, *a, **k)

        # providers capture urlopen at construction, so patch before run_order builds them
        with mock.patch.object(urllib.request, "urlopen", op), \
                mock.patch.object(signals, "fetch_and_analyze", wraps=lambda u, c, **kw: signals.SiteSignals(url=u)):
            return run_order(order, mode="paid", cap_usd=cap, roster=roster or [], out_dir=self.tmp.name, render=render)

    def folder(self, oid):
        return os.path.join(self.tmp.name, oid)

    # item 1 / case J
    def test_J_no_register_trade_lists_names_without_register_wording(self):
        res, _ = self.run_paid(_order("F-J"))
        html = open(os.path.join(self.folder("F-J"), "report.html"), encoding="utf-8").read()
        self.assertFalse(res.has_register)
        self.assertNotIn("official register", html)
        self.assertNotIn("matched an official", html)
        self.assertNotIn("checked against official", html)
        self.assertIn("named by AI", html)
        self.assertIn("Columbus Plumbing Pros", html)
        self.assertNotIn("0</b><span>business names named", html)

    def test_item1_buyer_competitor_does_not_make_register(self):
        res, _ = self.run_paid(_order("F-1", competitors=["Rival Rooter"]))
        self.assertFalse(res.has_register)
        html = open(os.path.join(self.folder("F-1"), "report.html"), encoding="utf-8").read()
        self.assertNotIn("official register", html)

    # item 4 / case C
    def test_C_all_vendors_down_raises_and_writes_nothing(self):
        down = {"openai": 500, "perplexity": 500, "gemini": 429, "claude": 529}
        with self.assertRaises(OrderError):
            self.run_paid(_order("F-C"), fail=down)
        self.assertFalse(os.path.exists(self.folder("F-C")))

    # item 5 / cases B, D
    def test_B_openai_401_stops_naming_engine(self):
        with self.assertRaises(OrderError) as cm:
            self.run_paid(_order("F-B"), fail={"openai": 401})
        self.assertIn("openai", str(cm.exception))
        self.assertFalse(os.path.exists(self.folder("F-B")))

    def test_D_gemini_garbage_json_stops_naming_engine(self):
        with self.assertRaises(OrderError) as cm:
            self.run_paid(_order("F-D"), fail={"gemini": "garbage"})
        self.assertIn("gemini", str(cm.exception))
        self.assertFalse(os.path.exists(self.folder("F-D")))

    def test_item5_engine_below_80_percent_stops(self):
        n = {"k": 0}
        real = fake_apis.fake_urlopen

        def flaky(req, timeout=None, *a, **k):
            if "api.openai.com" in req.full_url:
                n["k"] += 1
                if n["k"] % 3 == 0:        # a third of openai calls fail -> 67%
                    raise urllib.error.HTTPError(req.full_url, 500, "x", {}, None)
            return real(req, timeout, *a, **k)

        with mock.patch.object(urllib.request, "urlopen", flaky), \
                mock.patch.object(signals, "fetch_and_analyze"):
            with self.assertRaises(OrderError) as cm:
                run_order(_order("F-5"), mode="paid", out_dir=self.tmp.name, render=render)
        self.assertIn("openai", str(cm.exception))

    def test_healthy_run_still_produces_report(self):
        o = _order("F-OK")
        res, log = self.run_paid(o)
        n, r = TIERS[o.plan]
        self.assertEqual(log["answers"], n * r * len(o.engines))   # 60 per engine: 180 for the default 3
        self.assertTrue(os.path.exists(os.path.join(self.folder("F-OK"), "report.html")))

    # item 6
    def test_item6_failed_calls_are_refunded(self):
        with self.assertRaises(OrderError):
            self.run_paid(_order("F-6"), fail={"openai": 401, "perplexity": 500, "gemini": 500, "claude": 500})
        g = BudgetGuard(1.0)
        from aivis.providers import ClaudeWebSearchProvider

        def boom(req, timeout=None):
            raise urllib.error.HTTPError("u", 500, "x", {}, None)

        prov = ClaudeWebSearchProvider(budget=g, allow_paid=True, opener=boom)
        with self.assertRaises(ProviderError):
            prov.ask("q")
        self.assertEqual(g.spent, 0.0)

    # item 7
    def test_item7_error_cutoff_stops_provider_entirely(self):
        calls = {"n": 0}

        class Down(Provider):
            name = "down"

            def ask(self, prompt, city="", run=0):
                calls["n"] += 1
                raise ProviderError("down")

        res = run_audit(get_niche("plumber"), "Columbus, OH", "DrainMaster", [], [Down()],
                        n_prompts=10, repeats=3, max_errors=5)
        self.assertEqual(calls["n"], 5)
        self.assertEqual(len(res.errors), 5)

    # item 8 / case K
    def test_K_competitor_same_as_target_dropped_and_deduped(self):
        with mock.patch("aivis.order.run_audit", wraps=run_audit) as m:
            self.run_paid(_order("F-K", competitors=["drainmaster", "DRAINMASTER LLC", "Rival Rooter",
                                                     "rival rooter llc"]))
        names = m.call_args.args[3]
        self.assertEqual(names, ["Rival Rooter"])

    # item 9 / case A
    def test_A_website_without_scheme_gets_https_and_error_is_logged(self):
        seen = []

        def fetch(url, city, **kw):
            seen.append(url)
            return signals.SiteSignals(url=url, error="fetch failed: URLError")

        def op(req, timeout=None, *a, **k):
            return fake_apis.fake_urlopen(req, timeout, *a, **k)

        with mock.patch.object(urllib.request, "urlopen", op), \
                mock.patch.object(signals, "fetch_and_analyze", fetch):
            _, log = run_order(_order("F-A", website="drainmasterohio.com"), mode="paid",
                               out_dir=self.tmp.name, render=render)
        self.assertEqual(seen, ["https://drainmasterohio.com"])
        self.assertEqual(log["site_error"], "fetch failed: URLError")


class ReportWording(unittest.TestCase):
    def _res(self, niche="plumber", providers=None):
        from aivis.providers import Business, MockProvider
        n = get_niche(niche)
        provs = providers or [MockProvider([Business("Alpha Group", 3.0)], seed=1, referees=n.referees)]
        return run_audit(n, "Austin, TX", "Zed Co", [], provs, n_prompts=6, repeats=1, seed=1)

    # item 15
    def test_item15_empty_competitor_section_says_none_found(self):
        res = self._res()
        res.score.competitors = []
        res.has_register = True
        html = render(res)
        self.assertIn("none found", html)
        self.assertNotIn("<th>Business</th><th style='width:45%'>Share of answers</th><th></th></tr></table>", html)

    # item 16
    def test_item16_mentions_not_business_names(self):
        res = self._res("dentist")
        html = render(res)
        self.assertNotIn("business names in", html)
        self.assertNotIn("of named businesses", html)


if __name__ == "__main__":
    unittest.main()
