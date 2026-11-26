import base64, hashlib, hmac, http.client, json, os, sys, tempfile, threading, time, unittest, urllib.parse
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "site"))
TMP = tempfile.mkdtemp()
os.environ["ORDERS_LOCAL_DIR"] = os.path.join(TMP, "orders")
for k in ("ORDERS_REPO", "ORDERS_GITHUB_TOKEN", "ORDER_ALERT_WEBHOOK_URL"):
    os.environ.pop(k, None)
os.environ["POLAR_WEBHOOK_SECRET"] = "test-secret"
import server  # noqa: E402
import delivery  # noqa: E402
server.LOCAL_ORDERS = os.environ["ORDERS_LOCAL_DIR"]

CALLS = []
def fake_http(req, timeout=15):
    CALLS.append(req)
    raise AssertionError("unexpected network call: " + req.full_url)
server.http_call = fake_http

BASE_PID = "5a9d5f7a-72a6-4ea4-8ae7-e9d4ac498fde"   # base product (site/products.py)
ORDER = {"business": "Acme Dental", "city": "Austin, TX", "niche": "dentist", "email": "A@b.co"}

def sign(body, mid="evt1", ts=None, secret="test-secret"):
    ts = str(int(ts or time.time()))
    mac = hmac.new(secret.encode(), f"{mid}.{ts}.".encode() + body, hashlib.sha256).digest()
    return {"webhook-id": mid, "webhook-timestamp": ts, "webhook-signature": "v1," + base64.b64encode(mac).decode()}


class VerifyPolarKeyTests(unittest.TestCase):
    """Signatures built independently of server.verify_polar's key derivation."""
    RAW = b"\x01\x02standard-webhooks-raw-key\xfe\xff"
    SECRET = "whsec_" + base64.b64encode(RAW).decode()
    BODY = b'{"type":"order.paid","data":{}}'

    def hdrs(self, key, ts=None, body=None):
        ts = str(int(ts or time.time()))
        mac = hmac.new(key, b"msg1." + ts.encode() + b"." + (body or self.BODY), hashlib.sha256).digest()
        return {"webhook-id": "msg1", "webhook-timestamp": ts, "webhook-signature": "v1," + base64.b64encode(mac).decode()}

    def test_standard_base64_key_verifies(self):
        self.assertTrue(server.verify_polar(self.SECRET, self.hdrs(self.RAW), self.BODY))

    def test_legacy_utf8_key_verifies(self):
        self.assertTrue(server.verify_polar(self.SECRET, self.hdrs(self.SECRET.encode("utf-8")), self.BODY))

    def test_signature_list_with_other_versions(self):
        h = self.hdrs(self.RAW)
        h["webhook-signature"] = "v1,AAAA v2,zzzz " + h["webhook-signature"]
        self.assertTrue(server.verify_polar(self.SECRET, h, self.BODY))

    def test_wrong_secret_rejected(self):
        self.assertFalse(server.verify_polar(self.SECRET, self.hdrs(b"some-other-key"), self.BODY))
        other = "whsec_" + base64.b64encode(b"different").decode()
        self.assertFalse(server.verify_polar(other, self.hdrs(self.RAW), self.BODY))

    def test_old_timestamp_rejected(self):
        self.assertFalse(server.verify_polar(self.SECRET, self.hdrs(self.RAW, ts=time.time() - 3600), self.BODY))

    def test_tampered_body_rejected(self):
        self.assertFalse(server.verify_polar(self.SECRET, self.hdrs(self.RAW), self.BODY + b" "))

    def test_invalid_base64_secret_falls_back_without_error(self):
        s = "whsec_not*base64!"
        self.assertTrue(server.verify_polar(s, self.hdrs(s.encode()), self.BODY))
        self.assertFalse(server.verify_polar(s, self.hdrs(b"x"), self.BODY))


