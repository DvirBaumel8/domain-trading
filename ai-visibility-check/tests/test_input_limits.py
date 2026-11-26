import http.client, json, os, sys, tempfile, threading, unittest
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import test_server as ts          # sets up the temp orders folder and the no-network guard
server = ts.server
ROOT = os.path.dirname(HERE)
OK = dict(ts.ORDER)


class Reset(ts.Base):
    def setUp(self):
        server.CHECK_LOG.clear(); server.JOBS.clear(); server.JOB_META.clear()
        self.saved = (server.FREE_RUN, server.clock)

    def tearDown(self):
        server.FREE_RUN, server.clock = self.saved
        server.CHECK_LOG.clear(); server.JOBS.clear(); server.JOB_META.clear()

    def raw(self, method, path, body=b"", extra=()):
        c = http.client.HTTPConnection("127.0.0.1", self.port)
        c.putrequest(method, path)
        for k, v in extra:
            c.putheader(k, v)
        c.endheaders(body)
        r = c.getresponse(); data = r.read(); hdrs = dict(r.getheaders()); c.close()
        return r.status, data, hdrs


class BodyTests(Reset):
    def test_non_object_json_gets_friendly_400(self):
        for path in ("/api/check", "/api/intake"):
            for body in (b"[1]", b"null", b'"x"', b"7", b"true"):
                st, data = self.post(path, body)
                self.assertEqual(st, 400, (path, body))
                self.assertEqual(json.loads(data)["error"], "Please send the form again.")

    def test_invalid_json_does_not_echo_parser(self):
        for body in (b"{bad", b"", b"\xff\xfe"):
            st, data = self.post("/api/check", body)
            self.assertEqual(st, 400)
            self.assertEqual(json.loads(data)["error"], "Please send the form again.")
            self.assertNotIn(b"Expecting", data); self.assertNotIn(b"line 1", data)

    def test_bad_content_length(self):
        for cl in (None, "-1", "abc", "1e3", "", "1 2"):
            extra = [] if cl is None else [("Content-Length", cl)]
            st, data, _ = self.raw("POST", "/api/check", b"", extra)
            self.assertEqual(st, 400, cl)

    def test_size_limit_kept(self):
        st, _ = self.post("/api/check", b"{" + b" " * 5000 + b"}")
        self.assertEqual(st, 400)


class LimitTests(Reset):
    def test_client_ip_helper(self):
        self.assertEqual(server.client_ip({"X-Forwarded-For": "1.2.3.4, 9.9.9.9"}, "10.0.0.1"), "1.2.3.4")
        self.assertEqual(server.client_ip({"X-Forwarded-For": "9.9.9.9"}, "10.0.0.1"), "9.9.9.9")
        self.assertEqual(server.client_ip({"CF-Connecting-IP": "5.6.7.8", "X-Forwarded-For": "1.2.3.4, 10.1.1.1"}, "10.0.0.1"), "5.6.7.8")
        self.assertEqual(server.client_ip({"CF-Connecting-IP": "bad", "X-Forwarded-For": "1.2.3.4, 10.1.1.1"}, "10.0.0.1"), "1.2.3.4")
        self.assertEqual(server.client_ip({"CF-Connecting-IP": "x", "X-Forwarded-For": "y"}, "10.0.0.1"), "10.0.0.1")
        self.assertEqual(server.client_ip({}, "10.0.0.1"), "10.0.0.1")
        self.assertEqual(server.client_ip({"X-Forwarded-For": "not an ip"}, "10.0.0.1"), "10.0.0.1")
        self.assertEqual(server.client_ip(None, "10.0.0.1"), "10.0.0.1")

    def test_first_forwarded_entries_get_separate_buckets(self):
        server.FREE_RUN = False
        for ip in ("7.7.7.7", "7.7.7.8"):
            for i in range(5):
                self.assertEqual(self.post("/api/check", OK, {"X-Forwarded-For": ip + ", 10.9.9.9"})[0], 200, (ip, i))
        self.assertEqual(self.post("/api/check", OK, {"X-Forwarded-For": "7.7.7.7, 10.9.9.9"})[0], 429)
        self.assertEqual(self.post("/api/check", OK, {"CF-Connecting-IP": "7.7.7.9", "X-Forwarded-For": "7.7.7.7, 10.9.9.9"})[0], 200)

    def test_sixth_check_in_an_hour_is_429(self):
        server.FREE_RUN = False
        for i in range(5):
            self.assertEqual(self.post("/api/check", OK)[0], 200, i)
        st, data = self.post("/api/check", OK)
        self.assertEqual((st, json.loads(data)["error"]), (429, "Too many checks right now, try again in a few minutes."))
        # another address is unaffected; the hour passing frees the first
        self.assertEqual(self.post("/api/check", OK, {"X-Forwarded-For": "8.8.8.8"})[0], 200)
        t0 = server.clock()
        server.clock = lambda: t0 + 3700
        self.assertEqual(self.post("/api/check", OK)[0], 200)

    def test_fourth_concurrent_job_is_429(self):
        server.FREE_RUN = True
        started = []
        orig = server.free_job
        server.free_job = lambda job, req: started.append(job)      # stays "running"
        try:
            for i in range(3):
                self.assertEqual(self.post("/api/check", dict(OK, niche="plumber"))[0], 200, i)
            self.assertEqual(self.post("/api/check", dict(OK, niche="plumber"))[0], 429)
            self.assertEqual(self.post("/api/check", dict(OK, niche="plumber"), {"X-Forwarded-For": "8.8.4.4"})[0], 200)
        finally:
            server.free_job = orig

    def test_old_finished_jobs_dropped(self):
        t0 = 1_000_000.0
        server.clock = lambda: t0
        server.JOBS.update({"old": {"status": "done"}, "new": {"status": "done"}, "run": {"status": "running"}})
        server.JOB_META.update({"old": {"ip": "1.1.1.1", "finished": t0 - 3601}, "new": {"ip": "1.1.1.1", "finished": t0 - 60},
                                "run": {"ip": "1.1.1.1", "started": t0 - 7200}})
        server.prune_jobs()
        self.assertEqual(sorted(server.JOBS), ["new", "run"])
        self.assertNotIn("old", server.JOB_META)


