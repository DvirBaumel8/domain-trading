import base64, hashlib, hmac, json, os, re, subprocess, sys, time, urllib.request, shutil, io, contextlib, traceback
os.environ["PYTHONDONTWRITEBYTECODE"] = "1"; sys.dont_write_bytecode = True
OUT = "/workspace/company/avc-mock-run"
REPO = "/workspace/dt/ai-visibility-check"
sys.path.insert(0, OUT); sys.path.insert(0, REPO + "/engine")
import fake_apis
from aivis.roster import from_nppes

# ---- 0. start the real site server locally, orders stored in a local folder (not the repo) ----
ORD = OUT + "/private-orders"; shutil.rmtree(ORD, ignore_errors=True)
whsec = "whsec_" + base64.b64encode(os.urandom(24)).decode()
env = dict(os.environ, ORDERS_LOCAL_DIR=ORD, POLAR_WEBHOOK_SECRET=whsec, PORT="8893", HOST="127.0.0.1")
for k in ("ORDERS_REPO", "ORDERS_GITHUB_TOKEN", "ORDER_ALERT_WEBHOOK_URL"): env.pop(k, None)
env.pop("PORT")  # PORT would make it bind 0.0.0.0
srv = subprocess.Popen([sys.executable, REPO + "/site/server.py", "--port", "8893"], env=env,
                       stdout=open(OUT + "/server.log", "w"), stderr=subprocess.STDOUT)
time.sleep(1.5)
BASE = "http://127.0.0.1:8893"

def post(path, obj, headers=None, raw=None):
    data = raw if raw is not None else json.dumps(obj).encode()
    r = urllib.request.Request(BASE + path, data=data, headers={"Content-Type": "application/json", **(headers or {})}, method="POST")
    try:
        with urllib.request.urlopen(r) as x: return x.status, json.loads(x.read())
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read() or b"{}")

def webhook(payload, secret=whsec, wid=None):
    body = json.dumps(payload).encode(); wid = wid or "evt_" + os.urandom(4).hex(); ts = str(int(time.time()))
    key = base64.b64decode(secret[6:])
    sig = base64.b64encode(hmac.new(key, f"{wid}.{ts}.".encode() + body, hashlib.sha256).digest()).decode()
    return post("/api/polar/webhook", None, {"webhook-id": wid, "webhook-timestamp": ts, "webhook-signature": "v1," + sig}, raw=body)

SAMPLES = [
  dict(tag="austin-dentist", business="Magnolia Family Dentistry", city="Austin, TX", niche="dentist",
       email="owner@magnolia-test.invalid", website="https://magnoliadentistryatx.com", competitors="Anderson Lane Dental, Austin Smile Studio", early_pay=False),
  dict(tag="columbus-plumber", business="DrainMaster", city="Columbus, OH", niche="plumber",
       email="owner@drainmaster-test.invalid", website="https://drainmasterohio.com", competitors="Roto-Rooter Columbus", early_pay=True),
  dict(tag="telaviv-dentist", business="Dr Cohen Dental Clinic", city="Tel Aviv, IL", niche="dentist",
       email="owner@cohen-test.invalid", website="", competitors="", early_pay=False),
]
PLUMB = ["Columbus Plumbing Pros", "Buckeye Drain & Rooter", "Olentangy Plumbing Co", "Short North Plumbers", "Capital City Plumbing",
         "Franklin County Water Heaters", "Roto-Rooter Columbus", "Clintonville Plumbing Service", "Grandview Pipe Works", "Easton Plumbing & Heating"]
TLV = ["Tel Aviv Dental Center", "Dizengoff Dental Clinic", "Rothschild Smile Studio", "Neve Tzedek Dentistry", "Ramat Aviv Dental Care", "Florentin Orthodontics"]
summary = []
for s in SAMPLES:
    tag = s["tag"]; print("=====", tag, flush=True); rec = {"sample": tag, "steps": {}}
    # ---- 1. intake via real HTTP endpoint ----
    body = {k: s[k] for k in ("business", "city", "niche", "email", "website", "competitors")}
    if s["early_pay"]:      # payment arrives before the intake form
        st, r = webhook({"type": "order.paid", "data": {"id": "polar_ord_" + tag, "customer": {"email": s["email"]}}})
        rec["steps"]["early_webhook"] = [st, r]
    st, r = post("/api/intake", body); rec["steps"]["intake"] = [st, r]
    if st != 200:
        rec["steps"]["intake_rejected"] = True; summary.append(rec); print(rec); continue
    oid = r["order_id"]
    if not s["early_pay"]:
        st, r = webhook({"type": "order.paid", "data": {"id": "polar_ord_" + tag, "customer": {"email": s["email"]}}})  # no metadata, like the real Polar link
        rec["steps"]["webhook"] = [st, r]
    order_file = f"{ORD}/orders/{oid}.json"; o = json.load(open(order_file)); rec["steps"]["order_after_payment"] = {k: v for k, v in o.items() if k != "email"}
    # ---- 2. operator runs the paid engine through the REAL cli, with fake AI endpoints ----
    if s["niche"] == "dentist" and "Austin" in s["city"]:
        pool = [e.name for e in from_nppes("Dentist", "Austin", "TX", limit=40)]
    elif s["niche"] == "plumber": pool = PLUMB
    else: pool = TLV
    fake_apis.POOLS["cur"] = pool; fake_apis.TARGET["name"] = s["business"]; fake_apis.CALLS.clear()
    urllib.request.urlopen = fake_apis.fake_urlopen
    for k in ("OPENAI_API_KEY", "PERPLEXITY_API_KEY", "GEMINI_API_KEY", "ANTHROPIC_API_KEY"): os.environ[k] = "FAKE-LOCAL-MOCK-KEY"
    os.environ["AIVIS_ALLOW_PAID"] = "1"
    from aivis.__main__ import main
    outdir = f"{OUT}/orders"; buf = io.StringIO()
    t = time.time()
    try:
        with contextlib.redirect_stdout(buf):
            main(["order", "--intake", order_file, "--mode", "paid", "--cap", "8", "--out", outdir])
        rec["steps"]["engine"] = "ok"
    except SystemExit as e: rec["steps"]["engine"] = f"SystemExit {e}"
    except Exception as e: rec["steps"]["engine"] = "CRASH " + traceback.format_exc()
    rec["steps"]["engine_seconds"] = round(time.time() - t, 1); rec["steps"]["fake_api_calls"] = len(fake_apis.CALLS)
    rec["steps"]["fake_calls_by_vendor"] = {v: sum(1 for c in fake_apis.CALLS if c[0] == v) for v in ("openai", "gemini", "claude")}
    try: rec["order_log"] = json.loads(buf.getvalue())
    except Exception: rec["cli_stdout"] = buf.getvalue()[-500:]
    rec["order_id"] = oid; rec["pool_size"] = len(pool)
    urllib.request.urlopen = fake_apis.REAL_URLOPEN
    summary.append(rec)
srv.terminate()
json.dump(summary, open(OUT + "/summary.json", "w"), indent=1, default=str)
print(json.dumps(summary, indent=1, default=str)[:6000])
