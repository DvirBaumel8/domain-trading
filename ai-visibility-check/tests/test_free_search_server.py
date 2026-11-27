"""Free check on the server: provider order, monthly caps and alert, 503 when unavailable, live-only display,
derived-only storage, no key leaks, paid mode still locked. Fully offline: both vendors are scripted openers."""
import contextlib, io, json, os, sys, unittest
from unittest import mock
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
sys.path.insert(0, os.path.join(HERE, "..", "engine", "tests"))
import test_free_check as tfc
import test_free_search as tfs
import aivis.order as order
from aivis import free_caps, free_config as fc
from aivis.providers.free_search import FreeSearchProvider, GeminiSearchProvider, OpenAISearchProvider
server = tfc.server
OK = tfc.OK
TOKEN = tfc.TOKEN
KEYS = {"GEMINI_API_KEY": tfs.GKEY, "OPENAI_API_KEY": tfs.OKEY}
GROUNDED_ALL = json.dumps({"businesses": ["Alpha Plumbing", "Beta Pipes"], "note": ""})
SUGG = tfs.SUGG


class Base(tfc.Base):
    def setUp(self):
        super().setUp()
        self.env = mock.patch.dict(os.environ, KEYS)
        self.env.start()
        self.sent = []
        self.saved_http, self.saved_hook = server.http_call, os.environ.get("ORDER_ALERT_WEBHOOK_URL")
        os.environ["ORDER_ALERT_WEBHOOK_URL"] = "https://hooks.example.test/x"
        def fake(req, timeout=15):
            self.sent.append(json.loads(req.data))
            return 200, b"ok"
        server.http_call = fake
        self.saved_ledger = free_caps.LEDGER
        self.saved_free_job = server.free_job
        shutil_rm = __import__("shutil").rmtree
        shutil_rm(os.path.join(server.LOCAL_ORDERS, "caps"), ignore_errors=True)

    def tearDown(self):
        server.http_call = self.saved_http
        if self.saved_hook is None:
            os.environ.pop("ORDER_ALERT_WEBHOOK_URL", None)
        else:
            os.environ["ORDER_ALERT_WEBHOOK_URL"] = self.saved_hook
        free_caps.install(self.saved_ledger)
        self.env.stop()
        super().tearDown()

    def chain(self, g=(), o=(), caps=None, now=None, **kw):
        led = free_caps.CapLedger(caps=caps, clock=now or (lambda: 1_780_000_000.0), load=server._cap_load,
                                  save=server._cap_save, on_cap=server.free_cap_alert,
                                  load_day=server._day_load, save_day=server._day_save, **kw)
        free_caps.install(led)
        self.g, self.o = tfs.Fake(g), tfs.Fake(o)
        order.build_free_provider = lambda: FreeSearchProvider(
            [GeminiSearchProvider(opener=self.g, sleep=lambda s: None, ledger=led),
             OpenAISearchProvider(opener=self.o, sleep=lambda s: None, ledger=led)], ledger=led)
        return led

    def run_free(self, jid="abcdef12-0000"):
        err = io.StringIO()
        with contextlib.redirect_stderr(err), contextlib.redirect_stdout(err):
            server.free_job(jid, dict(OK, niche="plumber", city="Denver, CO", business="Zed Co"))
        return server.JOBS[jid], err.getvalue()

    def files(self):
        out = {}
        for d, _, fs in os.walk(server.LOCAL_ORDERS):
            for f in fs:
                p = os.path.join(d, f)
                with open(p, encoding="utf-8", errors="replace") as fh:
                    out[p] = fh.read()
        return out


