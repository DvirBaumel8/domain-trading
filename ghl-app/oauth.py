"""HighLevel Marketplace OAuth v2 install, token refresh and app lifecycle webhooks. Stdlib only.

Routes: GET /oauth/callback?code=, GET /oauth/success, POST /webhooks/ghl.

Store interface used (module `store`, owned by another issue; tests use a fake):
  save_install(location_id, company_id, access_token, refresh_token, expires_at, user_type, scopes)
  get_install(location_id) -> dict with those keys, or None
  save_company_token(company_id, access_token, refresh_token, expires_at)
  get_company_token(company_id) -> dict or None
  update_location(location_id, name, website, city)
  delete_location(location_id): removes the tokens and every stored row of that location
expires_at is epoch seconds. Tokens and secrets are never logged."""
import base64, hashlib, hmac, json, logging, threading, time, urllib.error, urllib.parse, urllib.request

import config
import store

log = logging.getLogger("ghl.oauth")

API = "https://services.leadconnectorhq.com"
API_VERSION = "2021-07-28"
SCOPES = ("locations.readonly",)
REFRESH_MARGIN = 300            # refresh when under 5 minutes remain
SIGNATURE_HEADERS = ("X-WH-Signature", "X-GHL-Signature")
SUCCESS_PATH = "/oauth/success"


def _err(code, message, details=None):
    return {"error": {"code": code, "message": message, "details": details or {}}}


def _now():
    return time.time()


def _http(method, url, form=None, headers=None):
    """One HTTP call -> (status, dict). Tests replace this. Never logs bodies (they hold tokens)."""
    data = urllib.parse.urlencode(form).encode() if form is not None else None
    h = {"Accept": "application/json", "Version": API_VERSION, **(headers or {})}
    if data is not None:
        h["Content-Type"] = "application/x-www-form-urlencoded"
    req = urllib.request.Request(url, data=data, method=method, headers=h)
    try:
        with urllib.request.urlopen(req, timeout=15) as r:
            status, raw = r.status, r.read()
    except urllib.error.HTTPError as e:
        status, raw = e.code, e.read()
    try:
        return status, json.loads(raw or b"{}")
    except ValueError:
        return status, {}


class OAuthError(Exception):
    pass


def _token_call(form):
    cfg = config.get()
    body = {"client_id": cfg["GHL_CLIENT_ID"], "client_secret": cfg["GHL_CLIENT_SECRET"], **form}
    status, data = _http("POST", API + "/oauth/token", form=body)
    if status != 200 or not data.get("access_token") or not data.get("refresh_token"):
        raise OAuthError(f"token endpoint returned {status}")
    return data


def _expires_at(data):
    return int(_now() + int(data.get("expires_in") or 0))


def _save_location(data, location_id, company_id, user_type="Location"):
    store.save_install(location_id=location_id, company_id=company_id or data.get("companyId"),
                       access_token=data["access_token"], refresh_token=data["refresh_token"],
                       expires_at=_expires_at(data), user_type=user_type,
                       scopes=data.get("scope") or " ".join(SCOPES))


def _app_id():
    return config.get()["GHL_CLIENT_ID"].split("-")[0]


def _location_token_from_company(company_token, company_id, location_id):
    status, data = _http("POST", API + "/oauth/locationToken",
                         form={"companyId": company_id, "locationId": location_id},
                         headers={"Authorization": "Bearer " + company_token})
    if status not in (200, 201) or not data.get("access_token") or not data.get("refresh_token"):
        raise OAuthError(f"locationToken returned {status}")
    _save_location(data, location_id, company_id)
    log.info("saved install for location %s", location_id)


def _installed_locations(company_token, company_id):
    status, data = _http("GET", API + "/oauth/installedLocations?" + urllib.parse.urlencode(
        {"companyId": company_id, "appId": _app_id(), "isInstalled": "true", "limit": 100}),
        headers={"Authorization": "Bearer " + company_token})
    if status != 200:
        raise OAuthError(f"installedLocations returned {status}")
    return [loc["_id"] for loc in data.get("locations", []) if loc.get("_id")]


