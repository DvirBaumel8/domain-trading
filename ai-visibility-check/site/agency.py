"""Agency report bundles (CR-133). Everything here sits behind AIVIS_AGENCY=1 (products.agency_on()).

A bundle is created once per Polar order id (create-only) from a normalised paid event (polar_adapter.parse).
A report run takes the next free slot (`bundle_runs/<bundle>/<n>`, create-only like delivery's consume()) and then
goes through the one gated delivery path (delivery.on_paid): AIVIS_AUTORUN, AIVIS_ALLOW_PAID, the per-order cap and
the daily pack cap AIVIS_PACK_DAILY_CAP_USD (the gate below). A permanently failed run voids its slot.

Nothing here sends a message, calls Polar or spends money by itself. Alerts carry ids, counts and amounts only.
"""
import base64, csv, datetime, hashlib, hmac, io, json, os, re, struct, sys, threading, time

import delivery
import products

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "engine"))
from aivis.niches import NICHES, niche_label            # noqa: E402
from aivis.order import city_is_us, normalize_website   # noqa: E402

LOCK = threading.RLock()              # slot work inside this process (the create-only write is the cross-process guard)
SPEND_LOCK = threading.RLock()
ALERT = lambda text: None             # server.py installs its alert()
now = lambda: datetime.datetime.now()      # tests replace this (day rolls, 30-day rule)
mono = time.time                      # tests replace this (rate limits)

MAX_REBRANDS = 5
RERUN_DAYS = 30
MAX_CSV_ROWS = 25
MAX_LOGO_BYTES = 300 * 1024
MAX_LOGO_SIDE = 2000
MAX_CSV_BODY = 32 * 1024
MAX_JSON_BODY = 8 * 1024
MAX_LOGO_BODY = MAX_LOGO_BYTES + 1024
CLAIM_PER_MINUTE = 5                  # the 6th claim attempt from one address inside a minute gets 429
CLAIM_PER_HOUR_EMAIL = 10             # the 11th attempt for one purchase email inside an hour gets 429
BAD_TOKEN_PER_MINUTE = 30
RUN_PER_MINUTE = 20
DEFAULT_DAILY_CAP_USD = 60.0
NICHE_ALIASES = {"roofer": "roofing"}
NO_REPORTS_LEFT = "No reports left in this bundle."
NOT_A_PERSON = "Enter a business, not a person."
STATE_RE = re.compile(r"([^,]{2,40}),\s*([A-Z]{2})")


class AgencyError(ValueError):
    """A refusal with a plain message that is safe to show."""


class NoReportsLeft(AgencyError):
    pass


def clean_ref(v, limit=60):
    return re.sub(r"[^A-Za-z0-9_-]", "", str(v or ""))[:limit]


def email_key(email):
    return hashlib.sha256(str(email).strip().lower().encode()).hexdigest()[:32]


def bundle_id(ref):
    return "BND-" + hashlib.sha256(clean_ref(ref).encode()).hexdigest()[:12]


def _tkey(token):
    return hashlib.sha256(token.encode()).hexdigest()


# ---------------------------------------------------------------- rate limits (memory, per process)
_HITS = {}
_HLOCK = threading.Lock()


def limited(bucket, key, limit, window=60):
    t = mono()
    with _HLOCK:
        ts = [x for x in _HITS.get((bucket, key), []) if t - x < max(window, 60)]    # keep the longest window in use
        _HITS[(bucket, key)] = ts
        return len([x for x in ts if t - x < window]) >= limit


def note(bucket, key):
    with _HLOCK:
        _HITS.setdefault((bucket, key), []).append(mono())


def reset_limits():
    with _HLOCK:
        _HITS.clear()


