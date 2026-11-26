"""Free check with the Gemini provider at server level: daily cap, live Search Suggestions, nothing grounded stored."""
import contextlib, io, json, os, sys, threading, unittest
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import test_free_check as tfc
import aivis.order as order
from aivis.providers.base import Answer, ProviderError
from aivis.providers.gemini_free import DailyCap
til, server = tfc.til, tfc.server
OK = tfc.OK

SUGG1 = '<div class="container"><style>.chip{color:#123}</style><a class="chip" href="https://www.google.com/search?q=best+plumber">best plumber</a></div>'
SUGG2 = '<div class="container"><a class="chip" href="https://www.google.com/search?q=plumber+near+me">plumber near me</a></div>'
GROUNDED = "1. **Alpha Plumbing Grounded**\n2. **Beta Pipes Grounded**\nGROUNDED-BODY-MARKER"


class Scripted:
    name, mode, paid, attempts = "gemini-free", "web-search", False, 0
    def __init__(self, outcomes):
        self.outcomes, self.i = outcomes, 0
    def ask(self, prompt, city="", run=0):
        o = self.outcomes[self.i % len(self.outcomes)]; self.i += 1
        self.attempts += 1
        if o == "!grounding_missing":
            raise ProviderError("gemini-free: grounding_missing", "grounding_missing")
        return Answer(self.name, "gemini-2.5-flash-lite", prompt, GROUNDED, [], self.mode, 0.0, run, {}, o)


class Base(tfc.Base):
    def setUp(self):
        super().setUp()
        self.saved_cap = server.GEMINI_CAP
        self.t = [1_800_000_000.0]
        server.GEMINI_CAP = DailyCap(clock=lambda: self.t[0])
        os.environ["AVC_GEMINI_DAILY_CALL_CAP"] = "16"

    def tearDown(self):
        server.GEMINI_CAP = self.saved_cap
        os.environ.pop("AVC_GEMINI_DAILY_CALL_CAP", None)
        super().tearDown()

    def run_job(self, outcomes, jid="abcdef12-1111", reserved=True):
        order.GeminiFreeProvider = lambda: Scripted(outcomes)
        if reserved:
            server.GEMINI_CAP.reserve(8)
            server.JOB_META[jid] = {"reserved": 8}
        err = io.StringIO()
        with contextlib.redirect_stderr(err):
            server.free_job(jid, dict(OK, niche="plumber", city="Denver, CO", business="Zed Co"))
        return server.JOBS[jid], err.getvalue()


class DailyCapTests(Base):
    def post_check(self, extra=None):
        h = dict(extra or {})
        return self.post("/api/check", dict(OK, niche="plumber"), headers=h)

    def test_two_checks_run_third_is_refused_with_503_and_no_provider_call(self):
        server.FREE_RUN = True
        made = []
        order.GeminiFreeProvider = lambda: made.append(1) or Scripted([SUGG1])
        orig = server.free_job
        server.free_job = lambda job, req: None            # the cap is reserved by the request; no run needed here
        try:
            self.assertEqual(self.post_check()[0], 200)
            self.assertEqual(self.post_check()[0], 200)
            n_log = sum(len(v) for v in server.CHECK_LOG.values())
            st, data = self.post_check()
            n_after = sum(len(v) for v in server.CHECK_LOG.values())
        finally:
            server.free_job = orig
        self.assertEqual(st, 503)
        j = json.loads(data)
        self.assertEqual((j["code"], j["error"]), ("daily_cap_reached", "We have reached today's free-check limit. Please try again tomorrow."))
        self.assertEqual(made, [])
        self.assertEqual(sum(len(v) for v in server.CHECK_LOG.values()), n_after)   # a refused check is not counted
        self.t[0] += 24 * 3600                              # a Pacific day later
        server.free_job = lambda job, req: None
        try:
            self.assertEqual(self.post_check()[0], 200)
        finally:
            server.free_job = orig

    def test_bypass_token_does_not_bypass_the_cap(self):
        server.FREE_RUN = True
        os.environ["AVC_TEST_BYPASS_TOKEN"] = tfc.TOKEN
        self.assertTrue(server.GEMINI_CAP.reserve(16))
        st, data = self.post_check({"X-AVC-Test-Token": tfc.TOKEN})
        self.assertEqual((st, json.loads(data)["code"]), (503, "daily_cap_reached"))

    def test_no_technical_text_for_the_visitor(self):
        server.FREE_RUN = True
        server.GEMINI_CAP.reserve(16)
        body = self.post_check()[1].decode().lower()
        for bad in ("gemini", "quota", "google", "key"):
            self.assertNotIn(bad, body)

    def test_quota_error_refuses_next_check(self):
        server.FREE_RUN = True
        server.GEMINI_CAP.mark_exhausted()
        self.assertEqual(self.post_check()[0], 503)

    def test_reservation_is_settled_to_real_attempts(self):
        self.run_job([SUGG1] * 8)
        self.assertEqual(server.GEMINI_CAP.used, 8)
        self.run_job([SUGG1] * 8, jid="abcdef12-2222")
        self.assertEqual(server.GEMINI_CAP.used, 16)
        self.assertFalse(server.GEMINI_CAP.reserve(8))

    def test_unspent_reservation_is_given_back(self):
        order.GeminiFreeProvider = lambda: Scripted([])
        class Unconfigured(Scripted):
            def ask(self, *a, **k):
                raise ProviderError("gemini-free: provider_not_configured", "provider_not_configured", permanent=True)
        order.GeminiFreeProvider = lambda: Unconfigured([])
        server.GEMINI_CAP.reserve(8); server.JOB_META["abcdef12-3333"] = {"reserved": 8}
        with contextlib.redirect_stderr(io.StringIO()):
            server.free_job("abcdef12-3333", dict(OK, niche="plumber", city="Denver, CO", business="Zed Co"))
        self.assertEqual(server.GEMINI_CAP.used, 0)
        self.assertEqual(server.JOBS["abcdef12-3333"]["reasons"], {"provider_not_configured": 3, "skipped_after_permanent_errors": 5})