class Order(Base):
    def test_gemini_ok_no_openai_and_live_suggestions_exact(self):
        self.chain([tfs.gemini_body()] * 8)
        r, err = self.run_free()
        self.assertEqual((r["status"], r["answers"], len(self.g.reqs), len(self.o.reqs)), ("done", 1, 1, 0))     # one call, no hidden retry
        self.assertEqual(r["suggestions"], [SUGG])              # exact string, one copy
        self.assertEqual(r["names"]["heading"], tfc.HEADING)
        self.assertIn("Alpha Plumbing", [x["name"] for x in r["names"]["names"]])
        self.assertIn(r["named_in"], (0, 1))                   # a named / not-named outcome is produced
        self.assertEqual(json.loads(self.g.reqs[0].data)["tools"], [{"google_search": {}}])

    def test_suggestions_absent_means_nothing_shown(self):
        self.chain([tfs.gemini_body(rendered="")] * 24, [tfs.openai_body()] * 8)
        r, err = self.run_free()
        self.assertNotIn("suggestions", {k: v for k, v in r.items() if v})
        self.assertNotIn("Suggestions", json.dumps(r))
        self.assertIn("gemini:grounding_missing", err)         # the hidden failure is in the log line

    def test_fallback_citations_are_live_links(self):
        self.chain([tfs.http_err(500)] * 40, [tfs.openai_body(text=GROUNDED_ALL, urls=(("https://example.org/a", "Page A"),
                                                                                       ("https://example.org/b", "Page B")))] * 8)
        r, err = self.run_free()
        self.assertEqual(r["status"], "done")
        self.assertEqual([c["url"] for c in r["citations"]], ["https://example.org/a", "https://example.org/b"])
        self.assertEqual(r["suggestions"], [])
        js = open(os.path.join(os.path.dirname(HERE), "site", "assets", "app.js")).read()
        self.assertIn('<a href="${esc(c.url)}" target="_blank" rel="noopener noreferrer">', js)
        self.assertIn("Sources the AI searched (AI output, not verified)", js)
        self.assertNotIn("Sources the AI cited", js)

    def test_live_suggestions_and_citations_once_and_never_stored(self):
        self.chain([tfs.gemini_body()] * 3, [tfs.openai_body(text=GROUNDED_ALL, urls=(("https://example.org/zz-live", "Live Title"),))] * 3)
        jid = "abcdef12-2222-2222-2222-222222222222"
        r, err = self.run_free(jid)
        self.assertEqual(r["suggestions"], [SUGG])
        first = json.loads(self.req("GET", "/api/check/" + jid)[1])
        second = json.loads(self.req("GET", "/api/check/" + jid)[1])
        self.assertEqual(first["suggestions"], [SUGG])
        for k in ("suggestions", "citations"):
            self.assertNotIn(k, second)
        blob = "\n".join(self.files().values()) + err + self.req("GET", first["report"])[1].decode()
        for bad in (SUGG, "chip", "zz-live", "Live Title"):
            self.assertNotIn(bad, blob)

    def test_live_fields_delivered_once_then_dropped(self):
        self.chain([tfs.gemini_body()] * 8)
        r, _ = self.run_free("abcdef12-1111-1111-1111-111111111111")
        jid = "abcdef12-1111-1111-1111-111111111111"
        first = json.loads(self.req("GET", "/api/check/" + jid)[1])
        second = json.loads(self.req("GET", "/api/check/" + jid)[1])
        self.assertIn("names", first); self.assertIn("suggestions", first)
        for k in ("names", "suggestions", "citations"):
            self.assertNotIn(k, second)
        self.assertEqual((second["status"], second["answers"]), ("done", 1))


class OneCall(Base):
    """Acceptance 1-3 and 6: one vendor call per check; a second loop or hidden retry fails these."""
    def test_happy_path_exactly_one_gemini_call_zero_openai(self):
        self.chain([tfs.gemini_body()] * 5, [tfs.openai_body(text=GROUNDED_ALL)] * 5)
        r, _ = self.run_free()
        self.assertEqual((r["status"], len(self.g.reqs), len(self.o.reqs)), ("done", 1, 0))
        self.assertEqual(r["suggestions"], [SUGG])
        self.assertEqual({x["name"] for x in r["names"]["names"]}, {"Alpha Plumbing", "Beta Pipes"})
        self.assertEqual(free_caps.LEDGER.spent("gemini"), fc.cost_usd("gemini", 100, 250, 2))   # one call settled

    def test_check_cost_is_one_call_under_five_cents(self):
        self.assertEqual(fc.check_usd("gemini"), fc.reserve_usd("gemini"))
        self.assertLessEqual(fc.check_usd("gemini"), 0.05)
        self.assertEqual(fc.QUESTIONS_PER_CHECK, 1)

    def test_fallback_exactly_one_openai_call_with_citations(self):
        for g in ([http_err_500()] * 3, [tfs.http_err(429, b'{"error":{"status":"RESOURCE_EXHAUSTED"}}')], []):
            self.chain(g, [tfs.openai_body(text=GROUNDED_ALL, urls=(("https://example.org/a", "Page A"),))] * 3)
            with mock.patch.dict(os.environ, {"GEMINI_API_KEY": ""} if not g else {}):
                r, _ = self.run_free()
            self.assertEqual((r["status"], len(self.o.reqs)), ("done", 1))
            self.assertEqual([c["url"] for c in r["citations"]], ["https://example.org/a"])
        self.chain([], [tfs.openai_body(text=GROUNDED_ALL)] * 3, caps={"gemini": 0.01, "openai": 5.0})     # Gemini cap
        r, _ = self.run_free()
        self.assertEqual((r["status"], len(self.g.reqs), len(self.o.reqs)), ("done", 0, 1))

    def test_unstructured_reply_is_not_a_complete_check(self):
        self.chain([tfs.gemini_body(text="Sorry, I cannot help.")] * 3, [tfs.openai_body(text="not json")] * 3)
        r, err = self.run_free()
        self.assertEqual(r["status"], "failed")
        self.assertIn("parse_error", err)

    def test_persisted_files_hold_no_names_text_or_links(self):
        self.chain([tfs.gemini_body()])
        self.run_free()
        blob = "\n".join(self.files().values())
        for bad in ("Alpha Plumbing", "Beta Pipes", SUGG, "example.org", "chip"):
            self.assertNotIn(bad, blob)


