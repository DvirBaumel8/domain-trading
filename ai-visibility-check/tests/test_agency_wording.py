"""Agency copy is neutral (CR-133): no resale framing on any page a buyer sees. Offline."""
import ast, os, pathlib, re

import agency_base as ab

SITE = pathlib.Path(__file__).resolve().parent.parent / "site"
BANNED = ("resell", "credits", "wallet", "balance", "reseller program", "marketplace", "lead generation",
          "prospect", "pitch", "outreach", "cold email", "top up", "revenue share", "white-label", "white label", "wholesale")
BANNED_WORD = ("earn",)       # whole word only ("learn" is fine)


def text_of(html):
    return re.sub(r"\s+", " ", re.sub(r"<[^>]+>", " ", html)).lower()


def strings_of(path):
    """User-visible string literals of a module: every str constant except docstrings and the banned-word lists."""
    tree = ast.parse(path.read_text(encoding="utf-8"))
    skip = set()
    for node in ast.walk(tree):
        if isinstance(node, (ast.Module, ast.FunctionDef, ast.ClassDef)) and node.body and isinstance(node.body[0], ast.Expr):
            skip.add(id(node.body[0].value))
        if isinstance(node, ast.Assign) and any(getattr(t, "id", "") in ("BANNED_WORDS", "BANNED") for t in node.targets):
            skip.update(id(n) for n in ast.walk(node.value))
    return " ".join(n.value for n in ast.walk(tree) if isinstance(n, ast.Constant) and isinstance(n.value, str) and id(n) not in skip).lower()


class Wording(ab.AgencyBase):
    def check(self, name, low, report_body=False):
        for w in BANNED:
            self.assertNotIn(w, low, f"{name}: {w}")
        for w in () if report_body else BANNED_WORD:      # the sample report's fix list says "Earn real mentions"; the report text stays as is
            self.assertIsNone(re.search(rf"\b{w}\b", low), f"{name}: {w}")
        for w in ("todo", "tbd", "placeholder"):
            self.assertNotRegex(low, rf"\b{w}\b", name)

    def test_served_pages(self):
        token, _ = self.new_bundle()
        pages = {"agency.html": "/agency.html", "agency-terms.html": "/agency-terms.html", "agency-thanks.html": "/agency-thanks.html",
                 "portal": f"/agency/p/{token}", "preview": f"/agency/p/{token}/preview?mode=branded",
                 "preview-unbranded": f"/agency/p/{token}/preview?mode=unbranded"}
        for name, path in pages.items():
            st, body, _ = self.call("GET", path)
            self.assertEqual(st, 200, name)
            low = text_of(body.decode())
            self.check(name, low, report_body=name.startswith("preview"))
            if name in ("agency.html", "agency-terms.html", "agency-thanks.html", "portal"):
                for must in ("no cash value", "own logo", "automated"):
                    self.assertIn(must, low, f"{name}: {must}")

    def test_sources(self):
        for n in ("agency.html", "agency-terms.html", "agency-thanks.html"):
            self.check(n, text_of((SITE / n).read_text(encoding="utf-8")))
        for n in ("agency.py", "agency_web.py"):
            self.check(n, text_of(strings_of(SITE / n)))

    def test_flag_off_agency_page(self):
        os.environ.pop("AIVIS_AGENCY")
        st, body, _ = self.call("GET", "/agency.html")
        self.assertEqual(st, 200)
        low = text_of(body.decode())
        self.check("agency.html (flag off)", low)
        for must in ("no cash value", "own logo", "automated"):
            self.assertIn(must, low)
        for gone in ("/agency-thanks.html", "/agency-terms.html"):
            self.assertEqual(self.call("GET", gone)[0], 404, gone)

    def test_thanks_page_is_private_and_posts_to_claim(self):
        raw = (SITE / "agency-thanks.html").read_text(encoding="utf-8")
        self.assertIn('name="robots" content="noindex', raw)
        self.assertIn("/agency/claim", raw)
        os.environ.pop("AIVIS_AGENCY")
        self.assertEqual(self.call("GET", "/agency-thanks.html")[0], 404)
