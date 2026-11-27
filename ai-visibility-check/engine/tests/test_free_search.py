"""Free-check providers: Gemini (Search grounding) then OpenAI (web_search), monthly caps, reason codes. Offline."""
import io, json, os, tempfile, unittest, urllib.error
from contextlib import redirect_stderr, redirect_stdout
from email.message import Message
from unittest import mock

from aivis import config, free_caps, free_config as fc
from aivis.providers.base import ProviderError
from aivis.providers.free_search import FreeSearchProvider, GeminiSearchProvider, OpenAISearchProvider

GKEY, OKEY = "test-key-not-real-gemini", "test-key-not-real-openai"
SUGG = '<div class="container"><a class="chip" href="https://www.google.com/search?q=x">plumbers</a></div>'
GROUNDED = json.dumps({"businesses": ["Alpha Plumbing", "Beta Pipes"], "note": ""})


LIST = "1. Alpha Plumbing\n2. Beta Pipes"


def gemini_body(text=LIST, rendered=SUGG, queries=("q1",), usage=True, grounded=True):
    meta = {"webSearchQueries": list(queries), "searchEntryPoint": {"renderedContent": rendered}} if grounded else {}
    cand = {"content": {"parts": [{"text": text}]}, **({"groundingMetadata": meta} if grounded else {})}
    d = {"candidates": [cand]}
    if usage:
        d["usageMetadata"] = {"promptTokenCount": 100, "candidatesTokenCount": 200, "thoughtsTokenCount": 50}
    return d


def openai_body(text=GROUNDED, urls=(("https://example.org/a", "Page A"),), calls=1, usage=True):
    ann = [{"type": "url_citation", "url": u, "title": t, "start_index": 0, "end_index": 1} for u, t in urls]
    out = [{"type": "web_search_call"}] * calls + [{"type": "message", "content": [{"type": "output_text", "text": text, "annotations": ann}]}]
    return {"output": out, **({"usage": {"input_tokens": 300, "output_tokens": 100}} if usage else {})}


class Resp:
    def __init__(self, obj): self.b = (obj if isinstance(obj, str) else json.dumps(obj)).encode()
    def read(self): return self.b
    def __enter__(self): return self
    def __exit__(self, *a): return False


def http_err(code, body=b"", retry_after=None):
    h = Message()
    if retry_after is not None:
        h["Retry-After"] = str(retry_after)
    return urllib.error.HTTPError("https://x/", code, "m", h, io.BytesIO(body))


class Fake:
    """Scripted opener: records every Request. Items are dicts/strings (200 body) or exceptions."""
    def __init__(self, script=()):
        self.script, self.reqs = list(script), []
    def __call__(self, req, timeout=0):
        self.reqs.append(req)
        x = self.script.pop(0) if self.script else gemini_body()
        if isinstance(x, Exception):
            raise x
        return Resp(x)
    def hosts(self):
        return [urllib.parse.urlsplit(r.full_url).netloc for r in self.reqs]


import urllib.parse


def ledger(caps=None, t=None, **kw):
    now = [1_780_000_000.0 if t is None else t]
    kw.setdefault("daily_caps", {"gemini": 1e9, "openai": 1e9})     # the daily limits have their own tests
    kw.setdefault("daily_max", 10 ** 6)
    led = free_caps.CapLedger(caps=caps, clock=lambda: now[0], **kw)
    led.now = now
    return led


def providers(g_script=(), o_script=(), led=None):
    led = led or ledger()
    g, o = Fake(g_script), Fake(o_script)
    gp = GeminiSearchProvider(opener=g, sleep=lambda s: None, ledger=led)
    op = OpenAISearchProvider(opener=o, sleep=lambda s: None, ledger=led)
    return FreeSearchProvider([gp, op], ledger=led), g, o, led


class Env(unittest.TestCase):
    def setUp(self):
        self.patch = mock.patch.dict(os.environ, {"GEMINI_API_KEY": GKEY, "OPENAI_API_KEY": OKEY}, clear=False)
        self.patch.start()
        os.environ.pop("AVC_GEMINI_MODEL", None)

    def tearDown(self):
        self.patch.stop()


