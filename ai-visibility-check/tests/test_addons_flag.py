"""ADDONS_CHECKOUT flag: on by default; only the exact value 'off' hides add-on checkout URLs and buttons."""
import os, re, sys, unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import test_addons as ta  # noqa: E402  (Base, event, URLS; sets sys.path and env)
import server, products   # noqa: E402

CHECK_URL = "https://buy.polar.sh/polar_cl_y4lp8S18BldD0ZyWWdevI07SSgM4eXEwJ6zOI4Fw8mv"
PAGES = ["/", "/index.html", "/agency.html", "/privacy.html", "/refunds.html", "/sample-report.html",
         "/terms.html", "/thanks.html", "/assets/config.js", "/assets/app.js", "/assets/style.css", "/assets/legal.css"]
NAMES = {"payLinkMaps": "Google Maps Visibility Check", "payLinkListingsCheck": "Listings Consistency Check",
         "payLinkListings": "Listings with fix pack",
         "payLinkContent": "AI Content Pack", "payLinkBundle": "AI Visibility Bundle"}


class FlagTests(ta.Base):
    def served(self, flag):
        if flag is None:
            os.environ.pop("ADDONS_CHECKOUT", None)
        else:
            os.environ["ADDONS_CHECKOUT"] = flag
        out = {}
        for p in PAGES:
            st, body = self.get(p)
            self.assertEqual(st, 200, p)
            out[p] = body
        return out

    def test_off_leaks_no_addon_url(self):
        for flag in ("off",):
            pages = self.served(flag)
            everything = "\n".join(pages.values())
            for key, url in ta.URLS.items():
                self.assertNotIn(url, everything, (flag, key))
                self.assertNotIn(url.rsplit("/", 1)[1], everything, (flag, key))
            self.assertNotIn("payLinkMaps", pages["/assets/config.js"])
            self.assertIn(CHECK_URL, pages["/assets/config.js"], flag)
            self.assertIn("payLinkCheck", pages["/assets/config.js"])
            html = pages["/"]
            self.assertIn(f'data-pay="payLinkCheck"', html)
            for pk, name in NAMES.items():
                self.assertNotIn(f'data-pay="{pk}"', html, (flag, pk))
                m = re.search(r'<a [^>]*href="(mailto:[^"]+)"[^>]*>' + re.escape(name) + r": Coming soon - join waitlist</a>", html)
                self.assertIsNotNone(m, (flag, name))
                self.assertIn("mailto:" + server.SUPPORT_EMAIL + "?subject=AVC%20waitlist%3A%20", m.group(1))
                self.assertIn(name.replace(" ", "%20"), m.group(1))
                self.assertIn(name, html)                        # product rows stay
            self.assertEqual(html.count("Coming soon - join waitlist</a>"), 8)    # 5 add-ons + 3 monthly
            for plan in ("Visibility", "Growth", "Dominate"):
                self.assertIn("subject=AVC%20waitlist%3A%20" + plan + '">Coming soon - join waitlist', html)

    def test_on_values_show_exact_urls_and_buttons(self):
        for flag in (None, "", "on", "ON", "true", "1", "OFF", "off ", " off", "Off"):
            self.check_on(flag)

    def check_on(self, flag):
        pages = self.served(flag)
        cfg = pages["/assets/config.js"]
        for key, url in ta.URLS.items():
            self.assertIn(f'"{key}": "{url}"', cfg, flag)
        self.assertIn(CHECK_URL, cfg)
        html = pages["/"]
        for pk, name in NAMES.items():
            self.assertRegex(html, r'<a class="btn ghost" data-pay="' + pk + r'" href="#pricing">Buy the ' + re.escape(name) + " — \\$")
        self.assertEqual(html.count("Coming soon - join waitlist</a>"), 3)       # monthly only
        self.assertIn('data-pay="payLinkCheck"', html)

    def test_flag_read_per_request(self):
        self.served("off"); self.assertNotIn(ta.URLS["payLinkMaps"], self.served("off")["/assets/config.js"])
        self.assertIn(ta.URLS["payLinkMaps"], self.served(None)["/assets/config.js"])

    def test_config_is_generated_not_static(self):
        self.assertFalse(os.path.exists(os.path.join(os.path.dirname(server.__file__), "assets", "config.js")))
        self.assertEqual(set(products.PAY_LINKS), set(products.PAY_KEYS))
        self.assertEqual({k: products.PAY_LINKS[k] for k in ta.URLS}, ta.URLS)

    def test_webhook_unaffected_when_off(self):
        os.environ["ADDONS_CHECKOUT"] = "off"
        for t in ("maps", "listings_check", "listings", "content"):
            self.intake(f"{t}@x.co")
            self.sent.clear()
            code, res = self.hook(ta.event(t, "pol_f_" + t, f"{t}@x.co"), "evt-f-" + t)
            self.assertEqual((code, res["status"]), (200, "manual_delivery"))
            self.assertEqual(len(self.sent), 1)
            self.assertNotIn("@", self.texts()[0])
        self.assertEqual(len(self.manual_orders()), 4)
        self.assertEqual(self.runs(), 0)

    def test_default_is_on(self):
        os.environ.pop("ADDONS_CHECKOUT", None)
        self.assertTrue(products.addons_checkout_on())
        os.environ["ADDONS_CHECKOUT"] = "off"
        self.assertFalse(products.addons_checkout_on())


if __name__ == "__main__":
    unittest.main()
