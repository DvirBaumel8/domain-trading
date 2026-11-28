import os, sys, tempfile, unittest
from datetime import datetime, timezone

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from test_base import Base  # noqa: E402
import runs  # noqa: E402
import store  # noqa: E402


def T(d, h=12):
    return datetime(2026, 12, d, h, tzinfo=timezone.utc)


class Req:
    def __init__(self, headers):
        self.headers = headers


class RunsBase(Base):
    def setUp(self):
        super().setUp()
        self._cron = os.environ.pop("GHL_CRON_SECRET", None)
        os.environ["GHL_APP_ENABLED"] = "1"
        os.environ["GHL_TOKEN_KEY"] = "test-key-for-unit-tests"
        self.tmp = tempfile.TemporaryDirectory()
        self.store = store.Store("sqlite:///" + os.path.join(self.tmp.name, "t.db"))
        store.set_store(self.store)
        self.calls = []
        self._callers = dict(runs.CALLERS)
        for e in runs.ENGINES:
            runs.CALLERS[e] = self._fake(e)

    def tearDown(self):
        runs.CALLERS.update(self._callers)
        store.set_store(None)
        self.store.close()
        self.tmp.cleanup()
        os.environ.pop("GHL_CRON_SECRET", None)
        if self._cron is not None:
            os.environ["GHL_CRON_SECRET"] = self._cron
        super().tearDown()

    def _fake(self, eng):
        def f(prompt, loc):
            self.calls.append((eng, loc["id"], prompt))
            return {"text": f"1. **Rival One** - great\n2. **{loc['name']}** - ok\nsee https://x.example/a", "sources": []}
        return f

    def loc(self, i="L1", agency="A", plan="paid", installed="2026-11-20T00:00:00+00:00"):
        self.store.save_install(i, agency, "AT", "RT", 1, "Location", "s")
        self.store.update_location(i, "Acme Plumbing", None, "Austin", category="plumber")
        self.store.upsert_install(i, plan=plan)
        self.store._tx(lambda: self.store._exec("UPDATE installs SET installed_at=? WHERE location_id=?", (installed, i)))

    def runs_of(self, i, engine="openai"):
        return self.store.history(i, 50).get(engine, [])


class TestSchedule(RunsBase):
    def test_install_run_once(self):
        os.environ["OPENAI_API_KEY"] = "k"
        self.loc(installed="2026-12-01T01:00:00+00:00")
        self.assertEqual([s["key"] for s in runs.tick(T(1))["started"]], ["install"])
        for _ in range(3):
            self.assertEqual(runs.tick(T(1, 20))["started"], [])    # Dec 1 slot is covered by the install run
        self.assertEqual(len(self.calls), 10)

    def test_day1_and_day15_once(self):
        os.environ["OPENAI_API_KEY"] = "k"
        self.loc()
        runs.tick(T(1))                                            # install run
        self.assertEqual([s["key"] for s in runs.tick(T(2))["started"]], ["2026-12-01"])
        for _ in range(3):
            self.assertEqual(runs.tick(T(3))["started"], [])
        self.assertEqual([s["key"] for s in runs.tick(T(15))["started"]], ["2026-12-15"])
        self.assertEqual(runs.tick(T(15, 20))["started"], [])
        self.assertEqual(len(self.runs_of("L1")), 3)

    def test_disabled_does_nothing(self):
        os.environ["OPENAI_API_KEY"] = "k"
        os.environ["GHL_APP_ENABLED"] = "0"
        self.loc()
        self.assertEqual(runs.tick(T(1))["started"], [])
        self.assertEqual(self.calls, [])


