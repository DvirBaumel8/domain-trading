"""Install -> store -> tick -> page, all on one real SQLite Store (temp file). Offline, neutral data."""
import io, json, logging, os, sys, tempfile, unittest
from datetime import datetime, timezone
from unittest import mock

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from test_base import Base  # noqa: E402
from test_oauth import PEM, sign  # noqa: E402
import config, oauth, page, runs, store  # noqa: E402

NOW = 1_000_000.0
KEY = "test-key-for-unit-tests"
SECRETS = ("AT-secret-1", "RT-secret-1", "RT-secret-2", "AT-secret-2", "CO-secret-at", "CO-secret-rt", "LT-secret-a")


class Req:
    def __init__(self, method="GET", query=None, headers=None, body=b""):
        self.method, self.query, self.headers, self.body = method, query or {}, headers or {}, body


def T(d, h=12):
    return datetime(2026, 12, d, h, tzinfo=timezone.utc)


class Flow(Base):
    def setUp(self):
        super().setUp()
        os.environ.update(GHL_CLIENT_ID="app123-xyz", GHL_CLIENT_SECRET="client-secret-value", GHL_WEBHOOK_PUBLIC_KEY=PEM,
                          GHL_TOKEN_KEY=KEY, GHL_APP_ENABLED="1", OPENAI_API_KEY="k")
        self.tmp = tempfile.TemporaryDirectory()
        self.path = os.path.join(self.tmp.name, "flow.db")
        self.store = store.Store("sqlite:///" + self.path)
        store.set_store(self.store)
        self.responses, self.calls, self.ai_calls = [], [], []
        self._callers = dict(runs.CALLERS)
        runs.CALLERS["openai"] = self.fake_ai
        for p in (mock.patch.object(oauth, "_http", self.fake_http), mock.patch.object(oauth, "_now", lambda: NOW)):
            p.start()
            self.addCleanup(p.stop)
        oauth._seen.clear()
        self.log = io.StringIO()
        h = logging.StreamHandler(self.log)
        root = logging.getLogger()
        old = root.level
        root.setLevel(logging.DEBUG)
        root.addHandler(h)
        self.addCleanup(lambda: (root.removeHandler(h), root.setLevel(old)))

    def tearDown(self):
        runs.CALLERS.update(self._callers)
        store.set_store(None)
        self.store.close()
        self.tmp.cleanup()
        super().tearDown()

    def fake_ai(self, prompt, loc):
        self.ai_calls.append(loc["id"])
        return {"text": f"1. **Rival One**\n2. **{loc['name']}**", "sources": []}

    def fake_http(self, method, url, form=None, headers=None):
        self.calls.append(url)
        for match, status, data in self.responses:
            if match in url:
                return status, data(form) if callable(data) else data
        return 404, {}

    def callback(self, **kw):
        d = {"access_token": "AT-secret-1", "refresh_token": "RT-secret-1", "expires_in": 3600, "userType": "Location",
             "locationId": "locA", "companyId": "coX"}
        d.update(kw)
        self.responses = [("/oauth/token", 200, d)]
        return oauth.handle_callback(Req(query={"code": ["c"]}))

    def webhook(self, payload):
        body = json.dumps(payload).encode()
        return oauth.handle_webhook(Req("POST", headers={"X-WH-Signature": sign(body)}, body=body))

    def profile(self, loc, name="Acme Plumbing", city="Austin"):
        self.store.update_location(loc, name, None, city, category="plumber")

    def db_bytes(self):
        self.store.conn.commit()
        out = b""
        for n in os.listdir(self.tmp.name):
            with open(os.path.join(self.tmp.name, n), "rb") as f:
                out += f.read()
        return out