# ---------------------------------------------------------------- paid event -> bundle (R1, R7, R8)
def handle_paid(store, ev, info, ref, alert, notify):
    """ev: normalised paid event (polar_adapter.parse); info: products.agency_info(...).
    -> {"status": "bundle" | "duplicate" | "held"}. Create-only by the provider's order id."""
    ok = (ev["one_time"] and ev["paid_cents"] is not None and ev["paid_cents"] >= info["price_usd"] * 100
          and bool(ev["email"]))
    if not ok:
        alert(f"Payment {ref} for an agency bundle of {info['reports']} reports needs manual review (not a one-time purchase at list price, "
              "or no purchase email); no bundle was created.")
        notify("held", ref=ref, ptype="agency_bundle")
        return {"status": "held"}
    bid = bundle_id(ref)
    rec = {"bundle_id": bid, "ref": ref, "reports_total": int(info["reports"]), "email_key": email_key(ev["email"]),
           "frozen": False, "token": "", "brand": {"name": "", "accent": "", "contact_line": ""}, "logo": False,
           "created_at": now().isoformat(timespec="seconds")}
    if not store.put(f"bundles/{bid}.json", rec):
        if _own_email(store, bid, rec["email_key"]):
            index_add(store, rec["email_key"], bid)          # a crash between the two writes may have lost it
        return {"status": "duplicate"}
    index_add(store, rec["email_key"], bid)
    alert(f"Agency bundle {bid} created for payment {ref}: {rec['reports_total']} reports.")
    return {"status": "bundle", "bundle_id": bid, "reports": rec["reports_total"]}


def handle_refund(store, ev, ref, alert):
    """order.refunded: unreserved reports are voided (the bundle is frozen); reserved and delivered ones stay."""
    bid = bundle_id(ref)
    with LOCK:
        b = store.get(f"bundles/{bid}.json")[0]
        if b is None:
            return {"status": "ignored"}
        if b.get("frozen"):
            return {"status": "duplicate"}
        used = used_count(store, bid)
        b["frozen"], b["frozen_at"] = True, now().isoformat(timespec="seconds")
        store.put(f"bundles/{bid}.json", b, overwrite=True)
    cents = ev.get("paid_cents")
    alert(f"Agency bundle {bid} refunded (payment {ref}"
          + (f", amount ${cents / 100:.2f}" if isinstance(cents, int) else "")
          + f"): {b['reports_total'] - used} unreserved reports voided, {used} reserved or delivered stay.")
    return {"status": "refunded", "bundle_id": bid}


# ---------------------------------------------------------------- slots (R2)
def _slot_path(bid, n):
    return f"bundle_runs/{bid}/{n}.json"


def slots(store, bid):
    """[(n, record)] in order, voided ones included."""
    out = []
    for path in store.list_prefix(f"bundle_runs/{bid}/"):
        m = re.fullmatch(r"bundle_runs/[A-Za-z0-9_-]+/(\d+)\.json", path)
        rec = store.get(path)[0] if m else None
        if isinstance(rec, dict):
            out.append((int(m.group(1)), rec))
    return sorted(out, key=lambda x: x[0])


def used_count(store, bid):
    return sum(1 for _, r in slots(store, bid) if not r.get("void"))


def counts(store, b):
    used = used_count(store, b["bundle_id"])
    return {"total": b["reports_total"], "used": used,
            "left": 0 if b.get("frozen") else max(0, b["reports_total"] - used), "frozen": bool(b.get("frozen"))}


def _reserve(store, b, oid, client_key):
    """The next free slot number, or None. A fresh slot is a create-only write; a voided one is taken over under LOCK."""
    bid = b["bundle_id"]
    for n in range(1, b["reports_total"] + 1):
        rec = {"n": n, "order_id": oid, "client_key": client_key, "at": now().isoformat(timespec="seconds"), "void": False}
        if store.put(_slot_path(bid, n), rec):
            return n
        cur = store.get(_slot_path(bid, n))[0]
        if cur and cur.get("void"):
            store.put(_slot_path(bid, n), rec, overwrite=True)
            return n
    return None


def void_slot(store, bid, n, why):
    with LOCK:
        cur = store.get(_slot_path(bid, n))[0]
        if cur and not cur.get("void"):
            store.put(_slot_path(bid, n), {**cur, "void": True, "void_reason": why}, overwrite=True)
            return True
    return False


