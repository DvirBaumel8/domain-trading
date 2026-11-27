"""The page HighLevel shows in an iframe (Custom Page).

Routes: GET /page (shell, or full page when ?context=<encrypted> is given), POST /page/view (fragment),
POST /page/prompts, POST /page/run, GET /page/static/page.css|page.js.

Identity comes only from HighLevel's encrypted user context, decrypted here with GHL_SHARED_SECRET
(CryptoJS passphrase format: base64("Salted__" + salt + AES-256-CBC), key/iv by MD5 EVP_BytesToKey).
A location_id in the query string is never read.

Handlers return (status, Html). Html is a dict subclass carrying body/content_type/headers, so app.py's
dispatcher must send `payload.body` with `payload.content_type` and `payload.headers` when isinstance
of page.Html (see README note); until then it would be serialised as JSON.
"""
import base64, hashlib, html, json, os, time
from datetime import datetime, timezone
import config

HERE = os.path.dirname(os.path.abspath(__file__))
STATIC = os.path.join(HERE, "static")
ENGINES = (("openai", "OpenAI"), ("anthropic", "Anthropic"), ("perplexity", "Perplexity"))
MAX_PROMPTS, MAX_PROMPT_LEN, RUN_NOW_GAP = 10, 300, 24 * 3600
FRAME_ANCESTORS = ("https://*.gohighlevel.com https://*.leadconnectorhq.com "
                   "https://*.highlevel.com https://*.msgsndr.com")
NOT_IN_HL = "Open this page from inside HighLevel."


def now():
    return time.time()


# ---------------------------------------------------------------- AES-256 (stdlib has none)
def _build():
    sbox, p, q = [0] * 256, 1, 1
    while True:
        p = p ^ ((p << 1) & 0xFF) ^ (0x1B if p & 0x80 else 0)
        q ^= q << 1; q ^= q << 2; q ^= q << 4; q &= 0xFF
        if q & 0x80:
            q ^= 0x09
        x = q ^ (q << 1 | q >> 7) & 0xFF ^ (q << 2 | q >> 6) & 0xFF ^ (q << 3 | q >> 5) & 0xFF ^ (q << 4 | q >> 4) & 0xFF
        sbox[p] = (x ^ 0x63) & 0xFF
        if p == 1:
            break
    sbox[0] = 0x63
    return sbox, [sbox.index(i) for i in range(256)]


SBOX, INV = _build()


def _xt(a):
    return ((a << 1) ^ 0x1B) & 0xFF if a & 0x80 else a << 1


def _mul(a, b):
    r = 0
    while b:
        if b & 1:
            r ^= a
        a, b = _xt(a), b >> 1
    return r


def _expand(key):
    w, rc = [list(key[i:i + 4]) for i in range(0, 32, 4)], 1
    for i in range(8, 60):
        t = list(w[i - 1])
        if i % 8 == 0:
            t = [SBOX[b] for b in t[1:] + t[:1]]; t[0] ^= rc; rc = _xt(rc)
        elif i % 8 == 4:
            t = [SBOX[b] for b in t]
        w.append([a ^ b for a, b in zip(w[i - 8], t)])
    return [sum(w[r * 4:r * 4 + 4], []) for r in range(15)]


def _block(blk, rks, decrypt):
    s = [b ^ k for b, k in zip(blk, rks[14 if decrypt else 0])]
    for r in range(1, 15):
        k = rks[14 - r if decrypt else r]
        last = r == 14
        if decrypt:
            s = [s[(i - 4 * (i % 4)) % 16] for i in range(16)]   # inverse shift rows
            s = [INV[b] ^ kk for b, kk in zip(s, k)]
            if not last:
                s = sum(([_mul(c[(j) % 4], m[0]) ^ _mul(c[(j + 1) % 4], m[1]) ^ _mul(c[(j + 2) % 4], m[2]) ^ _mul(c[(j + 3) % 4], m[3])
                          for j in range(4)] for c in [s[i:i + 4] for i in range(0, 16, 4)] for m in [(14, 11, 13, 9)]), [])
        else:
            s = [SBOX[b] for b in s]
            s = [s[(i + 4 * (i % 4)) % 16] for i in range(16)]   # shift rows
            if not last:
                s = sum(([_mul(c[j], 2) ^ _mul(c[(j + 1) % 4], 3) ^ c[(j + 2) % 4] ^ c[(j + 3) % 4] for j in range(4)]
                         for c in [s[i:i + 4] for i in range(0, 16, 4)]), [])
            s = [b ^ kk for b, kk in zip(s, k)]
    return bytes(s)