class TestInstallPath(Flow):
    def test_callback_saves_install_and_tokens(self):
        self.assertEqual(self.callback()[0], 302)
        d = self.store.get_install("locA", with_tokens=True)
        self.assertEqual((d["access_token"], d["refresh_token"], d["company_id"], d["user_type"], d["expires_at"]),
                         ("AT-secret-1", "RT-secret-1", "coX", "Location", int(NOW + 3600)))

    def test_webhook_install_update_uninstall(self):
        self.store.save_company_token("coX", "CO-secret-at", "CO-secret-rt", NOW + 3600)
        self.responses = [("locationToken", 200, {"access_token": "LT-secret-a", "refresh_token": "RT-secret-2", "expires_in": 60})]
        self.assertEqual(self.webhook({"type": "INSTALL", "webhookId": "w1", "locationId": "locB", "companyId": "coX"})[0], 200)
        self.assertEqual(self.store.get_install("locB", with_tokens=True)["access_token"], "LT-secret-a")
        self.webhook({"type": "LocationUpdate", "webhookId": "w2", "id": "locB", "name": "Beta", "website": "beta.example", "city": "Haifa"})
        d = self.store.get_install("locB")
        self.assertEqual((d["business_name"], d["business_website"], d["business_city"]), ("Beta", "beta.example", "Haifa"))
        self.store.add_prompt("locB", "p")
        self.store.claim_run("locB", "install")
        self.store.add_run("locB", "openai", answers=[{"prompt_id": 1, "mentioned": False}])
        self.assertEqual(self.webhook({"type": "UNINSTALL", "webhookId": "w3", "locationId": "locB"})[0], 200)
        self.assertEqual(self.store.count_rows("locB"), 0)
        self.assertIsNotNone(self.store.get_company_token("coX"))

    def test_refresh_stores_rotated_token_and_expiry(self):
        self.callback()
        self.store.save_install("locA", "coX", "AT-secret-1", "RT-secret-1", NOW + 10, "Location", "s")
        self.responses = [("/oauth/token", 200, {"access_token": "AT-secret-2", "refresh_token": "RT-secret-2",
                                                 "expires_in": 7200})]
        self.assertEqual(oauth.get_location_token("locA"), "AT-secret-2")
        d = self.store.get_install("locA", with_tokens=True)
        self.assertEqual((d["refresh_token"], d["expires_at"]), ("RT-secret-2", int(NOW + 7200)))

    def test_tokens_never_in_db_file_or_logs(self):
        self.callback()
        self.store.save_company_token("coX", "CO-secret-at", "CO-secret-rt", NOW + 3600)
        self.store.save_install("locA", "coX", "AT-secret-1", "RT-secret-1", NOW + 10, "Location", "s")
        self.responses = [("/oauth/token", 200, {"access_token": "AT-secret-2", "refresh_token": "RT-secret-2", "expires_in": 9})]
        oauth.get_location_token("locA")
        data = self.db_bytes()
        self.assertIn(b"v1:", data)
        for s in SECRETS:
            self.assertNotIn(s.encode(), data)
            self.assertNotIn(s, self.log.getvalue())

    def test_no_token_key_fails_closed(self):
        os.environ.pop("GHL_TOKEN_KEY")
        with self.assertRaises(store.StoreError):
            self.callback()
        self.assertEqual(self.store.list_locations(), [])


class TestTick(Flow):
    def test_install_run_once_with_rows_and_spend(self):
        self.callback()
        self.profile("locA")
        self.store._tx(lambda: self.store._exec("UPDATE installs SET installed_at='2026-12-01T01:00:00+00:00'"))
        self.assertEqual([s["key"] for s in runs.tick(T(1))["started"]], ["install"])
        self.assertEqual(runs.tick(T(1, 20))["started"], [])
        self.assertEqual(len(self.ai_calls), 10)
        h = self.store.history("locA", 12)["openai"]
        self.assertEqual((len(h), len(h[0]["answers"])), (1, 10))
        self.assertAlmostEqual(self.store.spend_total("2026-12", "locA"), 10 * runs.PRICE_PER_CALL_USD["openai"])
        self.assertTrue(self.store.has_run("locA", "install"))

    def test_no_profile_no_run_until_profile_exists(self):
        self.callback()
        self.assertEqual(runs.tick(T(1))["started"], [])
        self.assertFalse(self.store.has_run("locA", "install"))
        self.profile("locA")
        self.assertEqual(len(runs.tick(T(1))["started"]), 1)

    def test_caps_read_spend_from_store(self):
        self.callback()
        self.profile("locA")
        self.store.add_spend("2026-12-01", "openai", 1.99, "locA")     # earlier spend, already in the Store
        res = runs.tick(T(2))
        self.assertEqual(len(self.ai_calls), 1)                         # 1.99 + 0.0095 fits under 2.00; the next does not
        self.assertEqual(res["started"][0]["status"], "cap_reached")
        os.environ["GHL_PER_LOCATION_CAP_USD"] = "50"
        os.environ["GHL_MONTHLY_CAP_USD"] = "1.995"
        self.callback(locationId="locB")
        self.profile("locB")
        n = len(self.ai_calls)
        self.assertEqual(runs.tick(T(3))["started"][0]["status"], "cap_reached")
        self.assertEqual(len(self.ai_calls), n)                         # app-wide spend is already at the cap

    def test_trial_limit_with_store_data(self):
        for i in range(4):
            self.callback(locationId=f"loc{i}")
            self.profile(f"loc{i}")
            self.store._tx(lambda i=i: self.store._exec("UPDATE installs SET installed_at=? WHERE location_id=?",
                                                         (f"2026-11-2{i}T00:00:00+00:00", f"loc{i}")))
        res = runs.tick(T(1))
        self.assertEqual(sorted(s["location_id"] for s in res["started"]), ["loc0", "loc1", "loc2"])
        self.assertEqual(res["skipped_trial"], ["loc3"])
        self.store.upsert_install("loc3", plan="paid")
        started = {s["location_id"]: s["key"] for s in runs.tick(T(1))["started"]}
        self.assertEqual(started["loc3"], "install")                   # no longer held back by the trial limit

    def test_uninstalled_location_not_run(self):
        self.callback()
        self.profile("locA")
        self.webhook({"type": "UNINSTALL", "webhookId": "w9", "locationId": "locA"})
        self.assertEqual(runs.tick(T(1))["started"], [])