class TestEngines(RunsBase):
    def test_missing_key_not_configured_others_run(self):
        os.environ["OPENAI_API_KEY"] = "k"
        os.environ["PERPLEXITY_API_KEY"] = "k"
        self.loc()
        runs.tick(T(1))
        self.assertEqual(self.store.history("L1", 5).keys(), {"openai", "perplexity"})   # no run row for anthropic
        self.assertEqual({c[0] for c in self.calls}, {"openai", "perplexity"})
        self.assertEqual(len(self.calls), 20)                      # one call per prompt per engine
        self.assertAlmostEqual(self.store.spend_total("2026-12", "L1"), 10 * 0.0095 + 10 * 0.0060)
        self.assertEqual(runs.execute_run(self.store.get_location("L1"), "k2", T(2))["engines"]["anthropic"]["status"],
                         "not_configured")


    def test_parse_and_prompts(self):
        os.environ["OPENAI_API_KEY"] = "k"
        self.loc()
        self.assertEqual(runs.prompts_for(self.store.list_locations()[0])[0], "best plumber in Austin")
        self.store.replace_prompts("L1", ["only this one"])
        runs.tick(T(1))
        self.assertEqual(len(self.calls), 1)
        c = self.runs_of("L1")[0]["answers"][0]
        self.assertEqual(c["prompt_id"], self.store.list_prompts("L1")[0]["id"])
        self.assertTrue(c["mentioned"])
        self.assertEqual(c["position"], 2)
        self.assertEqual(c["competitors"], ["Rival One"])
        self.assertEqual(c["sources"], ["https://x.example/a"])
        self.assertLessEqual(len(c["excerpt"]), 300)
        self.assertNotIn("text", c)
        self.assertNotIn("gemini", self.store.history("L1", 5))


class TestCaps(RunsBase):
    def test_per_location_cap_stops_before_call(self):
        os.environ["OPENAI_API_KEY"] = "k"
        os.environ["GHL_PER_LOCATION_CAP_USD"] = "0.03"
        self.loc()
        res = runs.tick(T(1))
        self.assertEqual(len(self.calls), 3)                       # 4th would pass 0.03
        self.assertEqual(res["started"][0]["status"], "cap_reached")
        self.assertLessEqual(res["started"][0]["cost_usd"], 0.03)

    def test_app_cap_stops_before_call(self):
        os.environ["OPENAI_API_KEY"] = "k"
        os.environ["GHL_MONTHLY_CAP_USD"] = "0.02"
        self.loc("L1"); self.loc("L2")
        res = runs.tick(T(1))
        self.assertEqual(len(self.calls), 2)
        self.assertEqual([s["status"] for s in res["started"]], ["cap_reached", "cap_reached"])

    def test_cap_resets_next_month(self):
        os.environ["OPENAI_API_KEY"] = "k"
        os.environ["GHL_PER_LOCATION_CAP_USD"] = "0.03"
        self.loc(installed="2026-10-01T00:00:00+00:00")
        runs.tick(T(1))
        n = len(self.calls)
        runs.tick(datetime(2027, 1, 1, tzinfo=timezone.utc))
        self.assertEqual(len(self.calls), n + 3)

    def test_trial_limit(self):
        os.environ["OPENAI_API_KEY"] = "k"
        for i in range(4):
            self.loc(f"L{i}", agency="A", plan="trial", installed=f"2026-11-2{i}T00:00:00+00:00")
        res = runs.tick(T(1))
        self.assertEqual(sorted(s["location_id"] for s in res["started"]), ["L0", "L1", "L2"])
        self.assertEqual(res["skipped_trial"], ["L3"])
        self.assertEqual({c[1] for c in self.calls}, {"L0", "L1", "L2"})


class TestAuthAndCost(RunsBase):
    def test_tick_needs_secret(self):
        os.environ["GHL_CRON_SECRET"] = "s3"
        self.assertEqual(runs.handle_tick(Req({}))[0], 401)
        self.assertEqual(runs.handle_tick(Req({"X-Cron-Secret": "bad"}))[0], 401)
        self.assertEqual(runs.handle_tick(Req({"X-Cron-Secret": "s3"}))[0], 200)

    def test_no_secret_configured_is_401(self):
        self.assertEqual(runs.handle_tick(Req({"X-Cron-Secret": ""}))[0], 401)

    def test_route_registered(self):
        routes = {}
        runs.register(routes)
        self.assertIn(("POST", "/cron/tick"), routes)

    def test_full_run_cost_under_10_cents(self):
        for eng in runs.ENGINES:
            self.assertLess(runs.cost_of_full_run(10, eng), 0.10, eng)


if __name__ == "__main__":
    unittest.main()
