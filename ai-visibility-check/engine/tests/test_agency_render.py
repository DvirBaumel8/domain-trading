"""CR-133 engine side: agency render options, the fixed method footer, stored results, the PDF. Mock providers only."""
import hashlib, io, json, os, re, sys, tempfile, unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from aivis import stored
from aivis.order import Order, run_order
from aivis.report_pdf import build as build_pdf
from aivis.report_pro import HEALTH_NICHES, UNBRANDED_NAME, method_footer, render

GOLDEN = os.path.join(os.path.dirname(__file__), "golden", "report_default.html")
ROSTER = ["Austin Dental Clinic", "Capital Dental Group", "Lone Star Smiles", "Barton Springs Dentistry", "Zilker Family Dental"]
DATE = "2026-11-26"
LOGO = "data:image/png;base64,iVBORw0KGgo="
HOST, SUPPORT = "ai-visibility-check-nrtl.onrender.com", "dvirbaumel9-mcbgx2@mail.grokbot.com"


def run(niche="dentist", name="Austin Dental Spa", city="Austin, TX", roster=ROSTER):
    o = Order(order_id="AG-1", business_name=name, city=city, niche=niche, plan="check", paid=True)
    res, _ = run_order(o, mode="mock", roster=roster, out_dir=tempfile.mkdtemp())
    return res


def data_of(html):
    """The numbers and names of a report, without the header or the footer."""
    body = html.split("<h1>", 1)[1].split("<div class='foot'>", 1)[0]
    return re.findall(r"<(?:td|b|span)[^>]*>(.*?)</(?:td|b|span)>", body)


class AgencyRender(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.res = run()

    def branded(self, **kw):
        return render(self.res, date=DATE, brand="Northwind Digital", accent="#1D4ED8", logo=LOGO, hide_vendor=True,
                      contact_line="northwind.example", prepared_for="Austin Dental Spa", **kw)

    def unbranded(self):
        return render(self.res, date=DATE, brand=UNBRANDED_NAME, hide_vendor=True)

    def test_6_no_brand_arguments_is_byte_identical_to_main(self):
        self.assertEqual(render(self.res, date=DATE), open(GOLDEN, encoding="utf-8").read())

    def test_1_branded_has_the_brand_unbranded_has_none_of_it(self):
        b, u = self.branded(), self.unbranded()
        for needle in ("Northwind Digital", "<img src='data:image/png;base64,", "#1D4ED8", "northwind.example"):
            self.assertIn(needle, b)
            self.assertNotIn(needle, u)
        self.assertIn("AI VISIBILITY REPORT", u)

    def test_2_neither_names_us(self):
        for h in (self.branded(), self.unbranded()):
            for banned in ("AI Visibility Check", HOST, SUPPORT, "Not affiliated"):
                self.assertNotIn(banned, h)

    def test_3_both_carry_the_method_footer(self):
        for h in (self.branded(), self.unbranded()):
            for need in ("engines used", "Answers counted: %d" % self.res.score.total_answers, DATE,
                         "Results vary from run to run", "no ranking is promised", "not medical advice"):
                self.assertIn(need, h)
        roof = run("roofing", "Phoenix Roofing Co", "Phoenix, AZ", ["Desert Roofing", "Valley Roofers", "Sun Roof Pros"])
        self.assertNotIn("medical", render(roof, date=DATE, brand=UNBRANDED_NAME, hide_vendor=True))
        self.assertIn("dentist", HEALTH_NICHES)
        self.assertNotIn("roofing", HEALTH_NICHES)

    def test_4_the_numbers_do_not_depend_on_the_brand(self):
        self.assertEqual(data_of(self.branded()), data_of(self.unbranded()))
        self.assertTrue(data_of(self.unbranded()))

    def test_stored_result_round_trip_renders_the_same(self):
        again = stored.from_dict(json.loads(stored.dumps(stored.to_dict(self.res, DATE))))
        self.assertEqual(render(again, date=DATE, brand="X", hide_vendor=True), render(self.res, date=DATE, brand="X", hide_vendor=True))
        self.assertEqual(stored.dumps(stored.to_dict(again, DATE)), stored.dumps(stored.to_dict(self.res, DATE)))

    def test_bad_accent_and_logo_are_never_reflected(self):
        for bad in ("red", "#12", "#GGGGGG", "javascript:alert(1)", "#1D4ED8;}</style><script>x</script>"):
            h = render(self.res, date=DATE, brand="N", accent=bad, hide_vendor=True)
            self.assertNotIn(bad, h)
            self.assertNotIn("<script", h)
        h = render(self.res, date=DATE, brand="N", logo="javascript:alert(1)", hide_vendor=True)
        self.assertNotIn("javascript", h)

    def test_hostile_names_are_escaped(self):
        for name in ("<script>alert(1)</script>", '"><img src=x onerror=alert(1)>', "Northwind & Sons"):
            h = render(self.res, date=DATE, brand=name, prepared_for=name, contact_line=name, hide_vendor=True)
            self.assertNotIn("<script", h)
            self.assertNotIn("<img src=x", h)
        self.assertIn("Northwind &amp; Sons", render(self.res, date=DATE, brand="Northwind & Sons", hide_vendor=True))

    def test_5_pdf_is_a_real_pdf_with_the_brand(self):
        from pypdf import PdfReader
        text = lambda b: " ".join(p.extract_text() for p in PdfReader(io.BytesIO(b)).pages)
        branded = build_pdf(self.res, DATE, "Northwind Digital", None, "#1D4ED8", "Austin Dental Spa", "northwind.example")
        plain = build_pdf(self.res, DATE, UNBRANDED_NAME)
        self.assertTrue(branded.startswith(b"%PDF") and plain.startswith(b"%PDF"))
        self.assertIn("Northwind Digital", text(branded))
        for banned in ("Northwind", "AI Visibility Check", "northwind.example"):
            self.assertNotIn(banned, text(plain))
        self.assertIn("no ranking is promised", re.sub(r"\s+", " ", text(plain)))
        self.assertNotIn(b"<script", build_pdf(self.res, DATE, "<script>alert(1)</script>" * 20))

    def test_footer_text_is_fixed(self):
        f = method_footer(self.res, DATE)
        self.assertTrue(f.startswith("Method: engines used:"))


if __name__ == "__main__":
    unittest.main()
