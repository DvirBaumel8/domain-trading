import copy, html as htmllib, http.client, json, os, re, subprocess, sys, tempfile, unittest
HERE = os.path.dirname(os.path.abspath(__file__))
SITE = os.path.join(HERE, "..", "site")
sys.path.insert(0, SITE)
os.environ["ORDERS_LOCAL_DIR"] = os.path.join(tempfile.mkdtemp(), "orders")
import server  # noqa: E402,F401  (registers the /ai-answers route used via ServerCase)
import discovery, answer_index  # noqa: E402
from server_base import ServerCase  # noqa: E402

DATA = os.path.join(SITE, "data", "answer-index", "phoenix-az.json")
FORBIDDEN = ("best", "top", "#1", "ranked", "leading", "guarantee")
PHONE = re.compile(r"\d{3}[-. )]\d{3}[-.]\d{4}")


def load():
    with open(DATA, encoding="utf-8") as fh:
        return json.load(fh)


def text_sections(text):
    """One chunk of the page per trade section (split at each section heading)."""
    parts = re.split(r"(?=<h2>[^<]*AI output, checked on)", text)
    return [p for p in parts if p.startswith("<h2>")]


class Base(ServerCase):
    def get(self, path, headers=None):
        c = http.client.HTTPConnection("127.0.0.1", self.port)
        c.request("GET", path, headers=dict({"Host": "example.org", "X-Forwarded-Proto": "https"}, **(headers or {})))
        r = c.getresponse(); data = r.read(); c.close()
        return r.status, data.decode("utf-8", "replace")


class PageTests(Base):
    def setUp(self):
        self.st, self.html = self.get("/ai-answers/phoenix-az")
        self.d = load()

    def test_renders_with_every_name_and_counts(self):
        self.assertEqual(self.st, 200)
        sections = text_sections(htmllib.unescape(self.html))
        for t, sec in zip(self.d["trades"].values(), sections):
            for name, o, c in t["counts"]:
                self.assertIn(f"<tr><td>{name}</td><td>{o}</td><td>{c}</td></tr>", sec)
            order = re.findall(r"<tr><td>(.*?)</td>", sec)      # table keeps the order of `counts`
            self.assertEqual(order, [x[0] for x in t["counts"]])

    def test_numbers_match_the_json(self):
        for key, (distinct, both) in {"hvac": (43, 7), "plumber": (54, 10)}.items():
            t = self.d["trades"][key]
            names, per = set(), {"openai": set(), "claude": set()}
            for a in t["answers"]:
                names |= set(a["names"]); per[a["engine"]] |= set(a["names"])
            self.assertEqual((len(names), len(per["openai"] & per["claude"])), (distinct, both))
            self.assertIn(f"Distinct businesses named in total: {distinct}</li>", self.html)
            self.assertIn(f"Named by both: {both}</li>", self.html)
            self.assertIn(f"{both} of {distinct} distinct businesses were named by both", self.html)
            self.assertIn(f"Named by the OpenAI model: {len(per['openai'])}</li>", self.html)
            self.assertIn(f"Named by the Claude model: {len(per['claude'])}</li>", self.html)
        self.assertIn("Average names per answer: OpenAI model 2.9, Claude model 9.5.", self.html)

    def test_headings_lead_links_canonical(self):
        self.assertIn("<strong>AI output, checked on 27 Nov 2026.</strong>", self.html)
        self.assertEqual(self.html.count("— AI output, checked on 27 Nov 2026</h2>"), 2)
        self.assertIn("HVAC companies in Phoenix — AI output, checked on 27 Nov 2026", self.html)
        self.assertIn("Plumbers in Phoenix — AI output, checked on 27 Nov 2026", self.html)
        title = "Which businesses AI assistants named for HVAC and plumbing in Phoenix, AZ (checked 27 Nov 2026)"
        self.assertIn(f"<title>{title}</title>", self.html)
        self.assertIn(f"<h1>{title}</h1>", self.html)
        self.assertIn('href="/#check"', self.html)
        self.assertIn('href="/reserve"', self.html)
        self.assertIn('href="/for/hvac-companies"', self.html)
        self.assertIn('href="/for/plumbers"', self.html)
        self.assertIn('<link rel="canonical" href="https://example.org/ai-answers/phoenix-az">', self.html)
        self.assertIn("Not affiliated with OpenAI, Google or Anthropic", self.html)
        self.assertIn("an OpenAI model (gpt-6.2-sol)", self.html)
        self.assertIn("an Anthropic Claude model (claude-sonnet-5-5)", self.html)
        self.assertIn("Count = how many of the 8 answers contained the name. Not a quality ranking.", self.html)
        self.assertEqual(self.html.count('<ol class="questions">'), 2)
        self.assertNotIn("{{BUSINESS_ADDRESS}}", self.html)

    def test_questions_exact(self):
        for t in self.d["trades"].values():
            for q in t["questions"]:
                self.assertIn(f"<li>{htmllib.escape(q)}</li>", self.html)

    def test_forbidden_words_only_inside_questions(self):
        outside = re.sub(r'<ol class="questions">.*?</ol>', "", self.html, flags=re.S)
        outside = re.sub(r'<script.*?</script>', "", outside, flags=re.S)
        text = htmllib.unescape(re.sub(r"<[^>]+>", " ", outside)).lower()
        for w in FORBIDDEN:
            pat = re.escape(w) if w == "#1" else r"\b" + re.escape(w) + r"\b"
            self.assertIsNone(re.search(pat, text), w)
        self.assertIsNone(PHONE.search(self.html))
        self.assertIsNone(re.search(r"<img", self.html))
        self.assertNotRegex(self.html, r"(?i)openai[^\"']*\.(png|svg|jpg)")

    def test_ref_hit_logged_and_unknown_slug_404(self):
        for p in ("/ai-answers/nope", "/ai-answers/", "/ai-answers/phoenix-az/x", "/ai-answers/../x", "/ai-answers/phoenix-az.json"):
            self.assertEqual(self.get(p)[0], 404, p)
        self.assertEqual(self.get("/ai-answers/phoenix-az?ref=abc")[0], 200)

    def test_sitemap_and_llms(self):
        _, sm = self.get("/sitemap.xml")
        self.assertIn("<loc>https://example.org/ai-answers/phoenix-az</loc>", sm)
        _, llms = self.get("/llms.txt")
        self.assertIn("## AI answer index", llms)
        self.assertIn("https://example.org/ai-answers/phoenix-az", llms)


