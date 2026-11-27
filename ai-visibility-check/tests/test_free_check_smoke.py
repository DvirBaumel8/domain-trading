"""The manual smoke script, offline: a fake opener, no network, never reads a real key."""
import io, os, sys, unittest
from unittest import mock
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "scripts"))
sys.path.insert(0, os.path.join(HERE, "..", "engine", "tests"))
import free_check_smoke as S
import test_free_search as tfs


class SmokeTests(unittest.TestCase):
    def run_main(self, env, script):
        fake = tfs.Fake(script)
        lines = []
        with mock.patch.dict(os.environ, env, clear=False):
            for k in ("GEMINI_API_KEY", "OPENAI_API_KEY"):
                if k not in env:
                    os.environ.pop(k, None)
            code = S.main(out=lines.append, opener=fake)
        return code, lines, fake

    def test_one_call_per_provider_and_safe_output(self):
        code, lines, fake = self.run_main({"GEMINI_API_KEY": tfs.GKEY, "OPENAI_API_KEY": tfs.OKEY},
                                          [tfs.gemini_body(), tfs.openai_body()])
        self.assertEqual((code, len(fake.reqs)), (0, 2))
        out = "\n".join(lines)
        self.assertIn("provider=gemini model=gemini-3.5-flash-lite status=ok", out)
        self.assertIn("searches=", out)
        for bad in (tfs.GKEY, tfs.OKEY, "Alpha Plumbing", "chip", "http", "Page A"):
            self.assertNotIn(bad, out)

    def test_unset_key_skipped_without_a_call(self):
        code, lines, fake = self.run_main({"OPENAI_API_KEY": tfs.OKEY}, [tfs.openai_body()])
        self.assertEqual((code, len(fake.reqs)), (0, 1))
        self.assertIn("provider=gemini", lines[0]); self.assertIn("reason=provider_not_configured", lines[0])

    def test_no_retry_and_nonzero_exit_when_nothing_is_ok(self):
        code, lines, fake = self.run_main({"GEMINI_API_KEY": tfs.GKEY, "OPENAI_API_KEY": tfs.OKEY},
                                          [tfs.http_err(500), tfs.http_err(403)])
        self.assertEqual((code, len(fake.reqs)), (1, 2))        # exactly one call each, no retries
        code, lines, fake = self.run_main({}, [])
        self.assertEqual((code, len(fake.reqs)), (1, 0))

    def test_not_wired_into_ci_or_discovery(self):
        root = os.path.join(HERE, "..")
        self.assertNotIn("free_check_smoke", open(os.path.join(root, "ci", "avc-tests.yml")).read())
        self.assertFalse(os.path.exists(os.path.join(root, "tests", "free_check_smoke.py")))


if __name__ == "__main__":
    unittest.main()