class LiveSuggestions(Base):
    def test_suggestions_are_returned_unmodified_and_once(self):
        r, _ = self.run_job([SUGG1, SUGG2] * 4)
        self.assertEqual(r["status"], "done")
        self.assertEqual(r["suggestions"], [SUGG1, SUGG2])           # exact strings, deduplicated
        self.assertEqual(r["names"]["heading"], tfc.HEADING)
        self.assertEqual(r["note"], "Free quick check: one AI model with Google Search grounding, 8 questions.")
        jid = "abcdef12-1111-0000-0000-000000000000"
        server.JOBS[jid] = dict(r); server.JOB_META[jid] = {"finished": server.clock()}
        st, data = self.req("GET", "/api/check/" + jid)
        got = json.loads(data)
        self.assertEqual(got["suggestions"], [SUGG1, SUGG2])
        self.assertEqual(got["names"]["heading"], tfc.HEADING)
        st, data = self.req("GET", "/api/check/" + jid)          # a later view: counts and flags only
        later = json.loads(data)
        for k in ("names", "suggestions"):
            self.assertNotIn(k, later)
        self.assertEqual((later["status"], later["answers"]), ("done", 8))
        for n in ("Alpha Plumbing", "google.com/search", "GROUNDED"):
            self.assertNotIn(n, data.decode())

    def test_missing_suggestions_are_not_invented_and_text_not_shown(self):
        r, _ = self.run_job([SUGG1] * 6 + ["!grounding_missing"] * 2)
        self.assertEqual((r["status"], r["answers"], r["reasons"]), ("done", 6, {"grounding_missing": 2}))
        self.assertEqual(r["suggestions"], [SUGG1])
        r2, _ = self.run_job(["!grounding_missing"] * 8, jid="abcdef12-4444")
        self.assertEqual(r2["status"], "failed")
        self.assertNotIn("suggestions", r2)
        self.assertNotIn("GROUNDED-BODY-MARKER", json.dumps(r2))
        self.assertNotIn("Alpha Plumbing", json.dumps(r2))

    def test_partial_label_unchanged_and_grounding_missing_not_counted(self):
        r, _ = self.run_job([SUGG1] * 3 + ["!grounding_missing"] * 5)
        self.assertEqual((r["status"], r["message"]), ("partial", "Partial result: 3 of 8 questions answered"))
        self.assertEqual(r["names"]["based_on"], "based on 3 of 8 answers")
        self.assertEqual(r["names"]["heading"], tfc.HEADING)

    def test_front_end_shows_suggestions_without_editing_them(self):
        js = open(os.path.join(til.ROOT, "site", "assets", "app.js"), encoding="utf-8").read()
        self.assertIn("showSuggestions(p, j.suggestions)", js)
        self.assertIn("fr.srcdoc =", js)
        self.assertNotIn("replace(", js[js.index("function showSuggestions"):js.index("function render")])


class NothingGroundedIsStored(Base):
    def all_files(self):
        out = []
        for root in (server.LOCAL_ORDERS, server.DATA):
            for d, _, fs in os.walk(root):
                for f in fs:
                    p = os.path.join(d, f)
                    try:
                        out.append((p, open(p, encoding="utf-8", errors="replace").read()))
                    except OSError:
                        pass
        return out

    def test_persisted_artifacts_hold_no_grounded_text_names_or_suggestions(self):
        server.FREE_RUN = True
        r, err = self.run_job([SUGG1, SUGG2] * 4)
        self.assertEqual(r["names"]["names"][0]["name"], "Alpha Plumbing Grounded")      # live: names are shown
        needles = ["GROUNDED-BODY-MARKER", "Alpha Plumbing", "Beta Pipes", SUGG1, SUGG2, "best plumber", "plumber near me",
                   "google.com/search"]
        seen = [(p, t) for p, t in self.all_files() if "free/FREE-abcdef12" in p.replace("\\", "/")]
        self.assertTrue(seen)                                                            # the derived page is stored
        for p, text in self.all_files() + [("stderr", err)]:
            for n in needles:
                self.assertNotIn(n, text, (p, n))
        page = self.req("GET", r["report"])[1].decode()                                  # a later view
        for n in needles:
            self.assertNotIn(n, page)
        self.assertIn("named", page.lower())

    def test_free_run_writes_no_grounded_answers_to_disk(self):
        import tempfile
        calls = []
        orig = order.run_order
        def spy(o, mode, out_dir, **kw):
            res = orig(o, mode, out_dir=out_dir, **kw)
            calls.append(sorted(os.listdir(os.path.join(out_dir, o.order_id))))
            with open(os.path.join(out_dir, o.order_id, "answers.json")) as fh:
                calls.append(json.load(fh))                  # grounded answers are left out of the file
            return res
        order.run_order = spy
        try:
            self.run_job([SUGG1] * 8)
        finally:
            order.run_order = orig
        self.assertEqual(calls, [["answers.json", "order-log.json"], []])   # no report page; answers.json is empty

    def test_summary_page_helper_uses_counts_only(self):
        page = server.free_summary_page(5, 8, None, {"timeout": 3})
        self.assertIn("Partial result: 5 of 8 questions answered", page)
        self.assertIn("Do not rely on these numbers.", page)
        self.assertIn("timeout 3", page)


if __name__ == "__main__":
    unittest.main()
