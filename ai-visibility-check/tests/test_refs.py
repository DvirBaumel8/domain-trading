import datetime, io, json, os, shutil, sys, tempfile, unittest, contextlib
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import test_server as ts          # sets env, fake network, imports server  # noqa: E402
import server, refs, ref_counts   # noqa: E402

CHECK = {"business": "Acme Dental", "city": "Austin, TX", "niche": "dentist", "email": "a@b.co"}
SITE = os.path.join(HERE, "..", "site")


def lines(path):
    if not os.path.exists(path):
        return []
    with open(path, encoding="utf-8") as f:
        return [json.loads(x) for x in f if x.strip()]


def leads(store):
    """Lead records of a local private store, oldest first."""
    d = os.path.join(store, "leads")
    return [json.load(open(os.path.join(d, f), encoding="utf-8")) for f in sorted(os.listdir(d))] if os.path.isdir(d) else []


class CleanRefTests(unittest.TestCase):
    def test_valid(self):
        self.assertEqual(refs.clean_ref("producthunt"), "producthunt")
        self.assertEqual(refs.clean_ref("agency-x_1.2"), "agency-x_1.2")
        self.assertEqual(refs.clean_ref("  ProductHunt "), "producthunt")
        self.assertEqual(refs.clean_ref("a" * 32), "a" * 32)

    def test_invalid(self):
        for v in ["", " ", "a" * 33, "a b", "a/b", "<script>", "a@b.co", "café", "K", "a\x00b", "a\nb",
                  "http://x.co", "https:x", ["a"], None, 5, {"a": 1}, b"abc"]:
            self.assertEqual(refs.clean_ref(v), "", repr(v))


class Fixture(ts.Base):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self._data = server.DATA
        server.DATA = self.tmp
        self._orders = server.LOCAL_ORDERS
        server.LOCAL_ORDERS = os.path.join(self.tmp, "orders-store")
        self.hits = os.path.join(self.tmp, "ref-hits.jsonl")
        self.reqs = os.path.join(self.tmp, "requests.jsonl")     # the old public log: must never come back

    def tearDown(self):
        server.DATA, server.LOCAL_ORDERS = self._data, self._orders
        shutil.rmtree(self.tmp, ignore_errors=True)


class PageHitTests(Fixture):
    def test_hits(self):
        for page, want in [("/", "/"), ("/agency.html", "/agency.html"), ("/sample-report.html", "/sample-report.html"),
                           ("/thanks.html", "/thanks.html"), ("/index.html", "/")]:
            if os.path.exists(self.hits):
                os.remove(self.hits)
            self.assertEqual(self.req("GET", page + "?ref=abc&utm=x")[0], 200)
            got = lines(self.hits)
            self.assertEqual(len(got), 1, page)
            self.assertEqual(set(got[0]), {"at", "ref", "path"})
            self.assertEqual((got[0]["ref"], got[0]["path"]), ("abc", want))

    def test_uppercase_normalized_first_ref_wins(self):
        self.req("GET", "/?ref=ABC&ref=zzz")
        self.assertEqual(lines(self.hits)[0]["ref"], "abc")

    def test_nothing_logged(self):
        for q in ["", "?ref=", "?ref=a%20b", "?ref=%3Cscript%3E", "?ref=a%40b.co", "?ref=" + "a" * 33,
                  "?ref=a%00b", "?other=abc"]:
            self.assertEqual(self.req("GET", "/" + q)[0], 200)
        self.req("GET", "/assets/app.js?ref=abc")
        self.req("GET", "/nope.html?ref=abc")
        self.req("GET", "/sample-report.pdf?ref=abc")
        self.assertEqual(lines(self.hits), [])

    def test_logging_failure_keeps_200(self):
        blocker = os.path.join(self.tmp, "file")
        open(blocker, "w").close()
        server.DATA = blocker                      # data dir cannot be created
        st, body = self.req("GET", "/?ref=abc")
        self.assertEqual(st, 200)
        self.assertIn(b"<html", body.lower())

    def test_trade_pages_generic(self):
        # generic hook: any served .html page, including a future /for/<trade> one
        got = []
        refs.record_hit("/for/x?ref=abc", os.path.join(SITE, "for", "x.html"), SITE, "/d", lambda p, o: got.append((p, o)))
        self.assertEqual(got[0][1]["path"], "/for/x.html")