class TestPage(Flow):
    def setUp(self):
        super().setUp()
        for loc, name in (("locA", "Acme Plumbing"), ("locB", "Beta Roofing")):
            self.callback(locationId=loc)
            self.profile(loc, name)

    def test_view_save_and_run(self):
        v = page.page_view("locA")
        self.assertEqual((v["business"]["name"], v["plan"], v["custom_prompts"]), ("Acme Plumbing", "trial", False))
        self.assertEqual(v["prompts"][0], "best plumber in Austin")
        self.assertEqual(page.save_prompts("locA", [" first ", "", "second"]), ["first", "second"])
        v = page.page_view("locA")
        self.assertEqual((v["prompts"], v["custom_prompts"]), (["first", "second"], True))
        r = page.run_now("locA", T(5))
        self.assertEqual((r["started"], len(self.ai_calls)), (True, 2))
        self.assertEqual(page.run_now("locA", T(5, 20)), {"started": False, "reason": "already_ran_today"})
        v = page.page_view("locA")
        self.assertEqual(v["latest"]["openai"]["answers"][0]["mentioned"], True)
        self.assertEqual(len(v["trend"]), 1)
        self.assertGreater(v["spend_month_usd"], 0) if runs._utc().month == 12 else None
        self.assertEqual(page.save_prompts("locA", []), [])

    def test_never_shows_another_location(self):
        page.save_prompts("locA", ["only a"])
        page.save_prompts("locB", ["only b"])
        page.run_now("locA", T(5))
        b = page.page_view("locB")
        self.assertEqual((b["business"]["name"], b["prompts"], b["trend"], b["latest"]), ("Beta Roofing", ["only b"], [], {}))
        self.assertNotIn("Acme", json.dumps(b))
        self.assertNotIn("only a", json.dumps(b))

    def test_unknown_location(self):
        self.assertIsNone(page.page_view("nope"))
        with self.assertRaises(store.StoreError):
            page.save_prompts("nope", ["x"])
        self.assertEqual(page.run_now("nope")["reason"], "not_installed")

    def test_prompt_limits(self):
        with self.assertRaises(store.StoreError):
            page.save_prompts("locA", [f"p{i}" for i in range(11)])
        self.assertEqual(len(page.save_prompts("locA", ["x" * 500])[0]), page.MAX_PROMPT_CHARS)


class TestConfigNames(Base):
    def test_names_in_config_and_env_example(self):
        cfg = config.get()
        self.assertEqual((cfg["GHL_TOKEN_KEY"], cfg["GHL_CRON_SECRET"]), ("", ""))
        path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", ".env.example")
        with open(path) as f:
            lines = f.read().split()
        self.assertIn("GHL_TOKEN_KEY=", lines)
        self.assertIn("GHL_CRON_SECRET=", lines)

    def test_not_configured_then_configured(self):
        self.assertEqual((config.status("token_key"), config.status("cron")), ("not_configured", "not_configured"))
        os.environ.update(GHL_TOKEN_KEY="x", GHL_CRON_SECRET="y")
        self.assertEqual((config.status("token_key"), config.status("cron")), ("configured", "configured"))

    def test_tick_401_without_secret(self):
        self.assertEqual(runs.handle_tick(Req(headers={"X-Cron-Secret": ""}))[0], 401)
        self.assertEqual(runs.handle_tick(Req(headers={"X-Cron-Secret": "anything"}))[0], 401)


if __name__ == "__main__":
    unittest.main()
