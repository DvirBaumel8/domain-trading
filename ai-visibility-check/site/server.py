"""Local preview server for the landing site + form endpoints. NOT deployed.

python3 server.py [--port 8080] [--free-run]

POST /api/check   free self-check. Instant answer from data/markets/*.json when we
                  have that niche+city; else, with --free-run, a short free run
                  (Pollinations, 8 questions, $0) in the background; else the
                  request is just saved. Requests go to the private orders store (leads/).
                  Limits per client address: 5 checks an hour, 3 free jobs at once (429 beyond).
GET  /api/check/<id>  status of a background free run.
POST /api/intake  order intake -> orders store (private GitHub repo via ORDERS_REPO +
                  ORDERS_GITHUB_TOKEN; else a local folder that is never served).
POST /api/polar/webhook  Polar payment webhook (POLAR_WEBHOOK_SECRET) marks the order paid.
New orders, payments and failed runs alert: a GitHub issue in ORDERS_REPO (ids, status and product type only)
and/or ORDER_ALERT_WEBHOOK_URL. A background thread resumes lost runs and sweeps stuck orders every 10 minutes.
Only the files in PUBLIC_FILES / PUBLIC_DIRS are served. Nothing here sends email or spends money.
"""
import argparse, base64, ipaddress, queue, shutil, tempfile, datetime, hashlib, hmac, http.server, json, mimetypes, os, posixpath, re, sys, threading, time, urllib.parse, urllib.request, uuid

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
sys.path.insert(0, os.path.join(HERE, "..", "engine"))
from aivis.parse import match_name          # noqa: E402
from aivis.niches import NICHES, get_niche  # noqa: E402
from aivis.order import US_STATES, US_ONLY_MSG, normalize_website
from aivis.uscities import is_us_place  # noqa: E402
from site_config import BUSINESS_ADDRESS    # noqa: E402
import delivery                             # noqa: E402
import products                             # noqa: E402
import html as _html

DATA = os.path.join(HERE, "data")
JOBS = {}
LOCK = threading.Lock()
FREE_RUN = False
MAX_BODY = 4096
MAX_HOOK_BODY = 65536
BAD_FORM_MSG = "Please send the form again."
BUSY_MSG = "Too many checks right now, try again in a few minutes."
FREE_PER_HOUR = 5           # free checks per client address per hour
FREE_CONCURRENT = 3         # free jobs running at once per client address
JOB_KEEP_SECONDS = 3600     # finished JOBS entries are dropped after this
JOB_META = {}               # job id -> {"ip", "started", "finished"}; never sent to the browser
CHECK_LOG = {}              # client address -> start times of recent checks
PUBLIC_FILES = {"index.html", "agency.html", "privacy.html", "refunds.html", "sample-report.html",
                "sample-report.pdf", "terms.html", "thanks.html", "favicon.ico"}
PUBLIC_DIRS = {"assets": {".css", ".js", ".png"}}   # direct children only, these extensions only
LOCAL_ORDERS = os.environ.get("ORDERS_LOCAL_DIR") or os.path.join(HERE, "..", "private-orders")


def render_page(raw):
    """Fill the {{BUSINESS_ADDRESS}} token of a static HTML page from site_config."""
    return raw.replace(b"{{BUSINESS_ADDRESS}}", _html.escape(BUSINESS_ADDRESS).encode())


def log(msg):
    print(msg, file=sys.stderr)


def clock():
    return time.time()      # tests replace this


def client_ip(headers, peer):
    """The client address: the entry the hosting proxy appended to X-Forwarded-For (the last one; earlier
    entries can be written by the client), else the socket address. Only a valid IP address is used."""
    xff = str((headers or {}).get("X-Forwarded-For") or "").split(",")[-1].strip()
    try:
        return str(ipaddress.ip_address(xff))
    except ValueError:
        return str(peer)


def prune_jobs(t=None):
    """Drop finished JOBS entries (and their metadata) older than JOB_KEEP_SECONDS, and old check times."""
    t = clock() if t is None else t
    with LOCK:
        for j, m in list(JOB_META.items()):
            if m.get("finished") and t - m["finished"] > JOB_KEEP_SECONDS:
                JOB_META.pop(j, None); JOBS.pop(j, None)
        for j in list(JOBS):
            if j not in JOB_META and JOBS[j].get("status") != "running":
                JOBS.pop(j, None)       # no record of when it ended: do not keep it forever
        for ip, ts in list(CHECK_LOG.items()):
            ts[:] = [x for x in ts if t - x < 3600]
            if not ts:
                CHECK_LOG.pop(ip, None)


