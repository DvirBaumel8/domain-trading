import io, os, sys, unittest
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "scripts"))
import free_check_matrix as M

TOKEN = "s" * 30
NAMES = {"heading": "x", "names": [{"name": "A"}, {"name": "B"}], "matched_count": 1}


class FakeServer:
    """Fake HTTP layer: Austin dentist is instant, one trade is partial, one run is rate-limited (429)."""
    def __init__(self):
        self.posts, self.tokens = [], []
    def __call__(self, method, url, body=None, token="", timeout=30):
        if method == "POST":
            self.posts.append(body); self.tokens.append(token)
            if body["niche"] == "hvac" and body["city"].startswith("Miami"):
                return 429, {"error": "busy"}
            if body["niche"] == "dentist":
                return 200, {"status": "instant", "answers": 20, "named_in": 0, "names": NAMES}
            return 200, {"status": "queued", "id": body["niche"] + "|" + body["city"]}
        key = url.rsplit("/", 1)[1]
        if key.startswith("roofing"):
            return 200, {"status": "partial", "answers": 3, "expected": 8, "reasons": {"rate_limited": 5}, "names": NAMES}
        return 200, {"status": "done", "answers": 8, "expected": 8, "reasons": {}, "names": NAMES}


class MatrixTests(unittest.TestCase):
    def run_main(self, argv=(), env=None, srv=None):
        srv = srv or FakeServer()
        t = [0.0]
        def sleep(s): t[0] += s
        out = io.StringIO()
        code = M.main(["--pace", "0", *argv], env=env if env is not None else {"AVC_BASE_URL": "http://x", "AVC_TEST_BYPASS_TOKEN": TOKEN},
                      http=srv, sleep=sleep, clock=lambda: t[0], out=out)
        return code, out.getvalue(), srv

    def test_table_summary_and_exit_code(self):
        code, out, srv = self.run_main()
        self.assertEqual(code, 1)
        self.assertEqual(len(srv.posts), 15)
        self.assertIn("SUMMARY runs=15 ok=11 partial_or_failed=4", out)
        self.assertIn("instant", out)
        self.assertIn("rate_limited=5", out)
        self.assertIn("3 of 8", out)
        self.assertIn("http 429", out)
        self.assertNotIn(TOKEN, out)
        self.assertEqual(set(srv.tokens), {TOKEN})

    def test_all_good_exits_zero(self):
        import json, tempfile
        p = os.path.join(tempfile.mkdtemp(), "m.json")
        json.dump({"trades": ["plumber", "dentist"], "cities": ["Austin, TX"]}, open(p, "w"))
        code, out, _ = self.run_main(["--matrix", p])
        self.assertEqual(code, 0)
        self.assertIn("SUMMARY runs=2 ok=2 partial_or_failed=0", out)

    def test_requires_env_not_arguments(self):
        code, _, srv = self.run_main(env={})
        self.assertEqual((code, srv.posts), (2, []))

    def test_max_runtime_stops(self):
        code, out, srv = self.run_main(["--max-runtime", "1"])
        self.assertEqual(code, 1)
        self.assertIn("max runtime", out)
        self.assertLess(len(srv.posts), 15)

    def test_dead_server_is_a_failed_row(self):
        def dead(*a, **k): raise OSError("down")
        code, out, _ = self.run_main(srv=dead)
        self.assertEqual(code, 1)
        self.assertIn("partial_or_failed=15", out)


if __name__ == "__main__":
    unittest.main()
