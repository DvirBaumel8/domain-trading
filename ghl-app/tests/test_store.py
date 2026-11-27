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
        self.assertEqual(self.s.schema_version(), 1)


@unittest.skipUnless(PG_URL, "DATABASE_URL (postgres) not set")
class TestPostgres(StoreContract, unittest.TestCase):
    def make_store(self):
        return Store(PG_URL)


if __name__ == "__main__":
    unittest.main()
