"""Automatic report build + private link. Fake vendor APIs from docs/requests/avc-mock-run, no network, no keys."""
import base64, hashlib, hmac, http.client, importlib.util, json, os, sys, tempfile, time, unittest, urllib.error
from types import SimpleNamespace
from unittest import mock

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "site"))
sys.path.insert(0, os.path.join(HERE, "..", "engine"))
os.environ.setdefault("ORDERS_LOCAL_DIR", tempfile.mkdtemp())
for k in ("ORDERS_REPO", "ORDERS_GITHUB_TOKEN"):
    os.environ.pop(k, None)
import server, delivery  # noqa: E402
from server_base import ServerCase  # noqa: E402
from aivis.reasons import build_findings  # noqa: E402
from aivis.niches import get_niche  # noqa: E402
from aivis.order import PAID_ENGINES  # noqa: E402

spec = importlib.util.spec_from_file_location("fake_apis", os.path.join(HERE, "..", "..", "docs", "requests", "avc-mock-run", "fake_apis.py"))
fake_apis = importlib.util.module_from_spec(spec); spec.loader.exec_module(fake_apis)

BASE_PID = "5a9d5f7a-72a6-4ea4-8ae7-e9d4ac498fde"   # base product (site/products.py)
EMAIL = "buyer.secret@example.com"
KEYS = {"OPENAI_API_KEY": "k1", "PERPLEXITY_API_KEY": "k2", "GEMINI_API_KEY": "k3", "ANTHROPIC_API_KEY": "k4"}
ORDER = {"business": "DrainMaster", "city": "Columbus, OH", "niche": "plumber", "email": EMAIL, "website": ""}


def sign(body, mid):
    ts = str(int(time.time()))
    mac = hmac.new(b"test-secret", f"{mid}.{ts}.".encode() + body, hashlib.sha256).digest()
    return {"webhook-id": mid, "webhook-timestamp": ts, "webhook-signature": "v1," + base64.b64encode(mac).decode()}


