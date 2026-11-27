import base64, hashlib, io, json, logging, os, random, re, sys, types, unittest
from unittest import mock

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
import oauth  # noqa: E402
from test_base import Base  # noqa: E402

# ---- tiny RSA key (pure python, deterministic) so signatures can be made without third-party libs ----


def _is_prime(n, rnd):
    if n < 4 or n % 2 == 0:
        return n in (2, 3)
    d, r = n - 1, 0
    while d % 2 == 0:
        d //= 2
        r += 1
    for _ in range(20):
        x = pow(rnd.randrange(2, n - 1), d, n)
        if x in (1, n - 1):
            continue
        for _ in range(r - 1):
            x = x * x % n
            if x == n - 1:
                break
        else:
            return False
    return True


def _prime(bits, rnd):
    while True:
        c = rnd.getrandbits(bits) | (1 << (bits - 1)) | 1
        if _is_prime(c, rnd):
            return c


def _tlv(tag, body):
    n = len(body)
    ln = bytes([n]) if n < 128 else bytes([0x80 | len(n.to_bytes(2, "big"))]) + n.to_bytes(2, "big")
    return bytes([tag]) + ln + body


def _int(i):
    b = i.to_bytes((i.bit_length() + 8) // 8, "big")
    return _tlv(0x02, b)


def _make_key():
    rnd = random.Random(7)
    e = 65537
    while True:
        p, q = _prime(512, rnd), _prime(512, rnd)
        phi = (p - 1) * (q - 1)
        if p != q and phi % e:
            break
    n, d = p * q, pow(e, -1, phi)
    spki = _tlv(0x30, _tlv(0x30, bytes.fromhex("06092a864886f70d0101010500"))
                + _tlv(0x03, b"\x00" + _tlv(0x30, _int(n) + _int(e))))
    pem = "-----BEGIN PUBLIC KEY-----\n" + base64.b64encode(spki).decode() + "\n-----END PUBLIC KEY-----\n"
    return pem, n, d


PEM, N, D = _make_key()


def sign(body):
    k = (N.bit_length() + 7) // 8
    t = oauth._SHA256_PREFIX + hashlib.sha256(body).digest()
    em = b"\x00\x01" + b"\xff" * (k - len(t) - 3) + b"\x00" + t
    return base64.b64encode(pow(int.from_bytes(em, "big"), D, N).to_bytes(k, "big")).decode()


# ---- fakes ----

class FakeStore:
    def __init__(self):
        self.installs, self.companies, self.locations, self.answers = {}, {}, {}, {}

    def save_install(self, **kw):
        self.installs[kw["location_id"]] = kw

    def get_install(self, location_id):
        return self.installs.get(location_id)

    def save_company_token(self, company_id, access_token, refresh_token, expires_at):
        self.companies[company_id] = dict(access_token=access_token, refresh_token=refresh_token, expires_at=expires_at)

    def get_company_token(self, company_id):
        return self.companies.get(company_id)

    def update_location(self, location_id, name, website, city):
        self.locations[location_id] = dict(name=name, website=website, city=city)

    def delete_location(self, location_id):
        for table in (self.installs, self.locations, self.answers):
            table.pop(location_id, None)


class Req:
    def __init__(self, method="GET", query=None, headers=None, body=b""):
        self.method, self.query, self.headers, self.body = method, query or {}, headers or {}, body


NOW = 1_000_000.0


class OAuthCase(Base):
    def setUp(self):
        super().setUp()
        os.environ.update(GHL_CLIENT_ID="app123-xyz", GHL_CLIENT_SECRET="client-secret-value", GHL_WEBHOOK_PUBLIC_KEY=PEM)
        self.store = FakeStore()
        self.calls = []
        self.responses = []         # list of (match substring, status, dict)
        for p in (mock.patch.object(oauth, "store", self.store), mock.patch.object(oauth, "_http", self.fake_http),
                  mock.patch.object(oauth, "_now", lambda: NOW)):
            p.start()
            self.addCleanup(p.stop)
        oauth._seen.clear()

    def fake_http(self, method, url, form=None, headers=None):
        self.calls.append((method, url, form, headers))
        for i, (match, status, data) in enumerate(self.responses):
            if match in url:
                return status, data(form) if callable(data) else data
        return 404, {}

    def token(self, **kw):
        d = {"access_token": "AT-1", "refresh_token": "RT-1", "expires_in": 86400, "userType": "Location",
             "locationId": "loc1", "companyId": "co1"}
        d.update(kw)
        return d

    def callback(self, code="abc"):
        return oauth.handle_callback(Req(query={"code": [code]}))

    def webhook(self, payload, signed=True):
        body = json.dumps(payload).encode()
        headers = {"X-WH-Signature": sign(body)} if signed else {}
        return oauth.handle_webhook(Req("POST", headers=headers, body=body))


class TestCallback(OAuthCase):
    def test_1_location_token_saves_install(self):
        self.responses = [("/oauth/token", 200, self.token())]
        status, body = self.callback()
        self.assertEqual((status, body["location"]), (302, "/oauth/success"))
        inst = self.store.installs["loc1"]
        self.assertEqual((inst["access_token"], inst["refresh_token"], inst["company_id"]), ("AT-1", "RT-1", "co1"))
        self.assertEqual(inst["expires_at"], NOW + 86400)
        _, url, form, _ = self.calls[0]
        self.assertEqual((form["grant_type"], form["code"], form["client_id"]), ("authorization_code", "abc", "app123-xyz"))
        self.assertEqual(oauth.handle_success(Req())[0], 200)

    def test_2_company_bulk_saves_one_install_per_location(self):
        self.responses = [
            ("/oauth/token", 200, self.token(userType="Company", locationId=None, access_token="CO-AT")),
            ("installedLocations", 200, {"locations": [{"_id": "a"}, {"_id": "b"}, {"_id": "c"}]}),
            ("locationToken", 200, lambda f: {"access_token": "LT-" + f["locationId"], "refresh_token": "LR-" + f["locationId"],
                                              "expires_in": 3600}),
        ]
        status, body = self.callback()
        self.assertEqual((status, body["installed"]), (302, 3))
        self.assertEqual(sorted(self.store.installs), ["a", "b", "c"])
        self.assertEqual(self.store.installs["b"]["access_token"], "LT-b")
        loc_calls = [c for c in self.calls if "locationToken" in c[1]]
        self.assertTrue(all(c[3]["Authorization"] == "Bearer CO-AT" for c in loc_calls))
        self.assertIn("appId=app123", [c for c in self.calls if "installedLocations" in c[1]][0][1])

    def test_callback_errors(self):
        self.assertEqual(oauth.handle_callback(Req())[0], 400)
        self.responses = [("/oauth/token", 400, {"error": "bad"})]
        self.assertEqual(self.callback()[0], 502)
        self.assertEqual(self.store.installs, {})


class TestRefresh(OAuthCase):
    def test_3_expired_token_refreshes_once_and_saves_rotated_refresh(self):
        self.store.installs["loc1"] = dict(location_id="loc1", company_id="co1", access_token="OLD", refresh_token="RT-old",
                                           expires_at=NOW + 60)
        self.responses = [("/oauth/token", 200, self.token(access_token="AT-new", refresh_token="RT-rotated"))]
        self.assertEqual(oauth.get_location_token("loc1"), "AT-new")
        self.assertEqual(oauth.get_location_token("loc1"), "AT-new")      # now fresh: no second call
        self.assertEqual(len(self.calls), 1)
        form = self.calls[0][2]
        self.assertEqual((form["grant_type"], form["refresh_token"]), ("refresh_token", "RT-old"))
        self.assertEqual(self.store.installs["loc1"]["refresh_token"], "RT-rotated")

    def test_fresh_token_not_refreshed(self):
        self.store.installs["loc1"] = dict(location_id="loc1", access_token="OK", refresh_token="r", expires_at=NOW + 3600)
        self.assertEqual(oauth.get_location_token("loc1"), "OK")
        self.assertEqual(self.calls, [])


class TestWebhooks(OAuthCase):
    def setUp(self):
        super().setUp()
        self.store.companies["co1"] = dict(access_token="CO-AT", refresh_token="CO-RT", expires_at=NOW + 3600)
        self.responses = [("locationToken", 200, {"access_token": "LT", "refresh_token": "LR", "expires_in": 3600})]

    def test_4_signature_rules(self):
        body = json.dumps({"type": "INSTALL", "webhookId": "w0", "locationId": "loc9", "companyId": "co1"}).encode()
        self.assertEqual(oauth.handle_webhook(Req("POST", body=body))[0], 401)
        self.assertEqual(oauth.handle_webhook(Req("POST", headers={"X-WH-Signature": "AAAA"}, body=body))[0], 401)
        self.assertEqual(oauth.handle_webhook(Req("POST", headers={"X-WH-Signature": sign(body + b" ")}, body=body))[0], 401)
        os.environ["GHL_WEBHOOK_PUBLIC_KEY"] = ""
        self.assertEqual(oauth.handle_webhook(Req("POST", headers={"X-WH-Signature": sign(body)}, body=body))[0], 401)
        self.assertEqual(self.store.installs, {})

    def test_4_install_creates_install_and_duplicate_processed_once(self):
        p = {"type": "INSTALL", "webhookId": "w1", "locationId": "loc9", "companyId": "co1"}
        self.assertEqual(self.webhook(p), (200, {"ok": True}))
        self.assertEqual(self.store.installs["loc9"]["access_token"], "LT")
        self.assertEqual(self.webhook(p)[1].get("duplicate"), True)
        self.assertEqual(len([c for c in self.calls if "locationToken" in c[1]]), 1)

    def test_unknown_type_ignored(self):
        self.assertEqual(self.webhook({"type": "Whatever", "webhookId": "w2"}), (200, {"ok": True, "ignored": True}))

    def test_location_update(self):
        self.webhook({"type": "LocationUpdate", "webhookId": "w3", "id": "loc1", "name": "Acme", "website": "acme.com", "city": "Haifa"})
        self.assertEqual(self.store.locations["loc1"], {"name": "Acme", "website": "acme.com", "city": "Haifa"})

    def test_location_update_fetches_when_payload_bare(self):
        self.store.installs["loc1"] = dict(location_id="loc1", access_token="T", refresh_token="r", expires_at=NOW + 3600)
        self.responses = [("/locations/loc1", 200, {"location": {"name": "Acme", "website": "w", "city": "Haifa"}})]
        self.webhook({"type": "LocationUpdate", "webhookId": "w4", "locationId": "loc1"})
        self.assertEqual(self.store.locations["loc1"]["city"], "Haifa")

    def test_5_uninstall_removes_tokens_and_all_rows(self):
        self.store.installs["loc1"] = dict(location_id="loc1", access_token="T", refresh_token="r", expires_at=NOW)
        self.store.installs["loc2"] = dict(location_id="loc2", access_token="T2", refresh_token="r2", expires_at=NOW)
        self.store.locations["loc1"] = {"name": "x"}
        self.store.answers["loc1"] = ["answer"]
        self.assertEqual(self.webhook({"type": "UNINSTALL", "webhookId": "w5", "locationId": "loc1"})[0], 200)
        self.assertNotIn("loc1", self.store.installs)
        self.assertNotIn("loc1", self.store.locations)
        self.assertNotIn("loc1", self.store.answers)
        self.assertIn("loc2", self.store.installs)


class TestNoTokensInLogs(OAuthCase):
    def test_6_no_token_value_in_logs(self):
        secrets = ["AT-secret", "RT-secret", "CO-secret", "LT-secret", "client-secret-value"]
        stream = io.StringIO()
        h = logging.StreamHandler(stream)
        root = logging.getLogger()
        old = root.level
        root.setLevel(logging.DEBUG)
        root.addHandler(h)
        self.addCleanup(lambda: (root.removeHandler(h), root.setLevel(old)))
        self.responses = [("/oauth/token", 200, self.token(access_token="AT-secret", refresh_token="RT-secret")),
                          ]
        self.callback()
        self.store.installs["loc1"]["expires_at"] = NOW
        oauth.get_location_token("loc1")
        self.responses = [("/oauth/token", 401, {"access_token": "CO-secret"})]
        self.callback()                                         # failure path
        self.store.companies["co1"] = dict(access_token="CO-secret", refresh_token="CO-RT-secret", expires_at=NOW + 3600)
        self.responses = [("locationToken", 200, {"access_token": "LT-secret", "refresh_token": "RT-secret", "expires_in": 9})]
        self.webhook({"type": "INSTALL", "webhookId": "w6", "locationId": "new", "companyId": "co1"})
        self.webhook({"type": "UNINSTALL", "webhookId": "w7", "locationId": "new"})
        self.webhook({"type": "INSTALL", "webhookId": "w8", "locationId": "x", "companyId": "co1"}, signed=False)
        out = stream.getvalue()
        self.assertTrue(out)                                    # something was logged
        for s in secrets + ["CO-RT-secret"]:
            self.assertNotIn(s, out)


class TestRoutes(Base):
    def test_routes_registered(self):
        routes = {}
        oauth.register(routes)
        self.assertEqual(set(routes), {("GET", "/oauth/callback"), ("GET", "/oauth/success"), ("POST", "/webhooks/ghl")})


class TestComposePassword(unittest.TestCase):
    def test_compose_has_no_default_password(self):
        path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "docker-compose.yml")
        with open(path) as f:
            text = f.read()
        uses = re.findall(r"\$\{POSTGRES_PASSWORD([^}]*)\}", text)
        self.assertEqual(len(uses), 2)                          # app DATABASE_URL and db service
        for u in uses:
            self.assertTrue(u.startswith(":?"), u)              # required, no :- or - default
        self.assertNotRegex(text, r"(?m)^\s*POSTGRES_PASSWORD:\s*[^$\s]")   # no literal password
        self.assertNotIn("ghl:ghl@", text)


if __name__ == "__main__":
    unittest.main()
