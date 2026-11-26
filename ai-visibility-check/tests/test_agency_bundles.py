"""CR-133: T-PAY (one payment, one bundle, never more) and T-COUNT (counting). Offline; fake vendor APIs only."""
import base64, csv, io, concurrent.futures, datetime, hashlib, hmac, json, os, time, unittest
from unittest import mock

import agency_base as ab
from agency_base import BUNDLE1, BUNDLE5, BUYER, CLIENT_A, CLIENT_B, CLIENT_C, MORE
import agency, delivery, server
ta = ab.ta


class PayTests(ab.AgencyBase):
    def test_1_one_payment_one_bundle(self):
        code, res = self.pay(BUNDLE5, "pol_1")
        self.assertEqual((code, res["status"]), (200, "bundle"))
        (b,) = self.bundles()
        self.assertEqual(b["reports_total"], 5)
        self.assertEqual(agency.counts(self.store(), b)["used"], 0)

    def test_2_same_webhook_id_twice_is_duplicate(self):
        self.pay(BUNDLE5, "pol_2", mid="evt-same")
        self.assertEqual(self.pay(BUNDLE5, "pol_2", mid="evt-same")[1]["status"], "duplicate")
        self.assertEqual(len(self.bundles()), 1)

    def test_3_same_order_new_webhook_id_is_still_one_bundle(self):
        self.pay(BUNDLE5, "pol_3", mid="evt-a")
        self.assertEqual(self.pay(BUNDLE5, "pol_3", mid="evt-b")[1]["status"], "duplicate")
        self.assertEqual(len(self.bundles()), 1)

    def test_4_one_cent_short_is_held(self):
        code, res = self.pay(BUNDLE5, "pol_4", amount=24499)
        self.assertEqual(res["status"], "held")
        self.assertEqual(self.bundles(), [])
        self.assertTrue(any("manual review" in t for t in self.texts()))
        self.assertEqual(self.orders(), [])

    def test_5_discount_codes_are_held(self):
        for ref, amount in (("pol_5a", 0), ("pol_5b", 19600)):
            self.assertEqual(self.pay(BUNDLE5, ref, amount=amount)[1]["status"], "held")
        self.assertEqual(self.bundles(), [])

    def test_6_not_a_one_time_purchase_is_held(self):
        self.assertEqual(self.pay(BUNDLE5, "pol_6a", reason="subscription_create")[1]["status"], "held")
        self.assertEqual(self.pay(BUNDLE5, "pol_6b", reason=None)[1]["status"], "held")
        self.assertEqual(self.bundles(), [])

    def test_7_the_product_id_decides_how_many_reports(self):
        self.pay(BUNDLE1, "pol_7", amount=24500)
        (b,) = self.bundles()
        self.assertEqual(b["reports_total"], 1)

    def test_8_two_product_ids_is_unknown_product(self):
        res = self.pay(None, "pol_8", items=[{"product_id": BUNDLE1}, {"product_id": BUNDLE5}])[1]
        self.assertEqual(res["status"], "unknown_product")
        self.assertEqual(self.bundles(), [])
        self.assertTrue(any("UNKNOWN Polar product" in t for t in self.texts()))

    def test_9_quantity_is_ignored(self):
        # Polar's order has no quantity field to read; an injected one must not multiply the reports
        self.pay(BUNDLE5, "pol_9", extra={"quantity": 3, "items": None})
        (b,) = self.bundles()
        self.assertEqual(b["reports_total"], 5)

    def test_10_bad_signature_and_old_timestamp(self):
        body = self.paid_body(BUNDLE5, "pol_10")
        hdr = ab.sign(body, "evt-bad"); hdr["webhook-signature"] = "v1," + base64.b64encode(b"x" * 32).decode()
        self.assertEqual(server.handle_polar(hdr, body)[0], 401)
        ts = str(int(time.time()) - 301)
        mac = hmac.new(b"test-secret", f"evt-old.{ts}.".encode() + body, hashlib.sha256).digest()
        old = {"webhook-id": "evt-old", "webhook-timestamp": ts, "webhook-signature": "v1," + base64.b64encode(mac).decode()}
        self.assertEqual(server.handle_polar(old, body)[0], 401)
        self.assertEqual(self.bundles(), [])

    def test_11_refund_voids_unreserved_and_freezes(self):
        token, bid = self.new_bundle(ref="pol_11")
        self.fake_engine()
        self.assertEqual(self.run_client(token, CLIENT_A)[0], 200)      # delivered (SYNC)
        self.assertEqual(self.refund("pol_11")[1]["status"], "refunded")
        self.assertTrue(any("refunded" in t and bid in t for t in self.texts()))
        st, j = self.run_client(token, CLIENT_B)
        self.assertEqual((st, j["error"]), (409, agency.NO_REPORTS_LEFT))
        self.assertEqual(self.state(token)["left"], 0)
        (o,) = self.orders_of(bid)
        self.assertEqual(self.get("/r/" + o["token"])[0], 200)           # a delivered report stays readable
        self.assertEqual(self.refund("pol_11", mid="ref-again")[1]["status"], "duplicate")

    def test_12_refund_without_a_bundle_is_ignored(self):
        self.assertEqual(self.refund("pol_none")[1]["status"], "ignored")

    def test_13_base_and_addons_have_no_ledger_side_effects(self):
        oid, _ = self.intake()
        self.hook(ta.event("base", "pol_13a", meta=oid), "evt-13a")
        self.hook(ta.event("maps", "pol_13b"), "evt-13b")
        self.assertEqual(self.files("bundles"), [])
        self.assertEqual(self.files("bundle_runs"), [])
        self.assertEqual(self.files("agency_spend"), [])

    def test_flag_off_an_agency_product_is_not_for_sale(self):
        os.environ["AIVIS_AGENCY"] = "0"
        self.assertEqual(self.pay(BUNDLE5, "pol_off")[1]["status"], "unknown_product")
        self.assertEqual(self.bundles(), [])