class GeminiShape(Env):
    def test_request_is_header_keyed_and_uses_search_tool(self):
        p, g, o, _ = providers()
        a = p.ask("best plumber in Austin, TX?")
        r = g.reqs[0]
        self.assertEqual(r.full_url, "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash-lite:generateContent")
        self.assertEqual(r.get_header("X-goog-api-key"), GKEY)
        self.assertNotIn(GKEY, r.full_url)
        body = json.loads(r.data)
        self.assertEqual(body["tools"], [{"google_search": {}}])
        text = body["contents"][0]["parts"][0]["text"]
        self.assertTrue(text.startswith("best plumber in Austin, TX?"))
        self.assertIn("Search Google and Google Maps", text)
        self.assertNotIn("You must run one Google Search", text)
        self.assertNotIn("Reply with only JSON", text)
        self.assertIn("numbered list", text)
        self.assertEqual(o.reqs, [])
        self.assertEqual(a.live["suggestions"], SUGG)           # exact string, unmodified
        self.assertEqual(a.provider, "ai-search")

    def test_model_env_override_and_default(self):
        self.assertEqual(GeminiSearchProvider().model, "gemini-3.5-flash-lite")
        with mock.patch.dict(os.environ, {"AVC_GEMINI_MODEL": "gemini-x"}):
            self.assertEqual(GeminiSearchProvider().model, "gemini-x")

    def test_grounding_missing_without_metadata_or_suggestions(self):
        for body in (gemini_body(grounded=False), gemini_body(rendered=""), gemini_body(rendered="   ")):
            p, g, o, _ = providers([body] * 3, [])
            gp = p.members[0]
            with self.assertRaises(ProviderError) as cm:
                gp.ask("q")
            self.assertEqual(cm.exception.reason, "grounding_missing")
            self.assertEqual(len(g.reqs), 3)                    # retried like empty_answer

    def test_empty_answer(self):
        p, g, _, _ = providers([gemini_body(text="")] * 3)
        with self.assertRaises(ProviderError) as cm:
            p.members[0].ask("q")
        self.assertEqual(cm.exception.reason, "empty_answer")

    def test_codes(self):
        cases = [
            (http_err(429, b'{"error":{"status":"RESOURCE_EXHAUSTED"}}'), "gemini_quota_exhausted", 1, True),
            (http_err(429, b"not json"), "rate_limited", 3, False),
            (http_err(404, b'{"error":{"message":"models/gemini-3.5-flash-lite is not found"}}'), "model_unavailable", 1, True),
            (http_err(403, b'{"error":{"message":"model gemini-3.5-flash-lite denied"}}'), "model_unavailable", 1, True),
            (http_err(403, b'{"error":{"message":"denied"}}'), "http_403", 1, True),
            (http_err(500), "http_500", 3, False),
            (TimeoutError(), "timeout", 3, False),
            (urllib.error.URLError(OSError("x")), "connection_error", 3, False),
            ("{not json", "parse_error", 3, False),
        ]
        for exc, code, calls, perm in cases:
            p, g, _, _ = providers([exc] * 3)
            with self.assertRaises(ProviderError) as cm:
                p.members[0].ask("q")
            self.assertEqual((cm.exception.reason, len(g.reqs), cm.exception.permanent), (code, calls, perm), code)


class OpenAIShape(Env):
    def test_request_and_citations(self):
        p, g, o, _ = providers([http_err(500)] * 3, [openai_body()])
        a = p.ask("q", city="Austin, TX")
        r = o.reqs[0]
        self.assertEqual(r.full_url, "https://api.openai.com/v1/responses")
        self.assertEqual(r.get_header("Authorization"), "Bearer " + OKEY)
        self.assertNotIn(OKEY, r.full_url)
        body = json.loads(r.data)
        self.assertEqual((body["model"], body["tools"][0]["type"]), ("gpt-4o-mini", "web_search"))
        self.assertEqual(a.live["citations"], [{"url": "https://example.org/a", "title": "Page A"}])
        self.assertEqual(a.citations, ["https://example.org/a"])

    def test_no_invented_citations_and_memory_answer_refused(self):
        p, _, o, _ = providers([], [openai_body(urls=(), calls=1)])
        self.assertEqual(p.members[1].ask("q").live["citations"], [])
        p, _, o, _ = providers([], [openai_body(urls=(), calls=0)] * 3)
        with self.assertRaises(ProviderError) as cm:
            p.members[1].ask("q")
        self.assertEqual(cm.exception.reason, "grounding_missing")

    def test_non_http_urls_dropped(self):
        p, _, _, _ = providers([], [openai_body(urls=(("javascript:alert(1)", "x"), ("https://ok.example/", "ok")))])
        self.assertEqual([c["url"] for c in p.members[1].ask("q").live["citations"]], ["https://ok.example/"])


