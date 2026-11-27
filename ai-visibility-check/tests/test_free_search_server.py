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
from aivis import free_caps
from aivis.providers.free_search import FreeSearchProvider, GeminiSearchProvider, OpenAISearchProvider
server = tfc.server
OK = tfc.OK
TOKEN = tfc.TOKEN
KEYS = {"GEMINI_API_KEY": tfs.GKEY, "OPENAI_API_KEY": tfs.OKEY}
GROUNDED_ALL = "1. **Alpha Plumbing**\n2. **Beta Pipes**"
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

    def chain(self, g=(), o=(), caps=None):
        led = free_caps.CapLedger(caps=caps, clock=lambda: 1_780_000_000.0, load=server._cap_load, save=server._cap_save,
                                  on_cap=server.free_cap_alert)
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
        self.chain([tfs.gemini_body(text=GROUNDED_ALL)] * 8)
        r, err = self.run_free()
        self.assertEqual((r["status"], r["answers"], len(self.g.reqs), len(self.o.reqs)), ("done", 8, 8, 0))
        self.assertEqual(r["suggestions"], [SUGG])              # exact string, one copy
        self.assertEqual(r["names"]["heading"], tfc.HEADING)
        self.assertIn("Alpha Plumbing", [x["name"] for x in r["names"]["names"]])

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

    def test_live_fields_delivered_once_then_dropped(self):
        self.chain([tfs.gemini_body(text=GROUNDED_ALL)] * 8)
        r, _ = self.run_free("abcdef12-1111-1111-1111-111111111111")
        jid = "abcdef12-1111-1111-1111-111111111111"
        first = json.loads(self.req("GET", "/api/check/" + jid)[1])
        second = json.loads(self.req("GET", "/api/check/" + jid)[1])
        self.assertIn("names", first); self.assertIn("suggestions", first)
        for k in ("names", "suggestions", "citations"):
            self.assertNotIn(k, second)
        self.assertEqual((second["status"], second["answers"]), ("done", 8))


class Storage(Base):
    def test_nothing_grounded_is_persisted_gemini_and_openai(self):
        led = self.chain([tfs.gemini_body(text=GROUNDED_ALL)] * 4 + [tfs.http_err(500)] * 20,
                         [tfs.openai_body(text=GROUNDED_ALL, urls=(("https://example.org/secret-cite", "Cite Title"),))] * 8)
        r, err = self.run_free()
        self.assertEqual(r["status"], "done")
        blob = "\n".join(self.files().values()) + err
        for bad in ("Alpha Plumbing", "Beta Pipes", SUGG, "chip", "example.org", "Cite Title", "secret-cite", tfs.GKEY, tfs.OKEY):
            self.assertNotIn(bad, blob)
        caps = [p for p in self.files() if os.sep + "caps" + os.sep in p]
        self.assertEqual(len(caps), 2)                           # one record per provider, written once per check
        for p in caps:
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
        self.assertEqual((r["status"], len(self.g.reqs), len(self.o.reqs)), ("done", 0, 8))
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
        for s in (server.UNAVAILABLE_MSG, server.FAIL_MSG, server.BUSY_MSG):
            for bad in ("OpenAI", "ChatGPT", "Gemini", "gemini"):
                self.assertNotIn(bad, s)
        src = open(server.__file__).read()
        self.assertNotIn("answering from memory", src)
        self.assertIn("AI output with web search, 8 questions", src)
        self.assertIn("Names the AI gave (AI output, not verified)", open(os.path.join(os.path.dirname(HERE), "engine", "aivis", "names.py")).read())


class PaidStaysLocked(Base):
    def test_keys_do_not_unlock_paid(self):
        os.environ.pop("AIVIS_ALLOW_PAID", None)
        self.assertFalse(server.health()["allow_paid"])
        self.chain([tfs.gemini_body(text=GROUNDED_ALL)] * 8)
        self.run_free()
        self.assertFalse(server.health()["allow_paid"])
        self.assertEqual(os.environ.get("AIVIS_ALLOW_PAID"), None)


if __name__ == "__main__":
    unittest.main()