# ---------------------------------------------------------------- bundle lookup, claim, token (R5)
def get_bundle(store, bid):
    return store.get(f"bundles/{bid}.json")[0] if re.fullmatch(r"BND-[a-f0-9]{12}", bid or "") else None


def _index_path(ek):
    return f"bundle_emails/{ek}.json"


def index_add(store, ek, bid):
    """bundle_emails/<email_key>.json lists the bundle ids bought with that email. Create or update under LOCK."""
    with LOCK:
        cur = store.get(_index_path(ek))[0] or {}
        ids = list(cur.get("bundles", []))
        if bid not in ids:
            ids.append(bid)
            store.put(_index_path(ek), {"bundles": ids}, overwrite=True)


def _own_email(store, bid, ek):
    b = get_bundle(store, bid)
    return bool(b) and b.get("email_key") == ek


_BACKFILL = "bundle_emails/_backfilled.json"
_backfilled = False


def backfill_index(store):
    """Bundles created before the index existed: scan bundles/ once, fill the index, leave a marker."""
    global _backfilled
    if _backfilled:
        return
    with LOCK:
        if store.get(_BACKFILL)[0] is None:
            for path in store.list_prefix("bundles/"):
                b = store.get(path)[0] or {}
                if b.get("bundle_id") and b.get("email_key"):
                    index_add(store, b["email_key"], b["bundle_id"])
            store.put(_BACKFILL, {"done": True}, overwrite=True)
        _backfilled = True


def claim(store, email, order_id=""):
    """The purchase email is the key; an order id is optional and only narrows. -> list of portal entries,
    newest first ({"token", "reports", "left"}), empty when nothing matches. Unknown email, wrong email and wrong
    order id look the same and do the same work."""
    ek = email_key(email or "")
    backfill_index(store)
    ids = list((store.get(_index_path(ek))[0] or {}).get("bundles", []))
    given = str(order_id or "").strip()
    want = bundle_id(given) if clean_ref(given) else None
    found = []
    for bid in ids or [""]:                                    # an unknown email still does one lookup and compare
        b = get_bundle(store, bid)
        same = hmac.compare_digest(str((b or {}).get("email_key") or "0" * 32).encode(), ek.encode()) and b is not None
        if same and (not given or (want is not None and bid == want)):
            found.append(b)
    out = []
    with LOCK:
        for b in found:
            b = get_bundle(store, b["bundle_id"])
            if not b.get("token"):
                tok = delivery.new_token()
                store.put(f"agency_tokens/{_tkey(tok)}.json", {"bundle_id": b["bundle_id"]})
                b["token"] = tok
                store.put(f"bundles/{b['bundle_id']}.json", b, overwrite=True)
            c = counts(store, b)
            out.append({"token": b["token"], "reports": c["total"], "left": c["left"], "at": b.get("created_at", "")})
    out.sort(key=lambda e: e["at"], reverse=True)
    return out


def bundle_for_token(store, token):
    if not isinstance(token, str) or not delivery.TOKEN_RE.fullmatch(token):
        return None
    bid = (store.get(f"agency_tokens/{_tkey(token)}.json")[0] or {}).get("bundle_id", "")
    b = get_bundle(store, bid)
    if not b or not hmac.compare_digest(str(b.get("token", "")).encode(), token.encode()):
        return None
    return b


# ---------------------------------------------------------------- input rules
_CTRL = re.compile(r"[\x00-\x1f\x7f<>]")
_TRADE_WORDS = {w for n in NICHES.values() for w in re.findall(r"[a-z]+", f"{n.label} {n.plural} {n.key}".lower())}
_TRADE_WORDS |= {"dental", "dentistry", "clinic", "spa", "plumbing", "roofing", "roofer", "hvac", "heating", "cooling",
                 "law", "legal", "attorney", "attorneys", "lawyers", "group", "services", "service", "care", "center",
                 "centre", "studio", "co", "inc", "llc", "company", "associates", "partners", "practice", "repair",
                 "electric", "electrical", "chiropractic", "veterinary", "vet", "animal", "pet", "realty", "homes",
                 "smiles", "family", "doors", "garage", "medical", "health", "wellness", "orthodontics", "pllc", "pc"}


