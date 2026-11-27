"""Payment handling: one-time use of a payment, matching order, payment validation, event claim, run guard.
No network, fake vendor APIs."""
import concurrent.futures, datetime, os, sys, time, unittest
from unittest import mock

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import test_addons as ta  # noqa: E402
import server, delivery, products  # noqa: E402

event, fake_apis, PID = ta.event, ta.fake_apis, ta.PID


class SlowStore(server.Store):
    def get(self, path):
        time.sleep(0.05); return super().get(path)

    def put(self, path, obj, overwrite=False):
        time.sleep(0.05); return super().put(path, obj, overwrite)


class PaymentBase(ta.Base):
    def order(self, oid):
        return self.store().get(f"orders/{oid}.json")[0]

    def alerts_for(self, oid):
        return [t for t in self.texts() if oid in t]

    def purchase(self, ref):
        return self.store().get(f"purchases/{ref}.json")[0]


class OneTimeUseTests(PaymentBase):
    def test_three_intakes_same_email_one_payment_one_paid_order_one_run(self):
        self.hook(event("base", "pol_once"), "evt-once")
        self.sent.clear()
        ids = [self.intake(e)[0] for e in ("Buyer.Secret@Example.com", "  buyer.secret@example.com ", "BUYER.SECRET@EXAMPLE.COM")]
        paid = [i for i in ids if self.order(i)["paid"]]
        self.assertEqual(paid, ids[:1])
        self.assertEqual(self.runs(), 180)
        for i in ids[1:]:
            self.assertFalse(self.order(i)["paid"])
            self.assertFalse(self.order(i).get("status"))
            self.assertEqual(len(self.alerts_for(i)), 1, i)
        self.assertEqual(server.consumer(self.store(), "pol_once"), ids[0])

    def test_typed_reference_matches_payment_of_another_email(self):
        self.hook(event("base", "pol_typed", "someone.else@example.org"), "evt-typed")
        oid, _ = server.new_order(dict(ta.ORDER, paid_ref="pol_typed"), dict(ta.ORDER, consent=True))
        o = self.order(oid)
        self.assertEqual((o["paid"], o["paid_ref"]), (True, "pol_typed"))
        self.assertEqual(self.runs(), 180)

    def test_typed_reference_beats_email_when_several_payments_are_unused(self):
        self.hook(event("base", "pol_t1"), "evt-t1"); self.hook(event("base", "pol_t2"), "evt-t2")
        oid, _ = server.new_order(dict(ta.ORDER, paid_ref="pol_t2"), dict(ta.ORDER, consent=True))
        self.assertEqual(self.order(oid)["paid_ref"], "pol_t2")
        self.assertEqual(server.consumer(self.store(), "pol_t1"), "")

    def test_several_unused_payments_and_no_reference_is_not_guessed(self):
        self.hook(event("base", "pol_s1"), "evt-s1"); self.hook(event("base", "pol_s2"), "evt-s2")
        self.sent.clear()
        oid, _ = self.intake()
        self.assertFalse(self.order(oid)["paid"]); self.assertEqual(self.runs(), 0)
        self.assertEqual(len(self.alerts_for(oid)), 1)
        self.assertIn("awaiting payment", self.alerts_for(oid)[0])

    def test_payment_consumed_by_intake_cannot_pay_another_order(self):
        self.hook(event("base", "pol_c1"), "evt-c1")
        first, _ = self.intake()
        other, _ = server.new_order(dict(ta.ORDER, paid_ref="pol_c1"), dict(ta.ORDER, consent=True))
        self.assertTrue(self.order(first)["paid"]); self.assertFalse(self.order(other)["paid"])
        self.assertEqual(self.runs(), 180)

    def test_payment_after_two_intakes_is_not_guessed(self):
        a, _ = self.intake(); b, _ = self.intake()
        self.sent.clear()
        code, res = self.hook(event("base", "pol_amb"), "evt-amb")
        self.assertEqual((code, res["status"]), (200, "unmatched"))
        self.assertFalse(self.order(a)["paid"] or self.order(b)["paid"])
        self.assertEqual(self.runs(), 0)
        self.assertEqual(len(self.sent), 1)
        self.assertNotIn("@", self.texts()[0])

    def test_second_payment_cannot_pay_an_already_paid_order(self):
        oid, _ = self.intake()
        self.hook(event("base", "pol_p1"), "evt-p1")
        self.hook(event("base", "pol_p2", meta=oid), "evt-p2")
        self.assertEqual(self.order(oid)["paid_ref"], "pol_p1")
        self.assertEqual(self.runs(), 180)
        self.assertEqual(server.consumer(self.store(), "pol_p2"), "")

    def test_consume_is_create_only(self):
        st = self.store()
        self.assertTrue(server.consume(st, "pol_x", "ORD-1"))
        self.assertFalse(server.consume(st, "pol_x", "ORD-2"))
        self.assertTrue(server.consume(st, "pol_x", "ORD-1"))
        self.assertEqual(server.consumer(st, "pol_x"), "ORD-1")


