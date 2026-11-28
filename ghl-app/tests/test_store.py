import os, sys, tempfile, unittest

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
import store
from store import Store, StoreError

PG_URL = os.environ.get("DATABASE_URL", "")  # captured before other tests clear it
PG_URL = PG_URL if PG_URL.startswith(("postgres://", "postgresql://")) else ""


class StoreContract:
    """Run on every backend; subclasses provide make_store()."""
    LOC = "loc-test-1"

    def setUp(self):
        self._key = os.environ.get(store.KEY_ENV)
        os.environ[store.KEY_ENV] = "test-key-for-unit-tests"
        self.s = self.make_store()
        self.s.delete_location(self.LOC)

    def tearDown(self):
        self.s.delete_location(self.LOC)
        self.s.close()
        os.environ.pop(store.KEY_ENV, None)
        if self._key is not None:
            os.environ[store.KEY_ENV] = self._key

    def ans(self, pid, mentioned, **kw):
        return {"prompt_id": pid, "mentioned": mentioned, **kw}

    def test_migrations_versioned(self):
        self.assertEqual(self.s.schema_version(), store.MIGRATIONS[-1][0])

    def test_prompts_capped_at_10(self):
        for i in range(10):
            self.s.add_prompt(self.LOC, f"p{i}")
        with self.assertRaises(StoreError) as cm:
            self.s.add_prompt(self.LOC, "one too many")
        self.assertEqual(cm.exception.code, "prompt_cap")
        self.assertEqual(len(self.s.list_prompts(self.LOC)), 10)

    def test_gemini_rejected(self):
        for eng in ("gemini", "Gemini"):
            with self.assertRaises(StoreError):
                self.s.add_run(self.LOC, eng)
        with self.assertRaises(StoreError):
            self.s.add_run(self.LOC, "openai", answers=[self.ans(1, True, engine="gemini")])
        self.assertEqual(self.s.history(self.LOC, 5), {})

    def test_trend_fixture(self):
        self.s.add_run(self.LOC, "openai", started_at="2026-01-01T00:00:00", answers=[
            self.ans(1, True), self.ans(2, False), self.ans(3, False), self.ans(4, True)])
        self.s.add_run(self.LOC, "openai", started_at="2026-01-02T00:00:00", answers=[
            self.ans(1, True), self.ans(2, True), self.ans(3, True), self.ans(4, False)])
        self.s.add_run(self.LOC, "anthropic", started_at="2026-01-03T00:00:00", answers=[self.ans(1, False)])
        self.s.add_run(self.LOC, "perplexity", started_at="2026-01-04T00:00:00")  # no answers: skipped
        t = self.s.trend(self.LOC)
        self.assertEqual([(x["engine"], x["rate"], x["answered"]) for x in t],
                         [("openai", 0.5, 4), ("openai", 0.75, 4), ("anthropic", 0.0, 1)])

    def test_history_last_n_per_engine_and_answer_fields(self):
        for i in range(4):
            self.s.add_run(self.LOC, "openai", started_at=f"2026-02-0{i + 1}T00:00:00")
        self.s.add_run(self.LOC, "anthropic", started_at="2026-02-01T00:00:00", cost_usd=0.5, answers=[
            self.ans(1, True, position=2, competitors=["A", "B"], excerpt="x" * 500, sources=["http://s"])])
        h = self.s.history(self.LOC, 2)
        self.assertEqual([r["started_at"] for r in h["openai"]], ["2026-02-04T00:00:00", "2026-02-03T00:00:00"])
        a = h["anthropic"][0]["answers"][0]
        self.assertEqual((a["mentioned"], a["position"], a["competitors"], a["sources"]), (True, 2, ["A", "B"], ["http://s"]))
        self.assertEqual(len(a["excerpt"]), 300)
        self.assertEqual(h["anthropic"][0]["cost_usd"], 0.5)

    def test_null_position(self):
        self.s.add_run(self.LOC, "openai", answers=[self.ans(1, False)])
        self.assertIsNone(self.s.history(self.LOC, 1)["openai"][0]["answers"][0]["position"])

    def test_delete_location_leaves_zero_rows(self):
        self.s.upsert_install(self.LOC, access_token="a", refresh_token="b", business_name="Biz")
        self.s.add_prompt(self.LOC, "q")
        self.s.add_run(self.LOC, "openai", answers=[self.ans(1, True)])
        self.assertGreater(self.s.count_rows(self.LOC), 0)
        self.s.delete_location(self.LOC)
        self.assertEqual(self.s.count_rows(self.LOC), 0)
        self.assertIsNone(self.s.get_install(self.LOC))
        self.assertEqual(self.s.history(self.LOC, 5), {})

    def test_prune_keeps_newest_12(self):
        ids = [self.s.add_run(self.LOC, "openai", started_at=f"2026-03-{i + 1:02d}T00:00:00",
                              answers=[self.ans(1, True)]) for i in range(15)]
        h = self.s.history(self.LOC, 100)["openai"]
        self.assertEqual([r["run_id"] for r in h], ids[:2:-1])
        self.assertEqual(len(h), 12)
        self.assertEqual(len(self.s.trend(self.LOC)), 12)

    def test_install_roundtrip_and_tokens(self):
        self.s.upsert_install(self.LOC, access_token="AT", refresh_token="RT", company_id="c1", status="trial")
        self.s.upsert_install(self.LOC, business_name="Biz")  # tokens kept
        got = self.s.get_install(self.LOC, with_tokens=True)
        self.assertEqual((got["access_token"], got["refresh_token"], got["company_id"], got["business_name"], got["status"]),
                         ("AT", "RT", "c1", "Biz", "trial"))
        self.assertNotIn("access_token", self.s.get_install(self.LOC))

    def test_tokens_need_key(self):
        os.environ.pop(store.KEY_ENV)
        with self.assertRaises(StoreError):
            self.s.upsert_install(self.LOC, access_token="AT")

    def test_spend(self):
        before = self.s.spend_total("2026-04")
        self.s.add_spend("2026-04-01", "openai", 0.25)
        self.s.add_spend("2026-04-02", "anthropic", 0.5)
        self.assertAlmostEqual(self.s.spend_total("2026-04") - before, 0.75)
        self.s.add_spend("2026-04-03", "gemini", 0.1)  # spend is cost only, not output

    def test_save_install_roundtrip_with_expiry(self):
        self.s.save_install(self.LOC, "co-test", "AT", "RT", 1234, "Location", "locations.readonly")
        d = self.s.get_install(self.LOC, with_tokens=True)
        self.assertEqual((d["access_token"], d["refresh_token"], d["expires_at"], d["user_type"], d["scopes"],
                          d["company_id"]), ("AT", "RT", 1234, "Location", "locations.readonly", "co-test"))
        self.s.save_install(self.LOC, "co-test", "AT2", "RT2", 5678, "Location", "s")   # rotated refresh token
        d = self.s.get_install(self.LOC, with_tokens=True)
        self.assertEqual((d["refresh_token"], d["expires_at"]), ("RT2", 5678))
        self.assertNotIn("access_token", self.s.get_install(self.LOC))

    def test_company_token_roundtrip(self):
        self.assertIsNone(self.s.get_company_token("co-test"))
        self.s.save_company_token("co-test", "CAT", "CRT", 99)
        self.s.save_company_token("co-test", "CAT2", "CRT2", 100)
        self.assertEqual(self.s.get_company_token("co-test"),
                         {"company_id": "co-test", "access_token": "CAT2", "refresh_token": "CRT2", "expires_at": 100})
        self.s._tx(lambda: self.s._exec("DELETE FROM company_tokens WHERE company_id=?", ("co-test",)))

    def test_update_location_only_given_fields(self):
        self.assertFalse(self.s.update_location(self.LOC, "x", None, None))
        self.assertIsNone(self.s.get_install(self.LOC))
        self.s.save_install(self.LOC, "co", "A", "R", 1, "Location", "s")
        self.assertTrue(self.s.update_location(self.LOC, "Acme", "acme.example", "Haifa"))
        self.assertTrue(self.s.update_location(self.LOC, None, None, "Tel Aviv", category="plumber"))
        d = self.s.get_install(self.LOC)
        self.assertEqual((d["business_name"], d["business_website"], d["business_city"], d["business_category"]),
                         ("Acme", "acme.example", "Tel Aviv", "plumber"))

    def test_location_dict_and_plan(self):
        self.s.save_install(self.LOC, "co", "A", "R", 1, "Location", "s")
        self.s.update_location(self.LOC, "Acme", None, "Haifa", category="plumber")
        loc = self.s.get_location(self.LOC)
        self.assertEqual((loc["id"], loc["agency_id"], loc["name"], loc["category"], loc["city"], loc["plan"], loc["active"]),
                         (self.LOC, "co", "Acme", "plumber", "Haifa", "trial", True))
        self.assertTrue(loc["installed_at"])
        self.s.upsert_install(self.LOC, plan="paid", status="inactive")
        loc = self.s.get_location(self.LOC)
        self.assertEqual((loc["plan"], loc["active"]), ("paid", False))
        self.assertIn(self.LOC, [l["id"] for l in self.s.list_locations()])

    def test_replace_prompts(self):
        self.s.add_prompt(self.LOC, "old")
        self.assertEqual([p["text"] for p in self.s.replace_prompts(self.LOC, [" a ", "", "b"])], ["a", "b"])
        with self.assertRaises(StoreError):
            self.s.replace_prompts(self.LOC, [f"p{i}" for i in range(11)])
        self.assertEqual(len(self.s.list_prompts(self.LOC)), 2)       # failed replace changed nothing
        self.assertEqual(self.s.replace_prompts(self.LOC, []), [])

    def test_claim_run_is_once(self):
        self.assertTrue(self.s.claim_run(self.LOC, "install"))
        self.assertFalse(self.s.claim_run(self.LOC, "install"))
        self.assertTrue(self.s.has_run(self.LOC, "install"))
        self.assertFalse(self.s.has_run(self.LOC, "2026-12-01"))
        self.s.delete_location(self.LOC)
        self.assertFalse(self.s.has_run(self.LOC, "install"))

    def test_spend_by_month_and_location(self):
        before = self.s.spend_total()
        self.s.add_spend("2026-12-01", "openai", 0.5, self.LOC)
        self.s.add_spend("2026-12-02", "openai", 0.25, "loc-other")
        self.s.add_spend("2027-01-01", "openai", 1.0, self.LOC)
        self.assertAlmostEqual(self.s.spend_total("2026-12", self.LOC), 0.5)
        self.assertAlmostEqual(self.s.spend_total(location_id=self.LOC), 1.5)
        self.assertAlmostEqual(self.s.spend_total() - before, 1.75)
        self.s.delete_location(self.LOC)                              # totals stay, the link goes
        self.assertAlmostEqual(self.s.spend_total() - before, 1.75)
        self.assertEqual(self.s.spend_total(location_id=self.LOC), 0)
        self.s._tx(lambda: self.s._exec("DELETE FROM spend WHERE location_id='loc-other' OR date IN "
                                        "('2026-12-01','2027-01-01')"))

    def test_delete_location_counts_claims(self):
        self.s.save_install(self.LOC, "co", "A", "R", 1, "Location", "s")
        self.s.claim_run(self.LOC, "install")
        self.assertEqual(self.s.count_rows(self.LOC), 2)
        self.s.delete_location(self.LOC)
        self.assertEqual(self.s.count_rows(self.LOC), 0)

    def test_no_key_fails_closed(self):
        os.environ.pop(store.KEY_ENV)
        for fn in (lambda: self.s.save_install(self.LOC, "co", "A", "R", 1, "Location", "s"),
                   lambda: self.s.save_company_token("co", "A", "R", 1)):
            with self.assertRaises(StoreError):
                fn()
        self.assertIsNone(self.s.get_install(self.LOC))

    def test_shared_store_accessor(self):
        store.set_store(self.s)
        try:
            self.assertIs(store.get_store(), self.s)
        finally:
            store.set_store(None)