class Base(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.srv = server.http.server.ThreadingHTTPServer(("127.0.0.1", 0), server.H)
        cls.port = cls.srv.server_address[1]
        threading.Thread(target=cls.srv.serve_forever, daemon=True).start()
    @classmethod
    def tearDownClass(cls):
        cls.srv.shutdown()
    def req(self, method, path, body=None, headers=None):
        c = http.client.HTTPConnection("127.0.0.1", self.port)
        c.request(method, path, body=body, headers=headers or {})
        r = c.getresponse(); data = r.read(); c.close()
        return r.status, data
    def post(self, path, obj, headers=None):
        b = obj if isinstance(obj, bytes) else json.dumps(obj).encode()
        return self.req("POST", path, b, {"Content-Type": "application/json", **(headers or {})})


class StaticTests(Base):
    def test_public_pages_ok(self):
        for p in ["/", "/index.html", "/thanks.html", "/terms.html", "/privacy.html", "/refunds.html",
                  "/agency.html", "/sample-report.html", "/sample-report.pdf", "/assets/app.js",
                  "/assets/style.css", "/assets/config.js", "/INDEX.HTML", "/index.html?x=1"]:
            self.assertEqual(self.req("GET", p)[0], 200, p)

    def test_server_side_paths_404(self):
        base = ["/server.py", "/data/", "/data", "/data/markets/", "/data/requests.jsonl", "/data/orders/x.json",
                "/data/free-checks/", "/build_market_cache.py", "/assets/", "/assets", "/assets/", "/.git/config",
                "/../engine/aivis/order.py", "/../private-orders/orders/x.json", "/__pycache__/server.cpython-311.pyc",
                "/assets/.hidden", "/assets/app.py", "/assets/sub/app.js"]
        for m in os.listdir(os.path.join(server.DATA, "markets")):
            base.append("/data/markets/" + m)
        disguised = []
        for p in base:
            disguised += [p, p.upper(), p.replace("/", "%2f"), urllib.parse.quote(p, safe=""),
                          urllib.parse.quote(urllib.parse.quote(p, safe=""), safe=""),
                          p.replace("/", "\\"), p.replace("/", "/./"), "/assets/.." + p, "/x/..%2f" + p.lstrip("/"),
                          "//" + p.lstrip("/"), p + "%00", p + "?a=1", p + "#f", "/%2564ata/requests.jsonl"]
        for p in disguised:
            st, body = self.req("GET", p)
            if p.startswith("/assets/..") and p.endswith("/"):
                pass
            self.assertEqual(st, 404, p)
            self.assertNotIn(b"<title>Index of", body)
        self.assertEqual(self.req("GET", "/%2564ata/requests.jsonl")[0], 404)
        self.assertEqual(self.req("HEAD", "/data/requests.jsonl")[0], 404)

    def test_dot_variant_of_public_data_not_served(self):
        self.assertEqual(self.req("GET", "/assets/%252e%252e/data/requests.jsonl")[0], 404)
        self.assertEqual(self.req("GET", "/assets/..%5cserver.py")[0], 404)


class StoreTests(unittest.TestCase):
    def test_local_fallback_not_served(self):
        for k in ("ORDERS_REPO", "ORDERS_GITHUB_TOKEN"):
            os.environ.pop(k, None)
        s = server.Store(); self.assertFalse(s.remote)
        self.assertTrue(s.put("orders/t1.json", {"a": 1}))
        self.assertFalse(s.put("orders/t1.json", {"a": 2}))
        self.assertEqual(s.get("orders/t1.json")[0], {"a": 1})
        self.assertTrue(s.put("orders/t1.json", {"a": 3}, overwrite=True))
        self.assertEqual(s.get("orders/t1.json")[0], {"a": 3})
        self.assertIsNone(s.get("orders/none.json")[0])
        self.assertFalse(os.path.realpath(server.LOCAL_ORDERS).startswith(os.path.realpath(server.HERE)))
        self.assertEqual(CALLS, [])

    def test_github_contents_api(self):
        os.environ["ORDERS_REPO"] = "me/private-orders"; os.environ["ORDERS_GITHUB_TOKEN"] = "TOKEN123"
        files, seen = {}, []
        def gh(req, timeout=15):
            seen.append(req)
            path = req.full_url.split("/contents/", 1)[1]
            self.assertEqual(req.headers["Authorization"], "Bearer TOKEN123")
            if req.get_method() == "PUT":
                d = json.loads(req.data)
                if path in files and d.get("sha") != files[path][1]:
                    return 422, b"{}"
                files[path] = (d["content"], "sha-" + str(len(seen)))
                return 201, b"{}"
            if path not in files:
                return 404, b"{}"
            return 200, json.dumps({"content": files[path][0], "sha": files[path][1]}).encode()
        old = server.http_call; server.http_call = gh
        try:
            s = server.Store(); self.assertTrue(s.remote)
            self.assertTrue(s.put("orders/o1.json", {"x": 1}))
            self.assertFalse(s.put("orders/o1.json", {"x": 2}))
            self.assertEqual(s.get("orders/o1.json")[0], {"x": 1})
            self.assertTrue(s.put("orders/o1.json", {"x": 3}, overwrite=True))
            self.assertEqual(s.get("orders/o1.json")[0], {"x": 3})
            self.assertIsNone(s.get("orders/zzz.json")[0])
            self.assertTrue(all(r.full_url.startswith("https://api.github.com/repos/me/private-orders/contents/") for r in seen))
        finally:
            server.http_call = old
            os.environ.pop("ORDERS_REPO"); os.environ.pop("ORDERS_GITHUB_TOKEN")

    def test_token_and_contents_not_logged(self):
        import io, contextlib
        os.environ["ORDERS_REPO"] = "me/r"; os.environ["ORDERS_GITHUB_TOKEN"] = "SECRETTOKEN"
        old = server.http_call; server.http_call = lambda r, timeout=15: (500, b"SECRETTOKEN Acme")
        buf = io.StringIO()
        try:
            with contextlib.redirect_stderr(buf):
                with self.assertRaises(RuntimeError) as cm:
                    server.Store().put("orders/o.json", {"business": "Acme"})
            self.assertNotIn("SECRETTOKEN", str(cm.exception) + buf.getvalue())
        finally:
            server.http_call = old
            os.environ.pop("ORDERS_REPO"); os.environ.pop("ORDERS_GITHUB_TOKEN")


class OrderAndPolarTests(Base):
    def setUp(self):
        self._sync = delivery.SYNC; delivery.SYNC = True      # the webhook worker runs inline
        self.sent = []
        def hook(req, timeout=15):
            self.sent.append(json.loads(req.data)); return 200, b"ok"
        server.http_call = hook
        os.environ["ORDER_ALERT_WEBHOOK_URL"] = "https://alerts.example/hook"
    def tearDown(self):
        delivery.SYNC = self._sync
        server.http_call = fake_http
        os.environ.pop("ORDER_ALERT_WEBHOOK_URL", None)

    def order(self, email="A@b.co"):
        st, b = self.post("/api/intake", {**ORDER, "email": email})
        self.assertEqual(st, 200)
        return json.loads(b)["order_id"]

    def stored(self, oid):
        return server.Store().get(f"orders/{oid}.json")[0]

    def test_new_order_alerts_and_stores(self):
        oid = self.order()
        self.assertEqual(len(self.sent), 1); self.assertIn(oid, self.sent[0]["text"])
        self.assertNotIn("Acme", json.dumps(self.sent))
        self.assertFalse(self.stored(oid)["paid"])
        self.assertFalse(os.path.exists(os.path.join(server.DATA, "orders", oid + ".json")))

    def test_alert_noop_without_target(self):
        os.environ.pop("ORDER_ALERT_WEBHOOK_URL")
        self.order()
        self.assertEqual(self.sent, [])

    def hook(self, body, **kw):
        return self.post("/api/polar/webhook", body, sign(body, **kw))

    def test_bad_signature_rejected(self):
        body = json.dumps({"type": "order.paid", "data": {}}).encode()
        self.assertEqual(self.post("/api/polar/webhook", body)[0], 401)
        self.assertEqual(self.post("/api/polar/webhook", body, sign(body, secret="wrong"))[0], 401)
        self.assertEqual(self.post("/api/polar/webhook", body, sign(body, ts=time.time() - 3600))[0], 401)
        h = sign(body); self.assertEqual(self.post("/api/polar/webhook", body + b" ", h)[0], 401)
        os.environ.pop("POLAR_WEBHOOK_SECRET")
        try:
            self.assertEqual(self.post("/api/polar/webhook", body, sign(body))[0], 401)
        finally:
            os.environ["POLAR_WEBHOOK_SECRET"] = "test-secret"

    def test_paid_by_email_then_duplicate_ignored(self):
        oid = self.order("buyer@x.co"); self.sent.clear()
        body = json.dumps({"type": "order.paid", "data": {"product_id": BASE_PID, "billing_reason": "purchase", "net_amount": 14900, "id": "pol_1", "customer": {"email": "Buyer@X.co"}}}).encode()
        st, b = self.hook(body, mid="evt-paid-1")
        self.assertEqual((st, json.loads(b)["status"]), (200, "paid"))
        o = self.stored(oid); self.assertTrue(o["paid"]); self.assertEqual(o["paid_ref"], "pol_1")
        self.assertEqual(len(self.sent), 1); self.assertIn("PAID", self.sent[0]["text"])
        st, b = self.hook(body, mid="evt-paid-1")
        self.assertEqual(json.loads(b)["status"], "duplicate"); self.assertEqual(len(self.sent), 1)

    def test_paid_by_metadata_order_id(self):
        oid = self.order("m@x.co")
        body = json.dumps({"type": "order.paid", "data": {"product_id": BASE_PID, "billing_reason": "purchase", "net_amount": 14900, "id": "pol_2", "metadata": {"order_id": oid}}}).encode()
        self.assertEqual(json.loads(self.hook(body, mid="evt-meta")[1])["order_id"], oid)
        self.assertTrue(self.stored(oid)["paid"])

    def test_payment_before_intake(self):
        body = json.dumps({"type": "order.paid", "data": {"product_id": BASE_PID, "billing_reason": "purchase", "net_amount": 14900, "id": "pol_3", "customer": {"email": "early@x.co"}}}).encode()
        self.assertEqual(json.loads(self.hook(body, mid="evt-early")[1])["status"], "unmatched")
        oid = self.order("early@x.co")
        self.assertTrue(self.stored(oid)["paid"])

    def test_other_events_ignored(self):
        body = json.dumps({"type": "checkout.created", "data": {}}).encode()
        self.assertEqual(json.loads(self.hook(body, mid="evt-other")[1])["status"], "ignored")
        self.assertEqual(self.sent, [])

    def test_us_only_city_at_intake(self):
        for city in ("London, UK", "Austin", "Austin, ZZ", "Toronto, ON"):
            st, b = self.post("/api/intake", {**ORDER, "city": city})
            self.assertEqual(st, 400, city)
            self.assertIn("US businesses only", json.loads(b)["error"])
        for city in ("Washington, DC", "Austin, tx", "Honolulu, HI"):
            self.assertEqual(self.post("/api/intake", {**ORDER, "city": city})[0], 200, city)

    def test_every_state_code_and_dc_accepted(self):
        from aivis.order import US_STATES
        self.assertEqual(len(US_STATES), 51); self.assertIn("DC", US_STATES)
        from aivis import uscities
        places = uscities._load()
        for code in sorted(US_STATES):
            name = sorted(places[code])[0]              # any real place in that state
            self.assertEqual(server.clean({**ORDER, "city": f"{name}, {code}"})["city"], f"{name.title()}, {code}")

    def test_city_must_be_a_real_place_in_that_state(self):
        for city in ("Tel Aviv, IL", "Tel Aviv, TX", "Lagos, NY", "Austin, OH"):
            st, b = self.post("/api/intake", {**ORDER, "city": city})
            self.assertEqual(st, 400, city)
            self.assertIn("US businesses only", json.loads(b)["error"])
        for city in ("Columbus, OH", "Austin, TX", "St. Louis, MO", "Saint Louis, MO", "Washington, DC",
                     "ft. worth, tx", "Fort  Worth, TX"):
            self.assertEqual(self.post("/api/intake", {**ORDER, "city": city})[0], 200, city)

    def test_html_pattern_matches_whitelist(self):
        import re as _re
        from aivis.order import US_STATES
        for page in ("index.html", "thanks.html"):
            t = open(os.path.join(server.HERE, page), encoding="utf-8").read()
            pat = _re.search(r'name="city"[^>]*pattern="([^"]+)"', t).group(1)
            self.assertEqual(set(_re.search(r"\(([A-Z|]+)\)", pat).group(1).split("|")), set(US_STATES), page)
            self.assertIn("maxlength", t)
            self.assertIn("US businesses only", t)   # visible on the form; 'Tel Aviv, IL' reads as Illinois, US

    def test_website_normalised_at_intake(self):
        oid = self.order_with(website="drainmasterohio.com")
        self.assertEqual(self.stored(oid)["website"], "https://drainmasterohio.com")
        oid = self.order_with(website="http://x.example/a")
        self.assertEqual(self.stored(oid)["website"], "http://x.example/a")
        self.assertEqual(self.stored(self.order_with(website=""))["website"], "")

    def test_invalid_website_rejected(self):
        for w in ("not a url", "ftp://x.com", "localhost", "http://", "a b.com"):
            st, b = self.post("/api/intake", {**ORDER, "website": w})
            self.assertEqual(st, 400, w); self.assertIn("website", json.loads(b)["error"])

    def order_with(self, **kw):
        st, b = self.post("/api/intake", {**ORDER, **kw})
        self.assertEqual(st, 200, b)
        return json.loads(b)["order_id"]

    def test_metadata_match_beats_email(self):
        a = self.order("a@x.co"); b = self.order("b@x.co")
        body = json.dumps({"type": "order.paid", "data": {"product_id": BASE_PID, "billing_reason": "purchase", "net_amount": 14900, "id": "pol_m", "metadata": {"order_id": b},
                                                         "customer": {"email": "a@x.co"}}}).encode()
        self.assertEqual(json.loads(self.hook(body, mid="evt-mb")[1])["order_id"], b)
        self.assertTrue(self.stored(b)["paid"]); self.assertFalse(self.stored(a)["paid"])

    def test_email_match_case_insensitive_and_trimmed(self):
        oid = self.order("  Mixed@Case.CO ")
        body = json.dumps({"type": "order.paid", "data": {"product_id": BASE_PID, "billing_reason": "purchase", "net_amount": 14900, "id": "pol_c", "customer": {"email": " MIXED@case.co  "}}}).encode()
        self.assertEqual(json.loads(self.hook(body, mid="evt-ci")[1])["order_id"], oid)
        self.assertTrue(self.stored(oid)["paid"])

    def test_bad_metadata_falls_back_to_email(self):
        oid = self.order("fb@x.co")
        body = json.dumps({"type": "order.paid", "data": {"product_id": BASE_PID, "billing_reason": "purchase", "net_amount": 14900, "id": "pol_f", "metadata": {"order_id": "ORD-000000-aaaaaa"},
                                                         "customer": {"email": "fb@x.co"}}}).encode()
        self.assertEqual(json.loads(self.hook(body, mid="evt-fb")[1])["order_id"], oid)

    def test_unmatched_payment_alerts_without_email(self):
        self.sent.clear()
        body = json.dumps({"type": "order.paid", "data": {"product_id": BASE_PID, "billing_reason": "purchase", "net_amount": 14900, "id": "pol_unm", "customer": {"email": "ghost@x.co", "name": "Ghost"},
                                                         "description": "secret body"}}).encode()
        self.assertEqual(json.loads(self.hook(body, mid="evt-unm")[1])["status"], "unmatched")
        self.assertEqual(len(self.sent), 1)
        txt = json.dumps(self.sent)
        self.assertIn("pol_unm", txt); self.assertIn("UNMATCHED", txt)
        for leak in ("ghost", "Ghost", "secret body"):
            self.assertNotIn(leak, txt)

    def test_pages_say_polar_not_paypal(self):
        for p in ("thanks.html", "terms.html", "privacy.html", "index.html"):
            t = open(os.path.join(server.HERE, p), encoding="utf-8").read().lower()
            self.assertNotIn("paypal", t, p)
        for p in ("thanks.html", "terms.html", "privacy.html"):
            self.assertIn("polar", open(os.path.join(server.HERE, p), encoding="utf-8").read().lower(), p)


if __name__ == "__main__":
    unittest.main()
