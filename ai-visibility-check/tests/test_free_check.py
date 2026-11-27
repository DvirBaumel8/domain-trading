import contextlib, datetime, io, json, os, shutil, sys, unittest
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import test_input_limits as til          # sets up the temp store and the no-network guard
import aivis.order as order
from aivis.providers.base import Answer, ProviderError
server = til.server
OK = dict(til.OK)
HEADING = "Names the AI gave (AI output, not verified)"
TOKEN = "t" * 12 + "k" * 12 + "z" * 8      # 32 characters


class ScriptedProvider:
    """Answers question i with texts[i] or fails with reasons[i]. No network, no sleeping."""
    name, mode, paid = "pollinations", "model-memory", False
    def __init__(self, outcomes):
        self.outcomes, self.i = outcomes, 0
    def ask(self, prompt, city="", run=0):
        o = self.outcomes[self.i % len(self.outcomes)]; self.i += 1
        if o.startswith("!"):
            if o[1:].startswith("http_"):
                raise ProviderError("pollinations: " + o[1:], o[1:], "http_error", permanent=o[1:] != "http_502")
            raise ProviderError("pollinations: " + o[1:], o[1:])
        return Answer(self.name, "openai", prompt, o, [], self.mode, 0.0, run)


NAMES = "1. **Alpha Dental**\n2. **Beta Smiles**"


def alerts():
    d = os.path.join(server.LOCAL_ORDERS, "alerts")
    return sorted(os.listdir(d)) if os.path.isdir(d) else []


class Base(til.Reset):
    def setUp(self):
        super().setUp()
        shutil.rmtree(os.path.join(server.LOCAL_ORDERS, "alerts"), ignore_errors=True)
        shutil.rmtree(os.path.join(server.LOCAL_ORDERS, "leads"), ignore_errors=True)
        server.ROSTER_CACHE.clear()
        self.saved_p, self.saved_ro, self.saved_now = order.build_free_provider, server.ROSTER_OPENER, server.now
        os.environ.pop("AVC_TEST_BYPASS_TOKEN", None)

    def tearDown(self):
        order.build_free_provider, server.ROSTER_OPENER, server.now = self.saved_p, self.saved_ro, self.saved_now
        os.environ.pop("AVC_TEST_BYPASS_TOKEN", None)
        super().tearDown()

    def free(self, outcomes, niche="plumber", city="Denver, CO", jid="abcdef12-0000"):
        order.build_free_provider = lambda: ScriptedProvider(outcomes)
        err = io.StringIO()
        with contextlib.redirect_stderr(err):
            server.free_job(jid, dict(OK, niche=niche, city=city, business="Zed Co"))
        return server.JOBS[jid], err.getvalue()


class Degraded(Base):
    def test_one_good_answer_is_a_complete_check(self):
        r, err = self.free([NAMES])
        self.assertEqual((r["status"], r["answers"], r["expected"], r["named_in"]), ("done", 1, 1, 0))
        self.assertIn("free_job answers=1/1", err)
        self.assertEqual(alerts(), [])
        self.assertEqual(r["names"]["heading"], HEADING)
        self.assertEqual(r["names"]["based_on"], "")

    def test_names_page_has_no_names_and_app_keeps_based_on(self):
        r, _ = self.free([NAMES])
        page = self.req("GET", r["report"])[1].decode()     # the stored page holds derived numbers only
        self.assertNotIn("Alpha Dental", page)
        self.assertNotIn("Partial result", page)
        self.assertIn("based_on", open(os.path.join(os.path.dirname(HERE), "site", "assets", "app.js")).read())

    def test_failed_call_is_failed_with_reason_and_alert(self):
        r, err = self.free(["!rate_limited"])
        self.assertEqual((r["status"], r["answers"], r["reasons"]), ("failed", 0, {"rate_limited": 1}))
        self.assertIn("free_job answers=0/1 rate_limited=1", err)
        self.assertEqual(len(alerts()), 1)

    def test_permanent_and_transient_codes_are_counted_once(self):
        for code in ("http_403", "http_502", "timeout"):
            r, err = self.free(["!" + code], jid="abcdef1" + str(len(code)) + "-0000")
            self.assertEqual((r["status"], r["reasons"]), ("failed", {code: 1}), code)

    def test_failed_check_says_so_clearly_and_request_is_saved(self):
        server.FREE_RUN = True
        order.build_free_provider = lambda: ScriptedProvider(["!rate_limited"])
        import threading
        orig = server.free_job
        done = threading.Event()
        def wrapped(job, req):
            with contextlib.redirect_stderr(io.StringIO()):
                orig(job, req)
            done.set()
        server.free_job = wrapped
        try:
            st, data = self.post("/api/check", dict(OK, niche="plumber"))
            job = json.loads(data)["id"]
            self.assertTrue(done.wait(20))
        finally:
            server.free_job = orig
        st, data = self.req("GET", "/api/check/" + job)
        j = json.loads(data)
        self.assertEqual(j["status"], "failed")
        self.assertEqual(j["message"], "We could not get answers from the AI model right now. Please try again in a few minutes.")
        self.assertEqual(j["reasons"], {"rate_limited": 1})
        self.assertEqual(len(alerts()), 1)
        leads = server.Store().list_prefix("leads/")
        self.assertEqual(server.Store().get(leads[0])[0]["result"], "free-run")

    def test_alert_dedupe_within_the_hour(self):
        t = datetime.datetime(2026, 11, 26, 10, 5)
        server.now = lambda: t
        for i in range(3):
            self.free(["!timeout"] * 8, jid=f"abcdef1{i}-0000")
        self.assertEqual(len(alerts()), 1)
        server.now = lambda: t + datetime.timedelta(hours=1)
        self.free(["!timeout"] * 8, jid="abcdef19-0000")
        self.assertEqual(len(alerts()), 2)

    def test_alert_text_has_no_user_data(self):
        self.free(["!timeout"] * 8)
        title, body = server.alert_text("free_check", ref="free-check", status="partial")
        self.assertNotIn("Zed", title + body)

    def test_summary_line_has_no_user_text(self):
        _, err = self.free([NAMES] + ["!timeout"] * 7)
        for bad in ("Zed", "Denver", "Alpha", "http"):
            self.assertNotIn(bad, err)