def clean_text(v, limit):
    return re.sub(r"\s+", " ", _CTRL.sub(" ", str(v or ""))).strip()[:limit]


def looks_like_person(name, website):
    """A bare personal name (two or three capitalised words, no trade word, no website)."""
    if website:
        return False
    words = name.split()
    if not 2 <= len(words) <= 3:
        return False
    if not all(re.fullmatch(r"[A-Z][a-z]+(?:['-][A-Z]?[a-z]+)?\.?", w) for w in words):
        return False
    return not any(w.lower().strip(".") in _TRADE_WORDS for w in words)


def clean_client(d):
    """One client row -> the clean dict, or AgencyError. Nothing is reserved before this passes."""
    if not isinstance(d, dict):
        raise AgencyError("Please send the form again.")
    business = clean_text(d.get("business"), 120)
    if not business:
        raise AgencyError("Enter the business name.")
    niche = str(d.get("niche") or "").strip().lower().replace(" ", "_").replace("-", "_")
    niche = NICHE_ALIASES.get(niche, niche)
    if niche not in NICHES:
        raise AgencyError("Choose a business type from the list.")
    m = STATE_RE.fullmatch(str(d.get("city") or "").strip())
    city = f"{m.group(1).strip()}, {m.group(2)}" if m else ""
    if not m or not city_is_us(city):
        raise AgencyError("US businesses only: write the city like 'Austin, TX'.")
    try:
        website = normalize_website(d.get("website", ""))
    except ValueError as e:
        raise AgencyError(str(e)) from None
    if looks_like_person(business, website):
        raise AgencyError(NOT_A_PERSON)
    comp = d.get("competitors") or []
    if isinstance(comp, str):
        comp = comp.split(",")
    competitors = [c for c in (clean_text(x, 120) for x in comp if isinstance(x, str)) if c][:5]
    return {"business": business, "city": city, "niche": niche, "website": website, "competitors": competitors,
            "prepared_for": clean_text(d.get("prepared_for"), 120), "mode": "unbranded" if d.get("mode") == "unbranded" else "branded"}


def client_key(c):
    return hashlib.sha256(f"{c['business'].lower()}|{c['city'].lower()}".encode()).hexdigest()[:16]


def clean_brand(d):
    """Brand settings -> clean dict, or AgencyError. The accent is never reflected unless it is #rrggbb."""
    if not isinstance(d, dict):
        raise AgencyError("Please send the form again.")
    accent = str(d.get("accent") or "").strip()
    if accent and not re.fullmatch(r"#[0-9a-fA-F]{6}", accent):
        raise AgencyError("The colour must look like #1D4ED8.")
    return {"name": clean_text(d.get("name"), 80), "accent": accent, "contact_line": clean_text(d.get("contact_line"), 120)}


# ---------------------------------------------------------------- logo (R6)
class LogoError(AgencyError):
    pass


PNG_SIG = b"\x89PNG\r\n\x1a\n"


def _png_end(raw):
    """Offset just after the IEND chunk, or None when the chunks do not parse."""
    i = len(PNG_SIG)
    while i + 12 <= len(raw):
        n, kind = struct.unpack(">I4s", raw[i:i + 8])
        i += 12 + n
        if kind == b"IEND":
            return i
    return None