def http_err_500():
    return tfs.http_err(500)


class Daily(Base):
    """Acceptance 4 and 5: the daily USD and check-count limits (UTC day), on top of the monthly caps."""
    T0 = 1_780_000_000.0        # 2026-05-28 20:26 UTC

    def post_check(self, hdr=None):
        return self.post("/api/check", dict(OK, niche="plumber", city="Denver, CO"), hdr or {})

    def setUp(self):
        super().setUp()
        server.FREE_RUN = True
        self.now = [self.T0]
        server.free_job = lambda job, req: server.finish_job(job, {"status": "done"})   # no vendor in the POST tests

    def tearDown(self):
        server.free_job = self.saved_free_job
        super().tearDown()

    def test_usd_cap_refuses_without_a_vendor_call_and_resets_next_day(self):
        self.chain([tfs.gemini_body()] * 6, [tfs.openai_body(text=GROUNDED_ALL)] * 6,
                   now=lambda: self.now[0], daily_caps={"gemini": 0.06, "openai": 0.01}, daily_max=100)
        server.free_job = self.saved_free_job
        r, _ = self.run_free()
        self.assertEqual((r["status"], len(self.g.reqs), len(self.o.reqs)), ("done", 1, 0))
        os.environ["AVC_TEST_BYPASS_TOKEN"] = TOKEN
        for hdr in ({}, {}, {"X-AVC-Test-Token": TOKEN}):           # refused again and again, token or not
            st, data = self.post_check(hdr)
            self.assertEqual(st, 503)
            j = json.loads(data)
            self.assertEqual((j["error"], j["reason"]), (server.DAILY_MSG, "daily_cap_reached"))
            for bad in ("gemini", "Gemini", "OpenAI", "ChatGPT", "cap_reached", "Traceback"):
                self.assertNotIn(bad, j["error"])
        self.assertEqual((len(self.g.reqs), len(self.o.reqs)), (1, 0))
        self.assertEqual(server.CHECK_LOG, {})
        r, err = self.run_free("abcdef12-0009")                     # a job that slipped through is refused too, no crash
        self.assertEqual(r["status"], "unavailable")
        self.assertEqual(r["message"], server.DAILY_MSG)
        self.assertIn("reason=daily_cap_reached", err)
        self.assertEqual((len(self.g.reqs), len(self.o.reqs)), (1, 0))
        self.now[0] += 86400                                        # next UTC day
        r, _ = self.run_free("abcdef12-0010")
        self.assertEqual((r["status"], len(self.g.reqs)), ("done", 2))

    def test_global_ceiling_env_refuses_even_with_provider_room(self):
        self.chain(now=lambda: self.now[0], daily_max=100)
        with mock.patch.dict(os.environ, {"AVC_FREE_DAILY_CAP_USD": "0.01"}):
            st, data = self.post_check()
        self.assertEqual((st, json.loads(data)["reason"]), (503, "daily_cap_reached"))
        self.assertEqual((self.g.reqs, self.o.reqs), ([], []))
        with mock.patch.dict(os.environ, {"AVC_FREE_DAILY_CAP_USD": "nonsense"}):
            self.assertIsNone(fc.daily_global_cap_usd())
            self.assertEqual(self.post_check()[0], 200)

    def test_default_slice_is_monthly_cap_over_days_in_month(self):
        led = self.chain(now=lambda: self.now[0])
        self.assertAlmostEqual(led.daily_cap("gemini"), 10.0 / 31, places=6)        # May has 31 days
        self.assertAlmostEqual(led.daily_cap("openai"), 5.0 / 31, places=6)
        self.now[0] = 1_782_000_000.0                                               # June: 30 days
        self.assertAlmostEqual(led.daily_cap("gemini"), 10.0 / 30, places=6)

    def test_max_checks_per_day_and_instant_results_do_not_count(self):
        led = self.chain(now=lambda: self.now[0], daily_max=2)
        instant = dict(OK, niche="dentist", city="Austin, TX")
        for _ in range(2):
            st, data = self.post("/api/check", instant)
            self.assertEqual(json.loads(data)["status"], "instant")
        self.assertEqual(self.post_check()[0], 200)
        self.assertEqual(self.post_check()[0], 200)
        for hdr in ({}, {"X-AVC-Test-Token": TOKEN}):
            os.environ["AVC_TEST_BYPASS_TOKEN"] = TOKEN
            st, data = self.post_check(hdr)
            self.assertEqual((st, json.loads(data)["error"]), (503, server.DAILY_MSG))
        self.assertEqual(self.post("/api/check", instant)[0], 200)      # cached results still served
        self.assertEqual((self.g.reqs, self.o.reqs), ([], []))
        self.now[0] += 86400
        server.CHECK_LOG.clear()            # the per-address hourly limit is a separate rule
        self.assertEqual(self.post_check()[0], 200)

    def test_counters_survive_a_restart_and_hold_only_counts(self):
        led = self.chain(now=lambda: self.now[0], daily_max=5)
        self.assertEqual(self.post_check()[0], 200)
        led.flush()
        led2 = free_caps.CapLedger(clock=lambda: self.now[0], load_day=server._day_load, save_day=server._day_save)
        self.assertEqual(led2._day_rec()["checks"], 1)
        rec = [v for p, v in self.files().items() if "daily-" in p]
        self.assertEqual(len(rec), 1)
        self.assertEqual(set(json.loads(rec[0])), {"day", "checks", "spent_usd", "alerted"})

    def test_max_checks_env_parsing(self):
        for raw, want in (("", 8), ("0", 8), ("-3", 8), ("x", 8), ("2.5", 8), ("3", 3)):
            with mock.patch.dict(os.environ, {"AVC_FREE_DAILY_MAX_CHECKS": raw}):
                self.assertEqual(fc.daily_max_checks(), want, raw)

    def test_monthly_message_is_unchanged_when_both_months_are_capped(self):
        self.chain(caps={"gemini": 0.01, "openai": 0.01}, now=lambda: self.now[0])
        st, data = self.post_check()
        self.assertEqual((st, json.loads(data)["error"]), (503, server.UNAVAILABLE_MSG))


