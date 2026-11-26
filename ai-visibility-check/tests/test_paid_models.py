"""Paid engines against the local fake APIs (docs/requests/avc-mock-run/fake_apis.py). No network, no keys."""
import contextlib
import io
import json
import os
import pathlib
import sys
import tempfile
import unittest

ROOT = pathlib.Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "engine"))
sys.path.insert(0, str(ROOT.parent / "docs" / "requests" / "avc-mock-run"))
import fake_apis  # noqa: E402
from aivis import config  # noqa: E402
from aivis import order as order_mod  # noqa: E402
from aivis.providers import (BudgetGuard, ClaudeWebSearchProvider, GeminiGroundedProvider,  # noqa: E402
                             OpenAIWebSearchProvider, PerplexityProvider, ProviderError)
from aivis.report_pro import render  # noqa: E402
from aivis.smoke import run_smoke  # noqa: E402

KEYS = {"OPENAI_API_KEY": "k", "PERPLEXITY_API_KEY": "k", "GEMINI_API_KEY": "k", "ANTHROPIC_API_KEY": "k"}
CFG_ENV = ("AIVIS_MODEL_OPENAI", "AIVIS_MODEL_PERPLEXITY", "AIVIS_MODEL_GEMINI", "AIVIS_MODEL_CLAUDE",
           "AIVIS_COST_OPENAI", "AIVIS_GEMINI_THINKING", "AIVIS_ORDER_CAP_USD", "CI", "AIVIS_ALLOW_PAID")
CLASSES = {"openai": OpenAIWebSearchProvider, "perplexity": PerplexityProvider,
           "gemini": GeminiGroundedProvider, "claude": ClaudeWebSearchProvider}
HOSTS = {"openai": "api.openai.com", "perplexity": "api.perplexity.ai",
         "gemini": "generativelanguage.googleapis.com", "claude": "api.anthropic.com"}