def aes256_cbc(data, key, iv, decrypt=True):
    rks, out, prev = _expand(key), b"", iv
    for i in range(0, len(data), 16):
        blk = data[i:i + 16]
        if decrypt:
            out += bytes(a ^ b for a, b in zip(_block(list(blk), rks, True), prev)); prev = blk
        else:
            prev = _block([a ^ b for a, b in zip(blk, prev)], rks, False); out += prev
    return out


def _evp(secret, salt):
    d, prev = b"", b""
    while len(d) < 48:
        prev = hashlib.md5(prev + secret + salt).digest(); d += prev
    return d[:32], d[32:48]


def encrypt_context(obj, secret, salt=b"saltsalt"):
    """CryptoJS-compatible encrypt (used by tests and local tooling)."""
    raw = json.dumps(obj).encode()
    pad = 16 - len(raw) % 16
    key, iv = _evp(secret.encode(), salt)
    return base64.b64encode(b"Salted__" + salt + aes256_cbc(raw + bytes([pad]) * pad, key, iv, False)).decode()


def decrypt_context(token, secret):
    """Return the context dict, or None for anything missing, malformed or forged."""
    try:
        if not token or not secret:
            return None
        raw = base64.b64decode(token, validate=True)
        if raw[:8] != b"Salted__" or len(raw) < 32 or (len(raw) - 16) % 16:
            return None
        key, iv = _evp(secret.encode(), raw[8:16])
        plain = aes256_cbc(raw[16:], key, iv)
        n = plain[-1]
        if not 1 <= n <= 16 or plain[-n:] != bytes([n]) * n:
            return None
        ctx = json.loads(plain[:-n].decode())
        return ctx if isinstance(ctx, dict) else None
    except Exception:
        return None


def location_of(token):
    """Location id from the signed context only; None when the context is bad or has no sub-account."""
    ctx = decrypt_context(token, config.get()["GHL_SHARED_SECRET"])
    loc = ctx and ctx.get("activeLocation")
    return loc if isinstance(loc, str) and 0 < len(loc) <= 64 else None


# ---------------------------------------------------------------- data provider
class _Memory:
    """Fallback used until store/runs provide page_view/save_prompts/run_now. Keyed per location."""
    def __init__(self):
        self.d = {}

    def _loc(self, loc):
        return self.d.setdefault(loc, {"prompts": [], "last_manual_run": None})

    def view(self, loc):
        v = self._loc(loc)
        return {"prompts": list(v["prompts"]), "last_manual_run": v["last_manual_run"], "rows": [], "trend": [],
                "engines": {}, "last_run": None, "next_run": None, "trial_ends": None,
                "spend_month_usd": 0.0, "spend_location_usd": 0.0}

    def save_prompts(self, loc, prompts):
        self._loc(loc)["prompts"] = list(prompts)

    def run_now(self, loc, ts):
        self._loc(loc)["last_manual_run"] = ts


_mem = _Memory()


def _view(loc):
    import store
    fn = getattr(store, "page_view", None)
    return fn(loc) if fn else _mem.view(loc)


def _save(loc, prompts):
    import store
    fn = getattr(store, "save_prompts", None)
    fn(loc, prompts) if fn else _mem.save_prompts(loc, prompts)


def _run(loc, ts):
    import runs
    fn = getattr(runs, "run_now", None)
    fn(loc, ts) if fn else _mem.run_now(loc, ts)


# ---------------------------------------------------------------- responses
class Html(dict):
    def __init__(self, body, content_type="text/html; charset=utf-8", headers=None):
        super().__init__()
        self.body = body.encode() if isinstance(body, str) else body
        self.content_type = content_type
        self.headers = {"Content-Security-Policy": f"default-src 'none'; script-src 'self'; style-src 'self'; "
                        f"connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'self'; "
                        f"frame-ancestors {FRAME_ANCESTORS}",
                        "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff",
                        "Referrer-Policy": "no-referrer", **(headers or {})}