def clean_logo(raw):
    """PNG or JPEG only (magic bytes AND a real decode), at most 300 KB and 2000x2000, no data after the image,
    re-encoded as a fresh PNG. -> PNG bytes. Raises LogoError."""
    msg = "Upload a PNG or JPEG logo, at most 300 KB and 2,000 x 2,000 pixels."
    if not isinstance(raw, (bytes, bytearray)) or not 0 < len(raw) <= MAX_LOGO_BYTES:
        raise LogoError(msg)
    raw = bytes(raw)
    if raw.startswith(PNG_SIG):
        kind = "PNG"
        if _png_end(raw) != len(raw):
            raise LogoError(msg)
    elif raw[:3] == b"\xff\xd8\xff":
        kind = "JPEG"
        if not raw.rstrip(b"\x00").endswith(b"\xff\xd9"):
            raise LogoError(msg)
    else:
        raise LogoError(msg)
    try:
        from PIL import Image
        Image.MAX_IMAGE_PIXELS = MAX_LOGO_SIDE * MAX_LOGO_SIDE
        im = Image.open(io.BytesIO(raw))
        if im.format != kind or im.width > MAX_LOGO_SIDE or im.height > MAX_LOGO_SIDE or im.width < 1 or im.height < 1:
            raise LogoError(msg)
        im.load()                                     # a real decode, not only a header
        im = im.convert("RGBA")
        im.thumbnail((600, 240))
        out = io.BytesIO()
        im.save(out, "PNG", optimize=True)
        return out.getvalue()
    except LogoError:
        raise
    except Exception:
        raise LogoError(msg) from None


def logo_data_uri(store, bid):
    rec = store.get(f"agency_logos/{bid}.json")[0]
    return "data:image/png;base64," + rec["b64"] if rec and re.fullmatch(r"[A-Za-z0-9+/=]+", rec.get("b64", "")) else None


def logo_png(store, bid):
    rec = store.get(f"agency_logos/{bid}.json")[0]
    return base64.b64decode(rec["b64"]) if rec else None


def save_logo(store, b, raw):
    png = clean_logo(raw)
    store.put(f"agency_logos/{b['bundle_id']}.json", {"b64": base64.b64encode(png).decode()}, overwrite=True)
    with LOCK:
        cur = get_bundle(store, b["bundle_id"])
        cur["logo"] = True
        store.put(f"bundles/{cur['bundle_id']}.json", cur, overwrite=True)


def save_brand(store, b, d):
    brand = clean_brand(d)
    with LOCK:
        cur = get_bundle(store, b["bundle_id"])
        cur["brand"] = brand
        if d.get("remove_logo"):
            cur["logo"] = False
        store.put(f"bundles/{cur['bundle_id']}.json", cur, overwrite=True)
    return brand


# ---------------------------------------------------------------- runs (R2, R5)
def _new_oid():
    import secrets
    return "ORD-" + now().strftime("%y%m%d") + "-" + secrets.token_hex(3)


def _brand_snapshot(b, c):
    return {"mode": c["mode"], "name": b["brand"].get("name", ""), "accent": b["brand"].get("accent", ""),
            "contact_line": b["brand"].get("contact_line", ""), "logo": bool(b.get("logo")),
            "prepared_for": c.get("prepared_for", "")}


