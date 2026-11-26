"""Tests for the combined discovery + refs + city pages change: product map, one FAQ, ref logging on every public
page, sitemap/llms/links, names off by default, private store, add-on switch. No network."""
import html as htmllib, http.client, json, os, re, shutil, sys, tempfile, threading, unittest
import xml.etree.ElementTree as ET
HERE = os.path.dirname(os.path.abspath(__file__))
SITE = os.path.join(HERE, "..", "site")
sys.path.insert(0, SITE)
os.environ["ORDERS_LOCAL_DIR"] = os.path.join(tempfile.mkdtemp(), "orders")
for k in ("ORDERS_REPO", "ORDERS_GITHUB_TOKEN", "ORDER_ALERT_WEBHOOK_URL", "AIVIS_PUBLIC_BASE_URL"):
    os.environ.pop(k, None)
import server, discovery, cities, products, refs  # noqa: E402

REAL_MARKETS = cities.MARKETS_DIR
server.http_call = lambda req, timeout=15: (_ for _ in ()).throw(AssertionError("network call"))
CHECK = {"business": "Acme Dental", "city": "Austin, TX", "niche": "dentist", "email": "a@b.co"}
ADDON_KEYS = products.ADDON_PAY_KEYS


class flag:
    """Set ADDONS_CHECKOUT for a block (None = unset = the shipped default, on)."""
    def __init__(self, value):
        self.value = value

    def __enter__(self):
        self.old = os.environ.get("ADDONS_CHECKOUT")
        if self.value is None:
            os.environ.pop("ADDONS_CHECKOUT", None)
        else:
            os.environ["ADDONS_CHECKOUT"] = self.value

    def __exit__(self, *a):
        if self.old is None:
            os.environ.pop("ADDONS_CHECKOUT", None)
        else:
            os.environ["ADDONS_CHECKOUT"] = self.old


def read(*p):
    with open(os.path.join(SITE, *p), encoding="utf-8") as f:
        return f.read()


def hit_lines(path):
    if not os.path.exists(path):
        return []
    with open(path, encoding="utf-8") as f:
        return [json.loads(x) for x in f if x.strip()]


