"""The 12 static /guide/ pages: no network, no AI, nothing measured."""
import http.client, os, re, subprocess, sys, tempfile, threading, unittest
import xml.etree.ElementTree as ET
HERE = os.path.dirname(os.path.abspath(__file__))
SITE = os.path.join(HERE, "..", "site")
sys.path.insert(0, SITE)
os.environ["ORDERS_LOCAL_DIR"] = os.path.join(tempfile.mkdtemp(), "private-orders")
for k in ("ORDERS_REPO", "ORDERS_GITHUB_TOKEN", "ORDER_ALERT_WEBHOOK_URL", "AIVIS_PUBLIC_BASE_URL"):
    os.environ.pop(k, None)
import server, guides  # noqa: E402

server.http_call = lambda req, timeout=15: (_ for _ in ()).throw(AssertionError("network call"))
BASE = "https://example.org"
FORBIDDEN = [r"\bbest\b", r"\btop\b", r"top-rated", r"#1", r"guarantee", r"ranked", r"review", r"\d\s*%"]
FORBID_RE = re.compile("|".join(FORBIDDEN), re.I)
NAME_RE = re.compile(r"\b[A-Z][a-z]+ (?:Dental|Dentistry|Law Firm|Roofing|Plumbing)\b")


def text(path_slug):
    return guides.page(path_slug, BASE).decode()


class GuideTests(unittest.TestCase):
    def test_twelve_pages_unique_meta(self):
        ps = guides.pages()
        self.assertEqual(len(ps), 12)
        titles, descs = set(), set()
        for slug, *_ in ps:
            t = text(slug)
            titles.add(re.search(r"<title>(.*?)</title>", t).group(1))
            descs.add(re.search(r'<meta name="description" content="(.*?)">', t).group(1))
            self.assertIn(f'<link rel="canonical" href="{BASE}/guide/{slug}">', t)
            self.assertIn("Not affiliated with OpenAI, Google or Anthropic", t)
            self.assertEqual(len(re.findall(r"<li>“", t)), 8)
        self.assertEqual((len(titles), len(descs)), (12, 12))

    def test_forbidden_terms_absent(self):
        for slug, *_ in guides.pages():
            body = re.sub(r"<[^>]+>", " ", text(slug))
            self.assertIsNone(FORBID_RE.search(body), (slug, FORBID_RE.search(body)))
            self.assertIsNone(NAME_RE.search(body), slug)

    def test_questions_deterministic_and_use_places(self):
        for slug, _, niche, metro in guides.pages():
            a, b = guides.questions(niche, metro), guides.questions(niche, metro)
            self.assertEqual(a, b)
            self.assertEqual(len(set(a)), 8)
            self.assertTrue(any(p in " ".join(a) for p in metro[2][1:]))
        self.assertEqual(text("plumbers-phoenix-az"), text("plumbers-phoenix-az"))

    def test_related_links(self):
        t = text("dentists-austin-tx")
        self.assertIn('href="/city/dentists-austin-tx"', t)
        self.assertIn('href="/guide/dentists-phoenix-az"', t)
        self.assertIn('href="/guide/plumbers-austin-tx"', t)
        self.assertNotIn("/city/dentists-austin-tx", text("dentists-phoenix-az"))
        for s in ("/for/dentists", "/sample-report.html", "/#check"):
            self.assertIn(f'href="{s}"', t)

    def test_unknown_slug(self):
        self.assertIsNone(guides.page("dentists-mars"))
        self.assertIsNone(guides.route_slug("/guide/../etc"))

    def test_no_provider_import_no_network(self):
        code = ("import socket,sys\n"
                "def no(*a,**k): raise AssertionError('network')\n"
                "socket.socket.connect=no; socket.getaddrinfo=no; socket.create_connection=no\n"
                f"sys.path.insert(0,{SITE!r}); import guides\n"
                "[guides.page(s) for s,*_ in guides.pages()]\n"
                "assert not [m for m in sys.modules if m.startswith('aivis.providers')], 'provider imported'\n")
        r = subprocess.run([sys.executable, "-c", code], capture_output=True, text=True)
        self.assertEqual(r.returncode, 0, r.stderr)


class ServerTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.srv = server.http.server.ThreadingHTTPServer(("127.0.0.1", 0), server.H)
        threading.Thread(target=cls.srv.serve_forever, daemon=True).start()

    @classmethod
    def tearDownClass(cls):
        cls.srv.shutdown()

    def get(self, path):
        c = http.client.HTTPConnection("127.0.0.1", self.srv.server_port)
        c.request("GET", path, headers={"Host": "example.org", "X-Forwarded-Proto": "https"})
        r = c.getresponse()
        return r.status, r.read().decode()

    def test_served_in_sitemap_and_llms(self):
        _, sm = self.get("/sitemap.xml")
        ns = {"s": "http://www.sitemaps.org/schemas/sitemap/0.9"}
        locs = [u.text for u in ET.fromstring(sm).findall("s:url/s:loc", ns)]
        _, llms = self.get("/llms.txt")
        self.assertIn("## Guides", llms)
        for p in guides.guide_paths():
            self.assertIn(BASE + p, locs)
            self.assertIn(f"({BASE}{p})", llms)
            st, body = self.get(p)
            self.assertEqual(st, 200)
            self.assertIn(f'<link rel="canonical" href="{BASE}{p}">', body)
            self.assertNotIn("{{", body)
        self.assertEqual(self.get("/guide/nope")[0], 404)
        self.assertEqual(self.get("/guide/")[0], 404)


if __name__ == "__main__":
    unittest.main()