def open_runs(store, b, clients, confirm_rerun=False):
    """Reserve one slot per client (all or nothing), create the paid order records, and return
    [(oid, token, n)]. delivery.on_paid is called by start_runs() afterwards, outside the lock."""
    if not clients:
        raise AgencyError("Nothing to run.")
    made = []
    with LOCK:
        cur = get_bundle(store, b["bundle_id"])
        c = counts(store, cur)
        if c["left"] < len(clients):
            raise NoReportsLeft(NO_REPORTS_LEFT if c["left"] == 0 else
                                f"Only {c['left']} reports are left in this bundle; this upload has {len(clients)}.")
        cutoff = now() - datetime.timedelta(days=RERUN_DAYS)
        recent = {r.get("client_key") for _, r in slots(store, cur["bundle_id"])
                  if not r.get("void") and _when(r.get("at")) >= cutoff}
        keys = [client_key(x) for x in clients]
        if not confirm_rerun:
            for i, k in enumerate(keys):
                if k in recent or keys.index(k) != i:
                    raise AgencyError(("Row %d: " % (i + 1) if len(clients) > 1 else "") +
                                      "this client already has a report in the last 30 days. "
                                      "Run it again only if you confirm.")
        try:
            for x, k in zip(clients, keys):
                oid = _new_oid()
                n = _reserve(store, cur, oid, k)
                if n is None:
                    raise NoReportsLeft(NO_REPORTS_LEFT)
                made.append((oid, n, x))
        except Exception:
            for _, n, _x in made:
                void_slot(store, cur["bundle_id"], n, "not started")
            raise
        out = []
        for oid, n, x in made:
            token = delivery.new_token()
            rec = {"order_id": oid, "business_name": x["business"], "city": x["city"], "niche": x["niche"],
                   "website": x["website"], "competitors": x["competitors"], "email": "", "token": token,
                   "plan": "check", "order_type": "base", "paid": True, "paid_ref": f"{cur['ref']}-{n}"[:60],
                   "paid_at": now().isoformat(timespec="seconds"), "created_at": now().isoformat(timespec="seconds"),
                   "bundle_id": cur["bundle_id"], "slot": n, "brand": _brand_snapshot(cur, x),
                   "run_date": now().date().isoformat(), "rebrands": 0}
            store.put(f"orders/{oid}.json", rec)
            delivery.register_token(store, oid, token)
            out.append((oid, token, n))
    return out


def start_runs(store, oids):
    for oid in oids:
        try:
            delivery.on_paid(store, oid, ALERT)
        except Exception as e:
            print("agency start failed: " + type(e).__name__, file=sys.stderr)


def submit(store, b, d, confirm_rerun=False):
    """One run from the portal form. Validation first; the slot is reserved only after it passes."""
    c = clean_client(d)
    made = open_runs(store, b, [c], confirm_rerun)
    start_runs(store, [m[0] for m in made])
    return made[0]


def parse_csv(text):
    """CSV text (business, city, niche, website, competitors; header optional) -> rows. Whole upload or nothing."""
    text = str(text or "")
    if len(text.encode("utf-8")) > MAX_CSV_BODY:
        raise AgencyError("The list is too large.")
    rows = [r for r in csv.reader(io.StringIO(text)) if any(x.strip() for x in r)]
    cols = ["business", "city", "niche", "website", "competitors", "prepared_for"]
    if rows and rows[0] and rows[0][0].strip().lower() in ("business", "business name", "name"):
        head = [h.strip().lower().replace(" ", "_") for h in rows[0]]
        cols = [{"name": "business", "business_name": "business"}.get(h, h) for h in head]
        rows = rows[1:]
    if not rows:
        raise AgencyError("The list is empty.")
    if len(rows) > MAX_CSV_ROWS:
        raise AgencyError(f"At most {MAX_CSV_ROWS} rows at a time.")
    return [dict(zip(cols, [x.strip() for x in r])) for r in rows]


def submit_many(store, b, text, confirm_rerun=False, mode="branded"):
    clients = []
    for i, row in enumerate(parse_csv(text), 1):
        try:
            clients.append(clean_client({**row, "mode": mode}))
        except AgencyError as e:
            raise AgencyError(f"Row {i}: {e}") from None
    made = open_runs(store, b, clients, confirm_rerun)
    start_runs(store, [m[0] for m in made])
    return made


def _when(iso):
    try:
        return datetime.datetime.fromisoformat(iso)
    except (TypeError, ValueError):
        return datetime.datetime.min


# ---------------------------------------------------------------- report output and re-brand (R3, R4)
def render_args(store, o):
    """Brand keywords for report_pro.render(); None for an order that is not a bundle run."""
    if not o.get("bundle_id"):
        return None
    from aivis.report_pro import UNBRANDED_NAME
    br = o.get("brand") or {}
    date = o.get("run_date") or now().date().isoformat()
    if br.get("mode") == "unbranded":
        return {"brand": UNBRANDED_NAME, "hide_vendor": True, "date": date}
    return {"brand": br.get("name") or UNBRANDED_NAME, "hide_vendor": True, "date": date,
            "accent": br.get("accent") or None, "contact_line": br.get("contact_line") or None,
            "prepared_for": br.get("prepared_for") or None,
            "logo": logo_data_uri(store, o["bundle_id"]) if br.get("logo") else None}


