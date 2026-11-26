import io, json, unittest, urllib.error
from email.message import Message
from aivis.audit import run_audit
from aivis.niches import get_niche
from aivis.parse import extract_candidates
from aivis.providers.base import ProviderError
from aivis.providers.free import PollinationsProvider, SUFFIX
from aivis import names as N


class Resp:
    def __init__(self, text): self.b = text.encode()
    def read(self): return self.b
    def __enter__(self): return self
    def __exit__(self, *a): return False


def http_err(code, retry_after=None):
    h = Message()
    if retry_after is not None:
        h["Retry-After"] = str(retry_after)
    return urllib.error.HTTPError("https://x/", code, "m", h, io.BytesIO(b"secret body"))


class Fake:
    """A scripted opener plus a clock that only moves when the provider sleeps."""
    def __init__(self, script):
        self.script, self.calls, self.t, self.sleeps = list(script), 0, 1000.0, []
    def opener(self, url, timeout=0):
        self.calls += 1
        x = self.script.pop(0) if self.script else "- Alpha Dental"
        if isinstance(x, Exception):
            raise x
        return Resp(x)
    def sleep(self, s): self.sleeps.append(s); self.t += s
    def clock(self): return self.t
    def provider(self, **kw):
        return PollinationsProvider(opener=self.opener, sleep=self.sleep, clock=self.clock, min_interval_s=0, **kw)


def reason(f, **kw):
    p = f.provider(**kw)
    try:
        p.ask("q")
    except ProviderError as e:
        return e.reason
    return "ok"


class ProviderRetry(unittest.TestCase):
    def test_429_without_retry_after_backs_off_and_gives_up(self):
        f = Fake([http_err(429)] * 5)
        self.assertEqual(reason(f), "rate_limited")
        self.assertEqual((f.calls, f.sleeps), (3, [2.0, 4.0]))

    def test_retry_after_is_honoured_but_capped(self):
        f = Fake([http_err(429, 3), http_err(429, 999), "- Ok Dental"])
        self.assertEqual(reason(f), "ok")
        self.assertEqual(f.sleeps, [3.0, 10.0])

    def test_5xx_then_success(self):
        f = Fake([http_err(503), "- Beta Dental"])
        self.assertEqual(f.provider().ask("q").text, "- Beta Dental")
        self.assertEqual(f.calls, 2)

    def test_permanent_error_not_retried(self):
        f = Fake([http_err(400)])
        self.assertEqual(reason(f), "http_400")
        self.assertEqual(f.calls, 1)

    def test_exact_http_status_codes(self):
        for code in (403, 404):
            f = Fake([http_err(code)] * 3)
            try:
                f.provider().ask("q")
            except ProviderError as e:
                self.assertEqual((e.reason, e.category, e.permanent), (f"http_{code}", "http_error", True))
            self.assertEqual(f.calls, 1)           # not retried
        f = Fake([http_err(502)] * 3)
        try:
            f.provider().ask("q")
        except ProviderError as e:
            self.assertEqual((e.reason, e.category, e.permanent), ("http_502", "http_error", False))
        self.assertEqual(f.calls, 3)               # retried
        for ra in (None, 1):
            f = Fake([http_err(429, ra)] * 3)
            try:
                f.provider().ask("q")
            except ProviderError as e:
                self.assertEqual((e.reason, e.category, e.permanent), ("rate_limited", "rate_limited", False))
            self.assertEqual(f.calls, 3)

    def test_other_codes_are_not_http_status(self):
        for exc, code in ((TimeoutError(), "timeout"), (ConnectionResetError(), "connection_error")):
            self.assertEqual(reason(Fake([exc] * 3)), code)

    def test_timeout_and_connection_reset(self):
        self.assertEqual(reason(Fake([TimeoutError()] * 3)), "timeout")
        f = Fake([ConnectionResetError()] * 3)
        self.assertEqual(reason(f), "connection_error")
        self.assertEqual(f.calls, 3)

    def test_empty_body_retried_then_empty_answer(self):
        f = Fake(["  "] * 3)
        self.assertEqual(reason(f), "empty_answer")
        self.assertEqual(f.calls, 3)

    def test_malformed_body_is_parse_error(self):
        self.assertEqual(reason(Fake(['{"error": "x"}'] * 3)), "parse_error")
        self.assertEqual(reason(Fake(["<html>oops</html>"] * 3)), "parse_error")

    def test_total_budget_is_bounded(self):
        f = Fake([http_err(429, 10)] * 10)
        reason(f, budget_s=12)
        self.assertLessEqual(f.t - 1000.0, 12)
        self.assertLessEqual(f.calls, 3)

    def test_error_text_carries_no_prompt_or_body(self):
        f = Fake([http_err(500)] * 3)
        try:
            f.provider().ask("my secret prompt")
        except ProviderError as e:
            self.assertNotIn("secret", str(e))

    def test_pacing_uses_injected_clock(self):
        f = Fake(["- A Dental", "- B Dental"])
        p = PollinationsProvider(opener=f.opener, sleep=f.sleep, clock=f.clock, min_interval_s=4)
        p.ask("a"); p.ask("b")
        self.assertEqual(f.sleeps, [4.0])