class Fallback(Env):
    def test_gemini_success_makes_no_openai_call(self):
        p, g, o, _ = providers()
        p.preflight()
        for _ in range(3):
            p.ask("q")
        self.assertEqual((len(g.reqs), len(o.reqs)), (3, 0))

    def test_gemini_failures_fall_back_exactly_once(self):
        for exc in (http_err(500), http_err(429, b'{"error":{"status":"RESOURCE_EXHAUSTED"}}'), http_err(404, b"gemini-3.5-flash-lite"),
                    http_err(403), TimeoutError()):
            p, g, o, _ = providers([exc] * 3, [openai_body()])
            a = p.ask("q")
            self.assertEqual(a.usage["vendor"], "openai")
            self.assertEqual(len(o.reqs), 1)

    def test_gemini_unconfigured_zero_gemini_calls(self):
        with mock.patch.dict(os.environ, {"GEMINI_API_KEY": ""}):
            p, g, o, _ = providers([], [openai_body()])
            self.assertIsNone(p.preflight())
            p.ask("q")
            self.assertEqual((len(g.reqs), len(o.reqs)), (0, 1))
            self.assertEqual(p.members[0].configured(), False)
            with self.assertRaises(ProviderError) as cm:
                p.members[0].ask("q")
            self.assertEqual(cm.exception.reason, "provider_not_configured")

    def test_openai_unconfigured_when_fallback_needed(self):
        with mock.patch.dict(os.environ, {"OPENAI_API_KEY": ""}):
            p, g, o, _ = providers([http_err(500)] * 3, [openai_body()])
            with self.assertRaises(ProviderError):
                p.ask("q")
            self.assertEqual(len(o.reqs), 0)
            self.assertEqual(p.failures["openai"], {"provider_not_configured": 1})

    def test_both_unset_unavailable_zero_calls(self):
        with mock.patch.dict(os.environ, {"GEMINI_API_KEY": "", "OPENAI_API_KEY": ""}):
            p, g, o, _ = providers()
            self.assertEqual(p.preflight(), "provider_not_configured")
            self.assertEqual((g.reqs, o.reqs), ([], []))

    def test_fail_fast_after_three_permanent_errors_per_provider(self):
        p, g, o, _ = providers([http_err(403)] * 10, [openai_body()] * 10)
        for _ in range(5):
            p.ask("q")
        self.assertEqual(len(g.reqs), 3)            # Gemini skipped after 3 permanent errors
        self.assertEqual(len(o.reqs), 5)
        self.assertEqual(p.failures["gemini"], {"http_403": 3})