def stored_result(store, oid):
    from aivis import stored
    text = store.get_text(f"reports/{oid}/result.json")
    return (stored.from_dict(json.loads(text)), json.loads(text)["date"]) if text else (None, None)


def rebrand(store, b, oid, new):
    """Regenerate the report from the stored result: no engine call, no slot. At most 5 per report."""
    from aivis.report_pro import render
    with LOCK:
        o = store.get(f"orders/{oid}.json")[0] if re.fullmatch(r"ORD-\d{6}-[a-f0-9]{6}", str(oid)) else None
        if not o or o.get("bundle_id") != b["bundle_id"] or o.get("status") != "ready":
            raise AgencyError("That report is not ready.")
        if int(o.get("rebrands") or 0) >= MAX_REBRANDS:
            raise AgencyError("This report has been re-branded 5 times already.")
        res, date = stored_result(store, oid)
        if res is None:
            raise AgencyError("That report cannot be re-branded.")
        snap = {**o["brand"], "mode": "unbranded" if new.get("mode") == "unbranded" else "branded"}
        if snap["mode"] == "branded":
            snap.update(clean_brand(new))
            snap["logo"] = bool(b.get("logo")) and not new.get("remove_logo")
            snap["prepared_for"] = clean_text(new.get("prepared_for", snap.get("prepared_for", "")), 120)
        o2 = {**o, "brand": snap}
        html = render(res, **render_args(store, o2))
        store.put_text(f"reports/{oid}/report.html", html)
        o2["rebrands"] = int(o.get("rebrands") or 0) + 1
        store.put(f"orders/{oid}.json", o2, overwrite=True)
        return o2["rebrands"]


def pdf_for_token(store, token):
    """-> PDF bytes of a ready bundle report, or None."""
    oid, o = delivery.order_for_token(store, token)
    if not o or not o.get("bundle_id") or o.get("status") != "ready":
        return None
    res, date = stored_result(store, oid)
    if res is None:
        return None
    from aivis import report_pdf
    from aivis.report_pro import UNBRANDED_NAME
    br = o.get("brand") or {}
    if br.get("mode") == "unbranded":
        return report_pdf.build(res, date, UNBRANDED_NAME)
    png = logo_png(store, o["bundle_id"]) if br.get("logo") else None
    return report_pdf.build(res, date, br.get("name") or UNBRANDED_NAME, png, br.get("accent") or None,
                            br.get("prepared_for") or None, br.get("contact_line") or None)


_SAMPLE = {}


def sample_html(brand_mode, brand, logo_uri):
    """A labelled SAMPLE preview from built-in mock data: no engine call, no slot, not fetchable at /r/<token>."""
    from aivis.order import Order, run_order
    from aivis.report_pro import UNBRANDED_NAME, render
    import tempfile
    if "res" not in _SAMPLE:
        o = Order(order_id="SAMPLE-1", business_name="Sample Dental Spa", city="Austin, TX", niche="dentist", plan="check", paid=True)
        with tempfile.TemporaryDirectory() as tmp:
            _SAMPLE["res"], _ = run_order(o, mode="mock", out_dir=tmp, roster=[
                "Sample Dental Clinic", "Example Smiles", "Sample Family Dental", "Demo Dentistry Group", "Sample Dental Care"])
    kw = {"brand": UNBRANDED_NAME, "hide_vendor": True}
    if brand_mode == "branded":
        kw.update(brand=brand.get("name") or UNBRANDED_NAME, accent=brand.get("accent") or None,
                  contact_line=brand.get("contact_line") or None, logo=logo_uri, prepared_for="Sample Client")
    return render(_SAMPLE["res"], sample=True, anonymize=False, date=now().date().isoformat(),
                  run_note="Sample data for layout only; nothing was run for this preview.", **kw)


