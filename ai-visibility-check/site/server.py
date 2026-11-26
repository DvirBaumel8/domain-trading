"""Local preview server for the landing site + form endpoints. NOT deployed.

python3 server.py [--port 8080] [--free-run]

POST /api/check   free self-check. Instant answer from data/markets/*.json when we
                  have that niche+city; else, with --free-run, a short free run
                  (Pollinations, 8 questions, $0) in the background; else the
                  request is just saved. Requests go to data/requests.jsonl.
GET  /api/check/<id>  status of a background free run.
POST /api/intake  order intake -> orders store (private GitHub repo via ORDERS_REPO +
                  ORDERS_GITHUB_TOKEN; else a local folder that is never served).
POST /api/polar/webhook  Polar payment webhook (POLAR_WEBHOOK_SECRET) marks the order paid.
New orders and payments alert ORDER_ALERT_WEBHOOK_URL (unset = logged no-op).
Only the files in PUBLIC_FILES / PUBLIC_DIRS are served. Nothing here sends email or spends money.
"""
import argparse, base64, datetime, hashlib, hmac, http.server, json, mimetypes, os, posixpath, re, sys, threading, time, urllib.parse, urllib.request, uuid

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
sys.path.insert(0, os.path.join(HERE, "..", "engine"))
from aivis.parse import match_name          # noqa: E402
from aivis.niches import NICHES, get_niche  # noqa: E402
from aivis.order import US_STATES, US_ONLY_MSG, normalize_website
from aivis.uscities import is_us_place  # noqa: E402
from site_config import BUSINESS_ADDRESS    # noqa: E402
import delivery                             # noqa: E402
import cities                               # noqa: E402
import html as _html

DATA = os.path.join(HERE, "data")
JOBS = {}
LOCK = threading.Lock()
FREE_RUN = False
MAX_BODY = 4096
MAX_HOOK_BODY = 65536
PUBLIC_FILES = {"index.html", "agency.html", "privacy.html", "refunds.html", "sample-report.html",
                "sample-report.pdf", "terms.html", "thanks.html"}
PUBLIC_DIRS = {"assets": {".css", ".js", ".png"}}   # direct children only, these extensions only
LOCAL_ORDERS = os.environ.get("ORDERS_LOCAL_DIR") or os.path.join(HERE, "..", "private-orders")


def render_page(raw):
    """Fill the {{BUSINESS_ADDRESS}} token of a static HTML page from site_config."""
    return raw.replace(b"{{BUSINESS_ADDRESS}}", _html.escape(BUSINESS_ADDRESS).encode())


def log(msg):
    print(msg, file=sys.stderr)


def http_call(req, timeout=15):
    """The only network entry point (tests replace it). Returns (status, body bytes)."""
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, r.read()
    except urllib.error.HTTPError as e:
        return e.code, e.read()


def normalize_path(raw):
    """Decode (repeatedly), unify separators and case, resolve dots. Returns None for unsafe input."""
    p = urllib.parse.urlsplit(raw).path
    for _ in range(6):
        d = urllib.parse.unquote(p)
        if d == p:
            break
        p = d
    else:
        return None
    if "\x00" in p:
        return None
    p = p.replace("\\", "/").lower()
    p = posixpath.normpath("/" + p).lstrip("/")
    return p


def public_file(raw):
    """Absolute path of an allow-listed public file for this request path, else None."""
    p = normalize_path(raw)
    if p is None:
        return None
    if p == "":
        p = "index.html"
    if p in PUBLIC_FILES:
        return os.path.join(HERE, p)
    d, _, name = p.rpartition("/")
    if d in PUBLIC_DIRS and name and not name.startswith(".") and os.path.splitext(name)[1] in PUBLIC_DIRS[d]:
        f = os.path.join(HERE, d, name)
        if os.path.isfile(f):
            return f
    return None


