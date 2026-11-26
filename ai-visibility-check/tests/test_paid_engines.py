"""Paid engines against the fake vendor APIs (no network, no keys)."""
import json
import os
import pathlib
import sys
import tempfile
import unittest
from unittest import mock

ROOT = pathlib.Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "engine"))
sys.path.insert(0, str(ROOT.parent / "docs" / "requests" / "avc-mock-run"))
import fake_apis  # noqa: E402
from aivis import config, order as order_mod  # noqa: E402
from aivis.order import DEFAULT_CAP_USD, PAID_ENGINES, Order, OrderError, run_order  # noqa: E402
from aivis.providers import REGISTRY, BudgetGuard, ProviderError  # noqa: E402
from aivis.report_pro import render  # noqa: E402
from aivis.smoke import run_smoke  # noqa: E402

KEYS = {"OPENAI_API_KEY": "k", "GEMINI_API_KEY": "k", "ANTHROPIC_API_KEY": "k"}
POOL = ["Columbus Plumbing Pros", "Buckeye Drain & Rooter", "Olentangy Plumbing Co", "Capital City Plumbing"]


def setUpModule():
    fake_apis.POOLS["cur"] = POOL
    fake_apis.TARGET["name"] = "Target Plumbing"


def make(engine, guard=None, **kw):
    return REGISTRY[engine](budget=guard or BudgetGuard(50), allow_paid=True, opener=fake_apis.fake_urlopen, **kw)


def last_body(vendor):
    return [b for v, b in fake_apis.BODIES if v == vendor][-1]


@mock.patch.dict(os.environ, KEYS)
class Providers(unittest.TestCase):
    def test_default_engine_set(self):
        self.assertEqual(tuple(PAID_ENGINES), ("openai", "gemini", "claude"))
        self.assertNotIn("perplexity", REGISTRY)
        self.assertEqual(set(config.PAID_COST_PER_CALL), {"openai", "gemini", "claude"})
        self.assertEqual(set(config.ENV_KEYS), {"openai", "gemini", "claude"})
        self.assertEqual(Order("abc", "X", "Columbus, OH", "plumber").engines, ["openai", "gemini", "claude"])

    def test_openai_fields_and_usage(self):
        a = make("openai").ask("best plumber", city="Columbus, OH")
        b = last_body("openai")
        self.assertEqual(b["model"], "gpt-6.2-sol")
        tool = b["tools"][0]
        self.assertEqual(tool["type"], "web_search")
        self.assertEqual(tool["user_location"]["country"], "US")
        self.assertEqual(tool["user_location"]["city"], "Columbus, OH")
        self.assertEqual(a.usage["input_tokens"], 2000)
        self.assertEqual(a.usage["searches"], 1)
        self.assertAlmostEqual(a.usage["cost_usd"], 2000 * 2 / 1e6 + 500 * 10 / 1e6 + 0.01, places=6)

    def test_gemini_fields_and_usage(self):
        a = make("gemini").ask("best plumber")
        b = last_body("gemini")
        self.assertEqual(b["tools"], [{"google_search": {}}])
        self.assertEqual(b["generationConfig"]["thinkingConfig"]["thinkingLevel"], "medium")
        self.assertEqual(a.model, "gemini-4-hydrogen")
        self.assertEqual(a.usage["output_tokens"], 1500)          # visible + thinking tokens
        self.assertGreater(a.usage["cost_usd"], 0)

    def test_gemini_without_grounding_fails_clearly(self):
        def no_grounding(req, timeout=None):
            r = fake_apis.fake_urlopen(req, timeout)
            d = json.loads(r.read().decode())
            del d["candidates"][0]["groundingMetadata"]
            return fake_apis._Resp(json.dumps(d).encode())
        p = REGISTRY["gemini"](budget=BudgetGuard(5), allow_paid=True, opener=no_grounding)
        with self.assertRaises(ProviderError) as cm:
            p.ask("best plumber")
        self.assertIn("grounding did not run", str(cm.exception))
        self.assertIn("free tier", str(cm.exception))

    def test_claude_fields_and_usage(self):
        a = make("claude").ask("best plumber")
        b = last_body("claude")
        self.assertEqual(b["model"], "claude-sonnet-5-5")
        self.assertEqual(b["tools"][0]["name"], "web_search")
        self.assertEqual(b["tools"][0]["max_uses"], 2)
        self.assertEqual(a.usage["searches"], 1)
        self.assertEqual(a.usage["output_tokens"], 600)

    def test_config_overrides(self):
        env = {"AIVIS_MODEL_OPENAI": "gpt-x", "AIVIS_MODEL_CLAUDE": "claude-y", "AIVIS_GEMINI_THINKING": "low",
               "AIVIS_COST_GEMINI": "0.5"}
        with mock.patch.dict(os.environ, env):
            self.assertEqual(make("openai").model, "gpt-x")
            make("openai").ask("q")
            self.assertEqual(last_body("openai")["model"], "gpt-x")
            self.assertEqual(make("claude").model, "claude-y")
            make("gemini").ask("q")
            self.assertEqual(last_body("gemini")["generationConfig"]["thinkingConfig"]["thinkingLevel"], "low")
            self.assertEqual(make("gemini").est_cost_per_call, 0.5)
        with mock.patch.dict(os.environ, {"AIVIS_GEMINI_THINKING": "turbo"}):
            with self.assertRaises(ValueError):
                config.gemini_thinking()

    def test_cap_default_and_env(self):
        self.assertEqual(DEFAULT_CAP_USD, 12.00)
        with mock.patch.dict(os.environ, {"AIVIS_ORDER_CAP_USD": "20"}):
            self.assertEqual(config.order_cap_usd(), 20.0)
        env = {k: v for k, v in os.environ.items() if k != "AIVIS_ORDER_CAP_USD"}
        with mock.patch.dict(os.environ, env, clear=True):
            self.assertEqual(config.order_cap_usd(), 12.0)

    def test_smoke_uses_fakes(self):
        with mock.patch.dict(os.environ, {"AIVIS_ALLOW_PAID": "1"}):
            rows = run_smoke(opener=fake_apis.fake_urlopen)
        self.assertEqual([r["engine"] for r in rows], ["openai", "gemini", "claude"])
        self.assertTrue(all(r["ok"] and r["usage"] for r in rows))
        self.assertEqual(rows[0]["model"], "gpt-6.2-sol")


