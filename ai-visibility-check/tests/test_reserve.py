"""The /reserve page and /api/reserve, /api/reservations: free reservations, no payment code. No network."""
import http.client, json, os, re, sys, unittest, urllib.parse
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import test_server as ts          # sets env, fake network, imports server  # noqa: E402
import server, agency             # noqa: E402
from server_base import ServerCase  # noqa: E402
from site_config import SUPPORT_EMAIL  # noqa: E402

PAGE = os.path.join(HERE, "..", "site", "reserve.html")
GOOD = {"agency": "  North Star Marketing ", "email": "Lead@Example.COM", "clients": 12, "note": "hello"}
TOKEN = "t" * 32
BANNED = ["resell", "credits", "wallet", "balance", "marketplace", "lead generation"]


def stored():
    d = os.path.join(server.LOCAL_ORDERS, "reservations")
    return sorted(os.listdir(d)) if os.path.isdir(d) else []


class ReserveCase(ServerCase):
    def setUp(self):
        agency.reset_limits()
        d = os.path.join(server.LOCAL_ORDERS, "reservations")
        for n in stored():
            os.remove(os.path.join(d, n))
        os.environ.pop("RESERVE_ADMIN_TOKEN", None)
        ts.CALLS.clear()

    def req(self, method, path, body=None, headers=None, raw=None):
        c = http.client.HTTPConnection("127.0.0.1", self.port, timeout=10)
        h = dict(headers or {})
        data = raw
        if data is None and body is not None:
            data = json.dumps(body).encode()
            h.setdefault("Content-Type", "application/json")
        c.request(method, path, body=data, headers=h)
        r = c.getresponse()
        b = r.read()
        out = (r.status, b, dict(r.getheaders()))
        c.close()
        return out

    def post(self, body, **kw):
        st, b, h = self.req("POST", "/api/reserve", body, **kw)
        return st, json.loads(b)

    def admin(self, method, path, token=TOKEN):
        st, b, h = self.req(method, path, headers={"Authorization": "Bearer " + token} if token else {})
        return st, json.loads(b), h


class PageTests(ReserveCase):
    def test_pages_served(self):
        for p in ("/reserve", "/reserve.html"):
            st, b, _ = self.req("GET", p)
            text = b.decode()
            self.assertEqual(st, 200, p)
            self.assertIn("Founding price: $29 per client per month, kept for life if you reserve now (regular price $49).", text)
            self.assertNotIn("planned price", text)
            self.assertIn("no payment", text)
            self.assertIn("We never contact your clients. To have it deleted, email", text)
            self.assertIn(SUPPORT_EMAIL, text)
            self.assertIn('href="privacy.html"', text)
            self.assertNotIn("{{", text)

    def test_in_sitemap(self):
        self.assertTrue(any(u.endswith("/reserve") for u in re.findall(r"<loc>(.*?)</loc>", self.req("GET", "/sitemap.xml")[1].decode())))


class ValidationTests(ReserveCase):
    def test_bad_input(self):
        cases = [({**GOOD, "agency": ""}, "agency"), ({**GOOD, "agency": " a "}, "agency"), ({**GOOD, "agency": "x" * 121}, "agency"),
                 ({k: v for k, v in GOOD.items() if k != "agency"}, "agency"),
                 ({**GOOD, "email": "nope"}, "email"), ({**GOOD, "email": "a@b"}, "email"), ({**GOOD, "email": "a" * 250 + "@b.co"}, "email"),
                 ({**GOOD, "clients": 0}, "clients"), ({**GOOD, "clients": 1001}, "clients"), ({**GOOD, "clients": "abc"}, "clients"),
                 ({**GOOD, "clients": True}, "clients"), ({**GOOD, "note": "n" * 1001}, "note")]
        for body, field in cases:
            if field == "note":
                body = {**body}          # 1001 chars still fits MAX_BODY
            st, j = self.post(body)
            self.assertEqual(st, 400, body)
            self.assertFalse(j["ok"])
            self.assertIn(field, j["errors"])
        self.assertEqual(stored(), [])

    def test_oversize_rejected(self):
        st, _, _ = self.req("POST", "/api/reserve", {**GOOD, "note": "n" * (server.MAX_BODY + 10)})
        self.assertEqual(st, 400)
        self.assertEqual(stored(), [])

    def test_bad_json(self):
        st, b, _ = self.req("POST", "/api/reserve", raw=b"[1]", headers={"Content-Type": "application/json"})
        self.assertEqual(st, 400)


