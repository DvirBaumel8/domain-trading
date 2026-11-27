"""Claim by purchase email alone (order id optional), the email index, the /agency-thanks alias, small copy fixes.
Offline. No real email, token or id: test addresses only."""
import datetime, os, pathlib, shutil, sys, unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import agency_base as ab  # noqa: E402
from agency_base import BUNDLE1, BUNDLE5, BUYER, agency  # noqa: E402

SITE = os.path.join(os.path.dirname(HERE), "site")
NOMATCH = b'{"error": "We could not match those details."}'


def ip(n):
    return {"CF-Connecting-IP": f"203.0.113.{n}"}


class ClaimByEmail(ab.AgencyBase):
    def claim(self, body, n=1):
        return self.call("POST", "/agency/claim", body, ip(n))

    def test_email_only_opens_the_portal(self):
        self.pay(BUNDLE5, "pol_e1")
        st, j = self.jcall("POST", "/agency/claim", {"email": "  " + BUYER.upper() + " "})
        self.assertEqual(st, 200)
        self.assertEqual(list(j), ["portal"])
        self.assertTrue(j["portal"].startswith("/agency/p/"))

    def test_order_id_only_narrows(self):
        self.pay(BUNDLE5, "pol_e2")
        self.assertEqual(self.jcall("POST", "/agency/claim", {"email": BUYER, "order_id": "pol_e2"})[0], 200)   # old path
        wrong = self.claim({"email": BUYER, "order_id": "pol_nope"}, 2)
        unknown = self.claim({"email": "nobody@example.com"}, 3)
        old_wrong = self.claim({"email": "nobody@example.com", "order_id": "pol_e2"}, 4)
        self.assertEqual((wrong[0], unknown[0], old_wrong[0]), (404, 404, 404))
        self.assertEqual(wrong[1], NOMATCH)
        self.assertEqual({wrong[1], unknown[1], old_wrong[1]}, {NOMATCH})

    def test_two_bundles_two_portals_newest_first(self):
        self.pay(BUNDLE5, "pol_e3")
        self.clock = self.clock + datetime.timedelta(minutes=5)
        self.pay(BUNDLE1, "pol_e4")
        st, j = self.jcall("POST", "/agency/claim", {"email": BUYER})
        self.assertEqual(st, 200)
        self.assertEqual([(p["reports"], p["left"]) for p in j["portals"]], [(1, 1), (5, 5)])
        self.assertTrue(all(p["portal"].startswith("/agency/p/") for p in j["portals"]))
        one = self.jcall("POST", "/agency/claim", {"email": BUYER, "order_id": "pol_e3"}, ip(9))
        self.assertEqual(list(one[1]), ["portal"])                    # an order id narrows to that bundle

    def test_refunded_bundle_is_still_listed(self):
        self.pay(BUNDLE5, "pol_e5")
        self.refund("pol_e5")
        st, j = self.jcall("POST", "/agency/claim", {"email": BUYER})
        self.assertEqual(st, 200)
        self.assertIn("portal", j)

    def test_rate_limits_per_address_and_per_email(self):
        self.pay(BUNDLE5, "pol_e6")
        agency.reset_limits()
        codes = [self.claim({"email": "x@example.com"})[0] for _ in range(6)]       # one address
        self.assertEqual(codes, [404] * 5 + [429])
        agency.reset_limits()
        codes = [self.claim({"email": "x@example.com"}, n)[0] for n in range(1, 12)]   # one email, many addresses
        self.assertEqual(codes, [404] * 10 + [429])
        known = [self.claim({"email": BUYER}, n)[0] for n in range(1, 12)]
        self.assertEqual(known, [200] * 10 + [429])
        a = self.claim({"email": "x@example.com"}, 30)
        b = self.claim({"email": BUYER}, 31)
        self.assertEqual((a[0], b[0], a[1]), (429, 429, b[1]))        # same body for known and unknown
        self.assertEqual(self.bundles()[0]["token"] != "", True)

    def test_a_429_changes_nothing(self):
        self.pay(BUNDLE5, "pol_e7")
        for n in range(1, 11):
            self.claim({"email": "x@example.com"}, n)
        before = [dict(b) for b in self.bundles()]
        self.assertEqual(self.claim({"email": "x@example.com"}, 40)[0], 429)
        self.assertEqual(self.bundles(), before)

    def test_bundle_made_before_the_index_is_found(self):
        self.pay(BUNDLE5, "pol_e8")
        shutil.rmtree(os.path.join(self.tmp, "bundle_emails"))                  # what a bundle from before the index looks like
        agency._backfilled = False
        st, j = self.jcall("POST", "/agency/claim", {"email": BUYER})
        self.assertEqual(st, 200)
        self.assertIn("portal", j)
        self.assertTrue(os.path.isfile(os.path.join(self.tmp, "bundle_emails", agency.email_key(BUYER) + ".json")))   # index filled

    def test_index_is_written_when_the_bundle_is_created(self):
        self.pay(BUNDLE5, "pol_e9")
        idx = self.store().get(f"bundle_emails/{agency.email_key(BUYER)}.json")[0]
        self.assertEqual(idx["bundles"], [agency.bundle_id("pol_e9")])
        self.assertEqual(self.pay(BUNDLE5, "pol_e9")[1]["status"], "duplicate")
        self.assertEqual(self.store().get(f"bundle_emails/{agency.email_key(BUYER)}.json")[0], idx)


class ThanksAlias(ab.AgencyBase):
    def test_extensionless_url_serves_the_page_with_the_flag_on(self):
        for path in ("/agency-thanks", "/agency-thanks?checkout_id=x", "/agency-thanks.html"):
            st, body, _ = self.call("GET", path)
            self.assertEqual(st, 200, path)
            text = body.decode().lower()
            self.assertIn("no cash value", text)
            self.assertNotIn("checkout_id", text)                    # a query is never echoed

    def test_flag_off_is_404(self):
        os.environ.pop("AIVIS_AGENCY")
        for path in ("/agency-thanks", "/agency-thanks?checkout_id=x", "/agency-thanks.html"):
            self.assertEqual(self.call("GET", path)[0], 404, path)

    def test_no_other_page_loses_its_extension(self):
        for path in ("/agency-terms", "/privacy", "/agency"):
            self.assertEqual(self.call("GET", path)[0], 404, path)

    def test_page_asks_only_for_the_email(self):
        raw = pathlib.Path(SITE, "agency-thanks.html").read_text(encoding="utf-8")
        self.assertEqual(raw.count(" required"), 1)
        self.assertIn('name="email" type="email" maxlength="200" required', raw)


class SmallCopy(ab.AgencyBase):
    def test_no_literal_n_and_no_monthly_plan_price(self):
        for on in ("1", None):
            if on is None:
                os.environ.pop("AIVIS_AGENCY")
            st, body, _ = self.call("GET", "/agency.html")
            self.assertNotIn("n automated", body.decode().lower())
        home = pathlib.Path(SITE, "index.html").read_text(encoding="utf-8")
        i = home.index("for your agency's own client work")
        line = home[i - 60:i + 300]
        self.assertNotIn("monthly plans", line)
        self.assertNotIn("$39", line)


if __name__ == "__main__":
    unittest.main()
