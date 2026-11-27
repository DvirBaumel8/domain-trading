import json, os, sys, unittest
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
from tests.test_base import Base
import page

SECRET = "test-shared-secret-value"


class Req:
    def __init__(self, query=None, body=None):
        self.query = {k: [v] for k, v in (query or {}).items()}
        self.body = json.dumps(body).encode() if body is not None else b""


class PageBase(Base):
    def setUp(self):
        super().setUp()
        os.environ["GHL_SHARED_SECRET"] = SECRET
        os.environ["OPENAI_API_KEY"] = "sk-secret-openai"
        page._mem.d.clear()
        page.now = lambda: 1_000_000.0
        self.addCleanup(setattr, page, "now", __import__("time").time)

    def tok(self, loc="locA", secret=SECRET):
        return page.encrypt_context({"userId": "u", "activeLocation": loc}, secret)

    def seed(self, loc, **kw):
        v = page._mem._loc(loc)
        v.update(kw)


class TestCrypto(unittest.TestCase):
    def test_aes_vector(self):
        key = bytes(range(32)); pt = bytes.fromhex("00112233445566778899aabbccddeeff")
        ct = page._block(list(pt), page._expand(key), False)
        self.assertEqual(ct.hex(), "8ea2b7ca516745bfeafc49904b496089")
        self.assertEqual(page._block(list(ct), page._expand(key), True), pt)


class TestIdentity(PageBase):
    def test_valid_context_shows_own_data_only(self):
        page.store_rows = None
        orig = page._view
        page._view = lambda loc: {"prompts": [f"p-{loc}"], "rows": [{"prompt": f"row-{loc}", "mentioned": {"openai": True}}],
                                  "engines": {"openai": {"mention_rate": 0.5, "avg_position": 2}}, "trend": []}
        self.addCleanup(setattr, page, "_view", orig)
        st, r = page.handle_page(Req({"context": self.tok("locA"), "location_id": "locB"}))
        body = r.body.decode()
        self.assertIn("row-locA", body); self.assertIn("50%", body)
        self.assertNotIn("locB", body)

    def test_missing_or_forged(self):
        for q in ({}, {"context": "garbage"}, {"context": self.tok(secret="other")}, {"location_id": "locA"}):
            st, r = page.handle_page(Req(q))
            body = r.body.decode()
            self.assertIn("Open this page from inside HighLevel", body)
            self.assertNotIn("Mention rate", body)
        st, r = page.handle_view(Req(body={"context": self.tok(secret="other")}))
        self.assertEqual(st, 401)

    def test_no_secret_configured(self):
        os.environ.pop("GHL_SHARED_SECRET")
        self.assertIsNone(page.location_of(self.tok()))


class TestActions(PageBase):
    def test_prompt_cap(self):
        st, _ = page.handle_prompts(Req(body={"context": self.tok(), "prompts": [f"p{i}" for i in range(10)]}))
        self.assertEqual(st, 200)
        st, r = page.handle_prompts(Req(body={"context": self.tok(), "prompts": [f"p{i}" for i in range(11)]}))
        self.assertEqual(st, 400)
        self.assertEqual(len(page._mem.d["locA"]["prompts"]), 10)

    def test_run_now_once_per_24h(self):
        self.seed("locA", prompts=["x"])
        t = {"context": self.tok()}
        self.assertEqual(page.handle_run(Req(body=t))[0], 202)
        self.assertEqual(page.handle_run(Req(body=t))[0], 429)
        page.now = lambda: 1_000_000.0 + 86401
        self.assertEqual(page.handle_run(Req(body=t))[0], 202)

    def test_run_now_blocked_by_cap(self):
        self.seed("locA", prompts=["x"])
        orig = page._view
        page._view = lambda loc: {"prompts": ["x"], "spend_location_usd": 5}
        self.addCleanup(setattr, page, "_view", orig)
        st, r = page.handle_run(Req(body={"context": self.tok()}))
        self.assertEqual(st, 429)
        self.assertIn("cap_reached", r.body.decode())


class TestHeadersAndCopy(PageBase):
    def test_frame_ancestors_and_no_secrets(self):
        os.environ["GHL_CLIENT_SECRET"] = "client-secret-xyz"
        for req in (Req(), Req({"context": self.tok()})):
            st, r = page.handle_page(req)
            self.assertIn("frame-ancestors https://*.gohighlevel.com", r.headers["Content-Security-Policy"])
            self.assertNotIn("X-Frame-Options", r.headers)
            blob = r.body.decode() + json.dumps(r.headers)
            for s in (SECRET, "sk-secret-openai", "client-secret-xyz"):
                self.assertNotIn(s, blob)
        for path in ("page.css", "page.js"):
            with open(os.path.join(page.STATIC, path)) as f:
                for s in (SECRET, "sk-secret"):
                    self.assertNotIn(s, f.read())

    def test_not_enabled_label(self):
        st, r = page.handle_page(Req({"context": self.tok()}))
        body = r.body.decode()
        self.assertEqual(body.count("not enabled"), 2)    # anthropic + perplexity
        self.assertIn("OpenAI", body)

    def test_neutral_copy_and_no_external_scripts(self):
        st, r = page.handle_page(Req({"context": self.tok()}))
        body = r.body.decode()
        self.assertNotIn("ChatGPT", body)
        self.assertIn("AI assistants", body)
        self.assertNotIn("http://", body); self.assertNotIn("https://", body)
        self.assertIn("viewport", body)

    def test_trial_banner_and_chart(self):
        orig = page._view
        page._view = lambda loc: {"trial_ends": "1970-01-21T00:00:00+00:00", "prompts": [], "rows": [],
                                  "trend": [{"rates": {"openai": 0.1}}, {"rates": {"openai": 0.4}}]}
        self.addCleanup(setattr, page, "_view", orig)
        st, r = page.handle_page(Req({"context": self.tok()}))
        body = r.body.decode()
        self.assertIn("<svg", body); self.assertIn("Trial:", body)

    def test_html_escaped(self):
        orig = page._view
        page._view = lambda loc: {"prompts": [], "rows": [{"prompt": "<script>x</script>"}]}
        self.addCleanup(setattr, page, "_view", orig)
        st, r = page.handle_page(Req({"context": self.tok()}))
        self.assertNotIn("<script>x", r.body.decode())


if __name__ == "__main__":
    unittest.main()
