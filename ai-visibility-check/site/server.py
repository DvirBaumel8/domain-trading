"""Local preview server for the landing site + form endpoints. NOT deployed.

python3 server.py [--port 8080] [--free-run]

POST /api/check   free self-check. Instant answer from data/markets/*.json when we
                  have that niche+city; else, with --free-run, a short free run
                  (Pollinations, 8 questions, $0) in the background; else the
                  request is just saved. Requests go to data/requests.jsonl.
GET  /api/check/<id>  status of a background free run.
POST /api/intake  order intake after payment -> data/orders/<order_id>.json
                  (the engine reads it: python3 -m aivis order --intake ...).
Nothing here sends email or spends money.
"""
import argparse, datetime, http.server, json, os, re, sys, threading, uuid

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "engine"))
from aivis.parse import match_name          # noqa: E402
from aivis.niches import NICHES, get_niche  # noqa: E402

DATA = os.path.join(HERE, "data")
JOBS = {}
LOCK = threading.Lock()
FREE_RUN = False
MAX_BODY = 4096


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
    if not biz or not re.fullmatch(r"[^,]{2,40},\s*[A-Za-z]{2}", city) or niche not in NICHES:
        raise ValueError("Please enter a business name, a US city like 'Austin, TX', and a business type.")
    if email and not re.fullmatch(r"[^@\s]+@[^@\s]+\.[^@\s]+", email):
        raise ValueError("That email doesn't look right.")
    city = city.split(",")[0].strip().title() + ", " + city.split(",")[1].strip().upper()
    return {"business": biz, "city": city, "niche": niche, "email": email, "consent": bool(d.get("consent"))}


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


class H(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *a, **k):
        super().__init__(*a, directory=HERE, **k)

    def _json(self, code, obj):
        b = json.dumps(obj).encode()
        self.send_response(code); self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(b))); self.end_headers(); self.wfile.write(b)

    def _body(self):
        n = int(self.headers.get("Content-Length") or 0)
        if n > MAX_BODY:
            raise ValueError("Request too large.")
        return json.loads(self.rfile.read(n) or b"{}")

    def do_GET(self):
        if self.path in ("/health", "/healthz"):
            return self._json(200, {"ok": True})
        if self.path == "/robots.txt":
            body = b"User-agent: *\nAllow: /\nDisallow: /data/\nDisallow: /api/\n"
            self.send_response(200); self.send_header("Content-Type", "text/plain")
            self.end_headers(); return self.wfile.write(body)
        if self.path.startswith("/data/") or self.path.endswith(".py"):
            return self.send_error(404)
        m = re.fullmatch(r"/api/check/([a-f0-9-]{36})", self.path)
        if m:
            return self._json(200, JOBS.get(m.group(1), {"status": "unknown"}))
        m = re.fullmatch(r"/free/(FREE-[a-f0-9]{8})", self.path)
        if m:
            p = os.path.join(DATA, "free-checks", m.group(1), "report.html")
            if os.path.exists(p):
                b = open(p, "rb").read()
                self.send_response(200); self.send_header("Content-Type", "text/html; charset=utf-8")
                self.end_headers(); return self.wfile.write(b)
            return self.send_error(404)
        return super().do_GET()

    def do_POST(self):
        try:
            if self.path == "/api/check":
                req = clean(self._body())
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
                d = self._body()
                req = clean(d)
                oid = "ORD-" + datetime.date.today().strftime("%y%m%d") + "-" + uuid.uuid4().hex[:6]
                intake = {"order_id": oid, "business_name": req["business"], "city": req["city"],
                          "niche": req["niche"], "email": req["email"], "website": str(d.get("website", ""))[:200],
                          "plan": "check", "paid_ref": str(d.get("paid_ref", ""))[:60],
                          "competitors": [c.strip()[:120] for c in str(d.get("competitors", "")).split(",") if c.strip()][:5]}
                os.makedirs(os.path.join(DATA, "orders"), exist_ok=True)
                with open(os.path.join(DATA, "orders", oid + ".json"), "w", encoding="utf-8") as f:
                    json.dump(intake, f, indent=1)
                return self._json(200, {"status": "received", "order_id": oid})
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