class NamesShown(Base):
    NPPES = json.dumps({"results": [{"basic": {"organization_name": "ALPHA DENTAL PLLC"}, "number": 1,
                                     "addresses": [{"address_purpose": "LOCATION", "city": "DENVER"}]}]})

    def roster(self, text=None, fail=False):
        class R:
            def __init__(s, t): s.t = t
            def read(s): return s.t.encode()
            def __enter__(s): return s
            def __exit__(s, *a): return False
        calls = []
        def op(url, timeout=0):
            calls.append(url)
            if fail:
                raise OSError("down")
            return R(text or self.NPPES)
        server.ROSTER_OPENER = op
        return calls

    def test_matched_vs_unmatched_and_report_heading(self):
        self.roster()
        r, _ = self.free([NAMES + "\n3. Zed Co"] * 8, niche="dentist")
        rows = {x["name"]: x["match"] for x in r["names"]["names"]}
        self.assertEqual(rows, {"Alpha Dental": "matches a real listing", "Beta Smiles": "not found in the official register"})
        self.assertEqual(r["names"]["named_in"], 1)
        self.assertEqual(r["names"]["heading"], HEADING)
        self.assertNotIn("Alpha Dental", self.req("GET", r["report"])[1].decode())   # names are live only

    def test_roster_failure_still_returns_result(self):
        self.roster(fail=True)
        r, _ = self.free([NAMES] * 8, niche="dentist")
        self.assertEqual(r["status"], "done")
        self.assertEqual(r["names"]["register_note"], "could not verify names")
        self.assertTrue(all(x["match"] == "" for x in r["names"]["names"]))
        self.assertNotIn("Alpha Dental", self.req("GET", r["report"])[1].decode())

    def test_roster_cached_per_niche_and_city(self):
        calls = self.roster()
        self.free([NAMES] * 8, niche="dentist", jid="abcdef10-0000")
        self.free([NAMES] * 8, niche="dentist", jid="abcdef11-0000")
        self.assertEqual(len(calls), 1)

    def test_no_register_niche(self):
        calls = self.roster()
        r, _ = self.free([NAMES] * 8, niche="personal_injury_lawyer")
        self.assertEqual(calls, [])
        self.assertEqual(r["names"]["register_note"], "no official register available for this type, names not verified")
        self.assertEqual(r["names"]["heading"], HEADING)
        self.assertNotIn("Alpha Dental", self.req("GET", r["report"])[1].decode())

    def test_no_names_message(self):
        r, _ = self.free(["I'm not sure any businesses exist here."] * 8)
        self.assertEqual(r["names"]["names"], [])
        self.assertEqual(r["names"]["empty_note"], "The AI did not name any businesses in its answers.")

    def test_hostile_names_escaped_in_report(self):
        r, _ = self.free(["1. **<img src=x onerror=alert(1)>**\n2. **Gamma Plumbing**"] * 8)
        page = self.req("GET", r["report"])[1].decode()
        self.assertNotIn("img src=x", page)         # never stored; the live names are escaped by app.js (esc)
        self.assertIn("img src=x", json.dumps(r["names"]))
        self.assertIn("esc(x.name)", open(os.path.join(os.path.dirname(HERE), "site", "assets", "app.js")).read())

    def test_unmatched_names_never_called_competitors(self):
        self.roster()
        r, _ = self.free([NAMES] * 8, niche="dentist")
        self.assertNotIn("competitor", json.dumps(r["names"]).lower())
        self.assertEqual(r["names"]["matched_count"], 1)

    def test_instant_path_exposes_names_and_keeps_counts(self):
        server.FREE_RUN = False
        st, data = self.post("/api/check", dict(OK, business="Zzz Nobody", niche="dentist", city="Austin, TX"))
        j = json.loads(data)
        self.assertEqual((st, j["status"], j["answers"], j["named_in"]), (200, "instant", 20, 0))
        for k in ("competitors", "unverified_pct", "source_note"):
            self.assertIn(k, j)
        self.assertEqual(j["names"]["heading"], HEADING)
        top = j["names"]["names"]
        self.assertTrue(top and top[0]["answers"] >= top[-1]["answers"])
        self.assertTrue(all(x["match"] in ("matches a real listing", "match not confirmed") for x in top))

    def test_app_js_uses_exact_heading_source_and_escaping(self):
        js = open(os.path.join(til.ROOT, "site", "assets", "app.js"), encoding="utf-8").read()
        self.assertIn("n.heading", js)
        self.assertIn("esc(x.name)", js)


