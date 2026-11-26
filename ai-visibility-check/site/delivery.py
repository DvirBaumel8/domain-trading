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
from site_config import SUPPORT_EMAIL   # noqa: E402

MAX_ATTEMPTS = 2
SYNC = False                      # tests set True to run jobs inline
_Q = queue.Queue()
_worker = None
_wlock = threading.Lock()
_PENDING = set()                  # order ids queued or running in this process
EVENT = lambda **kw: None         # server.py installs the structured-alert function
CHANNEL = lambda: False           # server.py installs: is any alert channel configured
RESUME_STALE_SECONDS = 20 * 60    # a running order older than this is taken as lost
STUCK_SECONDS = 2 * 3600
ALERT_REPEAT_SECONDS = 6 * 3600
GATE = lambda store, o: ""        # agency.py installs: a plain note when a run must wait (daily cap), else ""
SETTLE = lambda store, o: None    # agency.py installs: a run ended (ready, or failed for good)
RENDER_ARGS = lambda store, o: None   # agency.py installs: brand keywords for a bundle run's report


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
    if status == "failed":
        EVENT(kind="failed", oid=oid, status=status, ptype=o.get("order_type", "base"))
    if status == "ready" or (status == "failed" and not note.endswith("retrying")):
        SETTLE(store, o)
    return o


def autorun_missing():
    """Names (never values) of what an automatic run still needs. Empty = it may start."""
    from aivis import config
    miss = []
    if os.environ.get("AIVIS_ALLOW_PAID") != "1":
        miss.append("AIVIS_ALLOW_PAID")
    miss += [name for name in config.ENV_KEYS.values() if not os.environ.get(name, "").strip()]
    if cap_or_zero() <= 0:
        miss.append("AIVIS_ORDER_CAP_USD")
    if not CHANNEL():
        miss.append("alert channel")
    return miss


def autorun_state():
    if os.environ.get("AIVIS_AUTORUN") != "1":
        return "off"
    return "blocked" if autorun_missing() else "on"


def block_order(store, oid, alert, missing, send=None):
    """Keep the order queued with a plain note. Alerts once: the same note again changes nothing."""
    note = "autorun blocked, missing: " + ", ".join(missing)
    o, _ = store.get(f"orders/{oid}.json")
    if o is not None and o.get("status") == "queued" and o.get("status_note") == note:
        return
    set_status(store, oid, "queued", send or alert, note, status_note=note)
    EVENT(kind="blocked", oid=oid, status="queued", ptype=(o or {}).get("order_type", "base"))


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
    missing = autorun_missing()
    if missing:
        block_order(store, oid, alert, missing, send)
        return
    set_status(store, oid, "queued", send, status_note="")
    enqueue(store, oid, alert)


def enqueue(store, oid, alert):
    """Run the job inline (tests) or hand it to the one background worker."""
    global _worker
    with _wlock:
        if oid in _PENDING:
            return False
        _PENDING.add(oid)
    if SYNC:
        try:
            run_job(store, oid, alert)
        finally:
            _PENDING.discard(oid)
        return True
    _Q.put((store, oid, alert))
    with _wlock:
        if _worker is None or not _worker.is_alive():
            _worker = threading.Thread(target=_loop, daemon=True)
            _worker.start()
    return True


def _loop():
    while True:
        store, oid, alert = _Q.get()
        try:
            run_job(store, oid, alert)
        except Exception as e:
            log("job crashed: " + type(e).__name__)
        finally:
            _PENDING.discard(oid)


def run_job(store, oid, alert, roster_fn=None, providers_fn=None):
    """Attempts and spend are kept in the order record: MAX_ATTEMPTS and the cap hold across restarts."""
    from aivis.jobs import JobFailed, build_report, order_cap_usd
    o, _ = store.get(f"orders/{oid}.json")
    if o is None or o.get("order_type", "base") not in products.AUTORUN_TYPES:
        return
    spent = float(o.get("spent_usd") or 0)
    done = int(o.get("attempts") or 0)
    if may_run(o) and not (done >= MAX_ATTEMPTS):
        wait = GATE(store, o)
        if wait:
            note = "waiting: " + wait
            if o.get("status") != "queued" or o.get("status_note") != note:
                set_status(store, oid, "queued", alert, note, status_note=note)
            return
    if may_run(o) and done >= MAX_ATTEMPTS:      # the limit is reached: no provider call
        set_status(store, oid, "failed", alert, "attempt limit reached", spent_usd=round(spent, 4))
        return
    for attempt in range(done + 1, MAX_ATTEMPTS + 1):
        o, _ = store.get(f"orders/{oid}.json")
        if o is None or o.get("order_type", "base") not in products.AUTORUN_TYPES:
            return
        if attempt == done + 1 and not may_run(o):
            return
        set_status(store, oid, "running", alert, f"attempt {attempt}", attempts=attempt, spent_usd=round(spent, 4))
        try:
            cap = order_cap_usd()
            if spent >= cap - 1e-9:
                raise JobFailed("spend cap reached", retryable=False)
            args = RENDER_ARGS(store, o)
            files = build_report({**o, "_render": args} if args else o, cap - spent, roster_fn,
                                 providers_fn() if providers_fn else None)
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




