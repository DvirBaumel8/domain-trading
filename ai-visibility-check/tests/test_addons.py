"""Polar add-on products: routing, manual delivery, idempotency, buy buttons. No network, fake vendor APIs."""
import datetime, http.client, json, os, re, sys, tempfile, threading, unittest, urllib.error
from unittest import mock

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import test_delivery as td  # noqa: E402  (fake_apis, sign, KEYS; sets sys.path and env)
import server, delivery, products  # noqa: E402

fake_apis, sign, KEYS = td.fake_apis, td.sign, td.KEYS
PID = {t: next(k for k, v in products.PRODUCTS.items() if v["type"] == t)
       for t in ("base", "maps", "listings_check", "listings", "content", "bundle")}
EXPECT_PID = {"base": "5a9d5f7a-72a6-4ea4-8ae7-e9d4ac498fde", "maps": "5ee66135-2547-4885-81e3-f24bed392e29",
              "listings_check": "f6bd53b9-59db-4f91-ac76-078ec720fa0c",
              "listings": "f6e7aa8b-3886-4280-a584-b771c47f49ab", "content": "10ba0ce6-36ac-4bcf-ab98-8d15bdf22e49",
              "bundle": "46231531-e36e-4149-aa6c-2d8c59edba87"}
URLS = {"payLinkMaps": "https://buy.polar.sh/polar_cl_WLbIDFdoECel8rAZTJvC6UaexF6pSCNv9MpoY1vyfj2",
        "payLinkListingsCheck": "https://buy.polar.sh/polar_cl_DrKvZJBKUGDt4puhZpW7sRsQTINuzc7QuXYyB3Q7geb",
        "payLinkListings": "https://buy.polar.sh/polar_cl_m2zedkpR2g1l5AFs08clQMdfhGWqRr94czipg06Tuhk",
        "payLinkContent": "https://buy.polar.sh/polar_cl_7Vku9OAnFyhBOiQTJtvGUXvSTSqJyV6B69tvV2UXXtw",
        "payLinkBundle": "https://buy.polar.sh/polar_cl_oYtWtZ6fV3CZgv4QbZnQtpAlOs0Vta35Gx3zx2z7sjw"}
EMAIL, ORDER = td.EMAIL, td.ORDER
ADDONS = ("maps", "listings_check", "listings", "content")
FRIDAY = datetime.datetime(2026, 11, 27, 10, 0)     # Friday
SATURDAY = datetime.datetime(2026, 11, 28, 10, 0)


def event(ptype, ref, email=EMAIL, shape="product_id", meta=None, pid=None, amount="list", reason="purchase"):
    pid = PID[ptype] if pid is None else pid
    d = {"id": ref, "customer": {"email": email}}
    if reason is not None:
        d["billing_reason"] = reason
    if amount == "list":
        amount = products.TYPES[ptype]["price_usd"] * 100
    if amount is not None:
        d["net_amount"] = amount
    if meta:
        d["metadata"] = {"order_id": meta}
    if shape == "product_id" and pid:
        d["product_id"] = pid
    elif shape == "product" and pid:
        d["product"] = {"id": pid}
    elif shape == "items" and pid:
        d["items"] = [{"product_id": pid}]
    elif shape == "products" and pid:
        d["products"] = [{"id": pid}]
    return json.dumps({"type": "order.paid", "data": d}).encode()