class ValidationTests(PaymentBase):
    def assert_not_started(self, body, mid, status):
        oid, _ = self.intake()
        self.sent.clear()
        code, res = self.hook(body, mid)
        self.assertEqual((code, res["status"]), (200, status))
        self.assertFalse(self.order(oid)["paid"]); self.assertEqual(self.runs(), 0)
        self.assertEqual(self.manual_orders(), [])
        return self.texts()

    def test_product_not_in_the_map(self):
        texts = self.assert_not_started(event("base", "pol_v1", pid="00000000-0000-0000-0000-000000000000"), "evt-v1", "unknown_product")
        self.assertEqual(len(texts), 1); self.assertIn("00000000-0000-0000-0000-000000000000", texts[0])

    def test_zero_amount_and_discounted(self):
        texts = self.assert_not_started(event("base", "pol_z0", amount=0), "evt-z0", "held")
        self.assertIn("payment needs manual review", texts[0]); self.assertNotIn("@", texts[0])
        self.assertEqual(self.purchase("pol_z0")["status"], "held")
        for i, amount in ((1, 14899), (2, 100)):
            code, res = self.hook(event("base", f"pol_z{i}", amount=amount), f"evt-z{i}")
            self.assertEqual(res["status"], "held"); self.assertEqual(self.runs(), 0)

    def test_missing_or_non_numeric_amount(self):
        for i, amount in enumerate((None, "abc", True, [1], {"a": 1}, "")):
            code, res = self.hook(event("base", f"pol_n{i}", amount=amount), f"evt-n{i}")
            self.assertEqual(res["status"], "held", amount)
        self.assertEqual(self.runs(), 0)

    def test_billing_reason_not_a_one_time_purchase(self):
        for i, reason in enumerate((None, "", "subscription_cycle", "subscription_create", "PURCHASE")):
            self.intake(f"r{i}@x.co")
            code, res = self.hook(event("base", f"pol_r{i}", f"r{i}@x.co", reason=reason), f"evt-r{i}")
            self.assertEqual(res["status"], "held", reason)
        self.assertEqual(self.runs(), 0)
        self.assertTrue(all(not o["paid"] for o in self.orders()))

    def test_addon_below_price_is_held_without_a_manual_task(self):
        for t in ta.ADDONS:
            self.intake(f"{t}@x.co"); self.sent.clear()
            code, res = self.hook(event(t, "pol_h_" + t, f"{t}@x.co", amount=1), "evt-h-" + t)
            self.assertEqual(res["status"], "held")
            self.assertEqual(len([x for x in self.texts() if "needs manual review" in x]), 1)
        self.assertEqual(self.manual_orders(), [])
        self.assertEqual(self.runs(), 0)

    def test_bundle_below_price_runs_nothing_and_creates_no_parts(self):
        self.intake()
        code, res = self.hook(event("bundle", "pol_hb", amount=14900), "evt-hb")
        self.assertEqual(res["status"], "held")
        self.assertEqual((self.runs(), len(self.manual_orders())), (0, 0))

    def test_held_payment_is_never_used_by_a_later_intake(self):
        self.hook(event("base", "pol_hl", amount=0), "evt-hl")
        oid, _ = server.new_order(dict(ta.ORDER, paid_ref="pol_hl"), dict(ta.ORDER, consent=True))
        self.assertFalse(self.order(oid)["paid"]); self.assertEqual(self.runs(), 0)

    def test_held_replay_alerts_once(self):
        ev = event("base", "pol_hr", amount=0)
        self.hook(ev, "evt-hr1"); self.hook(ev, "evt-hr1"); self.hook(ev, "evt-hr2")
        self.assertEqual(len([t for t in self.texts() if "needs manual review" in t]), 1)

    def test_full_price_base_and_bundle_run_exactly_once(self):
        for t in ("base", "bundle"):
            fake_apis.CALLS.clear()
            self.intake(f"{t}@x.co")
            code, res = self.hook(event(t, "pol_f_" + t, f"{t}@x.co"), "evt-f-" + t)
            self.assertEqual((res["status"], self.runs()), ("paid", 180), t)
        self.assertEqual(len(self.manual_orders()), 3)

    def test_amount_above_price_and_string_amount_pass(self):
        for i, amount in enumerate((14900 + 2500, "14900")):
            self.intake(f"a{i}@x.co")
            self.assertEqual(self.hook(event("base", f"pol_a{i}", f"a{i}@x.co", amount=amount), f"evt-a{i}")[1]["status"], "paid")

    def test_paid_cents_helper(self):
        self.assertEqual(products.paid_cents({"net_amount": 5, "total_amount": 9}), 5)
        self.assertIsNone(products.paid_cents({}))
        self.assertIsNone(products.paid_cents({"net_amount": 5, "total_amount": "x"}))