class Storage(Base):
    def test_nothing_grounded_is_persisted_gemini_and_openai(self):
        led = self.chain([tfs.http_err(500)] * 20,
                         [tfs.openai_body(text=GROUNDED_ALL, urls=(("https://example.org/secret-cite", "Cite Title"),))] * 8)
        r, err = self.run_free()
        self.assertEqual(r["status"], "done")
        blob = "\n".join(self.files().values()) + err
        for bad in ("Alpha Plumbing", "Beta Pipes", SUGG, "chip", "example.org", "Cite Title", "secret-cite", tfs.GKEY, tfs.OKEY):
            self.assertNotIn(bad, blob)
        caps = [p for p in self.files() if os.sep + "caps" + os.sep in p]
        self.assertEqual(len(caps), 3)                           # two provider records and one daily record
        for p in caps:
            if "daily-" in p:
                self.assertEqual(set(json.loads(self.files()[p])), {"day", "checks", "spent_usd", "alerted"})
                continue
            self.assertEqual(set(json.loads(self.files()[p])), {"provider", "month", "calls", "searches", "input_tokens",
                                                                "output_tokens", "spent_usd", "alerted"})
        page = self.req("GET", r["report"])[1].decode()          # the later view
        self.assertIn("named in", page) if r.get("named_in") else self.assertIn("not named", page)
        self.assertNotIn("Alpha Plumbing", page)


