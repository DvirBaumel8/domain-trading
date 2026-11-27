import hashlib
import pathlib
import unittest

TERMS = pathlib.Path(__file__).resolve().parent.parent / "site" / "terms.html"
OLD = ("You may not resell our reports or our methods as your own product "
       "except under a separate agency agreement with us.")
NEW = ("If you bought an Agency Report Pack, you may deliver each report to the one client business "
       "it was made for, under your own brand. You may not resell, sublicense or redistribute reports "
       "otherwise, or offer them as a standalone product to third parties.")
# sha256 of terms.html before this change (with OLD in place of NEW)
ORIGINAL_SHA256 = "fa1b461556c3ff8d57c1a214d0da0007eaa1dfe91cf56f660edd6eae658399e6"


class TermsAgencySentence(unittest.TestCase):
    def setUp(self):
        self.raw = TERMS.read_bytes()
        self.text = self.raw.decode("utf-8")

    def test_new_sentence_once(self):
        self.assertEqual(self.text.count(NEW), 1)

    def test_old_wording_gone(self):
        self.assertNotIn("separate agency agreement", self.text)
        self.assertNotIn(OLD, self.text)

    def test_rest_of_page_unchanged(self):
        restored = self.text.replace(NEW, OLD).encode("utf-8")
        self.assertEqual(hashlib.sha256(restored).hexdigest(), ORIGINAL_SHA256)


if __name__ == "__main__":
    unittest.main()