def _msg(code, message, status):
    return status, Html(json.dumps({"error": {"code": code, "message": message, "details": {}}}), "application/json")


def _e(x):
    return html.escape(str(x), quote=True)


# ---------------------------------------------------------------- rendering
def _days_left(ts):
    try:
        end = datetime.fromisoformat(ts).astimezone(timezone.utc) if ts else None
    except ValueError:
        return None
    return None if end is None else max(0, -(-int((end.timestamp() - now())) // 86400))


def _chart(trend, enabled):
    pts = [t for t in trend if isinstance(t, dict)]
    if len(pts) < 2:
        return '<p class="muted">Not enough runs yet for a trend.</p>'
    w, h, colors, out = 320, 120, ("#2563eb", "#b45309", "#047857"), []
    for n, (key, label) in enumerate(e for e in ENGINES if e[0] in enabled):
        xy = [(10 + i * (w - 20) / (len(pts) - 1), h - 10 - max(0, min(1, float((p.get("rates") or {}).get(key) or 0))) * (h - 20))
              for i, p in enumerate(pts)]
        out.append(f'<polyline fill="none" stroke="{colors[n]}" stroke-width="2" points="{" ".join(f"{x:.1f},{y:.1f}" for x, y in xy)}"/>'
                   f'<text x="{10 + n * 100}" y="{h + 14}" font-size="11" fill="{colors[n]}">{_e(label)}</text>')
    return (f'<svg viewBox="0 0 {w} {h + 20}" role="img" aria-label="Mention rate over time" class="chart">'
            f'<rect x="0" y="0" width="{w}" height="{h}" fill="none" stroke="#d1d5db"/>{"".join(out)}</svg>')


def _yn(v):
    return "Yes" if v else "No"


def render_body(loc):
    v, cfg = _view(loc), config.get()
    on = {k for k, _ in ENGINES if config.status(k) == config.CONFIGURED}
    h = []
    left = _days_left(v.get("trial_ends"))
    if left is not None:
        h.append(f'<div class="banner">Trial: {left} day{"" if left == 1 else "s"} left.</div>')
    h.append(f'<p>Last run: <b>{_e(v.get("last_run") or "none yet")}</b> &middot; Next run: <b>{_e(v.get("next_run") or "not scheduled")}</b></p>')
    h.append('<div class="cards">')
    for k, label in ENGINES:
        if k not in on:
            h.append(f'<div class="card"><h3>{_e(label)}</h3><p class="muted">not enabled</p></div>')
            continue
        s = (v.get("engines") or {}).get(k) or {}
        rate, pos = s.get("mention_rate"), s.get("avg_position")
        h.append(f'<div class="card"><h3>{_e(label)}</h3><p>Mention rate: <b>{"-" if rate is None else f"{float(rate) * 100:.0f}%"}</b></p>'
                 f'<p>Average position: <b>{"-" if pos is None else f"{float(pos):.1f}"}</b></p></div>')
    h.append('</div><h2>Trend</h2>' + _chart(v.get("trend") or [], on))
    cols = [(k, l) for k, l in ENGINES if k in on]
    h.append('<h2>Prompts</h2><div class="scroll"><table><tr><th>Prompt</th>' + "".join(f"<th>{_e(l)}</th>" for _, l in cols)
             + '<th>Top competitors</th><th>Sources</th></tr>')
    for r in v.get("rows") or []:
        m = r.get("mentioned") or {}
        h.append(f'<tr><td>{_e(r.get("prompt", ""))}</td>' + "".join(f"<td>{_yn(m.get(k))}</td>" for k, _ in cols)
                 + f'<td>{_e(", ".join(map(str, r.get("competitors") or [])) or "-")}</td>'
                 f'<td>{_e(", ".join(map(str, r.get("sources") or [])) or "-")}</td></tr>')
    h.append('</table></div>')
    h.append(f'<h2>Edit prompts</h2><p class="muted">One per line, up to {MAX_PROMPTS}.</p>'
             f'<textarea id="prompts" rows="6" maxlength="{MAX_PROMPTS * (MAX_PROMPT_LEN + 1)}">{_e(chr(10).join(v.get("prompts") or []))}</textarea>'
             '<p><button id="save" type="button">Save prompts</button> '
             '<button id="run" type="button">Run now</button> <span id="status" role="status"></span></p>'
             '<p class="muted">Run now is available once every 24 hours and while usage is within limits.</p>'
             '<p class="muted small">Independent tool. Not affiliated with or endorsed by the AI providers or HighLevel.</p>')
    return "".join(h)


def _shell(inner):
    return ('<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">'
            '<title>AI assistant visibility</title><link rel="stylesheet" href="/page/static/page.css"></head><body>'
            f'<main><h1>How AI assistants mention your business</h1><div id="app">{inner}</div></main>'
            '<script src="/page/static/page.js"></script></body></html>')


# ---------------------------------------------------------------- handlers
def _q(req, name):
    return (req.query.get(name) or [""])[0]


def _json_body(req):
    try:
        b = json.loads(req.body or b"{}")
        return b if isinstance(b, dict) else {}
    except ValueError:
        return {}


def handle_page(req):
    token = _q(req, "context")
    loc = location_of(token) if token else None
    inner = render_body(loc) if loc else f'<p class="notice" id="notice">{_e(NOT_IN_HL)}</p>'
    return 200, Html(_shell(inner))


def handle_view(req):
    loc = location_of(_json_body(req).get("context"))
    if not loc:
        return 401, Html(f'<p class="notice">{_e(NOT_IN_HL)}</p>')
    return 200, Html(render_body(loc))


def handle_prompts(req):
    b = _json_body(req)
    loc = location_of(b.get("context"))
    if not loc:
        return _msg("not_in_highlevel", NOT_IN_HL, 401)
    raw = b.get("prompts")
    if not isinstance(raw, list) or not all(isinstance(p, str) for p in raw):
        return _msg("invalid_prompts", "prompts must be a list of text", 400)
    prompts = [p.strip() for p in raw if p.strip()]
    if len(prompts) > MAX_PROMPTS:
        return _msg("too_many_prompts", f"At most {MAX_PROMPTS} prompts.", 400)
    if any(len(p) > MAX_PROMPT_LEN for p in prompts):
        return _msg("prompt_too_long", f"Each prompt is at most {MAX_PROMPT_LEN} characters.", 400)
    _save(loc, prompts)
    return 200, Html(json.dumps({"ok": True, "count": len(prompts)}), "application/json")


def handle_run(req):
    loc = location_of(_json_body(req).get("context"))
    if not loc:
        return _msg("not_in_highlevel", NOT_IN_HL, 401)
    v, cfg, t = _view(loc), config.get(), now()
    last = v.get("last_manual_run")
    if last is not None and t - float(last) < RUN_NOW_GAP:
        return _msg("run_limit", "Run now is available once every 24 hours.", 429)
    if not any(config.status(k) == config.CONFIGURED for k, _ in ENGINES):
        return _msg("no_engines", "No engine is enabled.", 409)
    if not v.get("prompts"):
        return _msg("no_prompts", "Save at least one prompt first.", 409)
    if float(v.get("spend_month_usd") or 0) >= cfg["GHL_MONTHLY_CAP_USD"] or \
            float(v.get("spend_location_usd") or 0) >= cfg["GHL_PER_LOCATION_CAP_USD"]:
        return _msg("cap_reached", "The usage limit is reached; try again next period.", 429)
    _run(loc, t)
    return 202, Html(json.dumps({"ok": True}), "application/json")


def _static(name, ctype):
    def h(req):
        with open(os.path.join(STATIC, name), "rb") as f:
            return 200, Html(f.read(), ctype)
    return h


def register(routes):
    """routes maps (METHOD, path) -> handler(req) -> (status, json-able dict)."""
    routes[("GET", "/page")] = handle_page
    routes[("POST", "/page/view")] = handle_view
    routes[("POST", "/page/prompts")] = handle_prompts
    routes[("POST", "/page/run")] = handle_run
    routes[("GET", "/page/static/page.css")] = _static("page.css", "text/css; charset=utf-8")
    routes[("GET", "/page/static/page.js")] = _static("page.js", "application/javascript; charset=utf-8")
