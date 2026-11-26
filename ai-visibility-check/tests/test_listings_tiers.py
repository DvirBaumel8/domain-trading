"""Two Listings products, payment-to-intake matching with shared emails, and the Listings wording. No network."""
import os, re, sys, unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import test_addons as ta  # noqa: E402
import server, products   # noqa: E402

event, SITE = ta.event, os.path.join(HERE, "..", "site")


class ListingsTierTests(ta.Base):
    def test_map_entries(self):
        c, l = products.TYPES["listings_check"], products.TYPES["listings"]
        self.assertEqual((c["price_usd"], c["autorun"], c["manual"]), (99, False, ("listings_check",)))
        self.assertEqual((l["price_usd"], l["autorun"]), (249, False))
        self.assertEqual(products.TYPES["bundle"]["manual"], ("maps", "listings", "content"))
        self.assertEqual(products.PAY_KEYS["payLinkListingsCheck"], "listings_check")
        self.assertEqual(products.AUTORUN_TYPES, {"base", "bundle"})
        owed = " ".join(products.MANUAL_PARTS["listings"]["owed"])
        self.assertIn("ready-to-paste corrected-listing pack", owed)
        self.assertNotIn("pack", " ".join(products.MANUAL_PARTS["listings_check"]["owed"]))

    def test_no_done_for_you_wording(self):
        texts = [open(os.path.join(SITE, f), encoding="utf-8").read() for f in os.listdir(SITE) if f.endswith(".html")]
        texts.append(repr(products.MANUAL_PARTS))
        for t in texts:
            for banned in ("we fix your listings", "we claim and fix", "done-for-you fixes"):
                self.assertNotIn(banned, t.lower())

    def test_listings_check_starts_no_engine_with_autorun(self):
        self.intake("lc@x.co"); self.sent.clear()
        code, res = self.hook(event("listings_check", "pol_lc", "lc@x.co"), "evt-lc")
        self.assertEqual((code, res["status"]), (200, "manual_delivery"))
        self.assertEqual(self.runs(), 0)
        m = self.manual_orders()
        self.assertEqual(len(m), 1)
        self.assertEqual((m[0]["order_type"], m[0]["delivery"], m[0]["due_at"]), ("listings_check", "manual_delivery", "2026-12-02"))
        self.assertEqual(len(self.sent), 1)
        self.assertNotIn("@", self.texts()[0])
        self.assertEqual(len(self.orders()), 2)     # the intake and the one manual task
        for o in self.orders():
            if not o["order_id"].startswith("MAN-"):
                self.assertFalse(o["paid"])
                self.assertEqual(self.get("/r/" + o["token"])[0], 404)

    def test_same_email_two_listings_orders_do_not_cross_mark(self):
        oid, _ = self.intake("same@x.co")
        self.hook(event("listings_check", "pol_a", "same@x.co"), "evt-a")
        self.hook(event("listings", "pol_b", "same@x.co"), "evt-b")
        self.assertFalse(self.store().get(f"orders/{oid}.json")[0]["paid"])
        self.assertEqual(sorted(m["order_type"] for m in self.manual_orders()), ["listings", "listings_check"])
        self.assertEqual(sorted(m["paid_ref"] for m in self.manual_orders()), ["pol_a", "pol_b"])
        self.assertEqual(self.runs(), 0)

    def test_replay_makes_no_second_task(self):
        self.intake("rp@x.co")
        body = event("listings_check", "pol_rp", "rp@x.co")
        self.hook(body, "evt-rp1"); self.sent.clear()
        self.hook(body, "evt-rp2")
        self.assertEqual(len(self.manual_orders()), 1)
        self.assertEqual(self.sent, [])

    def test_buy_buttons(self):
        os.environ["ADDONS_CHECKOUT"] = "on"
        cfg = dict(re.findall(r'"(payLink\w+)":\s*"([^"]*)"', server.config_js().decode()))
        self.assertEqual(cfg["payLinkListingsCheck"], "https://buy.polar.sh/polar_cl_DrKvZJBKUGDt4puhZpW7sRsQTINuzc7QuXYyB3Q7geb")
        self.assertEqual(cfg["payLinkListings"], "https://buy.polar.sh/polar_cl_m2zedkpR2g1l5AFs08clQMdfhGWqRr94czipg06Tuhk")
        for k in ("payLinkListingsCheck", "payLinkListings"):
            self.assertEqual(products.delivery_kind(products.PAY_KEYS[k]), "manual")


class MatchingTests(ta.Base):
    def order(self, oid):
        return self.store().get(f"orders/{oid}.json")[0]

    def test_typed_reference_binds_despite_shared_email(self):
        a, _ = self.intake("dup@x.co")
        b, _ = server.new_order(dict(ta.ORDER, email="dup@x.co", paid_ref="pol_ref"), dict(ta.ORDER, email="dup@x.co", consent=True))
        self.hook(event("base", "pol_ref", "dup@x.co"), "evt-ref")
        self.assertTrue(self.order(b)["paid"]); self.assertFalse(self.order(a)["paid"])

    def test_polar_order_id_binds_despite_shared_email(self):
        self.intake("dup2@x.co")
        b, _ = server.new_order(dict(ta.ORDER, email="dup2@x.co", paid_ref="pol_oid"), dict(ta.ORDER, email="dup2@x.co", consent=True))
        self.intake("dup2@x.co")
        self.hook(event("base", "pol_oid", "dup2@x.co"), "evt-oid")
        self.assertTrue(self.order(b)["paid"])
        self.assertEqual(sum(1 for o in self.orders() if o.get("paid")), 1)

    def test_two_unpaid_same_email_no_reference_is_held(self):
        a, _ = self.intake("two@x.co"); b, _ = self.intake("two@x.co")
        self.sent.clear()
        code, res = self.hook(event("base", "pol_two1", "two@x.co"), "evt-two1")
        self.assertEqual(res["status"], "unmatched")
        self.assertFalse(self.order(a)["paid"]); self.assertFalse(self.order(b)["paid"])
        self.assertEqual(self.runs(), 0)
        self.assertEqual(len(self.sent), 1)
        t = self.texts()[0]
        self.assertIn("pol_two1", t); self.assertIn("several intakes share this email", t); self.assertNotIn("@", t)
        c, _ = server.new_order(dict(ta.ORDER, email="two@x.co", paid_ref="pol_two1"), dict(ta.ORDER, email="two@x.co", consent=True))
        self.assertTrue(self.order(c)["paid"]); self.assertEqual(self.runs(), 180)
        self.assertFalse(self.order(a)["paid"]); self.assertFalse(self.order(b)["paid"])

    def test_single_payment_single_intake_still_matches(self):
        a, _ = self.intake("one@x.co")
        self.hook(event("base", "pol_one", "one@x.co"), "evt-one")
        self.assertTrue(self.order(a)["paid"])


if __name__ == "__main__":
    unittest.main()