class Store:
    """Private order storage. GitHub contents API when configured, else a local folder."""
    def __init__(self):
        self.repo = os.environ.get("ORDERS_REPO", "").strip()
        self.token = os.environ.get("ORDERS_GITHUB_TOKEN", "").strip()
        self.remote = bool(self.repo and self.token)

    def _url(self, path):
        return f"https://api.github.com/repos/{self.repo}/contents/{urllib.parse.quote(path)}"

    def _hdr(self):
        return {"Authorization": "Bearer " + self.token, "Accept": "application/vnd.github+json",
                "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "aivis-orders"}

    def get(self, path):
        """-> (obj, sha) or (None, None)."""
        if not self.remote:
            f = os.path.join(LOCAL_ORDERS, path)
            if not os.path.isfile(f):
                return None, None
            with open(f, encoding="utf-8") as fh:
                return json.load(fh), None
        st, body = http_call(urllib.request.Request(self._url(path), headers=self._hdr()))
        if st == 404:
            return None, None
        if st != 200:
            raise RuntimeError(f"orders store read failed ({st})")
        j = json.loads(body)
        return json.loads(base64.b64decode(j["content"])), j["sha"]

    def put(self, path, obj, overwrite=False):
        """Create (or replace if overwrite). Returns False if it exists and overwrite is False."""
        if not self.remote:
            f = os.path.join(LOCAL_ORDERS, path)
            os.makedirs(os.path.dirname(f), exist_ok=True)
            with LOCK:
                if os.path.exists(f) and not overwrite:
                    return False
                with open(f, "w", encoding="utf-8") as fh:
                    json.dump(obj, fh, indent=1)
            return True
        payload = {"message": "order data", "content": base64.b64encode(json.dumps(obj, indent=1).encode()).decode()}
        if overwrite:
            _, sha = self.get(path)
            if sha:
                payload["sha"] = sha
        req = urllib.request.Request(self._url(path), data=json.dumps(payload).encode(), method="PUT",
                                     headers={**self._hdr(), "Content-Type": "application/json"})
        st, _ = http_call(req)
        if st in (200, 201):
            return True
        if st in (409, 422) and not overwrite:
            return False
        raise RuntimeError(f"orders store write failed ({st})")

    def put_text(self, path, text):
        """Store a text file (report.html etc.), replacing any older copy."""
        if not self.remote:
            f = os.path.join(LOCAL_ORDERS, path)
            os.makedirs(os.path.dirname(f), exist_ok=True)
            with LOCK, open(f, "w", encoding="utf-8") as fh:
                fh.write(text)
            return
        payload = {"message": "order data", "content": base64.b64encode(text.encode()).decode()}
        _, sha = self.get_raw(path)
        if sha:
            payload["sha"] = sha
        st, _ = http_call(urllib.request.Request(self._url(path), data=json.dumps(payload).encode(), method="PUT",
                                                 headers={**self._hdr(), "Content-Type": "application/json"}))
        if st not in (200, 201):
            raise RuntimeError(f"orders store write failed ({st})")

    def get_raw(self, path):
        """-> (text, sha) or (None, None)."""
        if not self.remote:
            f = os.path.join(LOCAL_ORDERS, path)
            if not os.path.isfile(f):
                return None, None
            with open(f, encoding="utf-8") as fh:
                return fh.read(), None
        st, body = http_call(urllib.request.Request(self._url(path), headers=self._hdr()))
        if st == 404:
            return None, None
        if st != 200:
            raise RuntimeError(f"orders store read failed ({st})")
        j = json.loads(body)
        return base64.b64decode(j["content"]).decode("utf-8"), j["sha"]

    def get_text(self, path):
        return self.get_raw(path)[0]


def alert(text):
    url = os.environ.get("ORDER_ALERT_WEBHOOK_URL", "").strip()
    if not url:
        log("alert (no target set): " + text)
        return False
    try:
        req = urllib.request.Request(url, data=json.dumps({"text": text, "content": text}).encode(), method="POST",
                                     headers={"Content-Type": "application/json", "User-Agent": "aivis-alert"})
        st, _ = http_call(req)
        return 200 <= st < 300
    except Exception as e:
        log("alert failed: " + type(e).__name__)
        return False


def email_key(email):
    return hashlib.sha256(email.strip().lower().encode()).hexdigest()[:32]


def verify_polar(secret, headers, body):
    """Standard Webhooks signature: HMAC-SHA256 over '<id>.<timestamp>.<body>', base64, 'v1,' prefix."""
    if not secret:
        return False
    mid, ts, sig = headers.get("webhook-id", ""), headers.get("webhook-timestamp", ""), headers.get("webhook-signature", "")
    try:
        if abs(time.time() - int(ts)) > 300:
            return False
    except ValueError:
        return False
    keys = []
    if secret.startswith("whsec_"):          # Standard Webhooks: key is the base64-decoded part after the prefix
        try:
            keys.append(base64.b64decode(secret[len("whsec_"):]))
        except ValueError:
            pass
    keys.append(secret.encode("utf-8"))      # legacy: the secret string itself
    msg = f"{mid}.{ts}.".encode() + body
    sigs = [c.split(",", 1)[1] for c in sig.split() if c.startswith("v1,")]
    ok = False
    for key in keys:
        want = base64.b64encode(hmac.new(key, msg, hashlib.sha256).digest()).decode()
        for s in sigs:
            ok = hmac.compare_digest(want, s) or ok
    return ok


def mark_paid(store, oid, ref):
    o, _ = store.get(f"orders/{oid}.json")
    if o is None:
        return False
    if not o.get("paid"):
        o.update({"paid": True, "paid_ref": ref or o.get("paid_ref", ""),
                  "paid_at": datetime.datetime.now().isoformat(timespec="seconds")})
        store.put(f"orders/{oid}.json", o, overwrite=True)
    return True


def start_delivery(store, oid, lead=""):
    try:
        delivery.on_paid(store, oid, alert, lead)
    except Exception as e:      # a delivery problem must never fail the webhook
        log("delivery start failed: " + type(e).__name__)
        if lead:
            alert(lead)


def handle_polar(headers, body):
    """-> (http status, json). Verifies, dedupes, marks paid, alerts."""
    if not verify_polar(os.environ.get("POLAR_WEBHOOK_SECRET", ""), headers, body):
        return 401, {"error": "bad signature"}
    store, eid = Store(), re.sub(r"[^A-Za-z0-9_-]", "", headers.get("webhook-id", ""))[:80]
    if not eid:
        return 400, {"error": "missing id"}
    if store.get(f"events/{eid}.json")[0] is not None:
        return 200, {"status": "duplicate"}
    ev = json.loads(body or b"{}")
    d = ev.get("data") or {}
    if ev.get("type") == "order.paid":
        ref = str(d.get("id", ""))[:60]
        email = str((d.get("customer") or {}).get("email") or d.get("customer_email") or "").strip().lower()
        oid = str((d.get("metadata") or {}).get("order_id", "")).strip()
        paid = bool(re.fullmatch(r"ORD-\d{6}-[a-f0-9]{6}", oid)) and mark_paid(store, oid, ref)
        if not paid and email:      # no (valid) metadata match: fall back to the buyer email
            oid = (store.get(f"index/{email_key(email)}.json")[0] or {}).get("order_id", "")
            paid = bool(oid) and mark_paid(store, oid, ref)
        if paid:
            start_delivery(store, oid, f"Order {oid} PAID (Polar {ref})")
            res = {"status": "paid", "order_id": oid}
        else:
            if email:   # payment arrived before the intake form: remember it
                store.put(f"payments/{email_key(email)}.json", {"ref": ref}, overwrite=True)
            alert(f"UNMATCHED Polar payment {ref}: no order matches yet. Match it by hand if no intake arrives.")
            res = {"status": "unmatched"}
    else:
        res = {"status": "ignored"}
    if not store.put(f"events/{eid}.json", {"type": ev.get("type", "")}):
        return 200, {"status": "duplicate"}
    return 200, res


def new_order(d, req):
    store = Store()
    oid = "ORD-" + datetime.date.today().strftime("%y%m%d") + "-" + uuid.uuid4().hex[:6]
    token = delivery.new_token()
    intake = {"order_id": oid, "business_name": req["business"], "city": req["city"],
              "niche": req["niche"], "email": req["email"], "website": req["website"],
              "token": token, "plan": "check", "paid_ref": str(d.get("paid_ref", ""))[:60], "paid": False,
              "competitors": [c.strip()[:120] for c in str(d.get("competitors", "")).split(",") if c.strip()][:5]}
    store.put(f"orders/{oid}.json", intake)
    delivery.register_token(store, oid, token)
    if req["email"]:
        store.put(f"index/{email_key(req['email'])}.json", {"order_id": oid}, overwrite=True)
        pay, _ = store.get(f"payments/{email_key(req['email'])}.json")
        if pay:
            mark_paid(store, oid, pay.get("ref", ""))
            start_delivery(store, oid)
    alert(f"New order {oid}")
    return oid, token


def slug(niche, city):
    return f"{niche}__{city.lower().replace(',', '').replace(' ', '-')}"


def save_line(path, obj):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with LOCK, open(path, "a", encoding="utf-8") as f:
        f.write(json.dumps(obj) + "\n")


def clean(d):
    biz = str(d.get("business", "")).strip()[:120]
    city = str(d.get("city", "")).strip()[:60]
    niche = str(d.get("niche", "")).strip()
    email = str(d.get("email", "")).strip()[:160]
    if not biz or niche not in NICHES:
        raise ValueError("Please enter a business name, a US city like 'Austin, TX', and a business type.")
    m = re.fullmatch(r"([^,]{2,40}),\s*([A-Za-z]{2})", city)
    if not m or m.group(2).upper() not in US_STATES or not is_us_place(m.group(1), m.group(2)):
        raise ValueError(US_ONLY_MSG)
    if email and not re.fullmatch(r"[^@\s]+@[^@\s]+\.[^@\s]+", email):
        raise ValueError("That email doesn't look right.")
    city = m.group(1).strip().title() + ", " + m.group(2).upper()
    return {"business": biz, "city": city, "niche": niche, "email": email, "consent": bool(d.get("consent")),
            "website": normalize_website(d.get("website", ""))}


def instant(req):
    p = os.path.join(DATA, "markets", slug(req["niche"], req["city"]) + ".json")
    if not os.path.exists(p):
        return None
    m = json.load(open(p, encoding="utf-8"))
    hits = 0
    for a in m["answers"]:
        if any(match_name(req["business"], [n], city=req["city"]) for n in a["names"] + a["raw"]):
            hits += 1
    return {"status": "instant", "named_in": hits, "answers": len(m["answers"]),
            "competitors": max(0, m["competitors"] - (1 if hits else 0)),
            "unverified_pct": m["unverified_pct"], "niche_label": m["niche_label"], "city": m["city"],
            "source_note": m["source_note"]}


def free_job(job_id, req):
    from aivis.order import Order, run_order
    from aivis.report_pro import render
    try:
        o = Order(order_id="FREE-" + job_id[:8], business_name=req["business"], city=req["city"],
                  niche=req["niche"], plan="free")
        res, log = run_order(o, mode="free", out_dir=os.path.join(DATA, "free-checks"),
                             render=lambda r: render(r, sample=True, run_note="Free quick check: one AI model "
                                                     "answering from memory, no web search, 8 questions."))
        JOBS[job_id] = {"status": "done", "named_in": sum(p.target_hits for p in res.score.providers),
                        "answers": res.score.total_answers, "report": f"/free/{o.order_id}"}
    except Exception as e:  # never leak internals to the browser
        JOBS[job_id] = {"status": "failed"}
        print("free job failed:", type(e).__name__, file=sys.stderr)


class H(http.server.BaseHTTPRequestHandler):
    def _json(self, code, obj):
        b = json.dumps(obj).encode()
        self.send_response(code); self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(b))); self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(b)

    def _send(self, code, ctype, body, private=False):
        self.send_response(code); self.send_header("Content-Type", ctype)
        if private:
            for k, v in (("X-Robots-Tag", "noindex, nofollow"), ("Cache-Control", "no-store"),
                         ("Referrer-Policy", "no-referrer")):
                self.send_header(k, v)
        self.send_header("Content-Length", str(len(body))); self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def _body(self, limit=MAX_BODY):
        n = int(self.headers.get("Content-Length") or 0)
        if n > limit:
            raise ValueError("Request too large.")
        return self.rfile.read(n)

    def log_message(self, fmt, *args):   # request lines can carry data; log nothing
        pass

    def do_HEAD(self):
        self.do_GET()

    def do_GET(self):
        path = urllib.parse.urlsplit(self.path).path
        if path in ("/health", "/healthz"):
            return self._json(200, {"ok": True})
        if path == "/robots.txt":
            return self._send(200, "text/plain", b"User-agent: *\nAllow: /\nDisallow: /data/\nDisallow: /api/\nDisallow: /r/\nDisallow: /status/\n")
        r = cities.route(path, self.headers)
        if r:
            st, ctype, body = r
            if st != 200:
                return self._json(404, {"error": "not found"})
            return self._send(200, ctype, render_page(body) if ctype.startswith("text/html") else body)
        m = re.fullmatch(r"/api/check/([a-f0-9-]{36})", path)
        if m:
            return self._json(200, JOBS.get(m.group(1), {"status": "unknown"}))
        m = re.fullmatch(r"/(r|status)/(.*)", path)
        if m:
            try:
                st = Store()
                page = (delivery.report_html if m.group(1) == "r" else delivery.status_page)(st, m.group(2))
            except Exception as e:
                print("error:", type(e).__name__, file=sys.stderr)
                page = None
            if page is None:
                return self._json(404, {"error": "not found"})
            return self._send(200, "text/html; charset=utf-8", page.encode(), private=True)
        m = re.fullmatch(r"/free/(FREE-[a-f0-9]{8})", path)
        if m:
            p = os.path.join(DATA, "free-checks", m.group(1), "report.html")
            if os.path.isfile(p):
                with open(p, "rb") as fh:
                    return self._send(200, "text/html; charset=utf-8", fh.read())
            return self._json(404, {"error": "not found"})
        f = public_file(self.path)
        if f is None:
            return self._json(404, {"error": "not found"})
        ctype = mimetypes.guess_type(f)[0] or "application/octet-stream"
        if ctype.startswith("text/"):
            ctype += "; charset=utf-8"
        with open(f, "rb") as fh:
            body = fh.read()
        if f.endswith(".html"):
            body = render_page(body)
        return self._send(200, ctype, body)

    def do_POST(self):
        try:
            if self.path == "/api/polar/webhook":
                hdr = {k.lower(): v for k, v in self.headers.items()}
                code, obj = handle_polar(hdr, self._body(MAX_HOOK_BODY))
                return self._json(code, obj)
            if self.path == "/api/check":
                req = clean(json.loads(self._body() or b"{}"))
                rec = {**req, "at": datetime.datetime.now().isoformat(timespec="seconds"), "ip": self.client_address[0]}
                r = instant(req)
                if r:
                    save_line(os.path.join(DATA, "requests.jsonl"), {**rec, "result": "instant"})
                    return self._json(200, r)
                if FREE_RUN:
                    job = str(uuid.uuid4()); JOBS[job] = {"status": "running"}
                    threading.Thread(target=free_job, args=(job, req), daemon=True).start()
                    save_line(os.path.join(DATA, "requests.jsonl"), {**rec, "result": "free-run", "job": job})
                    return self._json(200, {"status": "queued", "id": job, "prompts": 8, "eta_min": 1,
                                            "niche_label": get_niche(req["niche"]).plural})
                save_line(os.path.join(DATA, "requests.jsonl"), {**rec, "result": "saved"})
                return self._json(200, {"status": "saved"})
            if self.path == "/api/intake":
                d = json.loads(self._body() or b"{}")
                oid, token = new_order(d, clean(d))
                return self._json(200, {"status": "received", "order_id": oid, "status_url": "/status/" + token})
            return self._json(404, {"error": "not found"})
        except ValueError as e:
            return self._json(400, {"error": str(e)})
        except Exception as e:
            print("error:", type(e).__name__, file=sys.stderr)
            return self._json(500, {"error": "Something went wrong."})


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=int(os.environ.get("PORT", "8080")))
    ap.add_argument("--host", default=os.environ.get("HOST", "127.0.0.1"))
    ap.add_argument("--free-run", action="store_true"); a = ap.parse_args()
    # On Render (PORT is set by the platform) listen on all interfaces.
    if os.environ.get("PORT") and a.host == "127.0.0.1":
        a.host = "0.0.0.0"
    FREE_RUN = a.free_run or os.environ.get("AIVIS_FREE_RUN") == "1"
    print(f"listening on http://{a.host}:{a.port}  (free-run={'on' if FREE_RUN else 'off'})")
    http.server.ThreadingHTTPServer((a.host, a.port), H).serve_forever()
