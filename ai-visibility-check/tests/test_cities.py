import http.client, json, os, subprocess, sys, tempfile, unittest
import xml.etree.ElementTree as ET
HERE = os.path.dirname(os.path.abspath(__file__))
SITE = os.path.join(HERE, "..", "site")
sys.path.insert(0, SITE)
TMP = tempfile.mkdtemp()
os.environ["ORDERS_LOCAL_DIR"] = os.path.join(TMP, "private-orders")
for k in ("ORDERS_REPO", "ORDERS_GITHUB_TOKEN", "ORDER_ALERT_WEBHOOK_URL", "AIVIS_PUBLIC_BASE_URL"):
    os.environ.pop(k, None)
import server, cities  # noqa: E402
from server_base import ServerCase  # noqa: E402

REAL_DIR = cities.MARKETS_DIR
server.http_call = lambda req, timeout=15: (_ for _ in ()).throw(AssertionError("network call"))

NOTE = "one AI model answering from memory (no web search), 6 questions, 1 Dec 2026."
ANSWERS = [["Alpha Dental", "Beta Smiles", "Gamma <b>Care</b>"], ["Alpha Dental", "Beta Smiles", "Delta Dental"],
           ["Alpha Dental", "Epsilon Dental", "Zeta Dental"], ["Alpha Dental", "Alpha Dental", "Beta Smiles"],
           ["Eta Dental", "Theta Dental", "Iota Dental"], ["Alpha Dental", "Kappa Dental", "Lambda Dental"]]


def market(**kw):
    d = {"niche": "dentist", "niche_label": "dentists", "city": "Testville, TX",
         "answers": [{"names": n, "raw": ["RAWSTRING " + x for x in n]} for n in ANSWERS],
         "competitors": 4, "unverified_pct": 37, "source_note": NOTE, "data_date": "2026-12-01"}
    d.update(kw)
    return d


def write(directory, name, obj, raw=None):
    os.makedirs(directory, exist_ok=True)
    with open(os.path.join(directory, name), "w", encoding="utf-8") as f:
        f.write(raw if raw is not None else json.dumps(obj))


class Base(ServerCase):
    MARKETS = None

    @classmethod
    def tearDownClass(cls):
        super().tearDownClass()
        cities.MARKETS_DIR = REAL_DIR

    def req(self, path, headers=None):
        c = http.client.HTTPConnection("127.0.0.1", self.port)
        c.request("GET", path, headers=headers or {})
        r = c.getresponse(); data = r.read(); c.close()
        return r.status, data.decode("utf-8", "replace"), r.getheader("Content-Type")