class Caps(Base):
    def test_cap_alert_once_and_fallback(self):
        self.chain([], [tfs.openai_body(text=GROUNDED_ALL)] * 16, caps={"gemini": 0.01, "openai": 5.0})
        r, err = self.run_free()
        self.assertEqual((r["status"], len(self.g.reqs)), ("done", 0))
        r, err2 = self.run_free("abcdef12-0002")
        caps = [m for m in self.sent if "monthly cap" in m["text"]]
        self.assertEqual(len(caps), 1)
        self.assertIn("free_cap provider=gemini reason=cap_reached", err)
        self.assertNotIn("Zed Co", caps[0]["text"]); self.assertNotIn("Denver", caps[0]["text"])
        self.assertNotIn("test-key", caps[0]["text"])
        self.assertIn("month 2026-05", caps[0]["text"])

    def test_both_capped_is_503_even_with_bypass_token(self):
        self.chain(caps={"gemini": 0.01, "openai": 0.01})
        server.FREE_RUN = True
        os.environ["AVC_TEST_BYPASS_TOKEN"] = TOKEN
        for hdr in ({}, {"X-AVC-Test-Token": TOKEN}):
            st, data = self.post("/api/check", dict(OK, niche="plumber"), hdr)
            self.assertEqual(st, 503)
            msg = json.loads(data)["error"]
            self.assertIn("temporarily unavailable", msg)
            for bad in ("cap_reached", "gemini", "openai", "OpenAI", "ChatGPT", "Traceback"):
                self.assertNotIn(bad, data.decode())
        self.assertEqual((self.g.reqs, self.o.reqs), ([], []))
        self.assertEqual(len([m for m in self.sent if "monthly cap" in m["text"]]), 2)      # one per provider, not per refusal
        self.assertEqual(server.CHECK_LOG, {})                   # a refusal does not use up the visitor's hourly limit

    def test_unset_keys(self):
        self.chain([], [tfs.openai_body(text=GROUNDED_ALL)] * 8)
        with mock.patch.dict(os.environ, {"GEMINI_API_KEY": ""}):
            r, err = self.run_free()
        self.assertEqual((r["status"], len(self.g.reqs), len(self.o.reqs)), ("done", 0, 1))
        self.chain()
        with mock.patch.dict(os.environ, {"GEMINI_API_KEY": "", "OPENAI_API_KEY": ""}):
            r, err = self.run_free("abcdef12-0003")
        self.assertEqual(r["status"], "unavailable")
        self.assertIn("temporarily unavailable", r["message"])
        self.assertEqual((self.g.reqs, self.o.reqs), ([], []))
        self.assertIn("provider_not_configured=1", err)
        self.assertNotIn("Traceback", err)

    def test_keys_never_leak_on_errors(self):
        errs = [tfs.http_err(429, b"%s" % tfs.GKEY.encode()), tfs.http_err(500, tfs.OKEY.encode()), TimeoutError(tfs.GKEY),
                tfs.http_err(403, tfs.GKEY.encode()), "{" + tfs.OKEY]
        self.chain(errs * 10, errs * 10)
        r, err = self.run_free()
        blob = json.dumps(r) + err + "\n".join(self.files().values()) + json.dumps(self.sent)
        self.assertNotIn("test-key-not-real", blob)
        self.assertNotIn("test-key-not-real", "".join(q.full_url for q in self.g.reqs + self.o.reqs))


class Wording(Base):
    def test_no_vendor_names_in_user_facing_free_copy(self):
        js = open(os.path.join(os.path.dirname(HERE), "site", "assets", "app.js")).read()
        for bad in ("OpenAI", "ChatGPT"):
            self.assertNotIn(bad, js)
        for s in (server.UNAVAILABLE_MSG, server.FAIL_MSG, server.BUSY_MSG, server.DAILY_MSG):
            for bad in ("OpenAI", "ChatGPT", "Gemini", "gemini"):
                self.assertNotIn(bad, s)
        src = open(server.__file__).read()
        self.assertNotIn("answering from memory", src)
        self.assertIn("AI output with web search.", src)
        self.assertIn("Names the AI gave (AI output, not verified)", open(os.path.join(os.path.dirname(HERE), "engine", "aivis", "names.py")).read())


class PaidStaysLocked(Base):
    def test_keys_do_not_unlock_paid(self):
        os.environ.pop("AIVIS_ALLOW_PAID", None)
        self.assertFalse(server.health()["allow_paid"])
        self.chain([tfs.gemini_body()] * 8)
        self.run_free()
        self.assertFalse(server.health()["allow_paid"])
        self.assertEqual(os.environ.get("AIVIS_ALLOW_PAID"), None)


if __name__ == "__main__":
    unittest.main()