class Bypass(Base):
    def post_tok(self, tok=None, body=None, path="/api/check"):
        h = {"X-AVC-Test-Token": tok} if tok is not None else {}
        return self.post(path, body or dict(OK, niche="plumber"), h)

    def burn(self):
        server.FREE_RUN = False
        for _ in range(5):
            self.assertEqual(self.post_tok()[0], 200)

    def test_valid_token_skips_limit_and_marks_lead(self):
        os.environ["AVC_TEST_BYPASS_TOKEN"] = TOKEN
        self.burn()
        err = io.StringIO()
        with contextlib.redirect_stderr(err):
            st, data = self.post_tok(TOKEN)
        self.assertEqual(st, 200)
        self.assertIn("bypass_used", err.getvalue())
        self.assertNotIn(TOKEN, err.getvalue() + data.decode())
        recs = [server.Store().get(p)[0] for p in server.Store().list_prefix("leads/")]
        self.assertEqual([r for r in recs if r.get("bypass")][0]["result"], "saved")
        self.assertEqual(len([r for r in recs if r.get("bypass")]), 1)
        self.assertNotIn(TOKEN, json.dumps(recs))

    def test_invalid_or_missing_token_same_429(self):
        os.environ["AVC_TEST_BYPASS_TOKEN"] = TOKEN
        self.burn()
        a, b = self.post_tok("wrong" * 8), self.post_tok()
        self.assertEqual((a[0], b[0]), (429, 429))
        self.assertEqual(a[1], b[1])
        self.assertEqual(json.loads(a[1])["error"], server.BUSY_MSG)

    def test_off_when_unset_empty_or_short(self):
        for val in (None, "", "short-token", "x" * 23):
            if val is None:
                os.environ.pop("AVC_TEST_BYPASS_TOKEN", None)
            else:
                os.environ["AVC_TEST_BYPASS_TOKEN"] = val
            server.CHECK_LOG.clear()
            self.burn()
            self.assertEqual(self.post_tok(val or "")[0], 429, repr(val))
            self.assertFalse(server.bypass_ok({"X-AVC-Test-Token": val or ""}))

    def test_form_body_and_query_string_ignored(self):
        os.environ["AVC_TEST_BYPASS_TOKEN"] = TOKEN
        self.burn()
        self.assertEqual(self.post("/api/check", dict(OK, niche="plumber", token=TOKEN, bypass_token=TOKEN))[0], 429)
        self.assertNotEqual(self.post("/api/check?token=" + TOKEN, dict(OK, niche="plumber"))[0], 200)

    def test_constant_time_compare(self):
        os.environ["AVC_TEST_BYPASS_TOKEN"] = TOKEN
        seen = []
        orig = server.hmac.compare_digest
        server.hmac.compare_digest = lambda a, b: (seen.append((type(a), type(b))), orig(a, b))[1]
        try:
            self.assertTrue(server.bypass_ok({"X-AVC-Test-Token": TOKEN}))
            self.assertFalse(server.bypass_ok({"X-AVC-Test-Token": "é" * 40}))
        finally:
            server.hmac.compare_digest = orig
        self.assertEqual(seen, [(bytes, bytes)] * 2)

    def test_token_never_served(self):
        os.environ["AVC_TEST_BYPASS_TOKEN"] = TOKEN
        for p in ("/health", "/robots.txt", "/", "/assets/app.js", "/assets/config.js"):
            st, body = self.req("GET", p)
            self.assertNotIn(TOKEN.encode(), body, p)
            self.assertNotIn(b"X-AVC-Test-Token", body, p)
            self.assertNotIn(b"AVC_TEST_BYPASS", body, p)

    def test_render_yaml_has_no_value(self):
        y = open(os.path.join(til.ROOT, "render.yaml")).read()
        i = y.index("AVC_TEST_BYPASS_TOKEN")
        self.assertIn("sync: false", y[i:i + 200])
        self.assertNotIn("value", y[i:i + 140].split("sync: false")[0].split("\n", 1)[1])


if __name__ == "__main__":
    unittest.main()
