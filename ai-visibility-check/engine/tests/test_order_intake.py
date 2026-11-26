"""Intake-side order rules: US-only city, paid gate, website normalisation. No network."""
import contextlib, io, json, os, sys, tempfile, unittest
from unittest import mock

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from aivis import __main__ as cli
from aivis.order import Order, OrderError, US_STATES, normalize_website

BASE = {"order_id": "ORD-261126-abc123", "business_name": "Acme Dental", "city": "Austin, TX", "niche": "dentist"}


class CityTests(unittest.TestCase):
    def test_all_states_and_dc_accepted(self):
        self.assertEqual(len(US_STATES), 51)
        for code in US_STATES:
            Order.from_dict({**BASE, "city": f"Springfield, {code}"})

    def test_non_us_rejected(self):
        for city in ("London, UK", "Toronto, ON", "Austin, ZZ", "Austin, tx", "Austin"):
            with self.assertRaises(OrderError, msg=city):
                Order.from_dict({**BASE, "city": city})


class WebsiteTests(unittest.TestCase):
    def test_scheme_added(self):
        self.assertEqual(normalize_website(" drainmasterohio.com "), "https://drainmasterohio.com")
        self.assertEqual(Order.from_dict({**BASE, "website": "a.example/x"}).website, "https://a.example/x")

    def test_invalid(self):
        for w in ("not a url", "ftp://x.com", "localhost", "https://"):
            with self.assertRaises(ValueError, msg=w):
                normalize_website(w)
        with self.assertRaises(OrderError):
            Order.from_dict({**BASE, "website": "not a url"})


class PaidGateTests(unittest.TestCase):
    def run_cli(self, order, *extra):
        d = tempfile.mkdtemp()
        p = os.path.join(d, "o.json"); json.dump(order, open(p, "w"))
        err = io.StringIO()
        with contextlib.redirect_stderr(err), contextlib.redirect_stdout(io.StringIO()):
            with mock.patch.object(cli, "run_order", create=True):
                try:
                    cli.main(["order", "--intake", p, "--mode", "paid", "--roster", "/dev/null", "--out", d, *extra])
                    code = None
                except SystemExit as e:
                    code = str(e.code)
        return code, err.getvalue()

    def test_from_dict_keeps_paid_fields(self):
        o = Order.from_dict({**BASE, "paid": True, "paid_at": "2026-11-26T10:00:00", "paid_ref": "pol_1"})
        self.assertEqual((o.paid, o.paid_at, o.paid_ref), (True, "2026-11-26T10:00:00", "pol_1"))
        self.assertFalse(Order.from_dict(BASE).paid)

    def test_unpaid_refused_and_nothing_run(self):
        with mock.patch("aivis.order.run_order") as ro:
            code, _ = self.run_cli({**BASE, "paid": False})
        self.assertIn("not marked paid", code); ro.assert_not_called()

    def test_paid_runs(self):
        with mock.patch("aivis.order.run_order", return_value=(None, {})) as ro:
            code, _ = self.run_cli({**BASE, "paid": True})
        self.assertIsNone(code); self.assertFalse(ro.call_args.kwargs["unpaid_override"])

    def test_override_runs_and_is_logged(self):
        with mock.patch("aivis.order.run_order", return_value=(None, {})) as ro:
            code, err = self.run_cli({**BASE, "paid": False}, "--allow-unpaid")
        self.assertIsNone(code); self.assertTrue(ro.call_args.kwargs["unpaid_override"])
        self.assertIn("--allow-unpaid", err); self.assertIn(BASE["order_id"], err)

    def test_override_recorded_in_order_log(self):
        from aivis.order import run_order
        d = tempfile.mkdtemp()
        _, log = run_order(Order.from_dict(BASE), mode="mock", out_dir=d, unpaid_override=True)
        self.assertTrue(log["unpaid_override"]); self.assertFalse(log["paid"])


if __name__ == "__main__":
    unittest.main()
