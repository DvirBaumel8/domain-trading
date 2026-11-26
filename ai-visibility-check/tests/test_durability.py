"""Order and alert durability: resume on boot, stuck sweep, autorun prerequisites, alert issues, fast webhook ack.
No network: a fake GitHub (contents + issues) is the only transport, fake vendor APIs answer the engines."""
import base64, datetime, http.client, json, os, sys, tempfile, threading, time, unittest, urllib.parse
from unittest import mock

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import test_delivery as td  # noqa: E402  (sets up the path, env and the fake vendor APIs)
import server, delivery  # noqa: E402
from site_config import SUPPORT_EMAIL  # noqa: E402

fake_apis = td.fake_apis
REPO = "me/priv-orders"
WEBSITE = "drainmaster-plumbing.example"
FULL = dict(td.ORDER, website=WEBSITE)
HOOK = "http://alert.invalid/x"


class FakeGitHub:
    """Contents API (get, put, folder listing with paging) and issues, plus the alert webhook."""
    def __init__(self):
        self.files, self.issues, self.webhooks, self.calls = {}, [], [], []
        self.fail_issues = False
        self.reject_labels = False

    def __call__(self, req, timeout=15):
        url, method = req.full_url, req.get_method()
        self.calls.append((method, url))
        if url == HOOK:
            self.webhooks.append(json.loads(req.data)); return 200, b"ok"
        base = f"https://api.github.com/repos/{REPO}/"
        assert url.startswith(base), url
        rest = url[len(base):]
        if rest == "issues":
            payload = json.loads(req.data)
            if self.fail_issues:
                return 500, b"{}"
            if self.reject_labels and payload.get("labels"):
                return 422, b"{}"
            self.issues.append({"url": url, "auth": req.headers.get("Authorization"), **payload}); return 201, b"{}"
        path, _, query = rest[len("contents/"):].partition("?")
        path, q = urllib.parse.unquote(path), urllib.parse.parse_qs(query)
        if method == "PUT":
            p = json.loads(req.data)
            if path in self.files and "sha" not in p:
                return 422, b"{}"
            self.files[path] = base64.b64decode(p["content"]).decode(); return 201, b"{}"
        if path in self.files:
            return 200, json.dumps({"content": base64.b64encode(self.files[path].encode()).decode(), "sha": "s" + str(len(self.files[path]))}).encode()
        names = sorted(k for k in self.files if k.startswith(path + "/") and "/" not in k[len(path) + 1:])
        if not names:
            return 404, b"{}"
        per, page = int(q.get("per_page", ["30"])[0]), int(q.get("page", ["1"])[0])
        return 200, json.dumps([{"type": "file", "path": n} for n in names[(page - 1) * per:page * per]]).encode()


def ago(**kw):
    return (datetime.datetime.now() - datetime.timedelta(**kw)).isoformat(timespec="seconds")