class Caps(Env):
    def test_tiny_gemini_cap_falls_back_with_cap_reached(self):
        alerts = []
        led = ledger(caps={"gemini": 0.01, "openai": 5.0}, on_cap=lambda *a: alerts.append(a))
        p, g, o, _ = providers([], [openai_body()], led)
        self.assertIsNone(p.preflight())
        a = p.ask("q")
        self.assertEqual((len(g.reqs), len(o.reqs), a.usage["vendor"]), (0, 1, "openai"))
        self.assertEqual(len(alerts), 1)

    def test_direct_provider_call_over_cap_makes_no_request(self):
        led = ledger(caps={"gemini": 0.01, "openai": 5.0})
        p, g, o, _ = providers([], [], led)
        with self.assertRaises(ProviderError) as cm:
            p.members[0].ask("q")
        self.assertEqual((cm.exception.reason, cm.exception.permanent, g.reqs), ("cap_reached", True, []))

    def test_both_capped_refused_up_front(self):
        alerts = []
        led = ledger(caps={"gemini": 0.01, "openai": 0.01}, on_cap=lambda *a: alerts.append(a))
        p, g, o, _ = providers([], [], led)
        self.assertEqual(p.preflight(), "cap_reached")
        self.assertEqual((g.reqs, o.reqs), ([], []))
        self.assertEqual(sorted(a[0] for a in alerts), ["gemini", "openai"])

    def test_cap_alert_once_per_provider_per_month(self):
        alerts = []
        led = ledger(caps={"gemini": 0.01, "openai": 5.0}, on_cap=lambda *a: alerts.append(a))
        for _ in range(3):
            p, *_ = providers([], [openai_body()], led)
            p.preflight()
            self.assertFalse(led.try_reserve("gemini", 1.0))
        self.assertEqual([a[:2] for a in alerts], [("gemini", "2026-05")])
        led.now[0] += 40 * 86400                                # next calendar month: one new alert
        self.assertFalse(led.try_reserve("gemini", 1.0))
        self.assertEqual(len(alerts), 2)
        self.assertEqual(alerts[1][1], "2026-07")

    def test_spend_uses_response_counts_and_the_conservative_search_rate(self):
        led = ledger()
        p, *_ = providers([gemini_body(queries=("a", "b", "c"))], [], led)
        p.members[0].ask("q")
        want = (100 * 0.30 + 250 * 2.50) / 1e6 + 3 * 14 / 1000
        self.assertAlmostEqual(led.spent("gemini"), want, places=6)
        p, *_ = providers([], [openai_body(calls=2)], led)
        p.members[1].ask("q")
        want = (300 + 2 * 8000) * 0.15 / 1e6 + 100 * 0.60 / 1e6 + 2 * 10 / 1000
        self.assertAlmostEqual(led.spent("openai"), want, places=6)

    def test_missing_counts_use_conservative_estimate(self):
        led = ledger()
        p, *_ = providers([gemini_body(usage=False)], [openai_body(usage=False)], led)
        p.members[0].ask("q"); p.members[1].ask("q")
        self.assertGreaterEqual(led.spent("gemini"), (fc.EST_INPUT_TOKENS * 0.30 + fc.EST_OUTPUT_TOKENS * 2.5) / 1e6 + 2 * 0.014)
        self.assertGreaterEqual(led.spent("openai"), 0.01 + 8000 * 0.15 / 1e6)

    def test_http_error_gives_reservation_back_timeout_keeps_it(self):
        led = ledger()
        p, *_ = providers([http_err(500)] * 3, [], led)
        with self.assertRaises(ProviderError):
            p.members[0].ask("q")
        self.assertEqual(led.spent("gemini"), 0.0)
        p, *_ = providers([TimeoutError()] * 3, [], led)
        with self.assertRaises(ProviderError):
            p.members[0].ask("q")
        self.assertGreater(led.spent("gemini"), 0.0)

    def test_concurrent_reservations_never_pass_the_cap(self):
        import threading
        led = ledger(caps={"gemini": 1.0, "openai": 1.0})
        ok = []
        def go():
            for _ in range(50):
                if led.try_reserve("gemini", 0.01):
                    ok.append(1)
        ts = [threading.Thread(target=go) for _ in range(8)]
        [t.start() for t in ts]; [t.join() for t in ts]
        self.assertEqual(len(ok), 100)
        self.assertLessEqual(led.spent("gemini"), 1.0 + 1e-9)

    def test_counter_record_is_small_and_clean(self):
        d = tempfile.mkdtemp()
        store = free_caps.LocalFileStore(d)
        led = ledger(load=store.load, save=store.save)
        p, *_ = providers([gemini_body()], [], led)
        p.members[0].ask("secret prompt text")
        p.finish()
        files = os.listdir(d)
        self.assertEqual(files, ["gemini-2026-05.json"])
        raw = open(os.path.join(d, files[0])).read()
        self.assertEqual(set(json.loads(raw)), {"provider", "month", "calls", "searches", "input_tokens", "output_tokens",
                                                "spent_usd", "alerted"})
        for bad in (GKEY, "secret prompt", "Alpha Plumbing", "chip", "google.com"):
            self.assertNotIn(bad, raw)
        led2 = free_caps.CapLedger(clock=led._clock, load=store.load, save=store.save)    # reloaded after a restart
        self.assertAlmostEqual(led2.spent("gemini"), led.spent("gemini"))


