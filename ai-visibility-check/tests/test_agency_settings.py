"""Agency bundle settings come from the environment (CR-133). Offline; test-only ids and links."""
import io, os, unittest
from contextlib import redirect_stderr
from unittest import mock

import agency_base as ab
from agency_base import products, AGENCY_ENV

ID1, ID5, ID10, ID25 = (f"00000000-0000-4000-8000-0000000000{n}" for n in (11, 55, 10, 25))
LINK = "https://buy.polar.sh/polar_cl_testlink"


class Settings(unittest.TestCase):
    def setUp(self):
        self.saved = {k: os.environ.pop(k, None) for k in AGENCY_ENV + ["AIVIS_AGENCY"]}

    def tearDown(self):
        for k, v in self.saved.items():
            os.environ.pop(k, None)
            if v is not None:
                os.environ[k] = v

    def test_nothing_set_nothing_for_sale(self):
        os.environ["AIVIS_AGENCY"] = "1"
        self.assertEqual(products.agency_product_ids(), {})
        self.assertEqual(products.agency_bundles(), {})
        self.assertEqual(products.agency_pay_links(), {})

    def test_valid_ids_trimmed_and_case_insensitive(self):
        os.environ["AIVIS_AGENCY"] = "1"
        os.environ["AIVIS_AGENCY_PRODUCT_10"] = f"  {ID10.upper()} "
        self.assertEqual(products.agency_product_ids(), {10: ID10})
        self.assertEqual(products.agency_info(ID10)["reports"], 10)
        self.assertIsNone(products.agency_info(ID5))

    def test_bad_format_ignored(self):
        os.environ["AIVIS_AGENCY"] = "1"
        for bad in ("test-bundle", ID5[:-1], ID5 + "0", "not-a-uuid", ID5.replace("-", "")):
            os.environ["AIVIS_AGENCY_PRODUCT_5"] = bad
            self.assertEqual(products.agency_product_ids(), {}, bad)
        for bad in ("http://buy.polar.sh/polar_cl_x", "https://evil.example/polar_cl_x", "https://buy.polar.sh/other",
                    "https://buy.polar.sh.evil.example/polar_cl_x", "https://buy.polar.sh/polar_cl_x y", "https://buy.polar.sh/polar_cl_"):
            os.environ["AIVIS_AGENCY_LINK_5"] = bad
            self.assertEqual(products.agency_pay_links(), {}, bad)
        os.environ["AIVIS_AGENCY_LINK_5"] = f" {LINK} "
        self.assertEqual(products.agency_pay_links(), {"payLinkAgency5": LINK})

    def test_duplicates_and_clashes_ignored_and_logged_as_count(self):
        os.environ["AIVIS_AGENCY"] = "1"
        os.environ["AIVIS_AGENCY_PRODUCT_1"] = ID1
        os.environ["AIVIS_AGENCY_PRODUCT_5"] = ID1.upper()                     # same id, later size
        os.environ["AIVIS_AGENCY_PRODUCT_10"] = next(iter(products.PRODUCTS))  # an existing product id
        err = io.StringIO()
        with redirect_stderr(err):
            self.assertEqual(products.agency_product_ids(), {1: ID1})
        self.assertIn("2 duplicate", err.getvalue())
        self.assertNotIn(ID1, err.getvalue().lower())
        self.assertNotIn(next(iter(products.PRODUCTS)), err.getvalue())

    def test_flag_off_changes_nothing(self):
        for n, v in ((1, ID1), (5, ID5)):
            os.environ[f"AIVIS_AGENCY_PRODUCT_{n}"] = v
            os.environ[f"AIVIS_AGENCY_LINK_{n}"] = LINK
        for flag in (None, "0", "true", "11"):
            if flag is not None:
                os.environ["AIVIS_AGENCY"] = flag
            self.assertIsNone(products.agency_info(ID5))
            self.assertEqual(products.agency_pay_links(), {})


class Served(ab.AgencyBase):
    def test_links_reach_config_only_with_flag_and_valid_link(self):
        with mock.patch.dict(os.environ, {"AIVIS_AGENCY_LINK_25": LINK, "AIVIS_AGENCY_LINK_10": "http://buy.polar.sh/polar_cl_x"}):
            cfg = self.call("GET", "/assets/config.js")[1].decode()
            self.assertIn("payLinkAgency25", cfg)
            self.assertNotIn("payLinkAgency10", cfg)
            os.environ["AIVIS_AGENCY"] = "0"
            self.assertNotIn("payLinkAgency", self.call("GET", "/assets/config.js")[1].decode())

    def test_sentence_shows_only_while_no_product_is_valid(self):
        with mock.patch.dict(os.environ, {"AIVIS_AGENCY_PRODUCT_1": "bad", "AIVIS_AGENCY_PRODUCT_5": "bad"}):
            self.assertIn("Checkout is not connected yet", self.call("GET", "/agency.html")[1].decode())
        self.assertNotIn("Checkout is not connected yet", self.call("GET", "/agency.html")[1].decode())

    def test_unset_size_is_not_matched_by_webhook(self):
        with mock.patch.dict(os.environ, {"AIVIS_AGENCY_PRODUCT_5": ""}):
            self.assertEqual(self.pay(ab.BUNDLE5, "pol_unset")[1]["status"], "unknown_product")


if __name__ == "__main__":
    unittest.main()