class Durability(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.httpd = server.http.server.ThreadingHTTPServer(("127.0.0.1", 0), server.H)
        cls.port = cls.httpd.server_address[1]
        threading.Thread(target=cls.httpd.serve_forever, daemon=True).start()

    @classmethod
    def tearDownClass(cls):
        cls.httpd.shutdown(); cls.httpd.server_close()

    def setUp(self):
        self.saved = (server.http_call, delivery.SYNC, dict(os.environ))
        self.gh = FakeGitHub(); server.http_call = self.gh
        delivery.SYNC = True
        os.environ.update({"POLAR_WEBHOOK_SECRET": "test-secret", "AIVIS_ALLOW_PAID": "1", "AIVIS_ORDER_CAP_USD": "6",
                           "ORDERS_REPO": REPO, "ORDERS_GITHUB_TOKEN": "tok-secret", **td.KEYS})
        os.environ.pop("ORDER_ALERT_WEBHOOK_URL", None); os.environ.pop("AIVIS_AUTORUN", None)
        fake_apis.CALLS.clear()
        fake_apis.POOLS["cur"] = [f"Plumber {i} LLC" for i in range(40)]
        fake_apis.TARGET["name"] = "DrainMaster"
        p = mock.patch("urllib.request.urlopen", lambda req, timeout=None, *a, **k: fake_apis.fake_urlopen(req, timeout))
        p.start(); self.addCleanup(p.stop)

    def tearDown(self):
        server.http_call, delivery.SYNC = self.saved[:2]
        os.environ.clear(); os.environ.update(self.saved[2])

    # helpers
    def store(self):
        return server.Store()

    def order(self, oid):
        return self.store().get(f"orders/{oid}.json")[0]

    def edit(self, oid, **kw):
        o = self.order(oid); o.update(kw); self.store().put(f"orders/{oid}.json", o, overwrite=True)

    def webhook(self, oid, mid=None, ref="pol_1"):
        body = json.dumps({"type": "order.paid", "data": {"product_id": td.BASE_PID, "billing_reason": "purchase",
                           "net_amount": 14900, "id": ref, "metadata": {"order_id": oid},
                           "customer": {"email": td.EMAIL}}}).encode()
        return server.handle_polar(td.sign(body, mid or "evt-" + oid), body)

    def paid(self, order=FULL):
        """A paid order (autorun is off or blocked here unless the test turned it on first)."""
        oid, token = server.new_order(dict(order), dict(order, consent=True))
        self.assertEqual(self.webhook(oid)[0], 200)
        return oid, token

    def get(self, path):
        c = http.client.HTTPConnection("127.0.0.1", self.port); c.request("GET", path)
        r = c.getresponse(); return r.status, r.read().decode()

    def sentences(self):
        return " ".join(m["text"] for m in self.gh.webhooks)

    def with_webhook(self):
        os.environ["ORDER_ALERT_WEBHOOK_URL"] = HOOK

    # 2. resume on boot
    def test_stale_running_order_is_requeued_once(self):
        self.with_webhook(); os.environ["AIVIS_AUTORUN"] = "1"
        oid, _ = self.paid()
        self.assertEqual(self.order(oid)["status"], "ready")
        fake_apis.CALLS.clear()
        self.edit(oid, status="running", status_at=ago(hours=1), attempts=1, spent_usd=0)
        self.assertEqual(delivery.resume_orders(self.store(), server.alert), [oid])
        o = self.order(oid)
        self.assertEqual((o["status"], o["attempts"]), ("ready", 2))
        calls = len(fake_apis.CALLS); self.assertGreater(calls, 0)
        self.assertEqual(delivery.resume_orders(self.store(), server.alert), [])     # nothing left to resume
        self.assertEqual(len(fake_apis.CALLS), calls)

    def test_attempt_limit_holds_across_restarts(self):
        self.with_webhook(); os.environ["AIVIS_AUTORUN"] = "1"
        oid, _ = self.paid()
        fake_apis.CALLS.clear()
        self.edit(oid, status="running", status_at=ago(hours=1), attempts=delivery.MAX_ATTEMPTS, spent_usd=0.5)
        delivery.resume_orders(self.store(), server.alert)
        self.assertEqual(self.order(oid)["status"], "failed")
        self.assertEqual(fake_apis.CALLS, [])
        self.assertIn("failed", self.sentences())
        self.assertTrue(any("failed run" in i["title"] for i in self.gh.issues))

    def test_spend_so_far_counts_against_the_cap(self):
        self.with_webhook(); os.environ["AIVIS_AUTORUN"] = "1"
        for spent in (6.0, 5.99):                     # cap is 6: nothing (or too little) is left for another run
            oid, _ = self.paid()
            fake_apis.CALLS.clear()
            self.edit(oid, status="running", status_at=ago(hours=1), attempts=1, spent_usd=spent)
            delivery.resume_orders(self.store(), server.alert)
            self.assertEqual(self.order(oid)["status"], "failed", spent)
            self.assertEqual(fake_apis.CALLS, [], spent)
            os.environ["ORDER_ALERT_WEBHOOK_URL"] = HOOK
            self.gh.files.clear()

    def test_boot_leaves_other_orders_alone(self):
        self.with_webhook()
        oid, _ = self.paid()                             # autorun off: queued
        unpaid, _ = server.new_order(dict(FULL, email="u@x.co"), dict(FULL, email="u@x.co", consent=True))
        manual = {"order_id": "MAN-0123456789ab", "order_type": "maps", "delivery": "manual_delivery", "paid": True,
                  "status": "manual_delivery", "status_at": ago(hours=5), "due_at": "2020-01-01"}
        held = dict(self.order(oid), order_id="ORD-261126-bbbbbb", status="held", status_at=ago(hours=5))
        fresh = dict(self.order(oid), order_id="ORD-261126-cccccc", status="running", status_at=ago(minutes=5), attempts=1)
        done = dict(self.order(oid), order_id="ORD-261126-dddddd", status="ready", status_at=ago(hours=5))
        for rec in (manual, held, fresh, done):
            self.store().put(f"orders/{rec['order_id']}.json", rec)
        self.edit(oid, status="done-by-hand")            # not queued / running either
        os.environ["AIVIS_AUTORUN"] = "1"
        before = {p: self.gh.files[p] for p in self.gh.files if p.startswith("orders/")}
        sent = len(self.gh.webhooks)
        self.assertEqual(delivery.resume_orders(self.store(), server.alert), [])
        self.assertEqual({p: self.gh.files[p] for p in self.gh.files if p.startswith("orders/")}, before)
        self.assertEqual((fake_apis.CALLS, len(self.gh.webhooks)), ([], sent))
        self.assertEqual(self.order(unpaid)["paid"], False)

    def test_paid_queued_order_is_resumed(self):
        self.with_webhook()
        oid, _ = self.paid()                             # autorun off: stays queued
        self.assertEqual(self.order(oid)["status"], "queued")
        os.environ["AIVIS_AUTORUN"] = "1"
        self.assertEqual(delivery.resume_orders(self.store(), server.alert), [oid])
        self.assertEqual(self.order(oid)["status"], "ready")

    def test_store_listing_pages_through_all_files(self):
        for i in range(230):
            self.gh.files[f"orders/ORD-{i:06d}.json"] = "{}"
        names = self.store().list_prefix("orders/")
        self.assertEqual(len(names), 230)
        self.assertEqual(len(set(names)), 230)
        self.assertEqual(self.store().list_prefix("nothing/"), [])
        os.environ.pop("ORDERS_GITHUB_TOKEN"); os.environ["ORDERS_LOCAL_DIR"] = server.LOCAL_ORDERS = tempfile.mkdtemp()
        s = self.store(); s.put("orders/a.json", {}); s.put("orders/b.json", {})
        self.assertEqual(s.list_prefix("orders/"), ["orders/a.json", "orders/b.json"])

    # 4. autorun prerequisites
    def test_autorun_refuses_each_missing_prerequisite(self):
        cases = {"AIVIS_ALLOW_PAID": lambda: os.environ.pop("AIVIS_ALLOW_PAID"),
                 "OPENAI_API_KEY": lambda: os.environ.pop("OPENAI_API_KEY"),
                 "GEMINI_API_KEY": lambda: os.environ.pop("GEMINI_API_KEY"),
                 "ANTHROPIC_API_KEY": lambda: os.environ.pop("ANTHROPIC_API_KEY"),
                 "AIVIS_ORDER_CAP_USD": lambda: os.environ.update(AIVIS_ORDER_CAP_USD="abc"),
                 "alert channel": lambda: os.environ.pop("ORDER_ALERT_WEBHOOK_URL")}
        for missing, breaker in cases.items():
            with self.subTest(missing):
                self.gh.files.clear(); self.gh.issues.clear(); self.gh.webhooks.clear(); fake_apis.CALLS.clear()
                os.environ.update(AIVIS_ALLOW_PAID="1", AIVIS_ORDER_CAP_USD="6", AIVIS_AUTORUN="1", ORDER_ALERT_WEBHOOK_URL=HOOK, **td.KEYS)
                if missing == "alert channel":
                    os.environ.pop("ORDERS_REPO")                    # a local store, no GitHub, no webhook
                else:
                    os.environ["ORDERS_REPO"] = REPO
                breaker()
                oid, token = self.paid()
                o = self.order(oid)
                self.assertEqual(o["status"], "queued")
                self.assertIn(missing, o["status_note"])
                self.assertEqual(fake_apis.CALLS, [])
                self.assertEqual(delivery.resume_orders(self.store(), server.alert), [oid])   # still blocked, still queued
                self.assertEqual((self.order(oid)["status"], fake_apis.CALLS), ("queued", []))
                h = json.loads(self.get("/health")[1])
                self.assertEqual(h["ok"], True); self.assertEqual(h["autorun"], "blocked")
                self.assertEqual(h["allow_paid"], missing != "AIVIS_ALLOW_PAID")
                self.assertEqual(h["alerts"], missing != "alert channel")
                self.assertEqual(h["orders_store"], "local" if missing == "alert channel" else "remote")
                self.assertTrue(all(isinstance(v, (bool, str)) for v in h.values()))
                text = json.dumps(h)
                for secret in (*td.KEYS.values(), "tok-secret", REPO, HOOK, oid):
                    self.assertNotIn(secret, text)
                self.assertEqual(bool(self.gh.webhooks), missing != "alert channel")
                os.environ["ORDERS_REPO"] = REPO if missing != "alert channel" else ""

    def test_health_states(self):
        h = json.loads(self.get("/health")[1])
        self.assertEqual((h["autorun"], h["allow_paid"], h["alerts"], h["orders_store"]), ("off", True, True, "remote"))
        os.environ["AIVIS_AUTORUN"] = "1"; self.with_webhook()
        self.assertEqual(json.loads(self.get("/health")[1])["autorun"], "on")

    # 3. sweep
    def test_sweep_alerts_once_per_six_hours(self):
        self.with_webhook()
        oid, _ = self.paid()
        self.edit(oid, paid_at=ago(hours=1))
        self.assertEqual(delivery.sweep_orders(self.store(), server.notify_event), [])      # not old enough
        self.edit(oid, paid_at=ago(hours=3))
        self.assertEqual(delivery.sweep_orders(self.store(), server.notify_event), [oid])
        stuck = [i for i in self.gh.issues if "stuck order" in i["title"]]
        self.assertEqual(len(stuck), 1)
        self.assertEqual(delivery.sweep_orders(self.store(), server.notify_event), [])      # same 6 h window
        self.assertEqual(len([i for i in self.gh.issues if "stuck order" in i["title"]]), 1)
        self.edit(oid, last_alert_at=ago(hours=7))
        self.assertEqual(delivery.sweep_orders(self.store(), server.notify_event), [oid])
        self.assertEqual(len([i for i in self.gh.issues if "stuck order" in i["title"]]), 2)
        self.assertEqual(self.order(oid)["alert_n"], 2)

    def test_sweep_alerts_for_failed_but_not_ready(self):
        oid, _ = self.paid()
        self.edit(oid, status="failed", paid_at=ago(minutes=10))
        self.assertEqual(delivery.sweep_orders(self.store(), server.notify_event), [oid])
        ready, _ = self.paid(dict(FULL, email="r@x.co"))
        self.edit(ready, status="ready", paid_at=ago(hours=9))
        self.assertEqual(delivery.sweep_orders(self.store(), server.notify_event), [])

    def test_sweep_overdue_manual_order_once_per_six_hours(self):
        m = {"order_id": "MAN-0123456789ab", "order_type": "maps", "delivery": "manual_delivery", "paid": True,
             "status": "manual_delivery", "status_at": ago(days=9), "paid_at": ago(days=9),
             "due_at": (datetime.date.today() - datetime.timedelta(days=2)).isoformat()}
        fut = dict(m, order_id="MAN-fedcba987654", due_at=(datetime.date.today() + datetime.timedelta(days=2)).isoformat())
        for rec in (m, fut):
            self.store().put(f"orders/{rec['order_id']}.json", rec)
        self.assertEqual(delivery.sweep_orders(self.store(), server.notify_event), ["MAN-0123456789ab"])
        self.assertEqual(delivery.sweep_orders(self.store(), server.notify_event), [])
        self.edit("MAN-0123456789ab", last_alert_at=ago(hours=7))
        self.assertEqual(delivery.sweep_orders(self.store(), server.notify_event), ["MAN-0123456789ab"])
        self.assertEqual(len([i for i in self.gh.issues if "overdue manual order" in i["title"]]), 2)

    # 5. alert channel
    def test_github_alert_has_ids_status_and_type_only(self):
        self.with_webhook(); os.environ["AIVIS_AUTORUN"] = "1"
        oid, token = self.paid()
        self.assertEqual(self.order(oid)["status"], "ready")
        self.assertEqual(len(self.gh.issues), 1)       # new order only; a ready order opens nothing else
        new = [i for i in self.gh.issues if i["title"].startswith("[AVC] new order ")]
        self.assertEqual(len(new), 1)
        i = new[0]
        self.assertEqual(i["url"], f"https://api.github.com/repos/{REPO}/issues")
        self.assertEqual(i["auth"], "Bearer tok-secret")
        self.assertEqual(i["title"], f"[AVC] new order {oid} (base)")
        self.assertEqual(i["labels"], ["avc-alert"])
        self.assertIn(f"Order: {oid}", i["body"]); self.assertIn("Product type: base", i["body"])
        self.assertRegex(i["body"], r"Status: \w")
        blob = json.dumps([{k: v for k, v in i.items() if k != "auth"} for i in self.gh.issues]) + json.dumps(self.gh.webhooks)
        for private in (td.EMAIL, "buyer.secret", "DrainMaster", "Columbus", "OH", WEBSITE, token, *td.KEYS.values(), "tok-secret"):
            self.assertNotIn(private, blob)
        self.assertNotIn("$", json.dumps(self.gh.issues))

    def test_alert_token_override_and_payment_without_order(self):
        os.environ["ALERT_GITHUB_TOKEN"] = "alert-tok"
        body = json.dumps({"type": "order.paid", "data": {"product_id": td.BASE_PID, "billing_reason": "purchase",
                           "net_amount": 14900, "id": "pol_unm", "customer": {"email": "ghost@x.co", "name": "Ghost"}}}).encode()
        self.assertEqual(server.handle_polar(td.sign(body, "evt-unm"), body)[1]["status"], "unmatched")
        [i] = self.gh.issues
        self.assertEqual(i["auth"], "Bearer alert-tok")
        self.assertEqual(i["title"], "[AVC] unmatched payment pol_unm (base)")
        self.assertIn("Reason: unmatched", i["body"])
        for private in ("ghost", "Ghost"):
            self.assertNotIn(private, json.dumps(self.gh.issues))

    def test_held_payment_is_alerted_with_reason_code(self):
        body = json.dumps({"type": "order.paid", "data": {"product_id": td.BASE_PID, "billing_reason": "purchase",
                           "net_amount": 100, "id": "pol_low", "customer": {"email": "a@x.co"}}}).encode()
        self.assertEqual(server.handle_polar(td.sign(body, "evt-low"), body)[1]["status"], "held")
        [i] = self.gh.issues
        self.assertEqual(i["title"], "[AVC] held payment pol_low (base)"); self.assertIn("Reason: held", i["body"])

    def test_alert_dedupes_on_replay_resume_and_sweep(self):
        oid, _ = self.paid()
        self.assertEqual(self.webhook(oid)[1], {"status": "duplicate"})          # replayed webhook
        server.notify_event("new", oid=oid, status="queued", ptype="base")       # same event again
        server.maintenance_tick(); server.maintenance_tick()
        self.assertEqual(len([i for i in self.gh.issues if "new order" in i["title"]]), 1)

    def test_failing_github_does_not_fail_the_webhook_and_is_retried(self):
        self.gh.fail_issues = True
        oid, _ = self.paid()
        self.assertEqual(self.order(oid)["paid"], True)
        self.assertEqual(self.gh.issues, [])
        self.gh.fail_issues = False
        server.maintenance_tick()                                  # the sweep retries what is pending
        self.assertEqual(len([i for i in self.gh.issues if "new order" in i["title"]]), 1)
        server.maintenance_tick()
        self.assertEqual(len([i for i in self.gh.issues if "new order" in i["title"]]), 1)

    def test_issue_without_label_when_labels_rejected(self):
        self.gh.reject_labels = True
        self.paid()
        self.assertTrue(self.gh.issues and all("labels" not in i for i in self.gh.issues))

    # 1. fast ack
    def event_body(self, oid):
        return json.dumps({"type": "order.paid", "data": {"product_id": td.BASE_PID, "billing_reason": "purchase", "net_amount": 14900,
                           "id": "pol_slow", "metadata": {"order_id": oid}, "customer": {"email": td.EMAIL}}}).encode()

    def test_webhook_acks_while_the_worker_is_slow(self):
        delivery.SYNC = False
        oid, _ = server.new_order(dict(FULL), dict(FULL, consent=True))
        gate, real = threading.Event(), server.process_paid
        def slow(store, d, eid):
            gate.wait(5); return real(store, d, eid)
        body = self.event_body(oid)
        with mock.patch.object(server, "process_paid", slow):
            t0 = time.time()
            code, res = server.handle_polar(td.sign(body, "evt-slow"), body)
            self.assertLess(time.time() - t0, 1.0)
            self.assertEqual((code, res["status"]), (200, "accepted"))
            self.assertEqual(self.order(oid)["paid"], False)                     # the work has not happened yet
            self.assertEqual(server.handle_polar(td.sign(body, "evt-slow"), body)[1], {"status": "duplicate"})
            gate.set(); server._EQ.join()
        self.assertEqual(self.order(oid)["paid"], True)
        self.assertEqual(self.store().get("events/evt-slow.json")[0]["status"], "done")

    def test_background_failure_marks_the_event_failed_alerts_and_can_be_retried(self):
        self.with_webhook()
        delivery.SYNC = False
        oid, _ = server.new_order(dict(FULL), dict(FULL, consent=True))
        body = self.event_body(oid)
        with mock.patch.object(server, "process_paid", side_effect=RuntimeError("boom")):
            code, res = server.handle_polar(td.sign(body, "evt-bad"), body)
            server._EQ.join()
        self.assertEqual((code, res["status"]), (200, "accepted"))
        self.assertEqual(self.store().get("events/evt-bad.json")[0]["status"], "failed")
        self.assertIn("failed in the background", self.sentences())
        self.assertTrue(any(i["title"].startswith("[AVC] webhook event failed") for i in self.gh.issues))
        self.assertEqual(self.order(oid)["paid"], False)
        delivery.SYNC = True
        server.retry_events(self.store())                                       # a retry picks it up
        self.assertEqual(self.order(oid)["paid"], True)
        self.assertEqual(self.store().get("events/evt-bad.json")[0]["status"], "done")

    def test_lost_claim_is_retried_after_the_ttl(self):
        oid, _ = server.new_order(dict(FULL), dict(FULL, consent=True))
        data = json.loads(self.event_body(oid))["data"]
        self.assertTrue(server.claim_event(self.store(), "evt-lost", "order.paid", data))       # worker died here
        server.retry_events(self.store())
        self.assertEqual(self.order(oid)["paid"], False)                          # claim still fresh
        rec = self.store().get("events/evt-lost.json")[0]; rec["claimed_at"] -= 3600
        self.store().put("events/evt-lost.json", rec, overwrite=True)
        server.retry_events(self.store())
        self.assertEqual(self.order(oid)["paid"], True)

    # 6. failed page
    def test_failed_page_has_support_email_and_refund_line_and_no_report_link(self):
        oid, token = self.paid()
        self.edit(oid, status="failed")
        st, page = self.get("/status/" + token)
        self.assertEqual(st, 200)
        self.assertIn("We are on it", page); self.assertIn(SUPPORT_EMAIL, page)
        self.assertIn("full refund", page); self.assertIn("refund policy", page)
        self.assertNotIn("/r/", page)
        self.assertEqual(self.get("/r/" + token)[0], 404)
        self.assertNotIn(oid, page)


if __name__ == "__main__":
    unittest.main()
