"""Automatic report delivery: paid order -> background job -> private report link.

Order status: queued -> running -> ready | failed (one retry at most). The job runs only with
AIVIS_AUTORUN=1; the per-order cap defaults to 12.00 (config) and AIVIS_ORDER_CAP_USD overrides it. Storage, alerts and
logging are passed in by server.py. Nothing here emails anyone; alerts carry order id, status and
cost only (never email, keys or report content).
"""
import datetime, hashlib, hmac, html as _html, os, queue, re, secrets, sys, threading

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "engine"))

TOKEN_RE = re.compile(r"[A-Za-z0-9_-]{22,100}")
import products                   # noqa: E402

MAX_ATTEMPTS = 2
SYNC = False                      # tests set True to run jobs inline
_Q = queue.Queue()
_worker = None
_wlock = threading.Lock()


def log(msg):
    print(msg, file=sys.stderr)


def new_token():
    return secrets.token_urlsafe(32)          # 256 bits


def _tkey(token):
    return hashlib.sha256(token.encode()).hexdigest()


def register_token(store, oid, token):
    store.put(f"tokens/{_tkey(token)}.json", {"order_id": oid})


def order_for_token(store, token):
    """-> (order_id, order) or (None, None). Constant-time compare against the stored token."""
    if not isinstance(token, str) or not TOKEN_RE.fullmatch(token):
        return None, None
    idx, _ = store.get(f"tokens/{_tkey(token)}.json")
    oid = (idx or {}).get("order_id", "")
    if not re.fullmatch(r"[A-Za-z0-9_-]{3,40}", oid):
        return None, None
    o, _ = store.get(f"orders/{oid}.json")
    if not o or not hmac.compare_digest(str(o.get("token", "")).encode(), token.encode()):
        return None, None
    return oid, o


def report_html(store, token):
    """The ready report for this token, else None."""
    oid, o = order_for_token(store, token)
    if not o or o.get("status") != "ready":
        return None
    return store.get_text(f"reports/{oid}/report.html")


def set_status(store, oid, status, alert, note="", **extra):
    o, _ = store.get(f"orders/{oid}.json")
    if o is None:
        return None
    o.update({"status": status, "status_at": datetime.datetime.now().isoformat(timespec="seconds"), **extra})
    store.put(f"orders/{oid}.json", o, overwrite=True)
    msg = f"Order {oid}: {status}" + (f" ({note})" if note else "") + f", spent ${float(o.get('spent_usd', 0)):.2f}"
    log("order status: " + msg)
    alert(msg)
    return o


def on_paid(store, oid, alert, lead=""):
    """Called when a webhook (or a late intake) marks an order paid. Idempotent.
    `lead` is the 'paid' alert text; it is sent as one alert together with the first status."""
    o, _ = store.get(f"orders/{oid}.json")
    if o is None or o.get("status"):
        if lead:
            alert(lead)
        return
    if o.get("order_type", "base") not in products.AUTORUN_TYPES:     # manual products never run an engine
        if lead:
            alert(lead)
        return
    send = (lambda m: alert(lead + "; " + m)) if lead else alert
    if os.environ.get("AIVIS_AUTORUN") != "1":
        set_status(store, oid, "queued", send, "AIVIS_AUTORUN is off; build the report by hand")
        return
    set_status(store, oid, "queued", send)
    if SYNC:
        run_job(store, oid, alert)
        return
    global _worker
    _Q.put((store, oid, alert))
    with _wlock:
        if _worker is None or not _worker.is_alive():
            _worker = threading.Thread(target=_loop, daemon=True)
            _worker.start()


def _loop():
    while True:
        store, oid, alert = _Q.get()
        try:
            run_job(store, oid, alert)
        except Exception as e:
            log("job crashed: " + type(e).__name__)


def run_job(store, oid, alert, roster_fn=None, providers_fn=None):
    from aivis.jobs import JobFailed, build_report, order_cap_usd
    spent = 0.0
    for attempt in range(1, MAX_ATTEMPTS + 1):
        o, _ = store.get(f"orders/{oid}.json")
        if o is None or o.get("order_type", "base") not in products.AUTORUN_TYPES:
            return
        if attempt == 1 and not may_run(o):
            return
        set_status(store, oid, "running", alert, f"attempt {attempt}", attempts=attempt, spent_usd=round(spent, 4))
        try:
            cap = order_cap_usd()
            files = build_report(o, cap - spent, roster_fn, providers_fn() if providers_fn else None)
            spent += files.pop("spent_usd")
            for name, text in files.items():           # publish only after the whole run passed
                store.put_text(f"reports/{oid}/{name}", text)
        except JobFailed as e:
            spent += e.spent
            retry = e.retryable and attempt < MAX_ATTEMPTS and spent < cap_or_zero() - 1e-9
            set_status(store, oid, "failed", alert, str(e)[:120] + ("; retrying" if retry else ""),
                       spent_usd=round(spent, 4))
            if retry:
                continue
            return
        except Exception as e:
            set_status(store, oid, "failed", alert, "publish/run error " + type(e).__name__, spent_usd=round(spent, 4))
            return
        set_status(store, oid, "ready", alert, spent_usd=round(spent, 4))
        return


RUNNING_FRESH_SECONDS = 2 * 3600


def may_run(o):
    """No second run: never for a ready order, nor for one still running with a fresh status time."""
    if o.get("status") == "ready":
        return False
    if o.get("status") == "running":
        try:
            age = (datetime.datetime.now() - datetime.datetime.fromisoformat(o["status_at"])).total_seconds()
        except (KeyError, ValueError, TypeError):
            return False
        return age >= RUNNING_FRESH_SECONDS
    return True


def cap_or_zero():
    try:
        from aivis import config
        return float(config.order_cap_usd())
    except (ValueError, TypeError):
        return 0.0


def status_page(store, token):
    """-> (html str) or None for unknown token."""
    oid, o = order_for_token(store, token)
    if not o:
        return None
    st = o.get("status") or ("queued" if o.get("paid") else "awaiting payment")
    manual = [m for m in (store.get(f"orders/{mid}.json")[0] for mid in o.get("manual_orders", [])
                          if re.fullmatch(r"[A-Za-z0-9_-]{3,40}", str(mid))) if m]
    body = ""
    if st == "ready":
        body = f'<h2>Your report is ready</h2><p><a href="/r/{token}">Open your report</a></p>'
    elif st == "failed":
        body = "<h2>Your report is taking longer than expected</h2><p>We are looking into it. This page updates when it is ready.</p>"
    elif st == "awaiting payment":
        if not manual:
            body = "<h2>Waiting for your payment</h2><p>This page updates once the payment is received.</p>"
    else:
        body = "<h2>Your report is being prepared</h2><p>Refresh this page in a few minutes.</p>"
    if manual:      # prepared by a person; there is never a link here until a human publishes the result
        items = "".join(f"<li><b>{_html.escape(m.get('product_name', ''))}</b>: being prepared by hand, due by "
                        f"{_html.escape(m.get('due_at', ''))}</li>" for m in manual)
        body += ("<h2>Prepared by hand</h2><p>These items are done by a person, not automatically. "
                 f"Each is due within {products.MANUAL_DELIVERY_BUSINESS_DAYS} business days of your payment and "
                 f"details.</p><ul>{items}</ul>")
    return ('<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="robots" content="noindex,nofollow">'
            '<meta name="viewport" content="width=device-width,initial-scale=1"><title>Your report</title>'
            '<link rel="stylesheet" href="/assets/style.css"></head><body><section><div class="wrap" style="max-width:720px">'
            f'{body}</div></section></body></html>')