class AuditOutcomes(unittest.TestCase):
    def run_script(self, script):
        f = Fake(script)
        res = run_audit(get_niche("plumber"), "Austin, TX", "Zed", [], [f.provider()], n_prompts=8, repeats=1)
        return res, f

    def test_mixed_reasons_and_answered_count(self):
        script = ["- Alpha Plumbing", http_err(429), http_err(429), http_err(429),
                  TimeoutError(), TimeoutError(), TimeoutError(),
                  "- Beta Plumbing", "", "", "",
                  http_err(400), "- Gamma Plumbing", "- Delta Plumbing", "- Eps Plumbing"]
        res, f = self.run_script(script)
        self.assertEqual(res.reason_counts(), {"ok": 4, "rate_limited": 1, "timeout": 1, "empty_answer": 1, "http_400": 1})
        self.assertEqual(res.score.total_answers, 4)
        self.assertEqual(len(res.outcomes), 8)
        self.assertNotIn("prompt", json.dumps(res.outcomes).lower().replace("prompt_no", ""))

    def test_all_fail(self):
        res, f = self.run_script([http_err(429)] * 30)
        self.assertEqual(res.reason_counts(), {"rate_limited": 8})
        self.assertEqual(res.score.total_answers, 0)
        self.assertEqual(f.calls, 24)


class Parser(unittest.TestCase):
    def test_suffix_asks_for_honesty(self):
        self.assertIn("If you are not sure a business exists, say so instead of guessing.", SUFFIX)

    def test_not_sure_lines_are_not_names(self):
        txt = ("1. **Alpha Plumbing** - good\n2. Beta Plumbing\n"
               "- I'm not sure any such business exists.\n- I don't know of specific businesses\n"
               "- If you are not sure a business exists, say so instead of guessing.\n"
               "**I cannot verify these businesses**\n")
        self.assertEqual(extract_candidates(txt), ["Alpha Plumbing", "Beta Plumbing"])
        self.assertEqual(extract_candidates("1. Alpha Plumbing\n2. Beta Plumbing"), ["Alpha Plumbing", "Beta Plumbing"])


class Aggregate(unittest.TestCase):
    def test_counts_case_dupes_and_own_business(self):
        per = [[("Alpha Plumbing", None), ("alpha plumbing", None), ("Zed Plumbing", None)],
               [("ALPHA PLUMBING", None), ("Beta Co", None)], []]
        s = N.aggregate(per, "Zed Plumbing", "Austin, TX", "none")
        self.assertEqual([(r["name"], r["answers"]) for r in s["names"]], [("Alpha Plumbing", 2), ("Beta Co", 1)])
        self.assertEqual((s["named_in"], s["answers"]), (1, 3))
        self.assertEqual(s["heading"], "Names the AI gave (AI output, not verified)")
        self.assertEqual(s["register_note"], "no official register available for this type, names not verified")
        self.assertTrue(all(r["match"] == "" for r in s["names"]))

    def test_no_names(self):
        s = N.aggregate([[], []], "Zed", "Austin, TX", "none")
        self.assertEqual(s["empty_note"], "The AI did not name any businesses in its answers.")

    def test_matched_vs_unmatched(self):
        s = N.aggregate([[("Real Dental", True), ("Made Up Dental", False)]], "Zed", "Austin, TX", "ok")
        m = {r["name"]: r["match"] for r in s["names"]}
        self.assertEqual(m, {"Real Dental": "matches a real listing", "Made Up Dental": "not found in the official register"})
        self.assertEqual(s["matched_count"], 1)

    def test_unavailable_register(self):
        s = N.aggregate([[("X Dental", None)]], "Zed", "Austin, TX", "unavailable")
        self.assertEqual(s["register_note"], "could not verify names")

    def test_html_escaped(self):
        s = N.aggregate([[("<script>alert(1)</script>", None)]], "Zed", "Austin, TX", "none")
        h = N.to_html(s)
        self.assertNotIn("<script>", h)
        self.assertIn("&lt;script&gt;", h)
        self.assertIn(N.HEADING, h)