def admit_check(ip, free_run):
    """True and the check is counted, or False when this address is over its limits."""
    t = clock()
    prune_jobs(t)
    with LOCK:
        if len(CHECK_LOG.get(ip, [])) >= FREE_PER_HOUR:
            return False
        if free_run and sum(1 for j, m in JOB_META.items()
                            if m.get("ip") == ip and not m.get("finished") and JOBS.get(j, {}).get("status") == "running") >= FREE_CONCURRENT:
            return False
        CHECK_LOG.setdefault(ip, []).append(t)
        return True


def finish_job(job_id, result):
    with LOCK:
        JOBS[job_id] = result
        JOB_META.setdefault(job_id, {})["finished"] = clock()


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
                tmp = f"{f}.{uuid.uuid4().hex}.tmp"     # readers never see a half-written file
                with open(tmp, "w", encoding="utf-8") as fh:
                    json.dump(obj, fh, indent=1)
                os.replace(tmp, f)
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

    def list_prefix(self, prefix):
        """Paths of the files directly under a folder prefix like 'orders/' (paginated for the remote store)."""
        folder = prefix.strip("/")
        if not self.remote:
            d = os.path.join(LOCAL_ORDERS, folder)
            return [f"{folder}/{n}" for n in sorted(os.listdir(d))
                    if os.path.isfile(os.path.join(d, n)) and not n.endswith(".tmp")] if os.path.isdir(d) else []
        out, seen, page = [], set(), 1
        while True:
            st, body = http_call(urllib.request.Request(f"{self._url(folder)}?per_page=100&page={page}", headers=self._hdr()))
            if st == 404:
                break
            if st != 200:
                raise RuntimeError(f"orders store list failed ({st})")
            rows = [r for r in json.loads(body) if isinstance(r, dict) and r.get("type") == "file"]
            new = [r["path"] for r in rows if r["path"] not in seen]
            if not new:
                break               # an empty page, or an API that ignores paging and repeats itself
            seen.update(new); out += new
            if len(rows) < 100:
                break
            page += 1
        return out

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


def redact(text):
    """Webhook/log text never carries an email address or a link."""
    return re.sub(r"https?://\S+", "[link]", re.sub(r"[^\s@]+@[^\s@]+", "[email]", str(text)))


def alert(text):
    text = redact(text)
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


ALERT_LOCK = threading.RLock()
ALERT_TITLES = {"new": "new order", "failed": "failed run", "blocked": "blocked run", "stuck": "stuck order",
                "overdue": "overdue manual order", "unmatched": "unmatched payment", "held": "held payment",
                "unknown_product": "unknown product payment", "webhook_failed": "webhook event failed"}


def github_alert_token():
    return (os.environ.get("ALERT_GITHUB_TOKEN") or os.environ.get("ORDERS_GITHUB_TOKEN") or "").strip()


def github_alerts_on():
    return bool(os.environ.get("ORDERS_REPO", "").strip() and github_alert_token())


def alerts_configured():
    return github_alerts_on() or bool(os.environ.get("ORDER_ALERT_WEBHOOK_URL", "").strip())


def alert_text(kind, oid="", status="", ptype="", ref=""):
    """-> (title, body). Only the internal order id, the status, the product type and (for a payment with
    no order) the opaque Polar order id and a reason code. Every value is checked against a fixed shape."""
    oid = oid if re.fullmatch(r"(ORD-\d{6}-[a-f0-9]{6}|MAN-[a-f0-9]{12})", oid or "") else ""
    ptype = ptype if ptype in products.TYPES else "unknown"
    status = re.sub(r"[^a-z_ ]", "", str(status or "").lower())[:30]
    ref = clean_ref(ref)
    what = ALERT_TITLES.get(kind, "alert")
    subject = oid or ref
    title = f"[AVC] {what} {subject} ({ptype})".replace("  ", " ")
    lines = [f"Order: {oid}"] if oid else [f"Payment (opaque id): {ref}"]
    lines += ([f"Status: {status}"] if status else []) + [f"Product type: {ptype}", f"Reason: {kind}"]
    return title, "\n".join(lines)


