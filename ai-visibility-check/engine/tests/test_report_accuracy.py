"""Report-accuracy tests. No network: providers are mocks, fetch_and_analyze is patched."""
import os
import sys
import tempfile
import unittest
from unittest import mock

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from aivis import order as order_mod
from aivis import signals
from aivis.audit import run_audit
from aivis.niches import get_niche, niche_label
from aivis.order import Order, run_order
from aivis.parse import match_name
from aivis.providers import Business, MockProvider
from aivis.report import to_markdown
from aivis.report_pro import render
from aivis.roster import dedupe_names, title_case

NO_REG_NICHE = "hvac"       # no npi_taxonomy
REG_NICHE = "dentist"       # has npi_taxonomy
CITY = "Austin, TX"


def _audit(niche_key, roster, target="Zed Co"):
    niche = get_niche(niche_key)
    provs = [MockProvider([Business("Alpha Group", 3.0), Business("Beta Works", 2.0)], seed=1,
                          referees=niche.referees)]
    return run_audit(niche, CITY, target, roster, provs, n_prompts=6, repeats=1, seed=1)


class RegisterWording(unittest.TestCase):
    def test_no_register_trade_does_not_claim_a_register_check(self):
        res = _audit(NO_REG_NICHE, [])
        self.assertFalse(res.has_register)
        html = render(res)
        self.assertNotIn("did not match any practice in the official register", html)
        self.assertNotIn("matched an official register", html)
        self.assertIn("we could not check these names against a register for this trade", html)

    def test_register_trade_keeps_register_claim(self):
        res = _audit(REG_NICHE, [])
        self.assertTrue(res.has_register)
        self.assertIn("official register", render(res))

    def test_roster_does_not_count_as_register(self):
        self.assertFalse(_audit(NO_REG_NICHE, ["Alpha Group"]).has_register)


class SiteFindings(unittest.TestCase):
    def _run(self, website="", competitors=()):
        o = Order("T-1001", "Zed Co", CITY, NO_REG_NICHE, website=website, plan="lean",
                  competitors=list(competitors))
        with tempfile.TemporaryDirectory() as d:
            return run_order(o, mode="mock", out_dir=d, roster=["Alpha Group"])[0]

    def test_website_signals_reach_report(self):
        sig = signals.analyze("https://zed.example", "<html><title>Zed</title></html>", "User-agent: GPTBot\nDisallow: /\n", CITY)
        with mock.patch.object(signals, "fetch_and_analyze", return_value=sig) as m:
            res = self._run("https://zed.example")
        m.assert_called_once_with("https://zed.example", CITY)
        reasons = " ".join(f.reason for f in res.findings)
        self.assertIn("robots.txt blocks AI crawlers", reasons)
        self.assertIn("No LocalBusiness-type structured data", reasons)

    def test_no_website_no_fetch(self):
        with mock.patch.object(signals, "fetch_and_analyze") as m:
            self._run("")
        m.assert_not_called()

    def test_competitors_join_roster(self):
        with mock.patch.object(order_mod, "run_audit", wraps=order_mod.run_audit) as m:
            self._run("", ["Rival Heating", "alpha group"])
        self.assertEqual(m.call_args.args[3], ["Alpha Group", "Rival Heating"])

    def test_evidence_rendered(self):
        res = _audit(NO_REG_NICHE, [])
        html = render(res)
        for f in res.findings:
            self.assertIn(f.evidence.replace("'", "&#x27;"), html)
        self.assertIn(res.findings[0].evidence.split(";")[0][:20], to_markdown(res))


class AnonymizeNotice(unittest.TestCase):
    def test_hidden_notice_only_when_anonymized(self):
        res = _audit(REG_NICHE, [])
        self.assertNotIn("Business names are hidden", render(res, sample=True))
        self.assertIn("Business names are hidden", render(res, sample=True, anonymize=True))


class Names(unittest.TestCase):
    def test_dedupe_roster(self):
        out = dedupe_names(["Acme Dental", "Acme Dental Center PLLC", "Other Smiles"])
        self.assertEqual(out, ["Acme Dental", "Other Smiles"])

    def test_suffixes_uppercase(self):
        self.assertEqual(title_case("PLLC SMITH DENTAL PLLC"), "PLLC Smith Dental PLLC")
        self.assertEqual(title_case("jane roe dds pc"), "Jane Roe DDS PC")

    def test_niche_label_casing(self):
        self.assertEqual(niche_label(get_niche("hvac").label), "HVAC Company")
        self.assertEqual(niche_label("med spa"), "Med Spa")
        self.assertIn("HVAC Company", render(_audit("hvac", [])))
        self.assertIn("HVAC Company", to_markdown(_audit("hvac", [])))


class MatchName(unittest.TestCase):
    def test_single_token_false_match_rejected(self):
        self.assertIsNone(match_name("Baylor Dental Group", ["Baylor Medical & Dental"]))

    def test_exact_equality_still_matches(self):
        self.assertEqual(match_name("Baylor Dental PLLC", ["Baylor Dental"]), "Baylor Dental")

    def test_two_shared_tokens_match(self):
        self.assertEqual(match_name("Oak Hill Dental Group", ["Oak Hill Family Dental"]), "Oak Hill Family Dental")


if __name__ == "__main__":
    unittest.main()