class EventClaimTests(PaymentBase):
    def test_concurrent_deliveries_of_one_webhook_id_run_once(self):
        self.intake()
        body = event("base", "pol_cc")
        with mock.patch.object(server, "Store", SlowStore):
            with concurrent.futures.ThreadPoolExecutor(2) as ex:
                futs = [ex.submit(self.hook, body, "evt-cc") for _ in range(2)]
                res = sorted(f.result()[1]["status"] for f in futs)
        self.assertEqual(res, ["duplicate", "paid"])
        self.assertEqual(self.runs(), 180)

    def test_failed_event_can_be_claimed_again(self):
        self.intake()
        body = event("maps", "pol_fe")
        with mock.patch.object(server, "alert", side_effect=RuntimeError("down")):
            with self.assertRaises(RuntimeError):
                self.hook(body, "evt-fe")
        self.assertEqual(self.store().get("events/evt-fe.json")[0]["status"], "failed")
        self.assertEqual(self.hook(body, "evt-fe")[1]["status"], "manual_delivery")
        self.assertEqual(self.store().get("events/evt-fe.json")[0]["status"], "done")
        self.assertEqual(self.hook(body, "evt-fe")[1]["status"], "duplicate")
        self.assertEqual(len(self.manual_orders()), 1)

    def test_same_polar_order_under_two_webhook_ids_one_run(self):
        self.intake()
        ev = event("base", "pol_two_ids")
        self.hook(ev, "evt-w1"); self.hook(ev, "evt-w2")
        self.assertEqual(self.runs(), 180)
        self.assertEqual(len(self.orders()), 1)


class RunGuardTests(PaymentBase):
    def paid_ready(self):
        oid, _ = self.intake()
        self.hook(event("base", "pol_g"), "evt-g")
        self.assertEqual(self.order(oid)["status"], "ready")
        fake_apis.CALLS.clear()
        return oid

    def test_ready_order_is_not_run_again(self):
        oid = self.paid_ready()
        delivery.run_job(self.store(), oid, server.alert)
        self.assertEqual(self.runs(), 0)

    def test_fresh_running_order_is_not_run_again(self):
        oid = self.paid_ready()
        o = self.order(oid)
        o.update({"status": "running", "status_at": datetime.datetime.now().isoformat(timespec="seconds")})
        self.store().put(f"orders/{oid}.json", o, overwrite=True)
        delivery.run_job(self.store(), oid, server.alert)
        self.assertEqual(self.runs(), 0)
        self.assertEqual(self.order(oid)["status"], "running")

    def test_stale_running_order_may_be_run(self):
        oid = self.paid_ready()
        o = self.order(oid)
        old = datetime.datetime.now() - datetime.timedelta(hours=3)
        o.update({"status": "running", "status_at": old.isoformat(timespec="seconds")})
        self.store().put(f"orders/{oid}.json", o, overwrite=True)
        delivery.run_job(self.store(), oid, server.alert)
        self.assertEqual(self.runs(), 180)


if __name__ == "__main__":
    unittest.main()