class PaidModels(unittest.TestCase):
    def setUp(self):
        self._env = {k: os.environ.get(k) for k in list(KEYS) + list(CFG_ENV)}
        for k in CFG_ENV:
            os.environ.pop(k, None)
        os.environ.update(KEYS)
        fake_apis.POOLS["cur"] = ["Alpha Dental", "Beta Dental", "Gamma Dental", "Delta Dental"]
        fake_apis.TARGET["name"] = "Acme Dental"
        fake_apis.NO_GROUNDING["on"] = False
        fake_apis.REQUESTS.clear()

    def tearDown(self):
        for k, v in self._env.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v

    def prov(self, name, **kw):
        return CLASSES[name](budget=BudgetGuard(12), allow_paid=True, opener=fake_apis.fake_urlopen, **kw)

    def body(self, name):
        return [b for h, _, b in fake_apis.REQUESTS if h == HOSTS[name]][-1]

    def test_openai(self):
        a = self.prov("openai").ask("best dentist?", city="Austin")
        b = self.body("openai")
        self.assertEqual(b["model"], "gpt-6.2-sol")
        self.assertEqual(b["tools"][0]["type"], "web_search")
        self.assertEqual(b["tools"][0]["user_location"], {"type": "approximate", "country": "US", "city": "Austin"})
        self.assertEqual(a.model, "gpt-6.2-sol")
        self.assertTrue(a.text and a.citations)

    def test_perplexity_agent_api(self):
        a = self.prov("perplexity").ask("best dentist?")
        h, url, b = [r for r in fake_apis.REQUESTS if r[0] == HOSTS["perplexity"]][-1]
        self.assertTrue(url.endswith("/v1/agent"))
        self.assertEqual(b["model"], "perplexity/sonar")
        self.assertEqual(b["tools"], [{"type": "web_search"}])
        self.assertNotIn("messages", b)
        self.assertIn("Please confirm availability", a.text)
        self.assertEqual(len(a.citations), 2)
        self.assertEqual(a.usage["searches"], 1)

    def test_gemini(self):
        a = self.prov("gemini").ask("best dentist?")
        b = self.body("gemini")
        self.assertEqual(b["tools"], [{"google_search": {}}])
        self.assertEqual(b["generationConfig"]["thinkingConfig"]["thinkingLevel"], "medium")
        self.assertIn("gemini-4-hydrogen", [r[1] for r in fake_apis.REQUESTS][-1])
        self.assertEqual(a.usage["output_tokens"], 1300)      # answer + thinking tokens
        self.assertEqual(a.usage["searches"], 1)

    def test_gemini_no_grounding_fails_clearly(self):
        fake_apis.NO_GROUNDING["on"] = True
        with self.assertRaises(ProviderError) as cm:
            self.prov("gemini").ask("best dentist?")
        self.assertIn("grounding did not run", str(cm.exception))
        self.assertIn("paid-tier", str(cm.exception))

    def test_claude(self):
        a = self.prov("claude").ask("best dentist?", city="Austin, TX")
        b = self.body("claude")
        self.assertEqual(b["model"], "claude-sonnet-5-5")
        t = b["tools"][0]
        self.assertEqual((t["type"], t["name"], t["max_uses"]), ("web_search_20250305", "web_search", 2))
        self.assertEqual(t["user_location"]["region"], "TX")
        self.assertEqual(a.usage["searches"], 1)

    def test_config_overrides(self):
        os.environ["AIVIS_MODEL_CLAUDE"] = "claude-opus-5-5"
        os.environ["AIVIS_GEMINI_THINKING"] = "high"
        os.environ["AIVIS_COST_OPENAI"] = "0.05"
        self.prov("claude").ask("q")
        self.prov("gemini").ask("q")
        self.assertEqual(self.body("claude")["model"], "claude-opus-5-5")
        self.assertEqual(self.body("gemini")["generationConfig"]["thinkingConfig"]["thinkingLevel"], "high")
        self.assertEqual(self.prov("openai").est_cost_per_call, 0.05)
        self.assertEqual(self.prov("openai", model="x").model, "x")
        os.environ["AIVIS_GEMINI_THINKING"] = "bogus"
        self.assertEqual(config.gemini_thinking(), "medium")

    def test_cost_estimates_and_cap_default(self):
        self.assertEqual(config.DEFAULT_COST_PER_CALL, {"openai": 0.025, "perplexity": 0.004, "gemini": 0.018, "claude": 0.025})
        self.assertEqual(config.default_cap_usd(), 12.00)
        self.assertEqual(order_mod.DEFAULT_CAP_USD, 12.00)
        os.environ["AIVIS_ORDER_CAP_USD"] = "20"
        self.assertEqual(config.default_cap_usd(), 20.0)

    def test_usage_cost_from_config_rates(self):
        a = self.prov("claude").ask("q")          # 5100 in, 510 out, 1 search at $2/$10 per M + $0.01
        self.assertAlmostEqual(a.usage["cost_usd"], 5100 * 2e-6 + 510 * 10e-6 + 0.01, places=6)
        self.assertEqual((a.usage["input_tokens"], a.usage["output_tokens"]), (5100, 510))

    def test_order_log_records_usage_and_totals(self):
        o = order_mod.Order("t-usage-1", "Acme Dental", "Austin, TX", "dentist", plan="lean")
        provs = [self.prov(n) for n in CLASSES]
        with tempfile.TemporaryDirectory() as d:
            res, log = order_mod.run_order(o, mode="paid", roster=["Alpha Dental"], out_dir=d, providers=provs,
                                           render=lambda r: render(r, date="2026-11-27"))
            saved = json.load(open(os.path.join(d, "t-usage-1", "order-log.json")))
            html = open(os.path.join(d, "t-usage-1", "report.html"), encoding="utf-8").read()
        u = saved["usage"]
        self.assertEqual(len(u["calls"]), 80)                       # 20 prompts x 4 engines
        self.assertEqual(u["totals"]["calls"], 80)
        self.assertEqual(set(u["by_engine"]), set(CLASSES))
        self.assertAlmostEqual(u["totals"]["cost_usd"], sum(c["cost_usd"] for c in u["calls"]), places=4)
        self.assertEqual(u["by_engine"]["gemini"]["model"], "gemini-4-hydrogen")
        self.assertEqual(set(u["calls"][0]), {"provider", "repeat", "model", "input_tokens", "output_tokens",
                                              "searches", "cost_usd"})        # no prompt, key or header
        for needle in ("gpt-6.2-sol", "perplexity/sonar", "gemini-4-hydrogen", "claude-sonnet-5-5", "2026-11-27"):
            self.assertIn(needle, html)

    def test_smoke_refuses_in_ci_and_without_allow(self):
        out = []
        self.assertEqual(run_smoke(out=out.append), 2)              # no AIVIS_ALLOW_PAID
        os.environ["AIVIS_ALLOW_PAID"] = "1"
        os.environ["CI"] = "true"
        self.assertEqual(run_smoke(out=out.append), 2)
        self.assertEqual(fake_apis.REQUESTS, [])

    def test_smoke_prints_model_and_usage(self):
        os.environ["AIVIS_ALLOW_PAID"] = "1"
        reg = {n: (lambda c: (lambda **kw: c(opener=fake_apis.fake_urlopen, **kw)))(c) for n, c in CLASSES.items()}
        out = []
        self.assertEqual(run_smoke(out=out.append, registry=reg), 0)
        self.assertEqual(len(out), 4)
        self.assertIn("model=gpt-6.2-sol ok", out[0])
        self.assertIn("searches=", out[0])
        fake_apis.NO_GROUNDING["on"] = True
        out.clear()
        self.assertEqual(run_smoke(["gemini"], out=out.append, registry=reg), 1)
        self.assertIn("ERROR", out[0])


if __name__ == "__main__":
    unittest.main()