class PersistenceTests(Reset):
    def test_free_report_survives_a_new_store(self):
        server.Store().put_text(server.free_report_path("FREE-abcdef12"), "<html>report</html>")
        st, body, h = self.raw("GET", "/free/FREE-abcdef12")        # a fresh Store() per request: a restart
        self.assertEqual((st, body), (200, b"<html>report</html>"))
        self.assertEqual(h["X-Robots-Tag"], "noindex")
        self.assertEqual(h["Cache-Control"], "no-store")
        self.assertEqual(h["Referrer-Policy"], "no-referrer")
        self.assertEqual(self.req("GET", "/free/FREE-00000000")[0], 404)

    def test_old_local_link_still_served(self):
        d = os.path.join(server.DATA, "free-checks", "FREE-0a1d11c0")
        os.makedirs(d, exist_ok=True)
        with open(os.path.join(d, "report.html"), "w") as f:
            f.write("old")
        try:
            self.assertEqual(self.req("GET", "/free/FREE-0a1d11c0"), (200, b"old"))
        finally:
            import shutil; shutil.rmtree(d)

    def test_free_job_writes_report_to_store(self):
        import aivis.order as order
        orig = order.run_order
        def fake(o, mode, out_dir, render):
            os.makedirs(os.path.join(out_dir, o.order_id))
            with open(os.path.join(out_dir, o.order_id, "report.html"), "w") as f:
                f.write("<p>done</p>")
            class P: target_hits = 1
            class S: providers = [P()]; total_answers = 8
            class R: score = S()
            return R(), {}
        order.run_order = fake
        try:
            server.free_job("12345678-aaaa", dict(ts.ORDER))
        finally:
            order.run_order = orig
        self.assertEqual(server.JOBS["12345678-aaaa"]["report"], "/free/FREE-12345678")
        self.assertEqual(server.Store().get_text("free/FREE-12345678/report.html"), "<p>done</p>")
        self.assertEqual(self.req("GET", "/free/FREE-12345678")[0], 200)

    def test_saved_request_lands_in_store(self):
        server.FREE_RUN = False
        import shutil; shutil.rmtree(os.path.join(server.LOCAL_ORDERS, "leads"), ignore_errors=True)
        self.assertEqual(self.post("/api/check", dict(OK, niche="plumber"))[0], 200)
        leads = server.Store().list_prefix("leads/")
        self.assertEqual(len(leads), 1)
        rec = server.Store().get(leads[0])[0]
        self.assertEqual((rec["result"], rec["business"]), ("saved", "Acme Dental"))
        self.assertFalse(os.path.exists(os.path.join(server.DATA, "requests.jsonl")))

    def test_private_store_not_public(self):
        server.Store().put_text(server.free_report_path("FREE-abcdef13"), "x")
        for p in ("/free/FREE-abcdef13/report.html", "/private-orders/free/FREE-abcdef13/report.html",
                  "/leads/", "/orders/x.json"):
            self.assertEqual(self.req("GET", p)[0], 404, p)


class HeaderTests(Reset):
    def test_security_headers_everywhere(self):
        for p in ("/", "/privacy.html", "/index.html", "/assets/app.js", "/favicon.ico", "/robots.txt", "/health", "/nope"):
            st, _, h = self.raw("GET", p)
            self.assertEqual(h.get("Strict-Transport-Security"), "max-age=31536000", p)
            self.assertEqual(h.get("X-Content-Type-Options"), "nosniff", p)
            self.assertEqual(h.get("X-Frame-Options"), "DENY", p)
        st, _, h = self.raw("POST", "/api/check", b"[]", [("Content-Length", "2")])
        self.assertEqual(h.get("X-Frame-Options"), "DENY")

    def test_robots_and_favicon(self):
        self.assertIn(b"Disallow: /free/", self.req("GET", "/robots.txt")[1])
        st, body, h = self.raw("GET", "/favicon.ico")
        self.assertEqual(st, 200)
        self.assertEqual(body[:4], b"\x00\x00\x01\x00")


class WebsiteTests(Reset):
    def test_non_public_hosts_rejected(self):
        for w in ("127.0.0.1", "http://localhost", "https://10.0.0.5/x", "192.168.1.1", "169.254.169.254", "172.16.0.1",
                  "127.1", "2130706433.com.1", "0x7f.0.0.1", "http://[::1]/", "foo.localhost", "printer.local",
                  "db.internal", "intranet.corp", "http://user@127.0.0.1", "8.8.8.8", "localhost:8080"):
            st, data = self.post("/api/check", dict(OK, website=w))
            self.assertEqual(st, 400, w)
            self.assertIn("That website doesn't look right", json.loads(data)["error"])

    def test_public_hosts_pass(self):
        server.FREE_RUN = False
        for w in ("", "example.com", "https://www.acmedental.com/path?x=1", "http://acme-dental.co.uk", "xn--bcher-kva.example.org"):
            self.assertEqual(self.post("/api/check", dict(OK, niche="plumber", website=w))[0], 200, w)
            server.CHECK_LOG.clear()


if __name__ == "__main__":
    unittest.main()