class NoLeaks(Env):
    def test_keys_never_appear_in_errors_logs_or_urls(self):
        errs = [http_err(429, b"%s %s" % (GKEY.encode(), OKEY.encode())), http_err(500, GKEY.encode()), http_err(403, OKEY.encode()),
                TimeoutError(GKEY), "{" + GKEY, http_err(404, b"model " + GKEY.encode())]
        led = ledger(caps={"gemini": 0.01, "openai": 0.01})
        seen = io.StringIO()
        with redirect_stderr(seen), redirect_stdout(seen):
            for e in errs:
                p, g, o, _ = providers([e] * 3, [e] * 3)
                try:
                    p.ask("q")
                except ProviderError as ex:
                    seen.write(repr(ex) + str(ex) + ex.reason + repr(p.failures))
                for r in g.reqs + o.reqs:
                    seen.write(r.full_url)
            p, *_ = providers([], [], led)
            p.preflight()
        out = seen.getvalue()
        self.assertNotIn("test-key-not-real", out)

    def test_every_call_goes_to_the_expected_vendor_endpoint(self):
        p, g, o, _ = providers([http_err(500)] * 3, [openai_body()])
        p.ask("q")
        self.assertEqual(set(g.hosts()), {"generativelanguage.googleapis.com"})
        self.assertEqual(set(o.hosts()), {"api.openai.com"})
        self.assertTrue(all(r.full_url.endswith(":generateContent") for r in g.reqs))


class PaidUnchanged(Env):
    def test_paid_defaults_and_lock(self):
        self.assertEqual(config.PAID_ENGINES, ("openai", "gemini", "claude"))
        self.assertEqual(config.DEFAULT_MODELS, {"openai": "gpt-6.2-sol", "gemini": "gemini-4-hydrogen", "claude": "claude-sonnet-5-5"})
        from aivis import order
        o = order.Order("ORD-1234", "Zed Co", "Austin, TX", "plumber")
        with mock.patch.dict(os.environ, {"GEMINI_API_KEY": GKEY, "OPENAI_API_KEY": OKEY}):
            os.environ.pop("AIVIS_ALLOW_PAID", None)
            with self.assertRaises(order.OrderError):
                order.build_providers(o, "paid", 12.0)
            prov, _ = order.build_providers(o, "free", 12.0)
            self.assertIsInstance(prov[0], FreeSearchProvider)
            with self.assertRaises(order.OrderError):
                order.build_providers(o, "paid", 12.0)           # reading the keys for the free check unlocked nothing

    def test_pollinations_never_in_the_free_chain(self):
        from aivis import order
        from aivis.providers.free import PollinationsProvider
        chain = order.build_free_provider()
        self.assertEqual([m.name for m in chain.members], ["gemini", "openai"])
        self.assertFalse(any(isinstance(m, PollinationsProvider) for m in chain.members))
        self.assertFalse(hasattr(order, "PollinationsProvider"))

    def test_free_run_order_writes_no_grounded_text(self):
        from aivis import order
        out = tempfile.mkdtemp()
        o = order.Order("FREE-abcdef12", "Zed Co", "Austin, TX", "plumber", plan="free")
        prov = FreeSearchProvider([GeminiSearchProvider(opener=Fake([gemini_body()] * 8), ledger=ledger())], ledger=ledger())
        order.run_order(o, mode="free", out_dir=out, providers=[prov], render=lambda r: "<p>page</p>")
        blob = "".join(open(os.path.join(d, f)).read() for d, _, fs in os.walk(out) for f in fs)
        for bad in ("Alpha Plumbing", "chip", "google.com"):
            self.assertNotIn(bad, blob)
        self.assertFalse(os.path.exists(os.path.join(out, "FREE-abcdef12", "answers.json")))


if __name__ == "__main__":
    unittest.main()


def openai_sources_body(urls, text=GROUNDED):
    srcs = [{"type": "url", "url": u} for u in urls]
    return {"output": [{"type": "web_search_call", "action": {"type": "search", "sources": srcs}},
                       {"type": "message", "content": [{"type": "output_text", "text": text, "annotations": []}]}],
            "usage": {"input_tokens": 300, "output_tokens": 100}}