class CountTests(ab.AgencyBase):
    def test_1_claim_and_wrong_details(self):
        self.assertEqual(self.pay(BUNDLE5, "pol_c1")[1]["status"], "bundle")
        st, good = self.jcall("POST", "/agency/claim", {"order_id": "pol_c1", "email": BUYER.upper()})
        self.assertEqual(st, 200)
        again = self.jcall("POST", "/agency/claim", {"order_id": "pol_c1", "email": BUYER})[1]
        self.assertEqual(good, again)                                    # idempotent: the same link
        agency.reset_limits()
        bad_email = self.call("POST", "/agency/claim", {"order_id": "pol_c1", "email": "other@example.com"})
        bad_order = self.call("POST", "/agency/claim", {"order_id": "pol_zzz", "email": BUYER})
        self.assertEqual((bad_email[0], bad_order[0]), (404, 404))
        self.assertEqual(bad_email[1], bad_order[1])
        agency.reset_limits()
        hdr = {"CF-Connecting-IP": "203.0.113.7"}
        codes = [self.call("POST", "/agency/claim", {"order_id": "pol_zzz", "email": BUYER}, hdr)[0] for _ in range(6)]
        self.assertEqual(codes, [404] * 5 + [429])

    def test_2_three_runs_three_slots(self):
        self.fake_engine()
        token, bid = self.new_bundle()
        for c in (CLIENT_A, CLIENT_B, CLIENT_C):
            self.assertEqual(self.run_client(token, c)[0], 200)
        st = self.state(token)
        self.assertEqual((st["used"], st["left"]), (3, 2))
        self.assertEqual(sorted(o["slot"] for o in self.orders_of(bid)), [1, 2, 3])

    def test_3_eight_simultaneous_runs_on_one_report(self):
        self.fake_engine()
        token, bid = self.new_bundle(BUNDLE1, "pol_c3")
        clients = [CLIENT_A, CLIENT_B, CLIENT_C] + MORE[:5]
        with concurrent.futures.ThreadPoolExecutor(8) as ex:
            res = list(ex.map(lambda c: self.run_client(token, c), clients))
        self.assertEqual(sorted(r[0] for r in res), [200] + [409] * 7)
        self.assertTrue(all(r[1]["error"] == agency.NO_REPORTS_LEFT for r in res if r[0] == 409))
        self.assertEqual(self.state(token)["used"], 1)
        self.assertEqual(len(self.engine_calls), 1)

    def csv(self, rows):
        out = io.StringIO()
        w = csv.writer(out)
        w.writerow(["business", "city", "niche", "website"])
        w.writerows(rows)
        return out.getvalue()

    def test_4_bulk_over_what_is_left_is_refused(self):
        self.fake_engine()
        token, bid = self.new_bundle()
        for c in (CLIENT_A, CLIENT_B, CLIENT_C):
            self.run_client(token, c)
        rows = [(c["business"], c["city"], c["niche"], "") for c in MORE[:5]]
        st, j = self.jcall("POST", f"/agency/p/{token}/bulk", {"csv": self.csv(rows)})
        self.assertEqual(st, 409)
        self.assertEqual(self.state(token)["used"], 3)
        self.assertEqual(len(self.engine_calls), 3)

    def test_5_bulk_with_a_non_us_row_is_refused_whole(self):
        self.fake_engine()
        token, bid = self.new_bundle()
        rows = [(c["business"], c["city"], c["niche"], "") for c in MORE[:3]] + [("Maple Plumbing", "Toronto, ON", "plumber", "")]
        st, j = self.jcall("POST", f"/agency/p/{token}/bulk", {"csv": self.csv(rows)})
        self.assertEqual(st, 400)
        self.assertIn("Row 4", j["error"])
        self.assertEqual(self.state(token)["used"], 0)
        self.assertEqual(self.engine_calls, [])

    def test_5b_bulk_good_rows_run(self):
        self.fake_engine()
        token, bid = self.new_bundle()
        rows = [(c["business"], c["city"], c["niche"], "") for c in MORE[:3]]
        st, j = self.jcall("POST", f"/agency/p/{token}/bulk", {"csv": self.csv(rows)})
        self.assertEqual((st, j["started"], j["left"]), (200, 3, 2))

    def test_6_rerun_within_30_days_needs_confirmation(self):
        self.fake_engine()
        token, bid = self.new_bundle()
        self.assertEqual(self.run_client(token, CLIENT_A)[0], 200)
        self.assertEqual(self.run_client(token, CLIENT_A)[0], 400)
        self.assertEqual(self.state(token)["used"], 1)
        self.assertEqual(self.run_client(token, CLIENT_A, confirm_rerun=True)[0], 200)
        self.assertEqual(self.state(token)["used"], 2)

    def test_7_validation_failures_reserve_nothing(self):
        self.fake_engine()
        token, bid = self.new_bundle()
        bad = [dict(CLIENT_A, city="Springfield, XX"), dict(CLIENT_A, city="Tel Aviv, IL"), dict(CLIENT_A, city="Austin, tx"),
               dict(CLIENT_A, business=""), dict(CLIENT_A, website="http://127.0.0.1")]
        for c in bad:
            self.assertEqual(self.run_client(token, c)[0], 400, c)
        self.assertEqual(self.state(token)["used"], 0)
        self.assertEqual(self.files("bundle_runs"), [])

    def test_8_engine_failure_retries_once_then_returns_the_report(self):
        self.fake_engine(fail=True)
        token, bid = self.new_bundle()
        self.assertEqual(self.run_client(token, CLIENT_A)[0], 200)
        (o,) = self.orders_of(bid)
        self.assertEqual((o["status"], o["attempts"], o["slot"]), ("failed", 2, 1))
        self.assertEqual(self.engine_calls, [o["order_id"]] * 2)            # the same slot, retried once
        st = self.state(token)
        self.assertEqual((st["used"], st["left"]), (0, 5))
        voided = [t for t in self.texts() if "returned after a failed run" in t]
        self.assertTrue(voided and all(BUYER not in t and token not in t for t in self.texts()))
        self.fake_engine()      # the returned slot can be used again
        self.assertEqual(self.run_client(token, CLIENT_B)[0], 200)
        self.assertEqual(sorted(o["slot"] for o in self.orders_of(bid)), [1, 1])

    def test_9_daily_cap_queues_and_keeps_the_slot(self):
        os.environ["AIVIS_PACK_DAILY_CAP_USD"] = "12"
        self.fake_engine(cost=5.88)
        p = mock.patch.object(agency, "estimate_usd", lambda o: 5.88); p.start(); self.patches.append(p)
        token, bid = self.new_bundle()
        for c in (CLIENT_A, CLIENT_B, CLIENT_C):
            self.assertEqual(self.run_client(token, c)[0], 200)
        third = [o for o in self.orders_of(bid) if o["business_name"] == CLIENT_C["business"]][0]
        self.assertEqual(third["status"], "queued")
        self.assertEqual(len(self.engine_calls), 2)
        self.assertEqual(self.state(token)["used"], 3)                      # its slot stays reserved
        self.clock += datetime.timedelta(days=1)                           # the day rolls
        self.assertEqual(delivery.resume_orders(self.store(), server.alert), [third["order_id"]])
        self.assertEqual(self.store().get(f"orders/{third['order_id']}.json")[0]["status"], "ready")
        self.assertEqual(len(self.engine_calls), 3)
        self.assertEqual(self.state(token)["used"], 3)

    def test_9b_the_cap_holds_against_a_race(self):
        os.environ["AIVIS_PACK_DAILY_CAP_USD"] = "12"
        self.fake_engine(cost=5.88)
        p = mock.patch.object(agency, "estimate_usd", lambda o: 5.88); p.start(); self.patches.append(p)
        token, bid = self.new_bundle()
        with concurrent.futures.ThreadPoolExecutor(3) as ex:
            res = list(ex.map(lambda c: self.run_client(token, c), (CLIENT_A, CLIENT_B, CLIENT_C)))
        self.assertEqual([r[0] for r in res], [200] * 3)
        self.assertEqual(len(self.engine_calls), 2)
        self.assertEqual(sorted(o["status"] for o in self.orders_of(bid)), ["queued", "ready", "ready"])

    def test_10_rebrand_five_times_costs_nothing(self):
        os.environ["AIVIS_ORDER_CAP_USD"] = "12"
        fake_apis = ab.fake_apis
        fake_apis.TARGET["name"] = CLIENT_C["business"]
        token, bid = self.new_bundle()
        self.assertEqual(self.run_client(token, dict(CLIENT_C))[0], 200)
        (o,) = self.orders_of(bid)
        self.assertEqual(o["status"], "ready")
        calls = len(fake_apis.CALLS)
        self.assertGreater(calls, 0)
        self.jcall("POST", f"/agency/p/{token}/brand", ab.AGENCY)
        for i in range(5):
            st, j = self.jcall("POST", f"/agency/p/{token}/rebrand",
                               {"order_id": o["order_id"], "mode": "unbranded" if i % 2 else "branded", **ab.AGENCY})
            self.assertEqual((st, j.get("rebrands")), (200, i + 1))
        st, j = self.jcall("POST", f"/agency/p/{token}/rebrand", {"order_id": o["order_id"], "mode": "unbranded"})
        self.assertEqual(st, 400)
        self.assertEqual(len(fake_apis.CALLS), calls)
        self.assertEqual(self.state(token)["used"], 1)

    def test_11_restart_resumes_the_reserved_slot(self):
        os.environ.pop("AIVIS_AUTORUN")
        token, bid = self.new_bundle()
        self.assertEqual(self.run_client(token, CLIENT_A)[0], 200)
        (o,) = self.orders_of(bid)
        self.assertEqual(o["status"], "queued")
        stale = (datetime.datetime.now() - datetime.timedelta(hours=1)).isoformat(timespec="seconds")
        self.store().put(f"orders/{o['order_id']}.json", {**o, "status": "running", "status_at": stale, "attempts": 1}, overwrite=True)
        os.environ["AIVIS_AUTORUN"] = "1"
        self.fake_engine()
        self.assertEqual(delivery.resume_orders(self.store(), server.alert), [o["order_id"]])
        self.assertEqual(self.store().get(f"orders/{o['order_id']}.json")[0]["status"], "ready")
        self.assertEqual(len(self.orders_of(bid)), 1)
        self.assertEqual(self.state(token)["used"], 1)
        self.assertEqual(self.files(f"bundle_runs/{bid}"), ["1.json"])


if __name__ == "__main__":
    unittest.main()