class TestSqlite(StoreContract, unittest.TestCase):
    def make_store(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.path = os.path.join(self.tmp.name, "t.db")
        return Store("sqlite:///" + self.path)

    def tearDown(self):
        super().tearDown()
        self.tmp.cleanup()

    def test_tokens_not_plaintext_in_db_file(self):
        secret_a, secret_r = "SECRET-ACCESS-TOKEN-123", "SECRET-REFRESH-TOKEN-456"
        self.s.upsert_install(self.LOC, access_token=secret_a, refresh_token=secret_r)
        self.s.close()
        for name in os.listdir(self.tmp.name):  # db plus any journal/wal
            with open(os.path.join(self.tmp.name, name), "rb") as f:
                data = f.read()
            self.assertNotIn(secret_a.encode(), data)
            self.assertNotIn(secret_r.encode(), data)
        self.s = Store("sqlite:///" + self.path)
        self.assertEqual(self.s.get_install(self.LOC, with_tokens=True)["access_token"], secret_a)

    def test_tampered_token_rejected(self):
        self.s.upsert_install(self.LOC, access_token="AT")
        self.s._tx(lambda: self.s._exec("UPDATE installs SET access_token_enc = substr(access_token_enc, 1, 10) || 'AAAA' "
                                        "|| substr(access_token_enc, 15) WHERE location_id=?", (self.LOC,)))
        with self.assertRaises(StoreError):
            self.s.get_install(self.LOC, with_tokens=True)

    def test_reopen_is_idempotent(self):
        self.s.close()
        self.s = Store("sqlite:///" + self.path)
        self.assertEqual(self.s.schema_version(), store.MIGRATIONS[-1][0])


@unittest.skipUnless(PG_URL, "DATABASE_URL (postgres) not set")
class TestPostgres(StoreContract, unittest.TestCase):
    def make_store(self):
        return Store(PG_URL)


if __name__ == "__main__":
    unittest.main()