class FixtureCities(Base):
    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls.root = tempfile.mkdtemp()
        cls.dir = os.path.join(cls.root, "data", "markets")
        write(cls.dir, "dentist__testville-tx.json", market())
        m = market(); del m["data_date"]
        write(cls.dir, "dentist__nodate-tx.json", m)
        write(cls.dir, "dentist__baddate-tx.json", market(city="Baddate, TX", data_date="2026-13-45"))
        write(cls.dir, "dentist__empty-tx.json", market(city="Empty, TX", answers=[]))
        write(cls.dir, "dentist__broken-tx.json", None, raw="{not json")
        write(cls.dir, "dentist__hostile-tx.json", market(city="<script>alert(1)</script>, TX"))
        write(cls.dir, "notes.txt", None, raw="x")
        cities.MARKETS_DIR = cls.dir
        cls.v = cities.load_markets()["dentists-testville-tx"]

    def test_only_valid_market_is_listed(self):
        self.assertEqual(list(cities.load_markets()), ["dentists-testville-tx"])
        self.assertEqual(cities.public_paths(), ["/city", "/city/dentists-testville-tx"])
        st, body, _ = self.req("/city")
        self.assertEqual(st, 200)
        self.assertIn("/city/dentists-testville-tx", body)
        self.assertIn("2026-12-01", body)
        for bad in ("nodate", "baddate", "empty", "broken", "hostile", "alert("):
            self.assertNotIn(bad, body.lower())
            self.assertEqual(self.req(f"/city/dentists-{bad}-tx")[0], 404)
        self.assertEqual(self.req("/city/dentists-testville-tx/card.svg")[0], 200)
        self.assertEqual(self.req("/city/dentists-nodate-tx/card.svg")[0], 404)

    def test_numbers_match_independent_computation(self):
        names = [set(a) for a in ANSWERS]
        distinct = len(set().union(*names))
        st, body, ct = self.req("/city/dentists-testville-tx")
        self.assertEqual(st, 200)
        self.assertIn("text/html", ct)
        self.assertIn(f"Questions asked: {len(ANSWERS)}", body)
        self.assertIn(f"Distinct businesses named: {distinct}", body)
        self.assertIn("matched to the official roster: 4", body)
        self.assertIn("not matched to the roster: 37%", body)
        self.assertIn("Data date: 2026-12-01", body)
        self.assertIn(NOTE, body)
        self.assertEqual(body.count("<li>"), 5)      # the 5 stat items only: names are off by default
        self.assertNotIn("RAWSTRING", body)
        self.assertEqual(body.count("<h1>"), 1)
        self.assertIn("Who does AI name for dentists in Testville, TX?", body)
        self.assertIn("not a ranking", body.lower())

    def test_show_names_on_explicitly(self):
        shipped = cities.SHOW_NAMES
        cities.SHOW_NAMES = True
        try:
            body = self.req("/city/dentists-testville-tx")[1]
            # N-of-M: Alpha is in 5 of 6 answers (counted once per answer), Beta in 3
            self.assertIn("Alpha Dental — named in 5 of 6 answers", body)
            self.assertIn("Beta Smiles — named in 3 of 6 answers", body)
            self.assertEqual(body.count("<li>") - 5, 5)  # 5 stat items + at most 5 names
            self.assertNotIn("Lambda Dental", body)
            self.assertNotIn("RAWSTRING", body)
            self.assertIn("have not verified", body)     # the disclaimer shows only together with names
            self.assertNotIn("Alpha Dental", self.req("/city/dentists-testville-tx/card.svg")[1])
        finally:
            cities.SHOW_NAMES = shipped

    def test_cta_and_links(self):
        body = self.req("/city/dentists-testville-tx")[1]
        self.assertEqual(body.count('data-pay="payLinkCheck"'), 1)
        self.assertEqual(body.count("$"), 1)
        self.assertIn("$149", body)
        self.assertNotIn("buy.polar.sh", body)
        self.assertIn('href="/#check"', body)
        self.assertNotIn("payLinkMonthly", body)
        self.assertNotIn("{{BUSINESS_ADDRESS}}", body)
        self.assertIn("Tel Aviv", body)
        self.assertIn("/privacy.html", body)
        self.assertNotIn("http://www.", body.replace("http://www.w3.org", ""))

    def test_head_tags_and_share_links(self):
        body = self.req("/city/dentists-testville-tx", {"Host": "example.org", "X-Forwarded-Proto": "https"})[1]
        self.assertIn('<link rel="canonical" href="https://example.org/city/dentists-testville-tx">', body)
        self.assertIn('og:title', body); self.assertIn('twitter:title', body); self.assertIn('name="description"', body)
        self.assertNotIn("og:image", body); self.assertNotIn("twitter:image", body)
        self.assertIn("mailto:?subject=", body)
        self.assertIn("twitter.com/intent/tweet?url=https%3A%2F%2Fexample.org%2Fcity%2Fdentists-testville-tx", body)
        self.assertIn("linkedin.com/sharing/share-offsite/?url=https%3A%2F%2Fexample.org%2Fcity%2Fdentists-testville-tx", body)
        self.assertEqual(body.count("<script"), 3)   # first-party ref.js + config.js + app.js only
        self.assertNotIn("http://", body.replace("http://www.w3.org", ""))

    def test_origin_comes_from_the_discovery_helper(self):
        # cities.public_base is gone: canonical and share URLs use discovery.public_origin
        self.assertFalse(hasattr(cities, "public_base"))
        canon = lambda h: __import__("re").search(r'rel="canonical" href="(.*?)"', self.req("/city/dentists-testville-tx", h)[1]).group(1)
        self.assertEqual(canon({"Host": "a.b:80", "X-Forwarded-Proto": "http"}), "http://a.b:80/city/dentists-testville-tx")
        self.assertEqual(canon({"Host": "a.b"}), "https://a.b/city/dentists-testville-tx")
        os.environ["AIVIS_PUBLIC_BASE_URL"] = "https://site.example/"
        try:
            self.assertEqual(canon({"Host": "x.y"}), "https://site.example/city/dentists-testville-tx")
            os.environ["AIVIS_PUBLIC_BASE_URL"] = "javascript:1"
            self.assertEqual(canon({"Host": "x.y"}), "/city/dentists-testville-tx")     # unsafe origin: relative, never echoed
        finally:
            os.environ.pop("AIVIS_PUBLIC_BASE_URL", None)

    def test_card_svg_valid_xml(self):
        st, body, ct = self.req("/city/dentists-testville-tx/card.svg")
        self.assertEqual((st, ct), (200, "image/svg+xml"))
        root = ET.fromstring(body.encode())
        self.assertEqual((root.get("width"), root.get("height")), ("1200", "630"))
        text = " ".join("".join(t.itertext()) for t in root.iter() if t.tag.endswith("text"))
        for want in ("Testville, TX", "dentists", "6 questions asked", "2026-12-01", "Snapshot of AI answers, not a ranking",
                     "AI Visibility Check"):
            self.assertIn(want, text)
        self.assertIn(f"{len(set().union(*[set(a) for a in ANSWERS]))} distinct businesses named", text)
        self.assertNotIn("Alpha Dental", body)
        self.assertIn("/city/dentists-testville-tx/card.svg", self.req("/city/dentists-testville-tx")[1])

    def test_unique_head_per_city(self):
        write(self.dir, "dentist__second-tx.json", market(city="Second, TX", data_date="2026-12-02"))
        try:
            import re
            seen = {k: set() for k in ("title", "desc", "canon")}
            for s in ("dentists-testville-tx", "dentists-second-tx"):
                b = self.req(f"/city/{s}")[1]
                seen["title"].add(re.search(r"<title>(.*?)</title>", b).group(1))
                seen["desc"].add(re.search(r'name="description" content="(.*?)"', b).group(1))
                seen["canon"].add(re.search(r'rel="canonical" href="(.*?)"', b).group(1))
            self.assertTrue(all(len(v) == 2 for v in seen.values()), seen)
        finally:
            os.remove(os.path.join(self.dir, "dentist__second-tx.json"))

    def test_show_names_off(self):
        st, body, _ = self.req("/city/dentists-testville-tx")
        card = self.req("/city/dentists-testville-tx/card.svg")[1]
        self.assertEqual(st, 200)
        for n in set().union(*[set(a) for a in ANSWERS]):
            self.assertNotIn(n, body); self.assertNotIn(n, card)
        self.assertNotIn("named in", body)
        self.assertNotIn("have not verified", body)
        self.assertIn("Questions asked: 6", body)

    def test_traversal_and_unknown(self):
        for p in ("/city/../server.py", "/city/%2e%2e/server.py", "/city/..%2fserver.py", "/city/%2e%2e%2fserver.py",
                  "/city/dentists-testville-tx/../../server.py", "/city/dentists-testville-tx/card.svg/x",
                  "/city/dentists-testville-tx/card.svg/", "/city/dentists-testville-tx/", "/city/", "/city/nope",
                  "/city/DENTISTS-TESTVILLE-TX", "/city/dentists-testville-tx%00", "/city/dentists-testville-tx/other.svg",
                  "/city/..%5cserver.py", "/city/dentists-testville-tx.json", "/city/dentist__testville-tx"):
            st, body, _ = self.req(p)
            self.assertEqual(st, 404, p)
            self.assertNotIn("Testville", body, p)
        self.assertEqual(self.req("/data/markets/dentist__testville-tx.json")[0], 404)

    def test_canary_private_data_never_public(self):
        data = os.path.join(self.root, "data")
        canary = {"business": "CANARYBIZ Plumbing", "city": "Canaryburg, TX", "email": "canary@leak.example", "ip": "203.0.113.77"}
        write(data, "requests.jsonl", None, raw=json.dumps(canary) + "\n")
        write(data, "ref-hits.jsonl", None, raw=json.dumps({**canary, "ref": "CANARYREF"}) + "\n")
        write(os.path.join(data, "free-checks", "FREE-aaaaaaaa"), "report.html", None, raw="<p>CANARYBIZ canary@leak.example</p>")
        write(os.path.join(self.root, "private-orders", "orders"), "ORD-1.json", canary)
        pages = [self.req(p)[1] for p in ("/city", "/city/dentists-testville-tx", "/city/dentists-testville-tx/card.svg")]
        pages.append("\n".join(cities.public_paths()))
        for b in pages:
            for c in ("CANARYBIZ", "canary@leak.example", "Canaryburg", "203.0.113.77", "CANARYREF", "leak.example"):
                self.assertNotIn(c, b)
            self.assertNotIn('"ip"', b)
        src = open(os.path.join(SITE, "cities.py"), encoding="utf-8").read().split('"""', 2)[2]   # code only
        for f in ("requests.jsonl", "ref-hits", "free-checks", "private-orders", "ORDERS_"):
            self.assertNotIn(f, src)

    def test_xss_escaped_in_page_and_svg(self):
        evil = '<script>alert("x")</script>&"\''
        write(self.dir, "dentist__xss-tx.json", market(
            city="Xss, TX", source_note="note " + evil,
            answers=[{"names": [evil, "Safe One"], "raw": [evil, "Safe One"]}] * 3, competitors=1))
        try:
            st, body, _ = self.req("/city/dentists-xss-tx")
            svg = self.req("/city/dentists-xss-tx/card.svg")[1]
            self.assertEqual(st, 200)
            self.assertNotIn("<script>alert", body)
            self.assertIn("&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;&amp;&quot;&#x27;", body)
            self.assertNotIn("<script>alert", svg)
            ET.fromstring(svg.encode())
            self.assertEqual(body.count("<script"), 3)
        finally:
            os.remove(os.path.join(self.dir, "dentist__xss-tx.json"))

    def test_no_valid_markets_means_404_and_no_paths(self):
        empty = tempfile.mkdtemp()
        old, cities.MARKETS_DIR = cities.MARKETS_DIR, empty
        try:
            self.assertEqual(self.req("/city")[0], 404)
            self.assertEqual(cities.public_paths(), [])
        finally:
            cities.MARKETS_DIR = old


