import html as htmllib, http.client, json, os, re, sys, tempfile, threading, unittest
import xml.etree.ElementTree as ET
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "site"))
os.environ["ORDERS_LOCAL_DIR"] = os.path.join(tempfile.mkdtemp(), "orders")
import server, discovery, cities, products  # noqa: E402


def no_network(req, timeout=15):
    raise AssertionError("unexpected network call: " + req.full_url)
server.http_call = no_network

PRIVATE = ("/thanks.html", "/r/", "/status/", "/api/", "/free/", "/data/")
EXPECTED_PLURALS = {
    "dentist": "dentists", "cosmetic_dentist": "cosmetic dentists", "med_spa": "med spas",
    "personal_injury_lawyer": "personal injury lawyers", "criminal_defense_lawyer": "criminal defense lawyers",
    "hvac": "HVAC companies", "roofing": "roofing companies", "plumber": "plumbers", "chiropractor": "chiropractors",
    "veterinarian": "veterinarians", "garage_door": "garage door companies", "electrician": "electricians",
    "real_estate_agent": "real estate agents", "orthodontist": "orthodontists", "family_law_attorney": "divorce lawyers"}
EXPECTED_SLUGS = {"dentists", "cosmetic-dentists", "med-spas", "personal-injury-lawyers", "criminal-defense-lawyers",
                  "hvac-companies", "roofing-companies", "plumbers", "chiropractors", "veterinarians",
                  "garage-door-companies", "electricians", "real-estate-agents", "orthodontists", "divorce-lawyers"}


class OriginTests(unittest.TestCase):
    def test_env_wins_and_is_validated(self):
        self.assertEqual(discovery.public_origin("evil.com", "http", {"AIVIS_PUBLIC_BASE_URL": "https://example.com/"}), "https://example.com")
        self.assertEqual(discovery.public_origin("a.com", None, {"AIVIS_PUBLIC_BASE_URL": "javascript:alert(1)"}), "")

    def test_host_header(self):
        self.assertEqual(discovery.public_origin("Example.COM", None, {}), "https://example.com")
        self.assertEqual(discovery.public_origin("example.com:8080", "http", {}), "http://example.com:8080")
        self.assertEqual(discovery.public_origin("example.com", "ftp", {}), "https://example.com")

    def test_hostile_host(self):
        for bad in ("evil.com/<script>", "a.com\r\nX: y", "a b.com", "a.com@evil.com", "-a.com", "a..com", "", None,
                    "a.com:99999999", "x" * 300 + ".com", "a.com/path", "<b>.com", "a.com#x", "a.com?q"):
            self.assertEqual(discovery.public_origin(bad, "https", {}), "", repr(bad))


class TradeData(unittest.TestCase):
    def test_all_fifteen_plurals_and_slugs(self):
        from aivis.niches import NICHES
        self.assertEqual({k: n.plural for k, n in NICHES.items()}, EXPECTED_PLURALS)
        self.assertEqual({s for s, _ in discovery.trades()}, EXPECTED_SLUGS)
        self.assertEqual(len(discovery.trades()), len(NICHES))

    def test_example_prompts_exist(self):
        for _, n in discovery.trades():
            self.assertGreaterEqual(len(discovery.example_prompts(n)), 3, n.key)