def _fresh_company_token(company_id):
    rec = store.get_company_token(company_id)
    if not rec:
        return None
    if rec["expires_at"] - _now() >= REFRESH_MARGIN:
        return rec["access_token"]
    data = _token_call({"grant_type": "refresh_token", "refresh_token": rec["refresh_token"], "user_type": "Company"})
    store.save_company_token(company_id, data["access_token"], data["refresh_token"], _expires_at(data))
    return data["access_token"]


_locks = {}
_locks_guard = threading.Lock()


def _lock_for(key):
    with _locks_guard:
        return _locks.setdefault(key, threading.Lock())


def get_location_token(location_id):
    """Access token for a location; refreshes (and stores the rotated refresh token) when <5 min remain."""
    with _lock_for(location_id):
        rec = store.get_install(location_id)
        if not rec:
            raise OAuthError("location not installed")
        if rec["expires_at"] - _now() >= REFRESH_MARGIN:
            return rec["access_token"]
        data = _token_call({"grant_type": "refresh_token", "refresh_token": rec["refresh_token"],
                            "user_type": "Location"})
        _save_location(data, location_id, rec.get("company_id"))
        log.info("refreshed token for location %s", location_id)
        return data["access_token"]


# ---- routes ----

def handle_callback(req):
    code = (req.query.get("code") or [""])[0]
    if not code:
        return 400, _err("missing_code", "code is required")
    if config.status("oauth") != config.CONFIGURED:
        return 503, _err("not_configured", "oauth is not configured")
    try:
        data = _token_call({"grant_type": "authorization_code", "code": code})
        user_type = data.get("userType") or data.get("user_type")
        company_id = data.get("companyId")
        if user_type == "Company":
            store.save_company_token(company_id, data["access_token"], data["refresh_token"], _expires_at(data))
            ids = _installed_locations(data["access_token"], company_id)
            for loc in ids:
                _location_token_from_company(data["access_token"], company_id, loc)
            count = len(ids)
        elif user_type == "Location" and data.get("locationId"):
            _save_location(data, data["locationId"], company_id)
            log.info("saved install for location %s", data["locationId"])
            count = 1
        else:
            return 400, _err("bad_user_type", "unsupported user type")
    except OAuthError as e:
        log.warning("install failed: %s", e)
        return 502, _err("oauth_failed", "HighLevel rejected the install")
    return 302, {"location": SUCCESS_PATH, "installed": count}


def handle_success(req):
    return 200, {"ok": True, "message": "Installed. You can close this window."}


# ---- webhooks ----

def _der(buf, pos):
    tag = buf[pos]
    n = buf[pos + 1]
    pos += 2
    if n & 0x80:
        k = n & 0x7F
        n = int.from_bytes(buf[pos:pos + k], "big")
        pos += k
    return tag, buf[pos:pos + n], pos + n


def _seq_items(content):
    items, pos = [], 0
    while pos < len(content):
        tag, body, pos = _der(content, pos)
        items.append((tag, body))
    return items


def _parse_public_key(pem):
    pem = pem.replace("\\n", "\n")
    b64 = "".join(l for l in pem.splitlines() if l and not l.startswith("-----"))
    _, top, _ = _der(base64.b64decode(b64), 0)
    items = _seq_items(top)
    if items[0][0] == 0x30:                      # SubjectPublicKeyInfo: algorithm, BIT STRING
        _, inner, _ = _der(items[1][1][1:], 0)   # skip unused-bits byte
        items = _seq_items(inner)
    return int.from_bytes(items[0][1], "big"), int.from_bytes(items[1][1], "big")


_SHA256_PREFIX = bytes.fromhex("3031300d060960864801650304020105000420")