class ValidationTests(unittest.TestCase):
    def setUp(self):
        self.d = load()

    def test_good_file_valid(self):
        self.assertIsNotNone(answer_index.validate(self.d))

    def test_bad_files_skipped(self):
        def mut(fn):
            d = copy.deepcopy(self.d); fn(d); return d
        bad = [mut(lambda d: d.pop("data_date")), mut(lambda d: d.update(data_date="2026-13-40")),
               mut(lambda d: d.update(data_date="27 Nov 2026")), mut(lambda d: d.update(schema="x")),
               mut(lambda d: d["trades"]["hvac"]["counts"][0].__setitem__(1, 7)),      # counts disagree with answers
               mut(lambda d: d["trades"]["hvac"]["counts"].pop()),
               mut(lambda d: d["trades"]["hvac"]["answers"].pop()),
               mut(lambda d: d["trades"]["hvac"]["questions"].pop()),
               mut(lambda d: d["trades"]["hvac"].update(for_slug="not-a-trade")),
               mut(lambda d: d["engines"].pop("claude")), mut(lambda d: d.pop("usage")),
               mut(lambda d: d.update(trades={})), "not a dict", [], None]
        for d in bad:
            self.assertIsNone(answer_index.validate(d))

    def test_directory_skips_bad_and_keeps_good(self):
        with tempfile.TemporaryDirectory() as tmp:
            with open(os.path.join(tmp, "good.json"), "w") as f:
                json.dump(self.d, f)
            nodate = copy.deepcopy(self.d); nodate["slug"] = "other-az"; nodate.pop("data_date")
            with open(os.path.join(tmp, "nodate.json"), "w") as f:
                json.dump(nodate, f)
            with open(os.path.join(tmp, "broken.json"), "w") as f:
                f.write("{not json")
            self.assertEqual(list(answer_index.load_pages(tmp)), ["phoenix-az"])
        old = answer_index.INDEX_DIR
        try:
            with tempfile.TemporaryDirectory() as tmp:
                answer_index.INDEX_DIR = tmp
                with open(os.path.join(tmp, "x.json"), "w") as f:
                    f.write("{}")
                self.assertEqual(answer_index.public_paths(), [])
                self.assertNotIn("/ai-answers/", discovery.sitemap_xml("https://e.org"))
                self.assertNotIn("AI answer index", discovery.llms_txt("https://e.org"))
                self.assertEqual(answer_index.route("/ai-answers/phoenix-az", {})[0], 404)
        finally:
            answer_index.INDEX_DIR = old


class NoNetworkNoProviders(unittest.TestCase):
    def test_subprocess_imports_no_provider_and_no_socket(self):
        code = (
            "import socket, sys\n"
            "def boom(*a, **k): raise AssertionError('network call')\n"
            f"sys.path.insert(0, {SITE!r})\n"
            "import answer_index, discovery, urllib.request, http.client\n"      # import first: ssl needs the real class
            "socket.socket = boom; socket.create_connection = boom; socket.getaddrinfo = boom\n"
            "p = answer_index.public_paths(); assert p == ['/ai-answers/phoenix-az'], p\n"
            "pg = answer_index.load_pages()['phoenix-az']\n"
            "assert len(answer_index.page(pg, 'https://x.org')) > 1000\n"
            "discovery.sitemap_xml('https://x.org'); discovery.llms_txt('https://x.org')\n"
            "bad = [m for m in sys.modules if m == 'aivis.providers' or m.startswith('aivis.providers.')]\n"
            "assert not bad, bad\n"
            "print('ok')\n")
        r = subprocess.run([sys.executable, "-c", code], capture_output=True, text=True, timeout=60)
        self.assertEqual(r.stdout.strip(), "ok", r.stderr)


if __name__ == "__main__":
    unittest.main()