class Base(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.srv = server.http.server.ThreadingHTTPServer(("127.0.0.1", 0), server.H)
        cls.port = cls.srv.server_address[1]
        threading.Thread(target=cls.srv.serve_forever, daemon=True).start()

    @classmethod
    def tearDownClass(cls):
        cls.srv.shutdown(); cls.srv.server_close()

    def get(self, path, headers=None):
        c = http.client.HTTPConnection("127.0.0.1", self.port)
        c.request("GET", path, headers=headers or {})
        r = c.getresponse(); data = r.read(); c.close()
        return r.status, data.decode("utf-8", "replace"), r

    def ld(self, text):
        blocks = re.findall(r'<script type="application/ld\+json">(.*?)</script>', text, re.S)
        return [json.loads(b) for b in blocks]


class SitemapRobotsLlms(Base):
    def test_sitemap(self):
        st, body, r = self.get("/sitemap.xml", {"Host": "example.org", "X-Forwarded-Proto": "https"})
        self.assertEqual(st, 200)
        self.assertIn("xml", r.getheader("Content-Type"))
        ns = {"s": "http://www.sitemaps.org/schemas/sitemap/0.9"}
        locs = [e.text for e in ET.fromstring(body).findall("s:url/s:loc", ns)]
        paths = {l.replace("https://example.org", "") for l in locs}
        self.assertTrue(all(l.startswith("https://example.org/") for l in locs))
        for p in discovery.PUBLIC_PAGES + tuple(discovery.trade_paths()):
            self.assertIn(p, paths)
        self.assertEqual(len(locs), 6 + 15 + len(cities.public_paths()))     # + /city and the dated city pages
        for p in cities.public_paths():
            self.assertIn(p, paths)
        for bad in PRIVATE:
            self.assertFalse([p for p in paths if p.startswith(bad)], bad)

    def test_sitemap_env_origin(self):
        os.environ["AIVIS_PUBLIC_BASE_URL"] = "https://www.example.net"
        try:
            _, body, _ = self.get("/sitemap.xml", {"Host": "other.example"})
        finally:
            del os.environ["AIVIS_PUBLIC_BASE_URL"]
        self.assertIn("<loc>https://www.example.net/for/dentists</loc>", body)
        self.assertNotIn("other.example", body)

    def test_sitemap_hostile_host_not_echoed(self):
        _, body, _ = self.get("/sitemap.xml", {"Host": "evil.com/<x>"})
        ET.fromstring(body)
        self.assertNotIn("evil", body)

    def test_robots(self):
        st, body, _ = self.get("/robots.txt", {"Host": "example.org"})
        self.assertEqual(st, 200)
        self.assertIn("Sitemap: https://example.org/sitemap.xml", body)
        for d in ("/data/", "/api/", "/r/", "/status/", "/free/"):
            self.assertIn("Disallow: " + d, body)

    def test_llms_txt(self):
        st, body, _ = self.get("/llms.txt")
        self.assertEqual(st, 200)
        self.assertTrue(body.startswith("# AI Visibility Check\n"))
        self.assertRegex(body.split("\n")[2], r"^> .+")
        links = re.findall(r"\]\((\S+?)\)", body)
        self.assertGreater(len(links), 20)
        for l in links:
            path = re.sub(r"^https?://[^/]+", "", l).split("#")[0] or "/"
            self.assertEqual(self.get(path)[0], 200, l)


class TradePages(Base):
    def test_every_trade(self):
        cfg = discovery.site_config()
        titles, descs = set(), set()
        for slug, n in discovery.trades():
            st, body, _ = self.get("/for/" + slug)
            self.assertEqual(st, 200, slug)
            self.assertIn(f"<h1>AI visibility for {htmllib.escape(n.plural)}</h1>", body)
            title = re.search(r"<title>(.*?)</title>", body).group(1)
            desc = re.search(r'<meta name="description" content="(.*?)">', body).group(1)
            titles.add(title); descs.add(desc)
            self.assertRegex(body, rf'<link rel="canonical" href="https://127\.0\.0\.1:\d+/for/{slug}">')
            for og in ("og:title", "og:description", "og:url", "og:type"):
                self.assertIn(f'property="{og}"', body)
            self.assertIn(f'href="{cfg["payLinkCheck"]}"', body)
            self.assertEqual(set(re.findall(r"\$\d+", body)), {"$149"}, slug)
            self.assertIn('href="/sample-report.html"', body)
            self.assertIn('href="/#check"', body)
            self.assertNotIn("{{", body)
            self.assertIn(server.BUSINESS_ADDRESS, body)
            self.assertNotIn("aggregateRating", body)
            self.assertEqual(len(self.ld(body)), 1)
        self.assertEqual(len(titles), 15)
        self.assertEqual(len(descs), 15)

    def test_only_base_check_buy_links(self):
        _, body, _ = self.get("/for/dentists")
        self.assertEqual(set(re.findall(r'data-pay="(\w+)"', body)), {"payLinkCheck"})

    def test_not_found_and_traversal(self):
        for p in ("/for/nope", "/for/", "/for", "/for/../server.py", "/for/%2e%2e/server.py", "/for/..%2fserver.py",
                  "/for/dentists/", "/for/Dentists", "/for/dentists.html", "/for/%2e%2e%2f%2e%2e%2fREADME.md",
                  "/for/dentists%00"):
            self.assertEqual(self.get(p)[0], 404, p)


class HomeStructuredData(Base):
    def setUp(self):
        _, self.body, _ = self.get("/", {"Host": "example.org"})
        blocks = self.ld(self.body)
        self.assertEqual(len(blocks), 1)
        self.graph = blocks[0]["@graph"]

    def by_type(self, t):
        return [x for x in self.graph if x["@type"] == t]

    def test_organization(self):
        org = self.by_type("Organization")[0]
        self.assertEqual(org["name"], "AI Visibility Check")
        self.assertEqual(org["url"], "https://example.org/")
        self.assertIn(org["contactPoint"]["email"], self.body.split("</script>", 1)[1])   # already public in the footer

    def test_product_prices_match_polar(self):
        # with the add-on switch off (shipped) only the base check carries an offer; the price is products.py's
        want = {"AI Visibility Check": "149"}
        got = {p["name"]: p["offers"] for p in self.by_type("Product") if "offers" in p}
        self.assertEqual({k: v["price"] for k, v in got.items()}, want)
        self.assertEqual(str(products.TYPES["base"]["price_usd"]), want["AI Visibility Check"])
        self.assertFalse(hasattr(discovery, "PRODUCTS"))        # no second price table
        for o in got.values():
            self.assertEqual(o["priceCurrency"], "USD")
            self.assertEqual(o["availability"], "https://schema.org/InStock")

    def test_no_ratings_and_no_monthly_offers(self):
        raw = json.dumps(self.graph)
        keys, types = set(), set()
        def walk(o):                      # schema property names and @types (the visible FAQ text may say "reviews")
            if isinstance(o, dict):
                for k, v in o.items():
                    keys.add(k); walk(v)
                    if k == "@type":
                        types.add(v)
            elif isinstance(o, list):
                for v in o:
                    walk(v)
        walk(self.graph)
        for w in ("aggregateRating", "review", "reviewRating", "ratingValue", "reviewCount"):
            self.assertNotIn(w, keys)
        self.assertFalse({t for t in types if "Rating" in t or "Review" in t})
        for plan in discovery.COMING_SOON_PLANS:
            self.assertFalse([p for p in self.by_type("Product") if p["name"] in (plan, plan + " plan")])
        self.assertEqual(raw.count("InStock"), 1)       # add-ons: no offers while the switch is off

    def test_faq_matches_visible(self):
        faq = self.by_type("FAQPage")[0]["mainEntity"]
        self.assertTrue(5 <= len(faq) <= 12)      # the merged "Honest answers" block (was 7 + 7 before the merge)
        self.assertEqual(self.body.count("<details>"), len(faq))      # exactly one FAQ block on the page
        sec = re.search(r'<section id="faq">(.*?)</section>', self.body, re.S).group(1)
        visible = [(htmllib.unescape(q), htmllib.unescape(re.sub(r"<[^>]+>", "", a)))
                   for q, a in re.findall(r"<summary>(.*?)</summary><p>(.*?)</p>", sec, re.S)]
        self.assertEqual(visible, [(x["name"], x["acceptedAnswer"]["text"]) for x in faq])

    def test_trades_linked_from_home(self):
        for p in discovery.trade_paths():
            self.assertIn(f'href="{p}"', self.body)

    def test_json_ld_escapes_script_end(self):
        self.assertNotIn("</script>", discovery._ld_script({"x": "</script><b>"})[:-9])


if __name__ == "__main__":
    unittest.main()