def verify_signature(body, signature_b64, public_key_pem):
    """RSA PKCS#1 v1.5 + SHA-256 over the raw body (HighLevel's X-WH-Signature)."""
    try:
        n, e = _parse_public_key(public_key_pem)
        sig = base64.b64decode(signature_b64, validate=True)
        k = (n.bit_length() + 7) // 8
        if len(sig) != k:
            return False
        em = pow(int.from_bytes(sig, "big"), e, n).to_bytes(k, "big")
        t = _SHA256_PREFIX + hashlib.sha256(body).digest()
        expected = b"\x00\x01" + b"\xff" * (k - len(t) - 3) + b"\x00" + t
        return hmac.compare_digest(em, expected)
    except Exception:
        return False


def _header(headers, name):
    try:
        return headers.get(name) or ""
    except AttributeError:
        return ""


_seen = {}
_seen_guard = threading.Lock()
MAX_SEEN = 5000


def _claim(webhook_id):
    """True if this webhookId is new (and now claimed). In-memory; handlers are idempotent across restarts."""
    with _seen_guard:
        if webhook_id in _seen:
            return False
        if len(_seen) >= MAX_SEEN:
            _seen.pop(next(iter(_seen)))
        _seen[webhook_id] = True
        return True


def _unclaim(webhook_id):
    with _seen_guard:
        _seen.pop(webhook_id, None)


def _refresh_location_info(location_id, payload):
    name, website, city = payload.get("name"), payload.get("website"), payload.get("city")
    if name is None and website is None and city is None:
        token = get_location_token(location_id)
        status, data = _http("GET", f"{API}/locations/{urllib.parse.quote(location_id, safe='')}",
                             headers={"Authorization": "Bearer " + token})
        if status != 200:
            raise OAuthError(f"locations returned {status}")
        loc = data.get("location") or data
        name, website, city = loc.get("name"), loc.get("website"), loc.get("city")
    store.update_location(location_id, name, website, city)


def _on_install(payload):
    location_id, company_id = payload.get("locationId"), payload.get("companyId")
    if not location_id or store.get_install(location_id):
        return
    token = _fresh_company_token(company_id) if company_id else None
    if not token:
        log.warning("install webhook for %s: no company token on file", location_id)
        return
    _location_token_from_company(token, company_id, location_id)


def handle_webhook(req):
    sig = next((s for s in (_header(req.headers, h) for h in SIGNATURE_HEADERS) if s), "")
    key = config.get()["GHL_WEBHOOK_PUBLIC_KEY"]
    if not sig or not key or not verify_signature(req.body, sig, key):
        return 401, _err("bad_signature", "invalid webhook signature")
    try:
        payload = json.loads(req.body or b"{}")
        if not isinstance(payload, dict):
            raise ValueError
    except ValueError:
        return 400, _err("bad_json", "body must be a JSON object")
    wid, kind = payload.get("webhookId"), payload.get("type")
    if wid and not _claim(wid):
        return 200, {"ok": True, "duplicate": True}
    try:
        location_id = payload.get("locationId") or payload.get("id")
        if kind == "INSTALL":
            _on_install(payload)
        elif kind == "UNINSTALL" and location_id:
            store.delete_location(location_id)
            log.info("uninstalled location %s", location_id)
        elif kind == "LocationUpdate" and location_id:
            _refresh_location_info(location_id, payload)
        else:
            return 200, {"ok": True, "ignored": True}
    except Exception as e:
        if wid:
            _unclaim(wid)                       # let HighLevel retry
        log.warning("webhook %s failed: %s", kind, type(e).__name__)
        return 500, _err("webhook_failed", "could not process webhook")
    return 200, {"ok": True}


def register(routes):
    """routes maps (METHOD, path) -> handler(req) -> (status, json-able dict)."""
    routes[("GET", "/oauth/callback")] = handle_callback
    routes[("GET", SUCCESS_PATH)] = handle_success
    routes[("POST", "/webhooks/ghl")] = handle_webhook