class StoreTests(ReserveCase):
    def test_json_post_stores_one_record(self):
        st, j = self.post({**GOOD, "ref": "PH"})
        self.assertEqual((st, j["ok"]), (200, True))
        self.assertRegex(j["id"], r"^\d{8}-[0-9a-f]{32}$")
        files = stored()
        self.assertEqual(files, [j["id"] + ".json"])
        rec = json.load(open(os.path.join(server.LOCAL_ORDERS, "reservations", files[0])))
        self.assertEqual(set(rec), {"id", "at", "agency", "email", "clients", "note", "ref", "founding_price"})
        self.assertEqual(rec["founding_price"], 29)
        self.assertEqual((rec["agency"], rec["email"], rec["clients"], rec["note"], rec["ref"]), ("North Star Marketing", "lead@example.com", 12, "hello", "ph"))
        self.assertNotIn("127.0.0.1", json.dumps(rec))

    def test_founding_price_server_side(self):
        for extra in ({}, {"founding_price": 1}):
            st, j = self.post({**GOOD, **extra})
            self.assertEqual(st, 200)
            rec = json.load(open(os.path.join(server.LOCAL_ORDERS, "reservations", j["id"] + ".json")))
            self.assertEqual(rec["founding_price"], 29)
            self.assertIs(type(rec["founding_price"]), int)

    def test_old_record_without_field_loads(self):
        rid = "20261101-" + "c" * 32
        d = os.path.join(server.LOCAL_ORDERS, "reservations")
        os.makedirs(d, exist_ok=True)
        with open(os.path.join(d, rid + ".json"), "w") as f:
            json.dump({"id": rid, "at": "2026-11-01T00:00:00+00:00", "agency": "Old Co", "email": "o@b.co", "clients": 2, "note": "", "ref": ""}, f)
        rows = server.reservation_list(server.Store())
        self.assertEqual([r["id"] for r in rows], [rid])
        self.assertNotIn("founding_price", rows[0])

    def test_urlencoded_post(self):
        body = urllib.parse.urlencode({"agency": "Acme Agency", "email": "a@b.co", "clients": "3", "note": "", "website": ""}).encode()
        st, b, _ = self.req("POST", "/api/reserve", raw=body, headers={"Content-Type": "application/x-www-form-urlencoded"})
        self.assertEqual(st, 200)
        self.assertEqual(len(stored()), 1)
        st, b, h = self.req("POST", "/api/reserve", raw=body, headers={"Content-Type": "application/x-www-form-urlencoded", "Accept": "text/html"})
        self.assertIn("Nothing was charged", b.decode())

    def test_honeypot(self):
        st, j = self.post({**GOOD, "website": "http://spam.example"})
        self.assertEqual((st, j["ok"]), (200, True))
        self.assertEqual(stored(), [])

    def test_rate_limit(self):
        for _ in range(5):
            self.assertEqual(self.post(GOOD)[0], 200)
        self.assertEqual(self.post(GOOD)[0], 429)

    def test_no_polar_call(self):
        import polar_adapter

        def boom(*a, **k):
            raise AssertionError("polar_adapter called")
        saved = {n: getattr(polar_adapter, n) for n in dir(polar_adapter) if callable(getattr(polar_adapter, n)) and not n.startswith("__")}
        try:
            for n in saved:
                setattr(polar_adapter, n, boom)
            self.assertEqual(self.post(GOOD)[0], 200)
        finally:
            for n, f in saved.items():
                setattr(polar_adapter, n, f)


class AdminTests(ReserveCase):
    def test_disabled_without_token(self):
        self.assertEqual(self.admin("GET", "/api/reservations")[0], 404)
        os.environ["RESERVE_ADMIN_TOKEN"] = "short"
        self.assertEqual(self.admin("GET", "/api/reservations", "short")[0], 404)
        self.assertEqual(self.admin("DELETE", "/api/reservations/20260101-" + "a" * 32, "short")[0], 404)

    def test_list_and_delete(self):
        os.environ["RESERVE_ADMIN_TOKEN"] = TOKEN
        rid = self.post(GOOD)[1]["id"]
        self.assertEqual(self.admin("GET", "/api/reservations", "wrong")[0], 401)
        self.assertEqual(self.admin("GET", "/api/reservations", None)[0], 401)
        st, j, h = self.admin("GET", "/api/reservations")
        self.assertEqual((st, j["count"], j["reservations"][0]["id"]), (200, 1, rid))
        self.assertEqual(h.get("Cache-Control"), "no-store")
        self.assertEqual(self.admin("DELETE", "/api/reservations/../x")[0], 400)
        self.assertEqual(self.admin("DELETE", "/api/reservations/..%2Fx")[0], 400)
        self.assertEqual(self.admin("DELETE", "/api/reservations/wrong", "wrong")[0], 401)
        self.assertEqual(self.admin("DELETE", "/api/reservations/" + rid)[0], 200)
        self.assertEqual(self.admin("DELETE", "/api/reservations/" + rid)[0], 404)
        self.assertEqual(self.admin("GET", "/api/reservations")[1]["count"], 0)

    def test_bad_token_limited(self):
        os.environ["RESERVE_ADMIN_TOKEN"] = TOKEN
        codes = [self.admin("GET", "/api/reservations", "bad")[0] for _ in range(agency.BAD_TOKEN_PER_MINUTE + 2)]
        self.assertEqual(codes[0], 401)
        self.assertEqual(codes[-1], 429)


class NoPaymentTests(unittest.TestCase):
    def setUp(self):
        self.text = open(PAGE, encoding="utf-8").read()

    def test_no_payment_inputs(self):
        for tag in re.findall(r"<(?:input|select|textarea)\b[^>]*>", self.text, re.I):
            for attr in re.findall(r'\b(?:name|id|autocomplete)="([^"]*)"', tag):
                for w in ("card", "cc-", "cvc", "cvv", "expiry", "iban", "payment"):
                    self.assertNotIn(w, attr.lower(), tag)

    def test_no_checkout_words(self):
        low = self.text.lower()
        for w in ("polar.sh", "checkout", "stripe"):
            self.assertNotIn(w, low)

    def test_banned_words(self):
        low = server.render_page(self.text.encode()).decode().lower()
        for w in BANNED:
            self.assertNotIn(w, low)


class AlertTests(unittest.TestCase):
    def test_alert_has_id_not_email(self):
        rid = "20261127-" + "ab" * 16
        title, body = server.alert_text("reservation", oid=rid)
        self.assertIn(rid, title + body)
        self.assertNotIn("@", title + body)
        self.assertNotIn("North Star", title + body)


if __name__ == "__main__":
    unittest.main()
