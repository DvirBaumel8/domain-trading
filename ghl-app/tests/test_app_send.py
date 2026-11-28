import http.client, os, sys, threading, unittest

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
from tests.test_base import Base  # noqa: E402


class TestSend(Base):
    def setUp(self):
        super().setUp()
        import app
        self.app = app
        app.ROUTES[("GET", "/_t_redirect")] = lambda req: (302, {"location": "/x"})
        self.httpd = app.http.server.ThreadingHTTPServer(("127.0.0.1", 0), app.H)
        self.t = threading.Thread(target=lambda: self.httpd.serve_forever(poll_interval=0.05), daemon=True)
        self.t.start()

    def tearDown(self):
        self.httpd.shutdown(); self.httpd.server_close(); self.t.join(timeout=5)
        self.app.ROUTES.pop(("GET", "/_t_redirect"), None)
        super().tearDown()

    def get(self, path):
        c = http.client.HTTPConnection("127.0.0.1", self.httpd.server_address[1])
        c.request("GET", path)
        r = c.getresponse()
        body = r.read()
        c.close()
        return r, body

    def test_page_is_html_with_csp(self):
        r, body = self.get("/page")
        self.assertEqual(r.status, 200)
        self.assertTrue(r.getheader("Content-Type").startswith("text/html"))
        self.assertIn("frame-ancestors", r.getheader("Content-Security-Policy"))
        self.assertEqual(int(r.getheader("Content-Length")), len(body))
        self.assertIn(b"<html", body.lower())

    def test_static_css(self):
        r, body = self.get("/page/static/page.css")
        self.assertEqual(r.status, 200)
        self.assertTrue(r.getheader("Content-Type").startswith("text/css"))
        self.assertTrue(body)

    def test_redirect_location(self):
        r, _ = self.get("/_t_redirect")
        self.assertEqual(r.status, 302)
        self.assertEqual(r.getheader("Location"), "/x")


if __name__ == "__main__":
    unittest.main()
