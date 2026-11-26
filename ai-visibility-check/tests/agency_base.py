"""Shared fixtures for the agency tests (CR-133). Not a test module. No network, no real AI call."""
import datetime, http.client, json, os, sys
from unittest import mock

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import test_addons as ta  # noqa: E402  (sets sys.path and env; Base starts the local server and fake vendor APIs)
import server, delivery, products, agency  # noqa: E402
from aivis.jobs import JobFailed  # noqa: E402

fake_apis, sign = ta.fake_apis, ta.sign
BUNDLE5, BUNDLE1 = "00000000-0000-4000-8000-000000000005", "00000000-0000-4000-8000-000000000001"   # test-only product ids, set through the environment
AGENCY_ENV = [f"AIVIS_AGENCY_{w}_{n}" for w in ("PRODUCT", "LINK") for n in (1, 5, 10, 25)]
BUYER = "agency.buyer@example.com"
AGENCY = {"name": "Northwind Digital", "accent": "#1D4ED8", "contact_line": "northwind.example"}
CLIENT_A = {"business": "Austin Dental Spa", "city": "Austin, TX", "niche": "dentist", "website": "https://example.com"}
CLIENT_B = {"business": "Phoenix Roofing Co", "city": "Phoenix, AZ", "niche": "roofer", "website": "https://example.org"}
CLIENT_C = {"business": "Saint Paul Plumbing", "city": "Saint Paul, MN", "niche": "plumber"}
MORE = [{"business": f"{n} Plumbing", "city": c, "niche": "plumber"} for n, c in (
    ("Denver", "Denver, CO"), ("Boise", "Boise, ID"), ("Tampa", "Tampa, FL"), ("Reno", "Reno, NV"),
    ("Omaha", "Omaha, NE"), ("Tulsa", "Tulsa, OK"), ("Fargo", "Fargo, ND"), ("Macon", "Macon, GA"))]


class AgencyBase(ta.Base):
    def setUp(self):
        self.saved_fake = (dict(fake_apis.TARGET), {k: list(v) for k, v in fake_apis.POOLS.items()})
        super().setUp()
        os.environ["AIVIS_AGENCY"] = "1"
        os.environ.pop("AIVIS_PACK_DAILY_CAP_USD", None)
        self.saved_env = {k: os.environ.pop(k, None) for k in AGENCY_ENV}
        os.environ["AIVIS_AGENCY_PRODUCT_1"], os.environ["AIVIS_AGENCY_PRODUCT_5"] = BUNDLE1, BUNDLE5
        self.saved_agency = (agency.now, agency.mono)
        agency.now = lambda: self.clock
        agency.reset_limits()
        self.engine_calls, self.patches = [], []

    def tearDown(self):
        for p in reversed(self.patches):
            p.stop()
        for k, v in self.saved_env.items():
            os.environ.pop(k, None)
            if v is not None:
                os.environ[k] = v
        agency.now, agency.mono = self.saved_agency
        fake_apis.TARGET.clear(); fake_apis.TARGET.update(self.saved_fake[0])      # other test files rely on the defaults
        fake_apis.POOLS.clear(); fake_apis.POOLS.update(self.saved_fake[1])
        super().tearDown()

    # -- a stand-in for the engine job: counts starts, costs `cost`, or fails
    def fake_engine(self, cost=0.5, fail=False):
        def build(order_dict, cap, roster_fn=None, providers=None):
            self.engine_calls.append(order_dict["order_id"])
            if fail:
                raise JobFailed("fake engine failure", spent=0.0, retryable=True)
            return {"report.html": "<html>REPORT</html>", "answers.json": "[]", "order-log.json": "{}", "spent_usd": cost}
        p = mock.patch("aivis.jobs.build_report", build)
        p.start(); self.patches.append(p)

    # -- webhooks
    def paid_body(self, pid, ref, amount=24500, reason="purchase", email=BUYER, extra=None, items=None, etype="order.paid"):
        d = {"id": ref, "customer": {"email": email}}
        if pid:
            d["product_id"] = pid
        if items is not None:
            d["items"] = items
        if reason is not None:
            d["billing_reason"] = reason
        if amount is not None:
            d["net_amount"] = amount
        d.update(extra or {})
        return json.dumps({"type": etype, "data": d}).encode()

    def pay(self, pid, ref, mid=None, **kw):
        return self.hook(self.paid_body(pid, ref, **kw), mid or "evt-" + ref)

    def refund(self, ref, mid=None):
        return self.hook(self.paid_body("", ref, etype="order.refunded"), mid or "ref-" + ref)

    def bundles(self):
        return [self.store().get(f"bundles/{f}")[0] for f in self.files("bundles")]

    # -- http
    def call(self, method, path, body=None, headers=None, raw=False):
        c = http.client.HTTPConnection("127.0.0.1", self.port)
        data = body if raw else (json.dumps(body).encode() if body is not None else None)
        c.request(method, path, body=data, headers={**({"Content-Length": str(len(data))} if data is not None else {}),
                                                    **(headers or {})})
        r = c.getresponse()
        out = r.read()
        return r.status, out, dict(r.getheaders())

    def jcall(self, method, path, body=None, headers=None):
        st, out, h = self.call(method, path, body, headers)
        try:
            return st, json.loads(out)
        except ValueError:
            return st, out.decode("utf-8", "replace")

    def new_bundle(self, pid=BUNDLE5, ref="pol_ord_1", n=None):
        self.assertEqual(self.pay(pid, ref)[1]["status"], "bundle")
        st, j = self.jcall("POST", "/agency/claim", {"order_id": ref, "email": BUYER})
        self.assertEqual(st, 200)
        token = j["portal"].rsplit("/", 1)[1]
        return token, agency.bundle_id(ref)

    def run_client(self, token, client, **extra):
        return self.jcall("POST", f"/agency/p/{token}/run", {**client, **extra})

    def state(self, token):
        return self.jcall("GET", f"/agency/p/{token}/state")[1]

    def orders_of(self, bid):
        return [o for o in self.orders() if o.get("bundle_id") == bid]