def send_github_issue(title, body):
    url = f"https://api.github.com/repos/{os.environ['ORDERS_REPO'].strip()}/issues"
    hdr = {"Authorization": "Bearer " + github_alert_token(), "Accept": "application/vnd.github+json",
           "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "aivis-orders", "Content-Type": "application/json"}
    for labels in (["avc-alert"], None):         # a missing label never blocks the alert
        payload = {"title": title, "body": body, **({"labels": labels} if labels else {})}
        st, _ = http_call(urllib.request.Request(url, data=json.dumps(payload).encode(), method="POST", headers=hdr))
        if st in (200, 201):
            return True
        if st != 422 or not labels:
            return False
    return False


def notify_event(kind, oid="", status="", ptype="", ref="", unique="", webhook=False):
    """One alert per event: the dedupe key (id + kind [+ window]) is stored create-only, so replays, resumes and
    sweeps never open a second issue. A failed GitHub call is logged by type, kept as pending and retried by the
    next sweep. Never raises."""
    try:
        title, body = alert_text(kind, oid, status, ptype, ref)
        key = clean_ref("-".join(x for x in (oid or ref, kind, unique) if x), 120)
        if not key:
            return False
        store = Store()
        with ALERT_LOCK:
            rec = {"sent": False, "title": title, "body": body}
            first = store.put(f"alerts/{key}.json", rec)
            if not first:
                rec = store.get(f"alerts/{key}.json")[0] or rec
                if rec.get("sent"):
                    return False
            if first and webhook:
                alert(title + " | " + body.replace("\n", " | "))
            return deliver_alert(store, key, rec)
    except Exception as e:
        log("alert event failed: " + type(e).__name__)
        return False


def deliver_alert(store, key, rec):
    if not github_alerts_on():
        return False
    try:
        ok = send_github_issue(rec["title"], rec["body"])
    except Exception as e:
        log("alert github failed: " + type(e).__name__)
        ok = False
    if ok:
        store.put(f"alerts/{key}.json", {**rec, "sent": True}, overwrite=True)
    return ok


def retry_pending_alerts(store):
    if not github_alerts_on():
        return
    with ALERT_LOCK:
        for path in store.list_prefix("alerts/"):
            rec = store.get(path)[0]
            if isinstance(rec, dict) and rec.get("sent") is False and rec.get("title"):
                deliver_alert(store, path[len("alerts/"):-len(".json")], rec)


delivery.EVENT = notify_event
delivery.CHANNEL = alerts_configured


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


def now():
    return datetime.datetime.now()      # tests replace this


IDX_LOCK = threading.RLock()


def clean_ref(v, limit=60):
    return re.sub(r"[^A-Za-z0-9_-]", "", str(v or ""))[:limit]


def manual_id(ref, part):
    return "MAN-" + hashlib.sha256(f"{ref}|{part}".encode()).hexdigest()[:12]


def index_purchase(store, ek, ref):
    """payments/<email_key>.json lists every purchase ref of that email (several can coexist)."""
    with IDX_LOCK:
        idx = store.get(f"payments/{ek}.json")[0] or {}
        refs = [r for r in idx.get("refs", []) if isinstance(r, str)]
        if ref not in refs:
            store.put(f"payments/{ek}.json", {"refs": refs + [ref]}, overwrite=True)


def intake_fields(o):
    return {k: o.get(k, "") for k in ("business_name", "city", "niche", "website", "email")}


def manual_task(store, rec, part, intake):
    """The manual-delivery order of one part. Created once (keyed by Polar order id + part)."""
    mid = manual_id(rec["ref"], part)
    m, _ = store.get(f"orders/{mid}.json")
    if m is not None:
        return mid, False
    info = products.MANUAL_PARTS[part]
    paid_dt = datetime.datetime.fromisoformat(rec["paid_at"])
    m = {"order_id": mid, "order_type": part, "product_name": info["name"], "delivery": "manual_delivery",
         "status": "manual_delivery", "status_at": rec["paid_at"], "paid": True, "paid_ref": rec["ref"],
         "paid_at": rec["paid_at"], "parts": list(info["owed"]), "bundle": rec["type"] == "bundle",
         "intake_missing": intake is None, "intake_order": "", "due_at": products.due_date(paid_dt)}
    if intake is not None:
        m.update(intake_fields(intake)); m["intake_order"] = intake["order_id"]
    created = store.put(f"orders/{mid}.json", m)
    return mid, created


def link_manual(store, mid, oid, intake):
    """Intake arrived: fill the business details and re-compute the due date from payment/intake."""
    m, _ = store.get(f"orders/{mid}.json")
    if m is None:
        return None
    m.update(intake_fields(intake))
    m.update({"intake_order": oid, "intake_missing": False,
              "due_at": products.due_date(datetime.datetime.fromisoformat(m["paid_at"]), now())})
    store.put(f"orders/{mid}.json", m, overwrite=True)
    o, _ = store.get(f"orders/{oid}.json")
    if o is not None and mid not in o.get("manual_orders", []):
        o["manual_orders"] = o.get("manual_orders", []) + [mid]
        store.put(f"orders/{oid}.json", o, overwrite=True)
    return m


def manual_summary(store, mids):
    parts = []
    for mid in mids:
        m = store.get(f"orders/{mid}.json")[0] or {}
        parts.append(f"{mid} {m.get('product_name', '')} due {m.get('due_at', '?')}")
    return "; ".join(parts)


def consumer(store, ref):
    return (store.get(f"consumed/{ref}.json")[0] or {}).get("order_id", "")


def consume(store, ref, oid):
    """A payment is used by exactly one order. Create-only: True when `oid` holds the payment, False
    when another order already does."""
    if store.put(f"consumed/{ref}.json", {"order_id": oid}):
        return True
    return consumer(store, ref) == oid


def pay_order(store, oid, ref):
    """Mark an order paid by this payment. An order already paid by another payment is never touched."""
    o, _ = store.get(f"orders/{oid}.json")
    if o is None:
        return False
    if o.get("paid"):
        return o.get("paid_ref") == ref
    return mark_paid(store, oid, ref)


def pay_report(store, oid, ref, lead, order_type):
    """Report part of base/bundle: mark paid, then the one gated delivery path (delivery.on_paid)."""
    o, _ = store.get(f"orders/{oid}.json")
    if o is None or (o.get("paid") and o.get("paid_ref") != ref):
        return False
    if order_type == "bundle" and o.get("order_type") != "bundle":
        o["order_type"] = "bundle"
        store.put(f"orders/{oid}.json", o, overwrite=True)
    if not pay_order(store, oid, ref):
        return False
    start_delivery(store, oid, lead)
    return True


def intake_orders(store, ek):
    return [i for i in (store.get(f"index/{ek}.json")[0] or {}).get("order_ids", []) if isinstance(i, str)]


def find_intake(store, rec, meta_oid):
    """Intake order for a payment: metadata order id, then the intake that typed this Polar order id,
    then the email's only eligible intake. -> (order id or "", why not)."""
    ref, report = rec["ref"], rec["type"] in products.AUTORUN_TYPES

    def usable(oid):
        o = store.get(f"orders/{oid}.json")[0] if re.fullmatch(r"[A-Za-z0-9_-]{3,40}", oid or "") else None
        return o is not None and not (report and o.get("paid"))

    if re.fullmatch(r"ORD-\d{6}-[a-f0-9]{6}", meta_oid) and store.get(f"orders/{meta_oid}.json")[0] is not None:
        return (meta_oid, "") if usable(meta_oid) else ("", "order already paid")
    typed = (store.get(f"intake_refs/{ref}.json")[0] or {}).get("order_id", "")
    if typed:
        return (typed, "") if usable(typed) else ("", "order already paid")
    if rec.get("email_key"):
        cands = [o for o in intake_orders(store, rec["email_key"]) if usable(o)]
        if len(cands) == 1:
            return cands[0], ""
        if len(cands) > 1:
            return "", "several intakes share this email"
    return "", ""


def process_paid(store, d, eid):
    with IDX_LOCK:
        return _process_paid(store, d, eid)


def _process_paid(store, d, eid):
    ref = clean_ref(d.get("id")) or ("evt-" + eid)
    email = str((d.get("customer") or {}).get("email") or d.get("customer_email") or "").strip().lower()
    meta_oid = str((d.get("metadata") or {}).get("order_id", "")).strip()
    ids = products.product_ids(d)
    info = products.PRODUCTS.get(ids[0]) if len(ids) == 1 else None
    rec, _ = store.get(f"purchases/{ref}.json")
    if rec and rec.get("done"):
        return {"status": "duplicate"}
    if rec is None:         # record the purchase first; the write is create-only (keyed by Polar order id)
        status, why = ("ok", "") if info else ("unknown", "")
        if info:
            ok, why = products.check_payment(d, info)
            status = "ok" if ok else "held"
        rec = {"ref": ref, "product_id": clean_ref(",".join(ids)) if len(ids) != 1 else clean_ref(ids[0]),
               "type": info["type"] if info else "unknown", "status": status, "reason": why,
               "email_key": email_key(email) if email and status == "ok" else "",
               "paid_at": now().isoformat(timespec="seconds"), "order_id": "", "manual_orders": [], "done": False}
        store.put(f"purchases/{ref}.json", rec)
        rec, _ = store.get(f"purchases/{ref}.json")
    if not info:
        alert(f"UNKNOWN Polar product {rec['product_id'] or '(none)'} on Polar order {ref}: nothing was run and no order "
              "was marked paid. Check it by hand.")
        notify_event("unknown_product", ref=ref, ptype="unknown")
        rec["done"] = True
        store.put(f"purchases/{ref}.json", rec, overwrite=True)
        return {"status": "unknown_product"}
    if rec.get("status", "ok") == "held":
        alert(f"Polar order {ref}: payment needs manual review ({rec.get('reason', '')}). Product type {rec['type']}; "
              "nothing was run, no order was marked paid and no task was created.")
        notify_event("held", ref=ref, ptype=rec["type"])
        rec["done"] = True
        store.put(f"purchases/{ref}.json", rec, overwrite=True)
        return {"status": "held"}
    if rec["email_key"]:
        index_purchase(store, rec["email_key"], ref)
    why = ""
    oid = consumer(store, ref)          # a resumed payment keeps its order
    if not oid:
        oid, why = find_intake(store, rec, meta_oid)
        if oid and not consume(store, ref, oid):
            oid, why = "", "payment already used by another order"
    intake = store.get(f"orders/{oid}.json")[0] if oid else None
    rec["order_id"] = oid if intake else ""
    mids = []
    for part in info["manual"]:     # manual parts first: a failed report run must not hide them
        mid, _ = manual_task(store, rec, part, intake)
        mids.append(mid)
    rec["manual_orders"] = mids
    if intake is not None and mids:
        intake["manual_orders"] = sorted(set(intake.get("manual_orders", [])) | set(mids))
        store.put(f"orders/{oid}.json", intake, overwrite=True)
    text = ""
    if mids and not rec.get("manual_alerted"):
        text = (f"{info['name']} paid (Polar {ref}): MANUAL delivery, by hand, nothing automatic. "
                + manual_summary(store, mids) + ("" if intake else "; intake missing, due dates re-computed when it arrives"))
        rec["manual_alerted"] = True
    if info["autorun"]:
        paid = False
        if intake is not None:
            lead = (text + "; " if text else "") + f"Order {oid} PAID (Polar {ref})"
            paid = pay_report(store, oid, ref, lead, info["type"])
            text = ""
        if not paid:
            alert((text + "; " if text else "") + f"UNMATCHED Polar payment {ref}: the report waits for the intake form"
                  + (f" ({why})" if why else "") + ". Match it by hand if no intake arrives.")
            notify_event("unmatched", ref=ref, ptype=info["type"])
            text = ""
        res = {"status": "paid", "order_id": oid} if paid else {"status": "unmatched"}
    else:
        res = {"status": "manual_delivery", "order_type": info["type"]}
    if text:
        alert(text)
    rec["done"] = True
    store.put(f"purchases/{ref}.json", rec, overwrite=True)
    return res


EVENT_CLAIM_TTL = 900


def claim_event(store, eid, etype, data=None):
    """Create-only claim of a webhook event before any work. A failed (or long-stuck) claim can be taken again.
    The payload is kept (private store) so a lost or failed background run can be retried without Polar."""
    claim = {"status": "claimed", "type": etype, "claimed_at": int(time.time()), "tries": 1,
             **({"data": data} if data else {})}
    if store.put(f"events/{eid}.json", claim):
        return True
    with IDX_LOCK:
        cur = store.get(f"events/{eid}.json")[0] or {}
        stale = cur.get("status") == "claimed" and time.time() - cur.get("claimed_at", 0) > EVENT_CLAIM_TTL
        if cur.get("status") == "failed" or stale:
            claim["tries"] = int(cur.get("tries", 1)) + 1
            if not data and cur.get("data"):
                claim["data"] = cur["data"]
            store.put(f"events/{eid}.json", claim, overwrite=True)
            return True
    return False


MAX_EVENT_TRIES = 3
_EQ = queue.Queue()
_ewlock = threading.Lock()
_eworker = None


def run_event(store, d, eid, etype, reraise=False):
    """Order matching, status changes and delivery start for one claimed event. A failure marks the event
    `failed` (payload kept) and alerts, so a retry or a human can pick it up."""
    try:
        res = process_paid(store, d, eid) if etype == "order.paid" else {"status": "ignored"}
    except BaseException as e:
        log("event failed: " + type(e).__name__)
        try:
            cur = store.get(f"events/{eid}.json")[0] or {}
            store.put(f"events/{eid}.json", {"status": "failed", "type": etype, "tries": cur.get("tries", 1),
                                             **({"data": d} if d else {})}, overwrite=True)
        except Exception:
            pass
        try:
            ids = products.product_ids(d) if isinstance(d, dict) else []
            info = products.PRODUCTS.get(ids[0]) if len(ids) == 1 else None
            alert(f"Webhook event {clean_ref(eid, 80)} failed in the background; it is kept for a retry.")
            notify_event("webhook_failed", ref=eid, ptype=info["type"] if info else "unknown")
        except BaseException:
            pass
        if reraise:
            raise
        return None
    store.put(f"events/{eid}.json", {"status": "done", "type": etype}, overwrite=True)
    return res


def _event_loop():
    while True:
        store, d, eid, etype = _EQ.get()
        try:
            run_event(store, d, eid, etype)
        except BaseException as e:
            log("event worker error: " + type(e).__name__)
        finally:
            _EQ.task_done()


def retry_events(store):
    """Events whose background run failed, or was lost with a restart (claimed and stale): run them again, at
    most MAX_EVENT_TRIES times in total."""
    for path in store.list_prefix("events/"):
        rec = store.get(path)[0]
        if not isinstance(rec, dict) or not rec.get("data") or int(rec.get("tries", 1)) >= MAX_EVENT_TRIES:
            continue
        if rec.get("status") not in ("failed", "claimed"):
            continue
        eid = path[len("events/"):-len(".json")]
        if claim_event(store, eid, rec.get("type", "")):
            run_event(store, rec["data"], eid, rec.get("type", ""))


def handle_polar(headers, body):
    """-> (http status, json). Verifies, claims the webhook id, answers 200 at once and does the work in the
    background worker (inline when delivery.SYNC, for tests)."""
    global _eworker
    if not verify_polar(os.environ.get("POLAR_WEBHOOK_SECRET", ""), headers, body):
        return 401, {"error": "bad signature"}
    store, eid = Store(), clean_ref(headers.get("webhook-id", ""), 80)
    if not eid:
        return 400, {"error": "missing id"}
    ev = json.loads(body or b"{}")
    d = ev.get("data") or {}
    etype = str(ev.get("type", ""))
    if not claim_event(store, eid, etype, d if etype == "order.paid" else None):
        return 200, {"status": "duplicate"}
    if delivery.SYNC:
        return 200, run_event(store, d, eid, etype, reraise=True)
    _EQ.put((store, d, eid, etype))
    with _ewlock:
        if _eworker is None or not _eworker.is_alive():
            _eworker = threading.Thread(target=_event_loop, daemon=True)
            _eworker.start()
    return 200, {"status": "accepted"}


def new_order(d, req):
    store = Store()
    oid = "ORD-" + now().strftime("%y%m%d") + "-" + uuid.uuid4().hex[:6]
    token = delivery.new_token()
    typed = clean_ref(d.get("paid_ref", ""))
    intake = {"order_id": oid, "business_name": req["business"], "city": req["city"],
              "niche": req["niche"], "email": req["email"], "website": req["website"],
              "token": token, "plan": "check", "order_type": "base", "paid_ref": str(d.get("paid_ref", ""))[:60],
              "paid": False, "created_at": now().isoformat(timespec="seconds"),
              "competitors": [c.strip()[:120] for c in str(d.get("competitors", "")).split(",") if c.strip()][:5]}
    store.put(f"orders/{oid}.json", intake)
    delivery.register_token(store, oid, token)
    manual, run, note = [], False, ""
    with IDX_LOCK:
        if typed:
            store.put(f"intake_refs/{typed}.json", {"order_id": oid})
        recs = []
        if req["email"]:
            ek = email_key(req["email"])
            store.put(f"index/{ek}.json", {"order_id": oid, "order_ids": intake_orders(store, ek) + [oid]}, overwrite=True)
            for ref in (store.get(f"payments/{ek}.json")[0] or {}).get("refs", []):
                r, _ = store.get(f"purchases/{clean_ref(ref)}.json")
                if r and r.get("status", "ok") == "ok" and r.get("type") in products.TYPES:
                    recs.append(r)
        email_refs = {r["ref"] for r in recs}
        typed_rec = None
        if typed:
            typed_rec = next((r for r in recs if r["ref"] == typed), None) or store.get(f"purchases/{typed}.json")[0]
            if typed_rec and not (typed_rec.get("status", "ok") == "ok" and typed_rec.get("type") in products.TYPES):
                typed_rec = None
        free = [r for r in recs if not consumer(store, r["ref"])]
        picked = {}
        if typed_rec and not consumer(store, typed):
            picked[typed] = typed_rec
        report = lambda r: r["type"] in products.AUTORUN_TYPES
        if not any(report(r) for r in picked.values()):
            free_reports = [r for r in free if report(r)]
            if len(free_reports) == 1:
                picked[free_reports[0]["ref"]] = free_reports[0]
            elif len(free_reports) > 1:
                note = "several unused payments share this email and none matches a typed payment reference"
            elif any(report(r) for r in recs):
                note = "the payment for this email was already used by another order"
        for r in free:                  # add-on purchases only hand over the business details
            if not report(r):
                picked[r["ref"]] = r
        for ref, r in picked.items():
            if not consume(store, ref, oid):
                continue
            r["order_id"] = oid
            for mid in r.get("manual_orders", []):
                if link_manual(store, mid, oid, intake):
                    manual.append(mid)
            if report(r):
                o, _ = store.get(f"orders/{oid}.json")
                if r["type"] == "bundle":
                    o["order_type"] = "bundle"; store.put(f"orders/{oid}.json", o, overwrite=True)
                if pay_order(store, oid, r["ref"]):
                    run = True
            store.put(f"purchases/{r['ref']}.json", r, overwrite=True)
    if run:
        start_delivery(store, oid)
    alert(f"New order {oid}" + (f": awaiting payment, {note}. Match it by hand." if note else ""))
    cur = store.get(f"orders/{oid}.json")[0] or {}
    notify_event("new", oid=oid, status=cur.get("status") or ("queued" if cur.get("paid") else "awaiting payment"),
                 ptype=cur.get("order_type", "base"))
    if manual:
        alert("Intake received for manual delivery: " + manual_summary(store, manual))
    return oid, token


def slug(niche, city):
    return f"{niche}__{city.lower().replace(',', '').replace(' ', '-')}"


def save_lead(obj):
    """A saved request goes to the private orders store (one file per request)."""
    return Store().put(f"leads/{now().strftime('%y%m%d-%H%M%S')}-{uuid.uuid4().hex[:8]}.json", obj)


def free_report_path(fid):
    return f"free/{fid}/report.html"


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
    tmp = tempfile.mkdtemp(prefix="free-")
    try:
        o = Order(order_id="FREE-" + job_id[:8], business_name=req["business"], city=req["city"],
                  niche=req["niche"], plan="free")
        res, log = run_order(o, mode="free", out_dir=tmp,
                             render=lambda r: render(r, sample=True, run_note="Free quick check: one AI model "
                                                     "answering from memory, no web search, 8 questions."))
        with open(os.path.join(tmp, o.order_id, "report.html"), encoding="utf-8") as fh:
            Store().put_text(free_report_path(o.order_id), fh.read())
        finish_job(job_id, {"status": "done", "named_in": sum(p.target_hits for p in res.score.providers),
                            "answers": res.score.total_answers, "report": f"/free/{o.order_id}"})
    except Exception as e:  # never leak internals to the browser
        finish_job(job_id, {"status": "failed"})
        print("free job failed:", type(e).__name__, file=sys.stderr)
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def health():
    """Booleans and fixed words only: never a value, key or id."""
    try:
        autorun = delivery.autorun_state()
    except Exception:
        autorun = "blocked"
    return {"ok": True, "autorun": autorun, "allow_paid": os.environ.get("AIVIS_ALLOW_PAID") == "1",
            "alerts": alerts_configured(), "orders_store": "remote" if Store().remote else "local"}


def maintenance_tick():
    """Resume lost runs, retry failed events and alerts, sweep stuck orders. One step failing never stops the rest."""
    store = Store()
    for step in (lambda: retry_events(store), lambda: delivery.resume_orders(store, alert),
                 lambda: delivery.sweep_orders(store, notify_event), lambda: retry_pending_alerts(store)):
        try:
            step()
        except Exception as e:
            log("maintenance step failed: " + type(e).__name__)


MAINTENANCE_SECONDS = 600


def start_maintenance():
    def loop():
        while True:
            maintenance_tick()
            time.sleep(MAINTENANCE_SECONDS)
    threading.Thread(target=loop, daemon=True).start()


class H(http.server.BaseHTTPRequestHandler):
    def _json(self, code, obj):
        b = json.dumps(obj).encode()
        self.send_response(code); self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(b))); self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(b)

    def end_headers(self):      # every response, whatever route or error produced it
        for k, v in (("Strict-Transport-Security", "max-age=31536000"), ("X-Content-Type-Options", "nosniff"),
                     ("X-Frame-Options", "DENY")):
            self.send_header(k, v)
        super().end_headers()

    def _send(self, code, ctype, body, private=False, robots="noindex, nofollow"):
        self.send_response(code); self.send_header("Content-Type", ctype)
        if private:
            for k, v in (("X-Robots-Tag", robots), ("Cache-Control", "no-store"),
                         ("Referrer-Policy", "no-referrer")):
                self.send_header(k, v)
        self.send_header("Content-Length", str(len(body))); self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def _body(self, limit=MAX_BODY):
        raw = self.headers.get("Content-Length")
        if raw is None or not re.fullmatch(r"[0-9]{1,9}", raw.strip()):
            raise ValueError(BAD_FORM_MSG)     # missing, negative or non-numeric
        n = int(raw)
        if n > limit:
            raise ValueError("Request too large.")
        return self.rfile.read(n)

    def _form(self):
        """The request body as a JSON object; anything else is a plain 400 that never quotes the parser."""
        raw = self._body()
        try:
            d = json.loads(raw.decode("utf-8"))
        except ValueError:
            raise ValueError(BAD_FORM_MSG) from None
        if not isinstance(d, dict):
            raise ValueError(BAD_FORM_MSG)
        return d

    def log_message(self, fmt, *args):   # request lines can carry data; log nothing
        pass

    def do_HEAD(self):
        self.do_GET()

    def do_GET(self):
        path = urllib.parse.urlsplit(self.path).path
        if path in ("/health", "/healthz"):
            return self._json(200, health())
        if path == "/robots.txt":
            return self._send(200, "text/plain", b"User-agent: *\nAllow: /\nDisallow: /data/\nDisallow: /api/\nDisallow: /r/\nDisallow: /status/\nDisallow: /free/\n")
        m = re.fullmatch(r"/api/check/([a-f0-9-]{36})", path)
        if m:
            prune_jobs()
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
            try:
                text = Store().get_text(free_report_path(m.group(1)))
            except Exception as e:
                print("error:", type(e).__name__, file=sys.stderr)
                text = None
            if text is None:        # links made before the reports moved to the private store
                p = os.path.join(DATA, "free-checks", m.group(1), "report.html")
                if os.path.isfile(p):
                    with open(p, encoding="utf-8") as fh:
                        text = fh.read()
            if text is None:
                return self._json(404, {"error": "not found"})
            return self._send(200, "text/html; charset=utf-8", text.encode(), private=True, robots="noindex")
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
                req = clean(self._form())
                ip = client_ip(self.headers, self.client_address[0])
                r = instant(req)
                if not admit_check(ip, FREE_RUN and not r):
                    return self._json(429, {"error": BUSY_MSG})
                rec = {**req, "at": datetime.datetime.now().isoformat(timespec="seconds"), "ip": ip}
                if r:
                    try:
                        save_lead({**rec, "result": "instant"})
                    except Exception as e:
                        log("lead save failed: " + type(e).__name__)
                    return self._json(200, r)
                if FREE_RUN:
                    job = str(uuid.uuid4())
                    with LOCK:
                        JOBS[job] = {"status": "running"}; JOB_META[job] = {"ip": ip, "started": clock()}
                    threading.Thread(target=free_job, args=(job, req), daemon=True).start()
                    try:
                        save_lead({**rec, "result": "free-run", "job": job})
                    except Exception as e:
                        log("lead save failed: " + type(e).__name__)
                    return self._json(200, {"status": "queued", "id": job, "prompts": 8, "eta_min": 1,
                                            "niche_label": get_niche(req["niche"]).plural})
                save_lead({**rec, "result": "saved"})
                return self._json(200, {"status": "saved"})
            if self.path == "/api/intake":
                d = self._form()
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
    start_maintenance()
    http.server.ThreadingHTTPServer((a.host, a.port), H).serve_forever()
