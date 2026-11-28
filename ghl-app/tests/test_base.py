import importlib, json, os, sys, threading, unittest, urllib.request

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
ENV_KEYS = ("GHL_CLIENT_ID", "GHL_CLIENT_SECRET", "GHL_SHARED_SECRET", "GHL_WEBHOOK_PUBLIC_KEY", "DATABASE_URL",
            "OPENAI_API_KEY", "ANTHROPIC_API_KEY", "PERPLEXITY_API_KEY", "GHL_MONTHLY_CAP_USD",
            "GHL_PER_LOCATION_CAP_USD", "GHL_TRIAL_MAX_LOCATIONS", "PORT", "GHL_APP_ENABLED")


class Base(unittest.TestCase):
    def setUp(self):
        self._saved = {k: os.environ.pop(k, None) for k in ENV_KEYS}

    def tearDown(self):
        for k, v in self._saved.items():
            os.environ.pop(k, None)
            if v is not None:
                os.environ[k] = v


class TestHealth(Base):
    def test_health_no_env(self):
        import app
        httpd = app.http.server.ThreadingHTTPServer(("127.0.0.1", 0), app.H)
        t = threading.Thread(target=lambda: httpd.serve_forever(poll_interval=0.05), daemon=True)
        t.start()
        try:
            r = urllib.request.urlopen(f"http://127.0.0.1:{httpd.server_address[1]}/health")
            self.assertEqual(r.status, 200)
            body = json.loads(r.read())
            self.assertTrue(body["ok"])
            self.assertTrue(body["version"])
        finally:
            httpd.shutdown(); httpd.server_close(); t.join(timeout=5)


class TestConfig(Base):
    def test_defaults(self):
        import config
        c = config.get()
        self.assertEqual(c["GHL_MONTHLY_CAP_USD"], 20)
        self.assertEqual(c["GHL_PER_LOCATION_CAP_USD"], 2)
        self.assertEqual(c["GHL_TRIAL_MAX_LOCATIONS"], 3)
        self.assertFalse(c["GHL_APP_ENABLED"])
        self.assertTrue(c["DATABASE_URL"].startswith("sqlite"))

    def test_missing_key_not_configured(self):
        import config
        self.assertTrue(all(v == "not_configured" for v in config.all_status().values()))
        os.environ["OPENAI_API_KEY"] = "x"
        self.assertEqual(config.status("openai"), "configured")
        self.assertEqual(config.status("anthropic"), "not_configured")

    def test_bad_number_falls_back(self):
        import config
        os.environ["GHL_MONTHLY_CAP_USD"] = "abc"
        self.assertEqual(config.get()["GHL_MONTHLY_CAP_USD"], 20)


class TestDatabaseUrl(Base):
    def test_postgres_url_read_as_is(self):
        import config
        for url in ("postgres://u:p@host:5432/db", "postgresql://u:p@host/db"):
            os.environ["DATABASE_URL"] = url
            self.assertEqual(config.get()["DATABASE_URL"], url)


class TestModules(Base):
    def test_each_stub_registers(self):
        for name in ("oauth", "store", "runs", "page"):
            mod = importlib.import_module(name)
            routes = {}
            mod.register(routes)
            self.assertTrue(routes, name)
            for (method, path), fn in routes.items():
                self.assertIn(method, ("GET", "POST"))
                self.assertTrue(path.startswith("/"))
                self.assertTrue(callable(fn))

    def test_app_routes(self):
        import app
        self.assertIn(("GET", "/health"), app.ROUTES)
        for name in ("oauth", "store", "runs", "page"):
            routes = {}
            importlib.import_module(name).register(routes)
            for key in routes:
                self.assertIn(key, app.ROUTES)


if __name__ == "__main__":
    unittest.main()


class TestPortable(Base):
    def test_port_default_and_env(self):
        import config
        self.assertEqual(config.get()["PORT"], 8080)
        os.environ["PORT"] = "9090"
        try:
            self.assertEqual(config.get()["PORT"], 9090)
        finally:
            os.environ.pop("PORT", None)

    def test_render_yaml_has_no_ghl_app(self):
        root = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "render.yaml")
        with open(root) as f:
            self.assertNotIn("ghl-app", f.read())

    def test_env_example_matches_config_keys(self):
        import config
        path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", ".env.example")
        with open(path) as f:
            lines = [l.strip() for l in f if l.strip() and not l.startswith("#")]
        self.assertTrue(all(l.endswith("=") for l in lines), "values must be empty")
        self.assertEqual(sorted(l[:-1] for l in lines), sorted(list(config.get()) + ["POSTGRES_PASSWORD"]))
