"""scripts/gemini_free_smoke.py: one call, key from GEMINI_FREE_API_KEY only, prints codes only. Offline."""
import contextlib, io, json, os, sys, unittest, urllib.error
from email.message import Message
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "scripts"))
sys.path.insert(0, os.path.join(HERE, "..", "engine"))
import gemini_free_smoke as S

FREE, PAID = "test-key-not-real-free", "test-key-not-real-PAID"
TEXT = "SECRET-RESPONSE-TEXT"
SUGG = "<div>SECRET-SUGGESTIONS</div>"


class Resp:
    status = 200
    def __init__(self, t): self.b = t.encode()
    def read(self): return self.b
    def __enter__(self): return self
    def __exit__(self, *a): return False


def body(grounded=True):
    c = {"content": {"parts": [{"text": TEXT}]}}
    if grounded:
        c["groundingMetadata"] = {"searchEntryPoint": {"renderedContent": SUGG}}
    return json.dumps({"candidates": [c]})


def err(code, b=""):
    return urllib.error.HTTPError("https://x/?key=" + FREE, code, "m", Message(), io.BytesIO(b.encode()))


class Rec:
    def __init__(self, x): self.x, self.reqs = x, []
    def __call__(self, req, timeout=0):
        self.reqs.append(req)
        if isinstance(self.x, BaseException):
            raise self.x
        return Resp(self.x)


def hdrs(r): return {k.lower(): v for k, v in r.header_items()}


class Smoke(unittest.TestCase):
    def test_ok_uses_free_key_header_and_prints_no_secrets(self):
        op = Rec(body())
        code, lines = S.run({"GEMINI_FREE_API_KEY": FREE, "GEMINI_API_KEY": PAID}, op)
        self.assertEqual(code, 0)
        self.assertEqual(lines, ["model=gemini-2.5-flash-lite", "http_status=200", "reason=ok", "grounding_metadata=true"])
        self.assertEqual(len(op.reqs), 1)
        r = op.reqs[0]
        self.assertEqual(hdrs(r)["x-goog-api-key"], FREE)
        self.assertNotIn(FREE, r.full_url); self.assertNotIn(PAID, json.dumps(hdrs(r)) + r.full_url + r.data.decode())
        self.assertEqual(json.loads(r.data)["tools"], [{"google_search": {}}])
        out = "\n".join(lines)
        for secret in (FREE, PAID, TEXT, SUGG, "https:", "Austin"):
            self.assertNotIn(secret, out)

    def test_missing_free_key_ignores_paid_key_and_makes_no_call(self):
        for env in ({"GEMINI_API_KEY": PAID}, {"GEMINI_FREE_API_KEY": ""}, {}):
            op = Rec(body())
            code, lines = S.run(env, op)
            self.assertEqual((code, op.reqs), (1, []))
            self.assertIn("reason=provider_not_configured", lines)

    def test_model_unavailable_and_other_codes(self):
        env = {"GEMINI_FREE_API_KEY": FREE}
        self.assertIn("reason=model_unavailable", S.run(env, Rec(err(404, "model not found")))[1])
        quota = json.dumps({"error": {"status": "RESOURCE_EXHAUSTED", "details": [{"quotaId": "GenerateRequestsPerDayPerProject"}]}})
        self.assertIn("reason=gemini_quota_exhausted", S.run(env, Rec(err(429, quota)))[1])
        code, lines = S.run(env, Rec(err(500, FREE)))
        self.assertEqual((code, "reason=http_500" in lines, "http_status=500" in lines), (1, True, True))
        code, lines = S.run(env, Rec(body(grounded=False)))
        self.assertEqual((code, "grounding_metadata=false" in lines), (1, True))

    def test_disallowed_model_makes_no_call(self):
        op = Rec(body())
        code, lines = S.run({"GEMINI_FREE_API_KEY": FREE, "AVC_GEMINI_MODEL": "gemini-4-hydrogen"}, op)
        self.assertEqual((code, op.reqs), (1, []))
        self.assertIn("reason=model_no_free_search", lines)

    def test_key_never_leaks_on_errors(self):
        for x in (err(403, FREE), err(500, FREE), TimeoutError(FREE), urllib.error.URLError(FREE), "{bad " + FREE):
            code, lines = S.run({"GEMINI_FREE_API_KEY": FREE}, Rec(x))
            self.assertNotEqual(code, 0)
            self.assertNotIn(FREE, "\n".join(lines))

    def test_script_never_reads_the_paid_key(self):
        import re
        with open(S.__file__, encoding="utf-8") as fh:
            src = fh.read()
        self.assertIsNone(re.search(r"environ[^\n]*GEMINI_API_KEY|getenv[^\n]*GEMINI_API_KEY|env\.get\(\"GEMINI_API_KEY", src))


if __name__ == "__main__":
    unittest.main()
