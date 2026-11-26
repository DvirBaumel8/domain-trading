"""Price and wording consistency: the site must show exactly the Polar prices held in products.py."""
import glob, os, re, sys, unittest

HERE = os.path.dirname(os.path.abspath(__file__))
SITE = os.path.join(HERE, "..", "site")
sys.path.insert(0, os.path.join(HERE, "..", "site"))
import products  # noqa: E402

RETIRED = ("Listings Audit", "Fix-It Bundle", "Content Fix Pack", "Google Maps Audit", "Maps Audit")


def read(*p):
    return open(os.path.join(SITE, *p), encoding="utf-8").read()


def by_type():
    return {p["type"]: p for p in products.PRODUCTS.values()}


def table_rows(html):
    """Rows of the one-time pricing table: (name, description, amount cell text)."""
    table = html.split('<h3 class="price-head">One-time</h3>')[1].split("</table>")[0]
    return [tuple(re.sub(r"<[^>]+>", "", c).strip() for c in re.findall(r"<td[^>]*>(.*?)</td>", r, re.S))
            for r in re.findall(r"<tr>(.*?)</tr>", table, re.S) if "<td" in r]


class PriceTests(unittest.TestCase):
    def test_every_product_has_integer_price(self):
        for p in products.PRODUCTS.values():
            self.assertIsInstance(p["price_usd"], int)
        self.assertEqual({t: p["price_usd"] for t, p in by_type().items()},
                         {"base": 149, "maps": 149, "listings": 249, "content": 249, "bundle": 397})

    def test_table_has_each_product_with_exact_price(self):
        rows = {r[0]: r for r in table_rows(read("index.html"))}
        self.assertEqual(set(rows), {p["name"] for p in products.PRODUCTS.values()})
        for p in products.PRODUCTS.values():
            amount = rows[p["name"]][2]
            self.assertEqual(re.findall(r"\$([\d,]+)", amount)[0], str(p["price_usd"]), p["name"])

    def test_bundle_math_from_the_map(self):
        t = by_type()
        parts = sum(t[k]["price_usd"] for k in ("base", "maps", "listings", "content"))
        saving = parts - t["bundle"]["price_usd"]
        row = next(r for r in table_rows(read("index.html")) if r[0] == t["bundle"]["name"])
        self.assertIn("would be $%d separately" % parts, row[1])
        self.assertIn("save $%d" % saving, row[2])
        self.assertEqual((parts, saving), (796, 399))

    def test_buttons_and_ctas_carry_mapped_price(self):
        html, js = read("index.html"), read("assets", "app.js")
        t = by_type()
        for key, typ in products.PAY_KEYS.items():
            for m in re.finditer(r'<a[^>]*data-pay="%s"[^>]*>(.*?)</a>' % key, html, re.S):
                text = re.sub(r"<[^>]+>", "", m.group(1))
                self.assertEqual(re.findall(r"\$([\d,]+)", text), [str(t[typ]["price_usd"])], text)
        # the free-check result text in app.js sells only the base check
        for amt in re.findall(r"\$([\d,]+)", js):
            self.assertEqual(amt, str(t["base"]["price_usd"]))

    def test_any_price_next_to_a_product_name_matches_map(self):
        for page in ("index.html", "thanks.html", "refunds.html", "terms.html", "sample-report.html"):
            text = re.sub(r"\(the four would be[^)]*\)", "", re.sub(r"<[^>]+>", " ", read(page)))
            for p in products.PRODUCTS.values():
                for m in re.finditer(re.escape(p["name"]) + r"[^$.;|<]{0,40}\$([\d,]+)", text):
                    self.assertEqual(m.group(1), str(p["price_usd"]), "%s: %s" % (page, m.group(0)))

    def test_no_retired_name_on_any_served_page(self):
        for f in glob.glob(os.path.join(SITE, "*.html")) + glob.glob(os.path.join(SITE, "assets", "*")):
            if f.endswith((".png", ".pdf")):
                continue
            body = open(f, encoding="utf-8", errors="ignore").read()
            for name in RETIRED:
                self.assertNotIn(name, body, "%s in %s" % (name, f))


class MonthlyTests(unittest.TestCase):
    def cards(self):
        html = read("index.html")
        section = html.split('<h3 class="price-head">Monthly</h3>')[1].split('<h3 class="price-head">For agencies')[0]
        return re.findall(r'<div class="price[^"]*"><b>(\w+)</b>.*?(<a [^>]*>.*?</a>)\s*</div>', section, re.S)

    def test_monthly_buttons_are_waitlist_mailto_only(self):
        cards = self.cards()
        self.assertEqual([c[0] for c in cards], ["Visibility", "Growth", "Dominate"])
        for name, a in cards:
            self.assertNotIn("data-pay", a)
            self.assertNotIn("polar.sh", a)
            self.assertIn("Coming soon - join waitlist", a)
            self.assertRegex(a, r'href="mailto:[^"?]+\?subject=AVC%20waitlist%3A%20' + name + '"')
            self.assertNotIn("Start ", a)

    def test_no_monthly_checkout_key_or_link(self):
        self.assertNotIn("payLinkMonthly", read("assets", "app.js") + read("index.html"))
        self.assertNotIn("data-pay=\"payLinkMonthly", read("index.html"))

    def test_monthly_prices_unchanged(self):
        html = read("index.html")
        for amt in ("$249", "$449", "$699"):
            self.assertIn(amt + ' <span>/ month</span>', html)

    def test_thanks_full_stop(self):
        self.assertIn("your private status page</a>. Bookmark it.", read("thanks.html"))


if __name__ == "__main__":
    unittest.main()