class DeliveryTests(ServerCase):
    @classmethod
    def tearDownClass(cls):
        super().tearDownClass()

    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.saved = (server.LOCAL_ORDERS, server.http_call, delivery.SYNC, dict(os.environ))
        server.LOCAL_ORDERS = self.tmp
        self.sent = []
        def fake_http(req, timeout=15):
            self.sent.append(json.loads(req.data)); return 200, b"ok"
        server.http_call = fake_http
        delivery.SYNC = True
        os.environ.update({"POLAR_WEBHOOK_SECRET": "test-secret", "ORDER_ALERT_WEBHOOK_URL": "http://alert.invalid/x",
                           "AIVIS_ALLOW_PAID": "1", "AIVIS_ORDER_CAP_USD": "6", **KEYS})
        os.environ.pop("AIVIS_AUTORUN", None)
        fake_apis.CALLS.clear()
        fake_apis.POOLS["cur"] = [f"Plumber {i} LLC" for i in range(40)]
        fake_apis.TARGET["name"] = "DrainMaster"
        self.fail_vendors = set()
        def urlopen(req, timeout=None, *a, **kw):
            host = req.full_url.split("/")[2]
            if host in self.fail_vendors:
                raise urllib.error.HTTPError(req.full_url, 401, "no", {}, None)
            return fake_apis.fake_urlopen(req, timeout)
        p = mock.patch("urllib.request.urlopen", urlopen); p.start(); self.addCleanup(p.stop)

    def tearDown(self):
        server.LOCAL_ORDERS, server.http_call, delivery.SYNC = self.saved[:3]
        os.environ.clear(); os.environ.update(self.saved[3])

    def paid_order(self):
        oid, token = server.new_order(dict(ORDER), dict(ORDER, consent=True))
        body = json.dumps({"type": "order.paid", "data": {"product_id": BASE_PID, "billing_reason": "purchase", "net_amount": 14900, "id": "pol_1", "metadata": {"order_id": oid},
                                                         "customer": {"email": EMAIL}}}).encode()
        code, res = server.handle_polar(sign(body, "evt-" + oid), body)
        self.assertEqual((code, res["status"]), (200, "paid"))
        return oid, token

    def order(self, oid):
        return server.Store().get(f"orders/{oid}.json")[0]

    def get(self, path):
        c = http.client.HTTPConnection("127.0.0.1", self.port); c.request("GET", path)
        r = c.getresponse(); return r.status, r.read().decode(), dict(r.getheaders())

    def test_autorun_off_only_queues(self):
        oid, token = self.paid_order()
        self.assertEqual(self.order(oid)["status"], "queued")
        self.assertEqual(fake_apis.CALLS, [])
        self.assertTrue(any("AIVIS_AUTORUN" in m["text"] for m in self.sent))
        st, body, _ = self.get("/status/" + token)
        self.assertIn("being prepared", body); self.assertNotIn("/r/", body)
        self.assertEqual(self.get("/r/" + token)[0], 404)

    def test_autorun_success_publishes_and_serves(self):
        os.environ["AIVIS_AUTORUN"] = "1"
        oid, token = self.paid_order()
        o = self.order(oid)
        self.assertEqual(o["status"], "ready")
        from aivis.order import TIERS
        n, r = TIERS["check"]
        self.assertEqual(len(fake_apis.CALLS), n * r * len(o["engines"] if o.get("engines") else PAID_ENGINES))
        for f in ("report.html", "answers.json", "order-log.json"):
            self.assertTrue(os.path.isfile(os.path.join(self.tmp, "reports", oid, f)))
        st, body, h = self.get("/r/" + token)
        self.assertEqual(st, 200); self.assertIn("DrainMaster", body)
        self.assertIn("noindex", h["X-Robots-Tag"])
        st, page, _ = self.get("/status/" + token)
        self.assertIn('href="/r/' + token + '"', page)
        self.assertNotIn(oid, page); self.assertNotIn(EMAIL, body)
        self.assertEqual([m["text"].split(":")[1].split()[0].strip(",") for m in self.sent if "Order" in m["text"] and ":" in m["text"]][-3:],
                         ["queued", "running", "ready"])

    def test_engine_failure_leaves_no_report(self):
        os.environ["AIVIS_AUTORUN"] = "1"
        os.environ["AIVIS_ORDER_CAP_USD"] = "12"       # room for the one retry
        self.fail_vendors = {"api.openai.com"}
        oid, token = self.paid_order()
        o = self.order(oid)
        self.assertEqual(o["status"], "failed"); self.assertEqual(o["attempts"], 2)   # retried once, no more
        self.assertFalse(os.path.exists(os.path.join(self.tmp, "reports")))
        self.assertEqual(self.get("/r/" + token)[0], 404)
        self.assertIn("failed", " ".join(m["text"] for m in self.sent))

    def test_cap_hit_fails_job(self):
        os.environ["AIVIS_AUTORUN"] = "1"; os.environ["AIVIS_ORDER_CAP_USD"] = "1"
        oid, token = self.paid_order()
        self.assertEqual(self.order(oid)["status"], "failed")
        self.assertEqual(fake_apis.CALLS, []); self.assertEqual(self.order(oid)["attempts"], 1)
        self.assertFalse(os.path.exists(os.path.join(self.tmp, "reports")))

    def test_missing_cap_uses_default_12(self):
        from aivis.jobs import order_cap_usd
        os.environ.pop("AIVIS_ORDER_CAP_USD", None)
        self.assertEqual(order_cap_usd(), 12.0)

    def test_invalid_cap_fails_job(self):
        os.environ["AIVIS_AUTORUN"] = "1"; os.environ["AIVIS_ORDER_CAP_USD"] = "0"
        oid, _ = self.paid_order()
        o = self.order(oid)         # a missing or invalid setting keeps the order queued; nothing is called
        self.assertEqual(o["status"], "queued"); self.assertEqual(fake_apis.CALLS, [])
        self.assertIn("AIVIS_ORDER_CAP_USD", o["status_note"])

    def test_unpaid_order_never_runs(self):
        from aivis.jobs import JobFailed, build_report
        oid, _ = server.new_order(dict(ORDER), dict(ORDER, consent=True))
        with self.assertRaises(JobFailed):
            build_report(self.order(oid), 6.0)
        self.assertEqual(fake_apis.CALLS, [])

    def test_unpaid_order_enqueued_fails_with_alert_and_no_calls(self):
        os.environ["AIVIS_AUTORUN"] = "1"; os.environ["AIVIS_ORDER_CAP_USD"] = "12"
        oid, _ = server.new_order(dict(ORDER), dict(ORDER, consent=True))
        delivery.run_job(server.Store(), oid, server.alert)
        self.assertEqual(self.order(oid)["status"], "failed")
        self.assertEqual(fake_apis.CALLS, [])
        self.assertFalse(os.path.exists(os.path.join(self.tmp, "reports")))
        self.assertIn("not paid", " ".join(m["text"] for m in self.sent))

    def test_run_order_itself_refuses_unpaid(self):
        from aivis.order import Order, OrderError, run_order
        oid, _ = server.new_order(dict(ORDER), dict(ORDER, consent=True))
        o = Order.from_dict(self.order(oid))
        os.environ["AIVIS_ALLOW_PAID"] = "1"
        with self.assertRaises(OrderError):
            run_order(o, mode="paid", cap_usd=12.0, out_dir=self.tmp)
        self.assertEqual(fake_apis.CALLS, [])

    def test_bad_tokens_404_without_detail(self):
        os.environ["AIVIS_AUTORUN"] = "1"
        oid, token = self.paid_order()
        for bad in ("x", "A" * 43, token[:-1] + ("A" if token[-1] != "A" else "B"), oid, "..%2f..", token + "x"):
            st, body, _ = self.get("/r/" + bad)
            self.assertEqual(st, 404); self.assertEqual(json.loads(body), {"error": "not found"})
            self.assertEqual(self.get("/status/" + bad)[0], 404)

    def test_token_strength(self):
        toks = {delivery.new_token() for _ in range(200)}
        self.assertEqual(len(toks), 200)
        for t in toks:
            self.assertGreaterEqual(len(t) * 6, 128 + 80)       # url-safe base64: 6 bits per char
            self.assertRegex(t, r"[A-Za-z0-9_-]+")

    def test_alerts_have_no_email_or_keys(self):
        os.environ["AIVIS_AUTORUN"] = "1"
        self.paid_order()
        text = json.dumps(self.sent)
        self.assertGreater(len(self.sent), 3)
        for secret in (EMAIL, "buyer.secret", *KEYS.values()):
            self.assertNotIn(secret, text)

    def test_fix_list_has_no_generic_items_without_evidence(self):
        niche = get_niche("plumber")
        strong = SimpleNamespace(score=60, competitors=[("Other LLC", 10, 0.2)])
        titles = " ".join(f.reason for f in build_findings(strong, niche))
        self.assertNotIn("cite trade sites", titles); self.assertNotIn("independent mentions", titles)
        weak = SimpleNamespace(score=5, competitors=[("Other LLC", 10, 0.2)])
        self.assertIn("independent mentions", " ".join(f.reason for f in build_findings(weak, niche)))

    def test_reviews_reach_the_fix_list(self):
        niche = get_niche("plumber")
        sc = SimpleNamespace(score=60, competitors=[])
        fs = build_findings(sc, niche, None, 10, [50, 80, 120])
        self.assertTrue(any("reviews" in f.reason for f in fs))


if __name__ == "__main__":
    unittest.main()