def may_run(o):
    """No second run: never for a ready order, nor for one still running with a fresh status time."""
    if o.get("status") == "ready":
        return False
    if o.get("status") == "running":
        try:
            age = (datetime.datetime.now() - datetime.datetime.fromisoformat(o["status_at"])).total_seconds()
        except (KeyError, ValueError, TypeError):
            return False
        return age >= RESUME_STALE_SECONDS
    return True


def cap_or_zero():
    try:
        from aivis import config
        return float(config.order_cap_usd())
    except (ValueError, TypeError):
        return 0.0


def _age(iso, default=None):
    try:
        return (datetime.datetime.now() - datetime.datetime.fromisoformat(iso)).total_seconds()
    except (TypeError, ValueError):
        return default


def list_orders(store):
    """Every order record (autorun and manual), read one by one."""
    for path in store.list_prefix("orders/"):
        if path.endswith(".json"):
            o, _ = store.get(path)
            if isinstance(o, dict) and o.get("order_id"):
                yield o


def resume_orders(store, alert):
    """Boot and every 10 minutes: re-queue paid orders that are `queued`, or `running` with a stale status.
    Attempts and spend stay in the record, so the limits hold across restarts. Returns the ids acted on."""
    if os.environ.get("AIVIS_AUTORUN") != "1":
        return []
    from aivis.jobs import order_cap_usd
    acted = []
    for o in list_orders(store):
        oid, st = o["order_id"], o.get("status")
        if (o.get("order_type", "base") not in products.AUTORUN_TYPES or o.get("paid") is not True
                or o.get("delivery") == "manual_delivery" or st not in ("queued", "running")):
            continue
        if st == "running" and not may_run(o):
            continue
        if oid in _PENDING:
            continue
        missing = autorun_missing()
        if missing:
            block_order(store, oid, alert, missing)
            acted.append(oid)
            continue
        try:
            over = float(o.get("spent_usd") or 0) >= order_cap_usd() - 1e-9
        except Exception:
            over = True
        if int(o.get("attempts") or 0) >= MAX_ATTEMPTS or over:
            set_status(store, oid, "failed", alert, "attempt or spend limit reached", status_note="")
        elif GATE(store, o):
            continue                  # waits for the daily cap; it stays queued with its note
        else:
            set_status(store, oid, "queued", alert, "resumed", status_note="")
            enqueue(store, oid, alert)
        acted.append(oid)
    return acted


def sweep_orders(store, notify):
    """Every 10 minutes: one alert per order per 6 hours for a paid autorun order that is failed or not
    ready after 2 hours, and for a manual order past its due date. `notify(**event)` sends it."""
    sent = []
    for o in list_orders(store):
        oid, st = o["order_id"], o.get("status") or ("queued" if o.get("paid") else "")
        if o.get("paid") is not True or st in ("ready", "held", "done", "delivered", "completed"):
            continue
        manual = o.get("order_type", "base") not in products.AUTORUN_TYPES
        if manual:
            due = o.get("due_at", "")
            try:
                late = datetime.date.fromisoformat(due[:10]) < datetime.date.today()
            except ValueError:
                late = False
            kind = "overdue"
            if not late:
                continue
        else:
            kind = "stuck"
            if st != "failed" and (_age(o.get("paid_at") or o.get("status_at"), 0) or 0) <= STUCK_SECONDS:
                continue
        last = _age(o.get("last_alert_at"))
        if last is not None and last < ALERT_REPEAT_SECONDS:
            continue
        notify(kind=kind, oid=oid, status=st, ptype=o.get("order_type", "base"),
               unique=str(int(o.get("alert_n") or 0) + 1), webhook=True)
        fresh, _ = store.get(f"orders/{oid}.json")
        if fresh is not None:
            fresh["alert_n"] = int(fresh.get("alert_n") or 0) + 1
            fresh["last_alert_at"] = datetime.datetime.now().isoformat(timespec="seconds")
            store.put(f"orders/{oid}.json", fresh, overwrite=True)
        sent.append(oid)
    return sent


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
        # Refund sentence: wording to be confirmed by the owner (keep it consistent with refunds.html).
        mail = _html.escape(SUPPORT_EMAIL)
        body = ("<h2>Your report is taking longer than expected</h2><p>We are on it. This page updates when it is ready.</p>"
                f'<p>Questions? Email <a href="mailto:{mail}">{mail}</a>.</p>'
                '<p>If we cannot make your report within the time stated in our <a href="/refunds.html">refund policy</a>, '
                "you get a full refund.</p>")
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
