import re, tempfile, unittest
from aivis.order import Order, run_order, normalize_website
from aivis.report_pro import render


class FreeReportText(unittest.TestCase):
    def html(self, niche):
        o = Order(order_id="FREE-t0000001", business_name="Zed", city="Austin, TX", niche=niche, plan="free")
        res, _ = run_order(o, mode="mock", out_dir=tempfile.mkdtemp(), roster=["Alpha One", "Beta Two", "Gamma Three"])
        for a, _, _ in res.records:
            a.provider = "pollinations"
        for p in res.score.providers:
            p.provider = "pollinations"
        return render(res, sample=True, run_note="x")

    def test_one_distinct_count_and_separate_mentions(self):
        for niche in ("dentist", "plumber"):
            h = self.html(niche)
            self.assertEqual(len(re.findall(r"names AI gave instead", h)), 1 + (1 if niche == "plumber" else 0), niche)
            self.assertIn("mentions", h)
            self.assertNotIn("pollinations", h.lower())
            self.assertIn("a free AI model", h)
            self.assertNotRegex(h, r"\s,")

    def test_website_hosts(self):
        for bad in ("127.0.0.1", "localhost", "10.1.2.3", "169.254.1.1", "a.local"):
            with self.assertRaises(ValueError):
                normalize_website(bad)
        self.assertEqual(normalize_website("acme.com"), "https://acme.com")


if __name__ == "__main__":
    unittest.main()