class Base(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.srv = server.http.server.ThreadingHTTPServer(("127.0.0.1", 0), server.H)
        cls.port = cls.srv.server_address[1]
        threading.Thread(target=cls.srv.serve_forever, daemon=True).start()

    @classmethod
    def tearDownClass(cls):
        cls.srv.shutdown(); cls.srv.server_close()
        cities.MARKETS_DIR = REAL_MARKETS

    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self._data, self._orders = server.DATA, server.LOCAL_ORDERS
        server.DATA = self.tmp
        server.LOCAL_ORDERS = os.path.join(self.tmp, "store")
        self.hits = os.path.join(self.tmp, "ref-hits.jsonl")

    def tearDown(self):
        server.DATA, server.LOCAL_ORDERS = self._data, self._orders
        cities.MARKETS_DIR = REAL_MARKETS
        shutil.rmtree(self.tmp, ignore_errors=True)

    def get(self, path, headers=None):
        c = http.client.HTTPConnection("127.0.0.1", self.port)
        c.request("GET", path, headers=headers or {})
        r = c.getresponse(); data = r.read(); c.close()
        return r.status, data.decode("utf-8", "replace")

    def post(self, path, obj):
        c = http.client.HTTPConnection("127.0.0.1", self.port)
        c.request("POST", path, json.dumps(obj).encode(), {"Content-Type": "application/json"})
        r = c.getresponse(); data = r.read(); c.close()
        return r.status, data.decode("utf-8", "replace")

    def graph(self):
        return self.ld(self.get("/")[1])[0]["@graph"]

    def ld(self, text):
        return [json.loads(b) for b in re.findall(r'<script type="application/ld\+json">(.*?)</script>', text, re.S)]


# ---- (a) product map, names, one FAQ, Maps wording ------------------------------------------------
class ProductMapTests(Base):
    def visible_table(self):
        rows = re.findall(r"<tr><td><b>(.*?)</b></td><td>(.*?)</td><td class=\"amt\">\$(\d+)", read("index.html"))
        return {n: (d, int(p)) for n, d, p in rows}

    def test_no_second_price_table(self):
        self.assertFalse(hasattr(discovery, "PRODUCTS"))
        src = read("discovery.py")
        self.assertNotRegex(src, r"\"price\":\s*\d")
        self.assertEqual(discovery.CHECK_PRICE, products.TYPES["base"]["price_usd"])

    def test_schema_names_equal_visible_table_and_products_map(self):
        table = self.visible_table()
        names = [p["name"] for p in self.graph() if p["@type"] == "Product"]
        self.assertEqual(sorted(names), sorted(table))
        self.assertEqual(sorted(names), sorted(products.site_name(p) for p in products.PRODUCTS.values()))
        self.assertIn("Listings Consistency Check", names)       # the two Listings tiers (#79)
        self.assertIn("Listings with fix pack", names)

    def test_schema_prices_equal_products_map_when_addons_on(self):
        for value in (None, "on", ""):                 # on by default; only the exact value "off" turns it off
            with flag(value):
                got = {p["name"]: p["offers"]["price"] for p in self.graph() if p["@type"] == "Product"}
            self.assertEqual(got, {products.site_name(p): str(p["price_usd"]) for p in products.PRODUCTS.values()})
            self.assertEqual(got, {n: str(price) for n, (_, price) in self.visible_table().items()})
            self.assertEqual(sorted(got.values(), key=int), ["149", "149", "249", "249", "397", "99"][:0] or
                             sorted(["149", "149", "99", "249", "249", "397"], key=int))

    def test_two_listings_tiers_in_schema(self):
        with flag(None):
            by = {p["name"]: p for p in self.graph() if p["@type"] == "Product"}
        self.assertEqual(by["Listings Consistency Check"]["offers"]["price"], "99")
        self.assertEqual(by["Listings with fix pack"]["offers"]["price"], "249")
        self.assertNotIn("corrected-listing pack", by["Listings Consistency Check"]["description"])
        self.assertIn("corrected-listing pack", by["Listings with fix pack"]["description"])
        self.assertIn("Listings with fix pack", by[products.site_name(products.TYPES["bundle"])]["description"])

    def test_base_offer_price_equals_products_map(self):
        base = [p for p in self.graph() if p["@type"] == "Product" and p["name"] == products.site_name(products.TYPES["base"])][0]
        self.assertEqual(base["offers"]["price"], str(products.TYPES["base"]["price_usd"]))

    def test_one_faq_block_matching_json_ld(self):
        body = self.get("/")[1]
        self.assertEqual(body.count("<details>"), len(discovery.FAQ))
        self.assertEqual(len(re.findall(r'<section id="faq">', body)), 1)
        self.assertEqual(body.count("Honest answers"), 1)
        self.assertNotIn("Common questions", body)
        faq = [x for x in self.graph() if x["@type"] == "FAQPage"][0]["mainEntity"]
        visible = [(htmllib.unescape(q), htmllib.unescape(re.sub(r"<[^>]+>", "", a)))
                   for q, a in re.findall(r"<summary>(.*?)</summary><p>(.*?)</p>", body, re.S)]
        self.assertEqual(visible, [(x["name"], x["acceptedAnswer"]["text"]) for x in faq])

    def test_faq_claims_are_ones_the_pages_already_make(self):
        text = " ".join(a for _, a in discovery.FAQ)
        home, refunds = read("index.html"), read("refunds.html")
        for claim, page in (("2 business days", home), ("5 business days", refunds), ("US businesses only", None),
                            ("coming soon", home)):
            self.assertIn(claim, text)
            if page:
                self.assertIn(claim, page)
        self.assertIn("We never promise a ranking", refunds)
        self.assertNotRegex(text.lower(), r"guarantee(d)? (a )?(rank|top|first)|will rank|number one|#1")
        self.assertIn("No, and nobody honestly can", text)

    def test_maps_description_not_stronger_than_table(self):
        maps = [p for p in self.graph() if p.get("name") == products.site_name(products.TYPES["maps"])][0]
        self.assertIn("once we have access", maps["description"])
        row = self.visible_table()[products.site_name(products.TYPES["maps"])][0]
        self.assertIn(maps["description"].rstrip("."), row)          # the table text says the same, in full
        for page in ("/llms.txt", "/for/dentists", "/city/dentists-austin-tx"):
            body = self.get(page)[1].lower()
            if "map-visibility baseline" in body:
                self.assertIn("once we have access", body)

    def test_monthly_plans_have_no_offer(self):
        names = [p["name"] for p in self.graph() if p["@type"] == "Product"]
        for plan in discovery.COMING_SOON_PLANS:
            self.assertFalse([n for n in names if n in (plan, plan + " plan")])
        self.assertNotIn("/ month", json.dumps(self.graph()))


# ---- add-on switch ---------------------------------------------------------------------------------
class AddonSwitchTests(Base):
    def test_switch_is_mains_helper_and_single(self):
        for value, on in ((None, True), ("", True), ("on", True), ("OFF", True), ("off", False)):
            with flag(value):
                self.assertEqual(discovery.addon_offers_enabled(), on, value)
                self.assertEqual(discovery.addon_offers_enabled(), products.addons_checkout_on())
                self.assertEqual(discovery.offer_types(), discovery.PRODUCT_ORDER if on else ("base",))
                self.assertEqual(discovery.pay_keys(), list(products.PAY_KEYS) if on else ["payLinkCheck"])
        src = read("discovery.py")
        self.assertNotIn("ADDONS_CHECKOUT", src.split("def addon_offers_enabled", 1)[1].split("def product_list", 1)[0]
                         .split('"""')[2])                        # no second flag read inside the function body

    def test_flag_on_offers_for_every_product_and_no_monthly_offer(self):
        with flag(None):
            graph = self.graph()
            self.assertEqual(sorted(x["name"] for x in graph if x["@type"] == "Product" and "offers" in x),
                             sorted(products.site_name(p) for p in products.PRODUCTS.values()))
            self.assertNotIn("/ month", json.dumps(graph))
            for plan in discovery.COMING_SOON_PLANS:
                self.assertFalse([x for x in graph if x.get("name") in (plan, plan + " plan")])

    def test_flag_off_no_addon_offers_or_checkout_urls_on_new_pages(self):
        urls = {k: products.PAY_LINKS[k] for k in ADDON_KEYS}
        pages = ["/llms.txt", "/city", "/city/dentists-austin-tx"] + discovery.trade_paths()
        with flag("off"):
            for p in pages:
                body = self.get(p)[1]
                for k, u in urls.items():
                    self.assertNotIn(u, body, (p, k))
                    self.assertNotIn(k, body, (p, k))
            home = self.get("/")[1]
            for u in urls.values():
                self.assertNotIn(u, home)
            graph = self.ld(home)[0]["@graph"]
            base = products.site_name(products.TYPES["base"])
            self.assertEqual([x["name"] for x in graph if x["@type"] == "Product" and "offers" in x], [base])
            for x in graph:
                if x["@type"] == "Product" and x["name"] != base:
                    self.assertNotIn("offers", x)
                    self.assertNotIn("price", json.dumps(x).lower())
            self.assertEqual(json.dumps(graph).count("InStock"), 1)
            self.assertIn(products.PAY_LINKS["payLinkCheck"], self.get("/for/dentists")[1])   # base keeps its buy button

    def test_flag_on_new_pages_still_only_base_checkout(self):
        with flag(None):
            for p in ["/llms.txt", "/city/dentists-austin-tx"] + discovery.trade_paths():
                body = self.get(p)[1]
                for k in ADDON_KEYS:
                    self.assertNotIn(products.PAY_LINKS[k], body, p)


# ---- (b) ref logging on every public page ----------------------------------------------------------
class RefOnNewPagesTests(Base):
    def test_valid_ref_logs_one_line_with_path(self):
        for page in ("/for/dentists", "/city/dentists-austin-tx", "/city"):
            if os.path.exists(self.hits):
                os.remove(self.hits)
            self.assertEqual(self.get(page + "?ref=Abc&utm=x")[0], 200)
            got = hit_lines(self.hits)
            self.assertEqual(len(got), 1, page)
            self.assertEqual(set(got[0]), {"at", "ref", "path"})
            self.assertEqual((got[0]["ref"], got[0]["path"]), ("abc", page))

    def test_no_ref_or_bad_ref_or_unknown_slug_logs_nothing(self):
        for p in ("/for/dentists", "/city", "/city/dentists-austin-tx", "/for/dentists?ref=", "/for/dentists?ref=a%20b",
                  "/city/dentists-austin-tx?ref=%3Cscript%3E", "/city?ref=" + "a" * 33, "/for/dentists?other=abc"):
            self.assertEqual(self.get(p)[0], 200, p)
        for p in ("/for/nope?ref=abc", "/city/nope?ref=abc", "/for/?ref=abc", "/city/dentists-austin-tx/other.svg?ref=abc"):
            self.assertEqual(self.get(p)[0], 404, p)
        self.assertEqual(hit_lines(self.hits), [])

    def test_card_svg_never_logs(self):
        self.assertEqual(self.get("/city/dentists-austin-tx/card.svg?ref=abc")[0], 200)
        self.assertEqual(hit_lines(self.hits), [])

    def test_hit_line_has_no_ip_or_user_agent(self):
        c = http.client.HTTPConnection("127.0.0.1", self.port)
        c.request("GET", "/for/dentists?ref=abc", headers={"User-Agent": "UAXYZ/9", "X-Forwarded-For": "198.51.100.9"})
        c.getresponse().read(); c.close()
        raw = open(self.hits, encoding="utf-8").read()
        for bad in ("UAXYZ", "198.51.100.9", "127.0.0.1", "user", "ip"):
            self.assertNotIn(bad, raw.lower() if bad.islower() else raw)
        self.assertEqual(set(json.loads(raw)), {"at", "ref", "path"})

    def test_pages_include_ref_js(self):
        for p in ["/for/dentists", "/city", "/city/dentists-austin-tx", "/", "/agency.html", "/sample-report.html",
                  "/thanks.html"] + discovery.trade_paths():
            self.assertIn("/ref.js", self.get(p)[1].replace('src="assets/ref.js"', 'src="/assets/ref.js"'), p)
        self.assertEqual(self.get("/assets/ref.js")[0], 200)

    def test_logging_failure_keeps_200(self):
        blocker = os.path.join(self.tmp, "file")
        open(blocker, "w").close()
        server.DATA = blocker
        self.assertEqual(self.get("/for/dentists?ref=abc")[0], 200)
        self.assertEqual(self.get("/city/dentists-austin-tx?ref=abc")[0], 200)


# ---- (c) sitemap, llms.txt, links ------------------------------------------------------------------
class SitemapCityTests(Base):
    def sitemap_paths(self):
        body = self.get("/sitemap.xml", {"Host": "example.org", "X-Forwarded-Proto": "https"})[1]
        ns = {"s": "http://www.sitemaps.org/schemas/sitemap/0.9"}
        return [e.text.replace("https://example.org", "") for e in ET.fromstring(body).findall("s:url/s:loc", ns)]

    def test_sitemap_and_llms_include_austin_and_city_index(self):
        self.assertEqual(cities.public_paths(), ["/city", "/city/dentists-austin-tx"])
        paths = self.sitemap_paths()
        for p in cities.public_paths():
            self.assertIn(p, paths)
        llms = self.get("/llms.txt", {"Host": "example.org"})[1]
        self.assertIn("(https://example.org/city)", llms)
        self.assertIn("(https://example.org/city/dentists-austin-tx)", llms)
        self.assertNotIn("card.svg", llms + "".join(paths))

    def test_no_valid_market_means_nothing_added(self):
        empty = os.path.join(self.tmp, "markets")
        os.makedirs(empty)
        with open(os.path.join(empty, "dentist__x-tx.json"), "w") as f:
            f.write('{"niche": "dentist", "answers": []}')          # not a valid market
        cities.MARKETS_DIR = empty
        self.assertEqual(cities.public_paths(), [])
        self.assertEqual([p for p in self.sitemap_paths() if p.startswith("/city")], [])
        llms = self.get("/llms.txt")[1]
        self.assertNotIn("/city", llms)
        self.assertNotIn("City snapshots", llms)
        self.assertEqual(self.get("/city")[0], 404)

    def test_every_sitemap_url_resolves(self):
        paths = self.sitemap_paths()
        self.assertGreater(len(paths), 22)
        for p in paths:
            self.assertEqual(self.get(p)[0], 200, p)

    def test_city_page_links_to_trade_page(self):
        body = self.get("/city/dentists-austin-tx")[1]
        self.assertIn('href="/for/dentists"', body)
        self.assertEqual(self.get("/for/dentists")[0], 200)
        self.assertEqual(discovery.trade_slug_for_niche("dentist"), "dentists")
        self.assertIsNone(discovery.trade_slug_for_niche("not_a_niche"))

    def test_city_page_without_trade_page_has_no_link(self):
        d = os.path.join(self.tmp, "markets")
        os.makedirs(d)
        m = json.load(open(os.path.join(REAL_MARKETS, "dentist__austin-tx.json"), encoding="utf-8"))
        m["niche"], m["niche_label"], m["city"] = "unicorn_groomer", "unicorn groomers", "Testville, TX"
        with open(os.path.join(d, "unicorn_groomer__testville-tx.json"), "w") as f:
            json.dump(m, f)
        cities.MARKETS_DIR = d
        st, body = self.get("/city/unicorn-groomers-testville-tx")
        self.assertEqual(st, 200)
        self.assertNotIn('href="/for/', body)

    def test_city_pages_use_the_discovery_origin(self):
        self.assertFalse(hasattr(cities, "public_base"))
        body = self.get("/city/dentists-austin-tx", {"Host": "example.org", "X-Forwarded-Proto": "https"})[1]
        self.assertIn('rel="canonical" href="https://example.org/city/dentists-austin-tx"', body)


# ---- (d) names off by default ----------------------------------------------------------------------
class NamesOffByDefaultTests(Base):
    def austin_names(self):
        raw = json.load(open(os.path.join(REAL_MARKETS, "dentist__austin-tx.json"), encoding="utf-8"))
        names = set()
        for a in raw["answers"]:
            names.update(a["names"]); names.update(a["raw"])
        names = {n for n in names if isinstance(n, str) and n.strip()}
        self.assertGreater(len(names), 20)
        return names

    def test_constant_is_false(self):
        self.assertIs(cities.SHOW_NAMES, False)
        self.assertRegex(read("cities.py"), r"(?m)^SHOW_NAMES = False\b")

    def test_real_austin_page_card_and_index_show_no_names(self):
        self.assertIs(cities.SHOW_NAMES, False)         # the shipped default, not switched here
        pages = [self.get(p)[1] for p in ("/city/dentists-austin-tx", "/city/dentists-austin-tx/card.svg", "/city")]
        text = "\n".join(pages) + self.get("/sitemap.xml")[1] + self.get("/llms.txt")[1] + self.get("/")[1]
        text += self.get("/for/dentists")[1]
        decoded = htmllib.unescape(text)
        leaked = [n for n in self.austin_names() if n in text or n in decoded]
        self.assertEqual(leaked, [])
        page = pages[0]
        self.assertIn("Questions asked:", page)
        self.assertNotIn("named in", page)
        self.assertNotIn("have not verified", page)      # the disclaimer only makes sense next to names
        self.assertNotIn("Names the AI produced", page)

    def test_free_check_keeps_names_heading_while_city_surfaces_stay_clean(self):
        """The free check (#80) may list names under its heading; that must not touch the city pages or card."""
        import contextlib, io
        import aivis.order as order
        from aivis.providers.base import Answer

        class P:
            name, mode, paid = "pollinations", "model-memory", False
            def ask(self, prompt, city="", run=0):
                return Answer(self.name, "openai", prompt, "1. **Alpha Dental**\n2. **Beta Smiles**", [], self.mode, 0.0, run)
        saved = order.build_free_provider
        order.build_free_provider = lambda: P()
        try:
            with contextlib.redirect_stderr(io.StringIO()):
                server.free_job("abcdef12-0001", {"business": "Zed Co", "city": "Austin, TX", "niche": "dentist",
                                                  "email": "a@b.co"})
        finally:
            order.build_free_provider = saved
        r = server.JOBS["abcdef12-0001"]
        self.assertEqual(r["names"]["heading"], "Names the AI gave (AI output, not verified)")
        self.assertIs(cities.SHOW_NAMES, False)         # the free check does not switch city names on (or use the flag)
        text = htmllib.unescape("\n".join(self.get(p)[1] for p in
                                ("/city/dentists-austin-tx", "/city/dentists-austin-tx/card.svg", "/city")))
        self.assertEqual([n for n in self.austin_names() if n in text], [])
        self.assertNotIn("Names the AI gave", text)
        self.assertNotIn("Alpha Dental", text)

    def test_names_only_with_the_explicit_switch(self):
        shipped = cities.SHOW_NAMES
        cities.SHOW_NAMES = True
        try:
            page = self.get("/city/dentists-austin-tx")[1]
            self.assertIn("Names the AI produced most often", page)
            self.assertIn("have not verified", page)
            card = self.get("/city/dentists-austin-tx/card.svg")[1]
            self.assertNotIn("Austin Dental Clinic", card)
            sm = self.get("/sitemap.xml")[1] + self.get("/llms.txt")[1]
            self.assertNotIn("Austin Dental Clinic", sm)
        finally:
            cities.SHOW_NAMES = shipped        # put back what was shipped, whatever it was


# ---- (e) private store ------------------------------------------------------------------------------
class PrivateStoreTests(Base):
    def test_lead_ref_goes_to_the_private_store_only(self):
        st, _ = self.post("/api/check", {**CHECK, "ref": "ProductHunt"})
        self.assertEqual(st, 200)
        folder = os.path.join(server.LOCAL_ORDERS, "leads")
        recs = [json.load(open(os.path.join(folder, f), encoding="utf-8")) for f in os.listdir(folder)]
        self.assertEqual([r["ref"] for r in recs], ["producthunt"])
        self.assertEqual(sorted(os.listdir(self.tmp)), ["store"])           # nothing request-like in the data folder
        self.assertFalse(os.path.exists(os.path.join(self.tmp, "requests.jsonl")))

    def test_bad_lead_ref_is_dropped(self):
        self.post("/api/check", {**CHECK, "ref": "a@b.co"})
        folder = os.path.join(server.LOCAL_ORDERS, "leads")
        self.assertEqual([json.load(open(os.path.join(folder, f)))["ref"] for f in os.listdir(folder)], [""])

    def test_intake_ref_is_in_the_order_record(self):
        st, body = self.post("/api/intake", {**CHECK, "ref": "Agency-X"})
        self.assertEqual(st, 200)
        oid = json.loads(body)["order_id"]
        self.assertNotIn("agency-x", body)
        self.assertEqual(server.Store().get(f"orders/{oid}.json")[0]["ref"], "agency-x")
        self.assertEqual(sorted(os.listdir(self.tmp)), ["store"])

    def test_nothing_from_new_modules_writes_request_data_to_data_folder(self):
        for mod in ("cities.py", "refs.py", "discovery.py"):
            src = read(mod).split('"""', 2)[2]                 # code only, not the module docstring
            for bad in ("requests.jsonl", "private-orders", "leads/", "orders/"):
                self.assertNotIn(bad, src, (mod, bad))
        self.assertEqual(refs.HITS_FILE, "ref-hits.jsonl")
        self.assertNotIn("requests.jsonl", read("server.py"))


if __name__ == "__main__":
    unittest.main()