class Base(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.httpd = server.http.server.ThreadingHTTPServer(("127.0.0.1", 0), server.H)
        cls.port = cls.httpd.server_address[1]
        threading.Thread(target=cls.httpd.serve_forever, daemon=True).start()

    @classmethod
    def tearDownClass(cls):
        cls.httpd.shutdown(); cls.httpd.server_close()

    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.saved = (server.LOCAL_ORDERS, server.http_call, delivery.SYNC, server.now, dict(os.environ))
        server.LOCAL_ORDERS = self.tmp
        self.sent = []
        def fake_http(req, timeout=15):
            self.sent.append(json.loads(req.data)); return 200, b"ok"
        server.http_call = fake_http
        delivery.SYNC = True
        self.clock = FRIDAY
        server.now = lambda: self.clock
        os.environ.update({"POLAR_WEBHOOK_SECRET": "test-secret", "ORDER_ALERT_WEBHOOK_URL": "http://alert.invalid/x",
                           "AIVIS_ALLOW_PAID": "1", "AIVIS_ORDER_CAP_USD": "12", "AIVIS_AUTORUN": "1", **KEYS})
        fake_apis.CALLS.clear()
        fake_apis.POOLS["cur"] = [f"Plumber {i} LLC" for i in range(40)]
        fake_apis.TARGET["name"] = "DrainMaster"
        def urlopen(req, timeout=None, *a, **kw):
            return fake_apis.fake_urlopen(req, timeout)
        p = mock.patch("urllib.request.urlopen", urlopen); p.start(); self.addCleanup(p.stop)

    def tearDown(self):
        server.LOCAL_ORDERS, server.http_call, delivery.SYNC, server.now = self.saved[:4]
        os.environ.clear(); os.environ.update(self.saved[4])

    def hook(self, body, mid):
        return server.handle_polar(sign(body, mid), body)

    def store(self):
        return server.Store()

    def intake(self, email=EMAIL):
        return server.new_order(dict(ORDER, email=email), dict(ORDER, email=email, consent=True))

    def get(self, path):
        c = http.client.HTTPConnection("127.0.0.1", self.port); c.request("GET", path)
        r = c.getresponse(); return r.status, r.read().decode()

    def files(self, folder):
        d = os.path.join(self.tmp, folder)
        return sorted(os.listdir(d)) if os.path.isdir(d) else []

    def orders(self):
        return [self.store().get(f"orders/{f}")[0] for f in self.files("orders")]

    def texts(self):
        return [m["text"] for m in self.sent]

    def manual_orders(self):
        return [o for o in self.orders() if o["order_id"].startswith("MAN-")]

    def runs(self):
        return len(fake_apis.CALLS)


class RoutingTests(Base):
    def test_product_ids_are_the_approved_ones(self):
        self.assertEqual(PID, EXPECT_PID)
        self.assertEqual(len(products.PRODUCTS), 6)

    def test_each_product_routes_to_its_type(self):
        for i, t in enumerate(PID):
            for shape in ("product_id", "product", "items", "products"):
                ids = products.product_ids(json.loads(event(t, "x", shape=shape))["data"])
                self.assertEqual(products.PRODUCTS[ids[0]]["type"], t, (t, shape))
            code, res = self.hook(event(t, f"pol_route_{i}"), f"evt-route-{i}")
            self.assertEqual(code, 200)
            rec = self.store().get(f"purchases/pol_route_{i}.json")[0]
            self.assertEqual(rec["type"], t); self.assertEqual(rec["product_id"], EXPECT_PID[t])

    def test_autorun_flags(self):
        self.assertEqual({t for t, p in ((v["type"], v) for v in products.PRODUCTS.values()) if p["autorun"]},
                         {"base", "bundle"})
        self.assertEqual(products.AUTORUN_TYPES, {"base", "bundle"})

    def test_only_base_and_bundle_start_a_run(self):
        expect = {"base": 180, "bundle": 180, "maps": 0, "listings_check": 0, "listings": 0, "content": 0}
        for t, calls in expect.items():
            fake_apis.CALLS.clear()
            self.intake(f"{t}@x.co")
            code, res = self.hook(event(t, "pol_run_" + t, f"{t}@x.co"), "evt-run-" + t)
            self.assertEqual(code, 200)
            self.assertEqual(self.runs(), calls, t)

    def test_bundle_one_run_three_parts_one_manual_alert(self):
        self.intake()
        self.sent.clear()
        code, res = self.hook(event("bundle", "pol_b1"), "evt-b1")
        self.assertEqual(res["status"], "paid")
        self.assertEqual(self.runs(), 180)
        man = self.manual_orders()
        self.assertEqual(sorted(m["order_type"] for m in man), ["content", "listings", "maps"])
        for m in man:
            self.assertEqual((m["delivery"], m["status"], m["paid"], m["paid_ref"]), ("manual_delivery", "manual_delivery", True, "pol_b1"))
            self.assertEqual(m["due_at"], "2026-12-02")        # Fri + 3 business days = Wed
            self.assertTrue(m["parts"])
        self.assertEqual(len([t for t in self.texts() if "MANUAL" in t]), 1)
        base = [o for o in self.orders() if not o["order_id"].startswith("MAN-")][0]
        self.assertEqual((base["order_type"], base["status"]), ("bundle", "ready"))

    def test_failed_base_run_keeps_manual_parts(self):
        self.intake()
        with mock.patch("urllib.request.urlopen", side_effect=urllib.error.HTTPError("http://x/", 401, "no", {}, None)):
            self.hook(event("bundle", "pol_b2"), "evt-b2")
        base = [o for o in self.orders() if not o["order_id"].startswith("MAN-")][0]
        self.assertEqual(base["status"], "failed")
        self.assertEqual(len(self.manual_orders()), 3)

    def test_manual_products_never_run_even_with_autorun(self):
        for t in ADDONS:
            self.intake(f"{t}@x.co")
            self.hook(event(t, "pol_m_" + t, f"{t}@x.co"), "evt-m-" + t)
        self.assertEqual(self.runs(), 0)
        self.assertFalse(os.path.exists(os.path.join(self.tmp, "reports")))
        from aivis import jobs
        with mock.patch.object(jobs, "build_report", side_effect=AssertionError("engine called")):
            for m in self.manual_orders():
                delivery.on_paid(self.store(), m["order_id"], server.alert)
                delivery.run_job(self.store(), m["order_id"], server.alert)


class ManualDeliveryTests(Base):
    def test_record_alert_due_no_email_no_report(self):
        for t in ADDONS:
            _, token = self.intake(f"{t}@x.co")
            self.sent.clear()
            code, res = self.hook(event(t, "pol_" + t, f"{t}@x.co"), "evt-" + t)
            self.assertEqual((code, res["status"]), (200, "manual_delivery"))
            m = [o for o in self.manual_orders() if o["order_type"] == t][0]
            self.assertEqual((m["delivery"], m["status"], m["paid"], m["paid_ref"], m["intake_missing"]),
                             ("manual_delivery", "manual_delivery", True, "pol_" + t, False))
            self.assertEqual(m["due_at"], "2026-12-02"); self.assertTrue(m["parts"])
            self.assertEqual(len(self.sent), 1)
            txt = self.texts()[0]
            self.assertIn(m["order_id"], txt); self.assertIn(products.TYPES[t]["name"], txt); self.assertIn("2026-12-02", txt)
            self.assertNotIn(EMAIL, txt); self.assertNotIn("@", txt)
            self.assertEqual(self.get("/r/" + token)[0], 404)
            st, page = self.get("/status/" + token)
            self.assertIn("by hand", page); self.assertIn("2026-12-02", page); self.assertNotIn("/r/", page)
            self.assertNotIn("Waiting for your payment", page)

    def test_business_day_helper(self):
        d = datetime.date
        cases = {d(2026, 11, 23): d(2026, 11, 26), d(2026, 11, 26): d(2026, 12, 1), d(2026, 11, 27): d(2026, 12, 2),
                 d(2026, 11, 28): d(2026, 12, 2), d(2026, 11, 29): d(2026, 12, 2)}
        for start, want in cases.items():
            self.assertEqual(products.add_business_days(start), want, start)
        self.assertEqual(products.MANUAL_DELIVERY_BUSINESS_DAYS, 3)
        self.assertEqual(products.due_date(FRIDAY, SATURDAY), "2026-12-02")

    def test_friday_and_weekend_payment(self):
        for when, due in ((FRIDAY, "2026-12-02"), (SATURDAY, "2026-12-02")):
            self.clock = when
            self.intake("w%d@x.co" % when.day)
            self.hook(event("maps", "pol_w%d" % when.day, "w%d@x.co" % when.day), "evt-w%d" % when.day)
        self.assertEqual({m["due_at"] for m in self.manual_orders()}, {"2026-12-02"})
        self.assertLessEqual(products.MANUAL_DELIVERY_BUSINESS_DAYS, 5)

    def test_payment_before_intake_then_due_date_recomputed(self):
        self.clock = FRIDAY
        code, res = self.hook(event("listings", "pol_early"), "evt-early")
        self.assertEqual(res["status"], "manual_delivery")
        m = self.manual_orders()[0]
        self.assertTrue(m["intake_missing"]); self.assertEqual(m["due_at"], "2026-12-02")
        self.assertIn("intake missing", self.texts()[-1]); self.assertNotIn("@", self.texts()[-1])
        self.clock = datetime.datetime(2026, 12, 4, 9, 0)           # intake a week later (Friday)
        self.sent.clear()
        oid, token = self.intake()
        m = self.manual_orders()[0]
        self.assertFalse(m["intake_missing"]); self.assertEqual(m["intake_order"], oid)
        self.assertEqual(m["due_at"], "2026-12-09"); self.assertEqual(m["business_name"], "DrainMaster")
        self.assertEqual(self.runs(), 0)
        self.assertIn("2026-12-09", self.get("/status/" + token)[1])
        self.assertFalse(self.store().get(f"orders/{oid}.json")[0]["paid"])

    def test_bundle_before_intake(self):
        self.hook(event("bundle", "pol_bpre"), "evt-bpre")
        self.assertEqual(len(self.manual_orders()), 3); self.assertEqual(self.runs(), 0)
        self.assertEqual(len([t for t in self.texts() if "MANUAL" in t or "intake missing" in t]), 1)
        oid, token = self.intake()
        self.assertEqual(self.runs(), 180)
        o = self.store().get(f"orders/{oid}.json")[0]
        self.assertEqual((o["paid"], o["status"], o["order_type"]), (True, "ready", "bundle"))
        self.assertTrue(all(not m["intake_missing"] for m in self.manual_orders()))
        self.assertEqual(self.get("/status/" + token)[1].count("being prepared by hand"), 3)

    def test_addon_and_base_same_email_do_not_cross_mark(self):
        self.hook(event("maps", "pol_x1"), "evt-x1")
        oid, token = self.intake()
        o = self.store().get(f"orders/{oid}.json")[0]
        self.assertFalse(o["paid"]); self.assertEqual(self.runs(), 0)
        self.hook(event("base", "pol_x2"), "evt-x2")        # base afterwards: only the base order is paid
        o = self.store().get(f"orders/{oid}.json")[0]
        self.assertTrue(o["paid"]); self.assertEqual(o["paid_ref"], "pol_x2"); self.assertEqual(self.runs(), 180)
        self.assertEqual(len(self.manual_orders()), 1)
        self.assertEqual(self.manual_orders()[0]["paid_ref"], "pol_x1")

    def test_several_purchases_same_email_before_intake(self):
        self.hook(event("base", "pol_y1"), "evt-y1")
        self.hook(event("maps", "pol_y2"), "evt-y2")
        self.hook(event("content", "pol_y3"), "evt-y3")
        refs = self.store().get(f"payments/{server.email_key(EMAIL)}.json")[0]["refs"]
        self.assertEqual(refs, ["pol_y1", "pol_y2", "pol_y3"])
        oid, _ = self.intake()
        o = self.store().get(f"orders/{oid}.json")[0]
        self.assertEqual((o["paid"], o["paid_ref"]), (True, "pol_y1"))
        self.assertEqual(self.runs(), 180)
        self.assertEqual(sorted(m["order_type"] for m in self.manual_orders()), ["content", "maps"])

    def test_addon_only_never_marks_a_base_order_paid(self):
        for t in ADDONS:
            oid, _ = self.intake(f"{t}@y.co")
            self.hook(event(t, "pol_" + t, f"{t}@y.co", meta=oid), "evt-" + t)
            self.assertFalse(self.store().get(f"orders/{oid}.json")[0]["paid"])
        self.assertEqual(self.runs(), 0)


class UnknownProductTests(Base):
    def test_unknown_and_missing_product(self):
        oid, token = self.intake()
        for i, pid in enumerate(("11111111-2222-3333-4444-555555555555", "")):
            self.sent.clear()
            code, res = self.hook(event("base", f"pol_u{i}", pid=pid, meta=oid), f"evt-u{i}")
            self.assertEqual((code, res["status"]), (200, "unknown_product"))
            self.assertEqual(len(self.sent), 1)
            t = self.texts()[0]
            self.assertIn("UNKNOWN Polar product", t); self.assertIn(f"pol_u{i}", t)
            if pid:
                self.assertIn(pid, t)
            self.assertNotIn("@", t)
        o = self.store().get(f"orders/{oid}.json")[0]
        self.assertFalse(o["paid"]); self.assertEqual(self.runs(), 0)
        self.assertEqual(self.manual_orders(), [])
        self.assertEqual(self.store().get(f"payments/{server.email_key(EMAIL)}.json")[0], None)
        oid2, _ = self.intake(); self.assertEqual(self.runs(), 0)
        self.assertFalse(self.store().get(f"orders/{oid2}.json")[0]["paid"])

    def test_two_products_in_one_order_is_unknown(self):
        body = json.dumps({"type": "order.paid", "data": {"id": "pol_two", "billing_reason": "purchase", "net_amount": 14900, "items": [{"product_id": PID["base"]}, {"product_id": PID["maps"]}]}}).encode()
        self.assertEqual(self.hook(body, "evt-two")[1]["status"], "unknown_product")
        self.assertEqual(self.runs(), 0)


class IdempotencyTests(Base):
    def test_replay_same_webhook_id_and_same_order_new_webhook_id(self):
        self.intake()
        for t, runs, manual in (("maps", 0, 1), ("bundle", 180, 4)):
            self.sent.clear()
            ev = event(t, "pol_i_" + t)
            self.assertEqual(self.hook(ev, "evt-i1-" + t)[1]["status"], "paid" if runs else "manual_delivery")
            n_alerts, n_orders = len(self.sent), len(self.orders())
            self.assertEqual(self.hook(ev, "evt-i1-" + t)[1]["status"], "duplicate")        # same webhook id
            self.assertEqual(self.hook(ev, "evt-i2-" + t)[1]["status"], "duplicate")        # new webhook id, same Polar order
            self.assertEqual((len(self.sent), len(self.orders())), (n_alerts, n_orders))
            self.assertEqual(len(self.manual_orders()), manual)
        self.assertEqual(self.runs(), 180)

    def test_replay_of_base(self):
        self.intake()
        ev = event("base", "pol_i_base")
        self.hook(ev, "e1"); n = len(self.sent)
        self.hook(ev, "e1"); self.hook(ev, "e2")
        self.assertEqual((len(self.sent), self.runs()), (n, 180))

    def test_crash_after_purchase_write_resumes_without_duplicates(self):
        self.intake()
        ev = event("maps", "pol_crash")
        calls = {"n": 0}
        def boom(text):
            calls["n"] += 1
            raise RuntimeError("down")
        with mock.patch.object(server, "alert", boom):
            with self.assertRaises(RuntimeError):
                self.hook(ev, "evt-crash")
        self.assertEqual(self.store().get("events/evt-crash.json")[0]["status"], "failed")   # Polar's retry can claim it
        self.assertEqual(len(self.manual_orders()), 1)
        self.hook(ev, "evt-crash")                                          # retry completes it
        self.assertEqual(len(self.manual_orders()), 1)
        self.assertEqual(len([t for t in self.texts() if "MANUAL" in t]), 1)
        self.hook(ev, "evt-crash-3")
        self.assertEqual(len([t for t in self.texts() if "MANUAL" in t]), 1)


class BuyButtonTests(unittest.TestCase):
    SITE = os.path.join(HERE, "..", "site")

    def setUp(self):
        self.saved_env = os.environ.get("ADDONS_CHECKOUT")
        os.environ["ADDONS_CHECKOUT"] = "on"     # URL/button assertions below describe the flag-on site
        self.addCleanup(self.restore_env)

    def restore_env(self):
        os.environ.pop("ADDONS_CHECKOUT", None)
        if self.saved_env is not None:
            os.environ["ADDONS_CHECKOUT"] = self.saved_env

    def config(self):
        raw = server.config_js().decode()
        return dict(re.findall(r'"(payLink\w+)":\s*"([^"]*)"', raw))

    def test_checkout_urls_exact(self):
        cfg = self.config()
        for k, url in URLS.items():
            self.assertEqual(cfg[k], url)
        self.assertEqual(cfg["payLinkCheck"], "https://buy.polar.sh/polar_cl_y4lp8S18BldD0ZyWWdevI07SSgM4eXEwJ6zOI4Fw8mv")
        self.assertNotIn("payLinkMonthly", cfg)
        for url in re.findall(r"https://buy\.polar\.sh/\S+", open(os.path.join(self.SITE, "index.html"), encoding="utf-8").read()):
            self.fail("hard-coded checkout URL in index.html: " + url)

    def test_every_button_belongs_to_a_working_delivery_path(self):
        html = open(os.path.join(self.SITE, "index.html"), encoding="utf-8").read()
        keys = set(re.findall(r'data-pay="(\w+)"', html)) - {"payLinkMonthly"}
        self.assertEqual(keys, set(products.PAY_KEYS))
        cfg = self.config()
        for k in keys:
            otype = products.PAY_KEYS[k]
            self.assertTrue(cfg[k].startswith("https://buy.polar.sh/polar_cl_"), k)
            kind = products.delivery_kind(otype)
            self.assertIn(kind, ("auto", "manual", "auto+manual"))
            if "manual" in kind:     # alert + due date + recorded order are asserted in ManualDeliveryTests
                for part in products.TYPES[otype]["manual"]:
                    self.assertIn(part, products.MANUAL_PARTS)
        self.assertEqual({k: products.delivery_kind(t) for k, t in products.PAY_KEYS.items()},
                         {"payLinkCheck": "auto", "payLinkMaps": "manual", "payLinkListingsCheck": "manual",
                          "payLinkListings": "manual",
                          "payLinkContent": "manual", "payLinkBundle": "auto+manual"})

    def test_site_names_match_polar_products_and_honest_timing(self):
        html = open(os.path.join(self.SITE, "index.html"), encoding="utf-8").read()
        for name in ("Google Maps Visibility Check", "Listings Consistency Check", "Listings with fix pack", "AI Content Pack", "AI Visibility Bundle"):
            self.assertIn(name, html)
        self.assertEqual(html.count("within 3 business days"), 5)
        for banned in ("we claim and fix", "re-check after 30 days"):
            self.assertNotIn(banned, html)
        self.assertIn("3 business days", open(os.path.join(self.SITE, "thanks.html"), encoding="utf-8").read())


if __name__ == "__main__":
    unittest.main()