# ---------------------------------------------------------------- spend control (R9) and failed runs (R2)
def daily_cap_usd():
    raw = os.environ.get("AIVIS_PACK_DAILY_CAP_USD", "").strip()
    if not raw:
        return DEFAULT_DAILY_CAP_USD
    try:
        v = float(raw)
    except ValueError:
        return 0.0
    return v if v == v and v >= 0 else 0.0


def estimate_usd(o):
    from aivis.order import Order, estimate_cost
    return estimate_cost(Order.from_dict(o))


def _spend_path(day):
    return f"agency_spend/{day}.json"


def gate(store, o):
    """delivery.GATE: '' when the run may start now (its estimated cost is reserved for the day), else a plain note.
    One order reserves once; a retry or a resume of the same order passes."""
    if not o.get("bundle_id"):
        return ""
    day = now().date().isoformat()
    with SPEND_LOCK:
        for d in (day, (now().date() - datetime.timedelta(days=1)).isoformat()):
            if o["order_id"] in (store.get(_spend_path(d))[0] or {}).get("orders", {}):
                return ""
        ent = (store.get(_spend_path(day))[0] or {}).get("orders", {})
        est = estimate_usd(o)
        if sum(ent.values()) + est > daily_cap_usd() + 1e-9:
            return "daily pack cap reached"
        ent[o["order_id"]] = round(est, 4)
        store.put(_spend_path(day), {"orders": ent}, overwrite=True)
    return ""


def settle(store, o):
    """delivery.SETTLE: a bundle run ended. Replace its reservation by the real spend; a run that failed for good
    returns its slot."""
    if not o.get("bundle_id"):
        return
    with SPEND_LOCK:
        for d in (now().date().isoformat(), (now().date() - datetime.timedelta(days=1)).isoformat()):
            led = store.get(_spend_path(d))[0]
            if led and o["order_id"] in led.get("orders", {}):
                led["orders"][o["order_id"]] = round(float(o.get("spent_usd") or 0), 4)
                store.put(_spend_path(d), led, overwrite=True)
                break
    if o.get("status") == "failed" and void_slot(store, o["bundle_id"], int(o.get("slot") or 0), "run failed"):
        ALERT(f"Agency bundle {o['bundle_id']}: report slot {o.get('slot')} returned after a failed run (order {o['order_id']}).")


def heal(store):
    """A slot reserved but whose order record never appeared (a crash in between) is returned after 10 minutes."""
    for path in store.list_prefix("bundles/"):
        b = store.get(path)[0]
        if not isinstance(b, dict) or "bundle_id" not in b:
            continue
        for n, r in slots(store, b["bundle_id"]):
            old = now() - _when(r.get("at")) > datetime.timedelta(minutes=10)
            if not r.get("void") and old and store.get(f"orders/{r.get('order_id')}.json")[0] is None:
                void_slot(store, b["bundle_id"], n, "no order record")


def install(alert):
    globals()["ALERT"] = alert
    delivery.GATE = gate
    delivery.SETTLE = settle
    delivery.RENDER_ARGS = render_args


# ---------------------------------------------------------------- portal data (R5)
def portal_state(store, b):
    reports = []
    for n, r in slots(store, b["bundle_id"]):
        if r.get("void"):
            continue
        o = store.get(f"orders/{r.get('order_id')}.json")[0] or {}
        ready = o.get("status") == "ready"
        reports.append({"n": n, "order_id": o.get("order_id", ""), "business": o.get("business_name", ""),
                        "city": o.get("city", ""), "niche": niche_label(NICHES[o["niche"]].label) if o.get("niche") in NICHES else "",
                        "status": o.get("status") or "queued", "note": o.get("status_note", ""),
                        "mode": (o.get("brand") or {}).get("mode", ""), "ready": ready,
                        "token": o.get("token", "") if ready else "",
                        "rebrands_left": max(0, MAX_REBRANDS - int(o.get("rebrands") or 0))})
    return {**counts(store, b), "brand": b.get("brand", {}), "has_logo": bool(b.get("logo")), "reports": reports}
