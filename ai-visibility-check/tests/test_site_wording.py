import pathlib
import re
import sys
import unittest

ROOT = pathlib.Path(__file__).resolve().parent.parent
SITE = ROOT / "site"
sys.path.insert(0, str(SITE))
sys.path.insert(0, str(ROOT / "engine"))
import server  # noqa: E402
from site_config import BUSINESS_ADDRESS  # noqa: E402

OLD_ADDRESS = "Physical postal address"
BANNED = [OLD_ADDRESS, "should be confirmed before the terms take effect", "Fix & Track", "Fix &amp; Track",
          "TODO", "FIXME", "TBD", "lorem ipsum", "placeholder text", "draft text", "[Your ", "address appears after launch"]


def served_pages():
    return {n: server.render_page((SITE / n).read_bytes()).decode() for n in sorted(server.PUBLIC_FILES) if n.endswith(".html")}


def email_templates():
    return {str(p.relative_to(ROOT)): p.read_text(encoding="utf-8") for p in (ROOT / "engine").rglob("*.py")
            if "email" in p.name.lower() or "footer" in p.name.lower()}


class SiteWording(unittest.TestCase):
    def test_no_paypal_in_site(self):
        hits = []
        for p in SITE.rglob("*"):
            if p.is_file() and p.suffix in {".html", ".py", ".js", ".css", ".json", ".txt", ".md"}:
                if "paypal" in p.read_text(encoding="utf-8", errors="ignore").lower():
                    hits.append(str(p.relative_to(SITE)))
        self.assertEqual(hits, [])

    def test_no_draft_or_placeholder_text(self):
        hits = []
        for name, text in {**served_pages(), **email_templates()}.items():
            low = text.lower()
            hits += [f"{name}: {b}" for b in BANNED if b.lower() in low]
            if re.search(r"\[[^\]]*(added before|to be added|insert|your address)[^\]]*\]", text, re.I):
                hits.append(f"{name}: bracket placeholder")
        self.assertEqual(hits, [])

    def test_address_comes_from_one_constant(self):
        self.assertEqual(BUSINESS_ADDRESS, "Dvir Baumel, A.D Gordon 18, Tel Aviv 6340726, Israel")
        for p in SITE.glob("*.html"):
            raw = p.read_text(encoding="utf-8")
            self.assertNotIn("A.D Gordon", raw, p.name)          # no hard-coded copy
            if p.name in {"sample-report.html"}:
                continue
            self.assertIn("{{BUSINESS_ADDRESS}}", raw, p.name)
            self.assertIn(BUSINESS_ADDRESS, served_pages()[p.name], p.name)
        for p in ROOT.rglob("*.py"):
            if p.name not in {"site_config.py", "test_site_wording.py"} and "venv" not in p.parts:
                self.assertNotIn("A.D Gordon", p.read_text(encoding="utf-8"), str(p))

    def test_register_claim_is_qualified_and_no_email_promise(self):
        import re as _re
        qual = "where one exists (dentists, orthodontists, chiropractors)"
        pages = served_pages()
        for n in ("index.html", "agency.html"):
            self.assertIn(qual, pages[n], n)
        for n, text in pages.items():
            for m in _re.finditer(r"checked against official registers", text):
                self.assertIn(qual, text[m.start():m.start() + 120], n)
        assets = {p.name: p.read_text(encoding="utf-8") for p in (SITE / "assets").glob("*.js")}
        for n, text in {**pages, **assets}.items():
            for banned in ("Email me my result", "we will send your free result", "will send your free result"):
                self.assertNotIn(banned.lower(), text.lower(), n)
        self.assertIn("your email to identify your order", pages["index.html"])
        self.assertNotIn("your email to deliver it", pages["index.html"] + pages["privacy.html"])
        from aivis.niches import NICHES
        self.assertEqual(sorted(k for k, v in NICHES.items() if v.npi_taxonomy),
                         ["chiropractor", "cosmetic_dentist", "dentist", "orthodontist"])

    def test_terms_and_refunds(self):
        pages = served_pages()
        self.assertIn("Tel Aviv have exclusive jurisdiction", pages["terms.html"])
        for w in ("Maps", "Listings", "Content", "Bundle"):
            self.assertIn(w, pages["refunds.html"])


if __name__ == "__main__":
    unittest.main()