@mock.patch.dict(os.environ, KEYS)
class OrderRun(unittest.TestCase):
    def run_it(self):
        o = Order("t-100", "Target Plumbing", "Columbus, OH", "plumber", plan="lean")
        providers = [make(e) for e in o.engines]
        d = tempfile.mkdtemp()
        res, log = run_order(o, mode="paid", roster=POOL, out_dir=d, render=render, providers=providers)
        return res, log, d

    def test_usage_logged_per_call_and_totalled(self):
        res, log, d = self.run_it()
        u = log["usage"]
        self.assertEqual(len(u["calls"]), 20 * 3)
        self.assertEqual(u["total"]["calls"], 60)
        self.assertEqual(set(u["by_engine"]), {"openai", "gemini", "claude"})
        self.assertAlmostEqual(u["total"]["cost_usd"], sum(c["cost_usd"] for c in u["calls"]), places=4)
        self.assertEqual(u["by_engine"]["claude"]["searches"], 20)
        saved = json.load(open(os.path.join(d, "t-100", "order-log.json")))
        self.assertEqual(saved["usage"]["total"]["calls"], 60)
        self.assertNotIn("k", json.dumps(saved["usage"]["calls"][0].get("headers", "")))

    def test_report_three_engines_footer(self):
        res, log, d = self.run_it()
        html = open(os.path.join(d, "t-100", "report.html"), encoding="utf-8").read()
        self.assertEqual({p.provider for p in res.score.providers}, {"openai", "gemini", "claude"})
        for m in ("gpt-6.2-sol", "gemini-4-hydrogen", "claude-sonnet-5-5"):
            self.assertIn(m, html)
        self.assertIn("run date " + __import__("datetime").date.today().isoformat(), html)
        self.assertNotIn("Perplexity", html)
        self.assertNotIn("four", html.lower())


class SiteText(unittest.TestCase):
    def test_no_four_assistants_or_perplexity(self):
        files = list((ROOT / "site").glob("*.html")) + [ROOT / "addons" / "PRICE-SHEET.md"]
        hits = []
        for p in files:
            t = p.read_text(encoding="utf-8").lower()
            hits += [f"{p.name}: {w}" for w in ("perplexity", "four assistants", "4 assistants", "4 engines") if w in t]
        self.assertEqual(hits, [])


if __name__ == "__main__":
    unittest.main()


class UsCityTests(unittest.TestCase):
    def test_engine_order_rejects_non_us_place(self):
        from aivis.order import city_is_us
        for c in ("Tel Aviv, IL", "London, UK", "Austin", "Austin, OH"):
            self.assertFalse(city_is_us(c), c)
        for c in ("Columbus, OH", "Austin, TX", "St. Louis, MO", "Saint Louis, MO", "Washington, DC", "Ft. Worth, TX"):
            self.assertTrue(city_is_us(c), c)
        with self.assertRaises(OrderError):
            Order(order_id="X", business_name="B", city="Tel Aviv, IL", niche="plumber", plan="check").validate()