class GeminiList(Env):
    def test_list_parsing(self):
        from aivis.providers.free_search import _names_from_list, MAX_NAMES
        self.assertEqual(_names_from_list("1. A Co\n2) B Co\n- C Co\n* D Co\n\n3.  \n1. a co"), ["A Co", "B Co", "C Co", "D Co"])
        for none in ("NONE", "none", " None \n"):
            self.assertEqual(_names_from_list(none), [])
        for junk in ("", "Sorry, no list here", "Alpha Plumbing is good"):
            self.assertIsNone(_names_from_list(junk), junk)
        self.assertEqual(len(_names_from_list("\n".join(f"{i}. N{i}" for i in range(1, 40)))), MAX_NAMES)

    def test_list_with_entry_point_gives_suggestions(self):
        p, g, _, _ = providers([gemini_body(text="1. Alpha Plumbing\n2. Beta Pipes")])
        a = p.ask("q")
        self.assertEqual(a.text, "1. Alpha Plumbing\n2. Beta Pipes")
        self.assertEqual(a.live["suggestions"], SUGG)

    def test_list_without_entry_point_is_grounding_missing(self):
        p, g, _, _ = providers([gemini_body(grounded=False)] * 3)
        with self.assertRaises(ProviderError) as cm:
            p.members[0].ask("q")
        self.assertEqual((cm.exception.reason, len(g.reqs)), ("grounding_missing", 3))

    def test_none_and_junk_reasons(self):
        for text, reason in (("NONE", "empty_answer"), ("no idea", "parse_error")):
            p, *_ = providers([gemini_body(text=text)] * 3)
            with self.assertRaises(ProviderError) as cm:
                p.members[0].ask("q")
            self.assertEqual(cm.exception.reason, reason)


class OpenAISources(Env):
    def test_request_body(self):
        p, g, o, _ = providers([http_err(500)] * 3, [openai_body()])
        p.ask("q")
        body = json.loads(o.reqs[0].data)
        self.assertEqual(body["tool_choice"], "required")
        self.assertEqual(body["include"], ["web_search_call.action.sources"])

    def test_sources_become_citations(self):
        from aivis.providers.free_search import MAX_LINKS
        urls = ["https://a.example/1", "ftp://x/y", "javascript:alert(1)", "https://a.example/1", "http://b.example/2"] + \
               [f"https://c.example/{i}" for i in range(30)]
        p, g, o, _ = providers([http_err(500)] * 3, [openai_sources_body(urls)])
        a = p.ask("q")
        want = ["https://a.example/1", "http://b.example/2"] + [f"https://c.example/{i}" for i in range(30)]
        self.assertEqual([c["url"] for c in a.live["citations"]], want[:MAX_LINKS])
        self.assertEqual(a.citations, want[:MAX_LINKS])

    def test_sources_count_as_grounded_without_annotations(self):
        p, g, o, _ = providers([http_err(500)] * 3, [openai_sources_body(["https://a.example/1"])])
        self.assertEqual(len(p.ask("q").live["citations"]), 1)


class StructuredList(unittest.TestCase):
    def test_names_from_json_fenced_json_and_junk(self):
        from aivis.providers.free_search import _names_from_text, _as_list_text
        self.assertEqual(_names_from_text('{"businesses": ["A Co", "a co", " B  Inc ", 3, ""]}'), ["A Co", "B Inc"])
        self.assertEqual(_names_from_text('```json\n{"businesses": ["A Co"], "note": "x"}\n```'), ["A Co"])
        self.assertEqual(_names_from_text('{"businesses": []}'), [])
        for bad in ("", "1. A Co\n2. B Co", "{not json", '{"businesses": "A Co"}', "[1]"):
            self.assertIsNone(_names_from_text(bad), bad)
        self.assertEqual(_as_list_text(["A", "B"]), "1. A\n2. B")

    def test_daily_defaults(self):
        self.assertEqual(fc.DEFAULT_DAILY_MAX_CHECKS, 8)
        led = free_caps.CapLedger(clock=lambda: 1_780_000_000.0)
        self.assertAlmostEqual(led.daily_cap("gemini") + led.daily_cap("openai"), 15.0 / 31, places=6)
