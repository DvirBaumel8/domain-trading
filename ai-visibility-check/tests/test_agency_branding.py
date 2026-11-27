"""CR-133 T-BRAND at the service level: a real (fake-vendor) run, then branded / unbranded output, PDF, SAMPLE preview."""
import hashlib, io, re, unittest

import agency_base as ab
from agency_base import CLIENT_C
from site_config import SUPPORT_EMAIL

HOST = "ai-visibility-check-nrtl.onrender.com"


def png(w=120, h=60, color=(30, 77, 216)):
    from PIL import Image
    out = io.BytesIO(); Image.new("RGB", (w, h), color).save(out, "PNG"); return out.getvalue()


def data_of(html):
    body = html.split("<h1>", 1)[1].split("<div class='foot'>", 1)[0]
    return re.findall(r"<(?:td|b|span)[^>]*>(.*?)</(?:td|b|span)>", body)


class Branding(ab.AgencyBase):
    def setUp(self):
        super().setUp()
        import os
        os.environ["AIVIS_ORDER_CAP_USD"] = "12"
        ab.fake_apis.TARGET["name"] = CLIENT_C["business"]
        self.token, self.bid = self.new_bundle()
        self.assertEqual(self.jcall("POST", f"/agency/p/{self.token}/brand", ab.AGENCY)[0], 200)
        self.assertEqual(self.call("POST", f"/agency/p/{self.token}/logo", png(), {"Content-Type": "image/png"}, raw=True)[0], 200)
        self.assertEqual(self.run_client(self.token, dict(CLIENT_C, prepared_for="Saint Paul Plumbing"))[0], 200)
        (self.order,) = self.orders_of(self.bid)
        self.assertEqual(self.order["status"], "ready")
        self.rtoken, self.oid = self.order["token"], self.order["order_id"]

    def report(self):
        st, body, _ = self.call("GET", "/r/" + self.rtoken); self.assertEqual(st, 200); return body.decode()

    def pdf_text(self):
        from pypdf import PdfReader
        st, body, h = self.call("GET", f"/r/{self.rtoken}.pdf")
        self.assertEqual((st, h["Content-Type"]), (200, "application/pdf"))
        self.assertTrue(body.startswith(b"%PDF"))
        return " ".join(p.extract_text() for p in PdfReader(io.BytesIO(body)).pages)

    def rebrand(self, mode, **kw):
        st, j = self.jcall("POST", f"/agency/p/{self.token}/rebrand", {"order_id": self.oid, "mode": mode, **ab.AGENCY, **kw})
        self.assertEqual(st, 200, j)

    def stored_hash(self):
        return hashlib.sha256(self.store().get_text(f"reports/{self.oid}/result.json").encode()).hexdigest()

    def test_1_to_4_branded_and_unbranded_share_the_data(self):
        b = self.report()
        for need in ("Northwind Digital", "<img src='data:image/png;base64,", "#1D4ED8", "northwind.example", "Prepared for Saint Paul Plumbing"):
            self.assertIn(need, b)
        before = self.stored_hash()
        self.rebrand("unbranded")
        u = self.report()
        for gone in ("Northwind", "data:image", "#1D4ED8", "northwind.example", "Prepared for"):
            self.assertNotIn(gone, u)
        for h in (b, u):
            for banned in ("AI Visibility Check", HOST, SUPPORT_EMAIL):
                self.assertNotIn(banned, h)
            for need in ("Results vary from run to run", "no ranking is promised", "Answers counted", "engines used"):
                self.assertIn(need, h)
            self.assertNotIn("medical advice", h)                 # a plumber is not a health niche
        self.assertEqual(data_of(b), data_of(u))
        self.assertEqual(self.stored_hash(), before)              # T-BRAND-10: the answers are untouched
        self.rebrand("branded")
        self.assertIn("Northwind Digital", self.report())
        self.assertEqual(self.stored_hash(), before)

    def test_5_pdf_follows_the_brand(self):
        t = self.pdf_text()
        self.assertIn("Northwind Digital", t)
        self.rebrand("unbranded")
        t = self.pdf_text()
        for gone in ("Northwind", "AI Visibility Check", "northwind.example"):
            self.assertNotIn(gone, t)
        self.assertIn(f"{CLIENT_C['business']}", t)

    def test_7_sample_preview_is_labelled_and_costs_nothing(self):
        calls, slots = len(ab.fake_apis.CALLS), self.files(f"bundle_runs/{self.bid}")
        for mode in ("branded", "unbranded"):
            st, body, h = self.call("GET", f"/agency/p/{self.token}/preview?mode={mode}")
            html = body.decode()
            self.assertEqual(st, 200)
            self.assertIn("SAMPLE", html)
            for banned in ("AI Visibility Check", HOST, SUPPORT_EMAIL):
                self.assertNotIn(banned, html)
            self.assertEqual("Northwind Digital" in html, mode == "branded")
        self.assertEqual(self.get("/r/" + self.token)[0], 404)             # the portal token is not a report token
        self.assertEqual((len(ab.fake_apis.CALLS), self.files(f"bundle_runs/{self.bid}")), (calls, slots))

    def test_8_hostile_agency_names_are_escaped(self):
        for name in ("<script>alert(1)</script>", '"><img src=x onerror=alert(1)>', "N" * 400, "Northwind & Sons"):
            st, j = self.jcall("POST", f"/agency/p/{self.token}/brand", {"name": name, "accent": "#1D4ED8"})
            self.assertEqual(st, 200)
            self.assertLessEqual(len(j["brand"]["name"]), 80)
            self.rebrand("branded", name=name)
            pages = [self.report(), self.call("GET", f"/agency/p/{self.token}")[1].decode(),
                     self.call("GET", f"/agency/p/{self.token}/preview?mode=branded")[1].decode()]
            for h in pages:
                self.assertNotIn("<script>alert", h)
                self.assertNotIn("<img src=x", h)
                self.assertNotIn("N" * 100, h)
            self.assertNotIn("<script>alert", self.pdf_text())
            # the portal's own script tag is ours; nothing agency-supplied may add another
            self.assertEqual(pages[1].count("<script"), 1)
        self.assertIn("Northwind &amp; Sons", self.report())

    def test_9_bad_accents_are_refused(self):
        for bad in ("red", "#12", "#GGGGGG", "javascript:alert(1)"):
            st, j = self.jcall("POST", f"/agency/p/{self.token}/brand", {"name": "Northwind Digital", "accent": bad})
            self.assertEqual(st, 400, bad)
            for page in (self.report(), self.call("GET", f"/agency/p/{self.token}/preview?mode=branded")[1].decode()):
                self.assertNotIn(f":{bad}", page)                  # never reflected into CSS
                if len(bad) > 4:
                    self.assertNotIn(bad, page)
        self.assertEqual(self.state(self.token)["brand"]["accent"], "#1D4ED8")


if __name__ == "__main__":
    unittest.main()
