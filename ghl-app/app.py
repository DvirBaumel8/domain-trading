"""GoHighLevel Marketplace app: stdlib HTTP server. python3 app.py [--host H] [--port P]

Routes come from the modules in MODULES (each has register(routes)); add routes there, not here.
Handlers take a Req and return (status, dict). Errors: {"error": {code, message, details}}."""
import argparse, http.server, json, os, sys, urllib.parse

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import config                                   # noqa: E402
import oauth, store, runs, page                 # noqa: E402,E401

MODULES = (oauth, store, runs, page)
MAX_BODY = 65536


class Req:
    def __init__(self, method, path, query, headers, body):
        self.method, self.path, self.query, self.headers, self.body = method, path, query, headers, body


def health(req):
    return 200, {"ok": True, "version": config.VERSION}


def build_routes():
    routes = {("GET", "/health"): health}
    for mod in MODULES:
        mod.register(routes)
    return routes


ROUTES = build_routes()


def err(code, message, details=None):
    return {"error": {"code": code, "message": message, "details": details or {}}}


class H(http.server.BaseHTTPRequestHandler):
    server_version = "ghl-app"

    def log_message(self, *a):
        pass

    def _send(self, status, payload):
        extra = {}
        if hasattr(payload, "body"):            # page.Html: raw body, own type and headers
            raw, ctype, extra = payload.body, payload.content_type, dict(payload.headers)
        else:
            raw, ctype = json.dumps(payload).encode(), "application/json"
            if status in (301, 302, 303, 307) and isinstance(payload, dict) and payload.get("location"):
                extra["Location"] = str(payload["location"])
        self.send_response(status)
        self.send_header("Content-Type", ctype)
        for k, v in extra.items():
            self.send_header(k, v)
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(raw)

    def _dispatch(self):
        url = urllib.parse.urlsplit(self.path)
        try:
            n = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            n = 0
        if n > MAX_BODY:
            return self._send(413, err("body_too_large", "Body too large"))
        body = self.rfile.read(n) if n > 0 else b""
        method = "GET" if self.command == "HEAD" else self.command
        handler = ROUTES.get((method, url.path))
        if handler is None:
            known = any(p == url.path for _, p in ROUTES)
            return self._send(405 if known else 404, err("method_not_allowed" if known else "not_found", "No such route"))
        try:
            status, payload = handler(Req(method, url.path, urllib.parse.parse_qs(url.query), self.headers, body))
        except Exception:                       # never leak internals or secrets
            status, payload = 500, err("internal_error", "Internal error")
        self._send(status, payload)

    do_GET = do_POST = do_HEAD = _dispatch


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--host", default="0.0.0.0")  # noqa: S104 (container-friendly)
    ap.add_argument("--port", type=int, default=config.get()["PORT"])
    a = ap.parse_args()
    http.server.ThreadingHTTPServer((a.host, a.port), H).serve_forever()


if __name__ == "__main__":
    main()