if __name__ == "__main__":
    unittest.main()


class FailFast(unittest.TestCase):
    def run_script(self, script, after=3):
        f = Fake(script)
        res = run_audit(get_niche("plumber"), "Austin, TX", "Zed", [], [f.provider()], n_prompts=8, repeats=1,
                        fail_fast_after=after)
        return res, f

    def test_two_permanent_errors_continue(self):
        res, f = self.run_script([http_err(403), http_err(403)] + ["- Alpha Plumbing"] * 6)
        self.assertEqual(res.reason_counts(), {"http_403": 2, "ok": 6})
        self.assertEqual(f.calls, 8)

    def test_three_permanent_errors_skip_the_rest(self):
        res, f = self.run_script([http_err(403)] * 3 + ["- Alpha Plumbing"] * 5)
        self.assertEqual(f.calls, 3)
        self.assertEqual(res.reason_counts(), {"http_403": 3, "skipped_after_permanent_errors": 5})
        self.assertEqual(len(res.outcomes), 8)
        self.assertEqual(res.score.total_answers, 0)

    def test_threshold_is_configurable(self):
        res, f = self.run_script([http_err(404)] * 2 + ["- A Plumbing"] * 6, after=2)
        self.assertEqual((f.calls, len(res.outcomes)), (2, 8))

    def test_three_429s_do_not_trigger(self):
        res, f = self.run_script([http_err(429)] * 9 + ["- Alpha Plumbing"] * 5)
        self.assertEqual(res.reason_counts(), {"rate_limited": 3, "ok": 5})
        self.assertEqual(f.calls, 14)

    def test_5xx_does_not_trigger(self):
        res, f = self.run_script([http_err(502)] * 9 + ["- Alpha Plumbing"] * 5)
        self.assertEqual(res.reason_counts(), {"http_502": 3, "ok": 5})

    def test_mixed_429_then_three_403(self):
        res, f = self.run_script([http_err(429)] * 3 + [http_err(403)] * 3 + ["- Alpha Plumbing"] * 5)
        self.assertEqual(res.reason_counts(),
                         {"rate_limited": 1, "http_403": 3, "skipped_after_permanent_errors": 4})
        self.assertEqual(len(res.outcomes), 8)
        self.assertEqual(f.calls, 6)


class PartialNames(unittest.TestCase):
    PER = [[("Alpha Dental", None)]]

    def test_partial_states_real_denominator(self):
        s = N.aggregate(self.PER, "Zed", "Austin, TX", "none", asked=8, min_answers=6)
        self.assertEqual(s["heading"], "Names the AI gave (AI output, not verified)")
        self.assertEqual((s["answers"], s["answered"], s["based_on"]), (8, 1, "based on 1 of 8 answers"))
        h = N.to_html(s)
        self.assertIn("<h2>Names the AI gave (AI output, not verified)</h2>", h)
        self.assertIn("based on 1 of 8 answers", h)
        self.assertIn("1 of 8", h)
        self.assertNotIn("1 of 1", h)

    def test_complete_runs_have_no_based_on_line(self):
        for n in (6, 8):
            s = N.aggregate(self.PER * n, "Zed", "Austin, TX", "none", asked=8, min_answers=6)
            self.assertEqual((s["answers"], s["based_on"]), (8, ""))
            self.assertNotIn("based on", N.to_html(s))

    def test_instant_path_keeps_own_total(self):
        s = N.aggregate(self.PER * 3, "Zed", "Austin, TX", "none")
        self.assertEqual((s["answers"], s["based_on"]), (3, ""))
