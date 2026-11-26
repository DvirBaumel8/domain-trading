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

    def test_roster_counts_as_register(self):
        self.assertTrue(_audit(NO_REG_NICHE, ["Alpha Group"]).has_register)


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



class IntakeGateTests(unittest.TestCase):
    def base(self, **kw):
        return {"order_id": "ORD-1", "business_name": "Acme", "city": CITY, "niche": REG_NICHE, **kw}

    def test_us_state_whitelist_incl_dc(self):
        from aivis.order import US_STATES
        self.assertEqual(len(US_STATES), 51); self.assertIn("DC", US_STATES)
        for code in sorted(US_STATES):
            Order.from_dict(self.base(city=f"Somewhere, {code}"))

    def test_rejects_non_us_city(self):
        from aivis.order import OrderError
        for city in ("Tel Aviv, ZZ", "Toronto, ON", "Paris, FR", "Austin", "Austin, tx", "Austin, TXX"):
            with self.assertRaises(OrderError, msg=city):
                Order.from_dict(self.base(city=city))

    def test_from_dict_keeps_paid_fields(self):
        o = Order.from_dict(self.base(paid=True, paid_at="2026-11-26T10:00:00", paid_ref="pol_1"))
        self.assertEqual((o.paid, o.paid_at, o.paid_ref), (True, "2026-11-26T10:00:00", "pol_1"))
        self.assertFalse(Order.from_dict(self.base()).paid)

    def test_unpaid_order_refused_in_paid_mode(self):
        from aivis.order import OrderError
        o = Order.from_dict(self.base())
        with mock.patch.object(order_mod, "build_providers", side_effect=AssertionError("must not be reached")):
            with self.assertRaises(OrderError) as cm:
                run_order(o, mode="paid", out_dir=tempfile.mkdtemp())
        self.assertIn("not marked paid", str(cm.exception))

    def test_override_is_logged(self):
        import io
        from contextlib import redirect_stderr
        o = Order.from_dict(self.base())
        err = io.StringIO()
        with mock.patch.object(order_mod, "build_providers", side_effect=RuntimeError("stop")), redirect_stderr(err):
            with self.assertRaises(RuntimeError):
                run_order(o, mode="paid", out_dir=tempfile.mkdtemp(), allow_unpaid=True)
        self.assertIn("--allow-unpaid", err.getvalue()); self.assertIn("ORD-1", err.getvalue())

    def test_paid_order_passes_gate(self):
        o = Order.from_dict(self.base(paid=True))
        with mock.patch.object(order_mod, "build_providers", side_effect=RuntimeError("stop")):
            with self.assertRaises(RuntimeError):
                run_order(o, mode="paid", out_dir=tempfile.mkdtemp())

    def test_normalize_website(self):
        from aivis.order import normalize_website
        self.assertEqual(normalize_website("drainmasterohio.com"), "https://drainmasterohio.com")
        self.assertEqual(normalize_website("http://a.com"), "http://a.com")
        self.assertEqual(normalize_website(""), "")
        for bad in ("a b", "ftp://a.com", "localhost", "https://"):
            with self.assertRaises(ValueError, msg=bad):
                normalize_website(bad)


if __name__ == "__main__":
    unittest.main()