class CheckTests(Fixture):
    def test_check_ref(self):
        base = {k: v for k, v in CHECK.items()}
        out = {}
        for name, extra in [("none", {}), ("valid", {"ref": "ProductHunt"}), ("bad", {"ref": "a@b.co"}), ("list", {"ref": ["x"]})]:
            st, body = self.post("/api/check", {**base, **extra})
            self.assertEqual(st, 200)
            self.assertNotIn(b"producthunt", body.lower())
            out[name] = body
        self.assertFalse(os.path.exists(self.reqs))           # requests go to the private store, not the data folder
        recs = leads(server.LOCAL_ORDERS)
        self.assertEqual(len(recs), 4)
        self.assertEqual(sorted(r["ref"] for r in recs), ["", "", "", "producthunt"])
        self.assertEqual(out["none"], out["valid"])
        keys = set(recs[0])
        for r in recs:
            self.assertEqual(set(r), keys)
        self.assertEqual(len({json.dumps({k: v for k, v in r.items() if k not in ("at", "ref")}, sort_keys=True)
                              for r in recs}), 1)

    def test_instant_has_ref(self):
        src = os.path.join(self._data, "markets")
        f = "dentist__austin-tx.json"
        if not os.path.exists(os.path.join(src, f)):
            self.skipTest("no market file")
        os.makedirs(os.path.join(self.tmp, "markets"))
        shutil.copy(os.path.join(src, f), os.path.join(self.tmp, "markets", f))
        st, body = self.post("/api/check", {**CHECK, "ref": "abc"})
        self.assertEqual(json.loads(body)["status"], "instant")
        self.assertNotIn(b"abc", body)
        self.assertFalse(os.path.exists(self.reqs))
        self.assertEqual([r["ref"] for r in leads(server.LOCAL_ORDERS)], ["abc"])


class IntakeTests(Fixture):
    def order(self, **extra):
        st, body = self.post("/api/intake", {**CHECK, **extra})
        self.assertEqual(st, 200)
        oid = json.loads(body)["order_id"]
        return server.Store().get(f"orders/{oid}.json")[0]

    def test_intake_ref(self):
        a, b, c = self.order(ref="Agency-X"), self.order(), self.order(ref="bad ref!")
        self.assertEqual((a["ref"], b["ref"], c["ref"]), ("agency-x", "", ""))
        for k in ("plan", "paid", "niche", "city", "business_name"):
            self.assertEqual(a[k], b[k])
        self.assertEqual(a["plan"], "check")
        self.assertFalse(a["paid"])

    def test_ref_not_in_alert_or_response(self):
        sent = []
        orig = server.alert
        server.alert = lambda t: sent.append(t)
        try:
            st, body = self.post("/api/intake", {**CHECK, "ref": "secretish"})
        finally:
            server.alert = orig
        self.assertNotIn(b"secretish", body)
        self.assertFalse(any("secretish" in t for t in sent))


def make_fixture(root):
    """A data dir (page hits) and a private store dir with leads/ and orders/ (old, recent, no-ref, bad files)."""
    d, st = os.path.join(root, "data"), os.path.join(root, "store")
    os.makedirs(d); os.makedirs(os.path.join(st, "leads")); os.makedirs(os.path.join(st, "orders"))
    now = datetime.datetime(2026, 11, 26, 12, 0, tzinfo=datetime.timezone.utc)
    ago = lambda days: (now - datetime.timedelta(days=days)).isoformat(timespec="seconds")
    with open(os.path.join(d, "ref-hits.jsonl"), "w") as f:
        for r, t in [("ph", 1), ("ph", 2), ("ph", 20), ("blog", 3)]:
            f.write(json.dumps({"at": ago(t), "ref": r, "path": "/"}) + "\n")
        f.write("not json\n[1]\n" + json.dumps({"at": "garbage", "ref": "ph"}) + "\n")
    pii = {"business": "Secret Biz LLC", "email": "leak@example.com", "ip": "9.9.9.9", "city": "Secretville, TX"}
    def lead(name, **kw):
        with open(os.path.join(st, "leads", name + ".json"), "w") as f:
            json.dump({**pii, **kw}, f)
    # dated by the stamp in the file name
    lead("261125-100000-aaaaaaaa", ref="ph")
    lead("261125-110000-bbbbbbbb", ref="")
    lead("261124-110000-cccccccc")                          # no ref key at all
    lead("261027-100000-dddddddd", ref="ph")                # old
    lead("261125-120000-eeeeeeee", ref="junk@x.co")         # invalid ref counts as none
    lead("nodate", at=ago(1), ref="blog")                   # no stamp in the name: the record's own time
    lead("baddate", at="garbage", ref="ph")                 # undated: skipped
    with open(os.path.join(st, "leads", "261126-100000-ffffffff.json"), "w") as f:
        f.write("{")                                        # bad file: skipped
    def order(oid, **kw):
        with open(os.path.join(st, "orders", oid + ".json"), "w") as f:
            json.dump({"order_id": oid, "business_name": "Secret Biz LLC", "email": "leak@example.com", **kw}, f)
    order("ORD-261125-aaaaaa", ref="ph")
    order("ORD-261126-bbbbbb")
    order("ORD-261001-cccccc", ref="ph")
    order("ORD-261001-dddddd", ref="blog", created_at=ago(1))      # created_at wins over the id date
    order("ORD-bad-eeeeee", ref="ph")
    with open(os.path.join(st, "orders", "ORD-261126-ffffff.json"), "w") as f:
        f.write("{")
    return d, st, now


class CountTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.d, self.st, self.now = make_fixture(self.tmp)

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_table(self):
        r = ref_counts.collect(self.d, self.st, 7, self.now)
        # (ref, page hits, free-check requests, orders)
        self.assertEqual(r["rows"], [("ph", 2, 1, 1), ("blog", 1, 1, 1), ("(none)", 0, 3, 1)])
        text = ref_counts.format_table(r)
        self.assertEqual(text.splitlines()[:3], ["Referral counts, last 7 days (UTC)",
                                                 "ref     page hits  free-check requests  orders",
                                                 "------  ---------  -------------------  ------"])
        self.assertNotIn("n/a", text)
        self.assertNotIn("Note:", text)
        for bad in ("leak@example.com", "Secret", "9.9.9.9", "junk", "x.co", "ORD-", "token"):
            self.assertNotIn(bad, text)

    def test_days(self):
        r = ref_counts.collect(self.d, self.st, 90, self.now)
        self.assertEqual({x[0]: x[1:] for x in r["rows"]}, {"ph": (3, 2, 2), "blog": (1, 1, 1), "(none)": (0, 3, 1)})
        r = ref_counts.collect(self.d, self.st, 1, self.now)
        self.assertEqual({x[0]: x[1:] for x in r["rows"]}, {"ph": (1, 0, 1), "blog": (0, 1, 1), "(none)": (0, 1, 1)})

    def test_missing_folders_print_na(self):
        r = ref_counts.collect(self.d, os.path.join(self.tmp, "nope"), 7, self.now)
        self.assertFalse(r["orders_available"]); self.assertFalse(r["leads_available"])
        text = ref_counts.format_table(r)
        self.assertIn("n/a", text)
        self.assertIn("--store-dir", text)
        self.assertIn("private orders repo", text)
        self.assertEqual([row[:2] for row in r["rows"]], [("ph", 2), ("blog", 1)])
        self.assertEqual([row[2:] for row in r["rows"]], [(None, None)] * 2)
        # one folder present, the other missing: only that column is n/a
        shutil.rmtree(os.path.join(self.st, "orders"))
        r = ref_counts.collect(self.d, self.st, 7, self.now)
        self.assertTrue(r["leads_available"]); self.assertFalse(r["orders_available"])
        self.assertEqual(r["rows"][0], ("ph", 2, 1, None))
        # no data dir file: the page-hit column is n/a
        r = ref_counts.collect(os.path.join(self.tmp, "nodata"), self.st, 7, self.now)
        self.assertFalse(r["hits_available"])
        self.assertIn("ref-hits.jsonl", ref_counts.format_table(r))

    def test_empty_but_present_folders_count_zero(self):
        empty = os.path.join(self.tmp, "empty")
        os.makedirs(os.path.join(empty, "leads")); os.makedirs(os.path.join(empty, "orders"))
        r = ref_counts.collect(self.d, empty, 7, self.now)
        self.assertTrue(r["leads_available"] and r["orders_available"])
        self.assertEqual(r["rows"], [("ph", 2, 0, 0), ("blog", 1, 0, 0)])

    def test_cli(self):
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            self.assertEqual(ref_counts.main(["--data-dir", self.d, "--store-dir", self.st]), 0)
        self.assertIn("ph", out.getvalue())
        for bad in (["--days", "0"], ["--days", "91"], ["--days", "x"], ["--orders-dir", "x"]):
            with contextlib.redirect_stderr(io.StringIO()), self.assertRaises(SystemExit) as cm:
                ref_counts.main(bad)
            self.assertEqual(cm.exception.code, 2)

    def test_default_store_dir_is_the_server_default(self):
        src = open(os.path.join(SITE, "ref_counts.py"), encoding="utf-8").read()
        self.assertIn('os.environ.get("ORDERS_LOCAL_DIR") or os.path.join(HERE, "..", "private-orders")', src)
        for word in ("urllib", "http.client", "import requests", "api.github.com", "socket", "subprocess"):
            self.assertNotIn(word, src)


class ClientScriptTests(unittest.TestCase):
    def setUp(self):
        with open(os.path.join(SITE, "assets", "ref.js"), encoding="utf-8") as f:
            self.js = f.read()

    def test_no_cookies_or_local_storage(self):
        for w in ("document.cookie", "localStorage"):
            self.assertNotIn(w, self.js)
        self.assertIn("sessionStorage", self.js)

    def test_external_links_untouched(self):
        self.assertIn("polar.sh", self.js)
        self.assertIn("[a-z][a-z0-9+.-]*:", self.js)      # any scheme (http, https, mailto...) is skipped
        self.assertIn("data-pay", self.js)

    def test_included_on_entry_pages(self):
        for p in ("index.html", "agency.html", "sample-report.html", "thanks.html"):
            with open(os.path.join(SITE, p), encoding="utf-8") as f:
                self.assertIn("assets/ref.js", f.read(), p)


if __name__ == "__main__":
    unittest.main()