class ShippedData(Base):
    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cities.MARKETS_DIR = REAL_DIR

    def test_austin_dentists(self):
        st, body, _ = self.req("/city/dentists-austin-tx")
        self.assertEqual(st, 200)
        raw = json.load(open(os.path.join(REAL_DIR, "dentist__austin-tx.json"), encoding="utf-8"))
        self.assertEqual(raw["data_date"], "2026-11-25")
        self.assertIn("Data date: 2026-11-25", body)
        self.assertIn(raw["source_note"], body)
        self.assertIn(f"Questions asked: {len(raw['answers'])}", body)
        self.assertIn("$149", body)
        self.assertEqual(body.count('data-pay="payLinkCheck"'), 1)
        self.assertEqual(body.count("$"), 1)
        self.assertEqual(self.req("/city/dentists-austin-tx/card.svg")[0], 200)
        self.assertIn("/city/dentists-austin-tx", self.req("/city")[1])

    def test_market_json_not_public_and_robots(self):
        self.assertNotIn("data", server.PUBLIC_DIRS)
        for p in ("/data/markets/dentist__austin-tx.json", "/data/markets/", "/data/requests.jsonl",
                  "/%64ata/markets/dentist__austin-tx.json", "/assets/../data/markets/dentist__austin-tx.json"):
            self.assertEqual(self.req(p)[0], 404, p)
        self.assertIn("Disallow: /data/", self.req("/robots.txt")[1])


class BuildCacheDate(unittest.TestCase):
    def run_cli(self, *extra):
        return subprocess.run([sys.executable, os.path.join(SITE, "build_market_cache.py"), "--niche", "dentist",
                               "--city", "Austin, TX", "--answers", "/nonexistent", "--roster", "/nonexistent",
                               "--source-note", "n", *extra], capture_output=True, text=True)

    def test_data_date_required_and_validated(self):
        r = self.run_cli()
        self.assertNotEqual(r.returncode, 0); self.assertIn("--data-date", r.stderr)
        for bad in ("25 Nov 2026", "2026-13-01", "2026-02-30", "2026-1-1", ""):
            r = self.run_cli("--data-date", bad)
            self.assertNotEqual(r.returncode, 0, bad)
            self.assertIn("--data-date must be a real date", r.stderr)
        r = self.run_cli("--data-date", "2026-11-25")      # date accepted; fails later on the missing input files
        self.assertNotIn("--data-date must", r.stderr)

    def test_source_writes_field(self):
        src = open(os.path.join(SITE, "build_market_cache.py"), encoding="utf-8").read()
        self.assertIn('"data_date": a.data_date', src)


if __name__ == "__main__":
    unittest.main()
