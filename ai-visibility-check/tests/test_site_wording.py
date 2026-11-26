import pathlib
import unittest

SITE = pathlib.Path(__file__).resolve().parent.parent / "site"


class SiteWording(unittest.TestCase):
    def test_no_paypal_in_site(self):
        hits = []
        for p in SITE.rglob("*"):
            if p.is_file() and p.suffix in {".html", ".py", ".js", ".css", ".json", ".txt", ".md"}:
                if "paypal" in p.read_text(encoding="utf-8", errors="ignore").lower():
                    hits.append(str(p.relative_to(SITE)))
        self.assertEqual(hits, [])


if __name__ == "__main__":
    unittest.main()
