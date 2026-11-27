"""HTTP side of the agency feature: /agency/claim, /agency/p/<token>[/...], /r/<token>.pdf.
Every function answers None (the caller sends the normal 404) while products.agency_on() is false.
No log line here carries a token, an email or a request body."""
import html as _html, json, re, sys, urllib.parse

import agency
import delivery
import products

E = _html.escape
NOT_FOUND = (404, "application/json", b'{"error": "not found"}')
TOO_BIG = "Request too large."


def _json(code, obj):
    return code, "application/json", json.dumps(obj).encode()


def _err(msg, code=400):
    return _json(code, {"error": msg})


def _obj(raw):
    try:
        d = json.loads(raw.decode("utf-8"))
    except ValueError:
        raise agency.AgencyError("Please send the form again.") from None
    if not isinstance(d, dict):
        raise agency.AgencyError("Please send the form again.")
    return d


def handle(method, path, query, ip, read, store):
    """-> (status, content type, body bytes) or None when this is not an agency path (or the feature is off).
    read(limit) returns the request body or raises ValueError('Request too large.')."""
    if not products.agency_on():
        return None
    if path == "/agency/claim" and method == "POST":
        return _claim(ip, read, store)
    m = re.fullmatch(r"/agency/p/([^/]+)(?:/([a-z]+))?", path)
    if m:
        return _portal(method, m.group(1), m.group(2) or "", query, ip, read, store)
    m = re.fullmatch(r"/r/([^/]+)\.pdf", path)
    if m and method in ("GET", "HEAD"):
        return _pdf(m.group(1), store)
    return None


def _claim(ip, read, store):
    if agency.limited("claim", ip, agency.CLAIM_PER_MINUTE):
        return _err("Too many attempts, try again in a minute.", 429)
    agency.note("claim", ip)
    try:
        d = _obj(read(agency.MAX_JSON_BODY))
    except ValueError:
        return _err("Please check the details and try again.")
    tok = agency.claim(store, str(d.get("order_id", "")), str(d.get("email", "")))
    if tok is None:
        return _json(404, {"error": "We could not match those details."})
    return _json(200, {"portal": "/agency/p/" + tok})


def _pdf(token, store):
    try:
        data = agency.pdf_for_token(store, token)
    except Exception as e:
        print("pdf error:", type(e).__name__, file=sys.stderr)
        data = None
    return (200, "application/pdf", data) if data else NOT_FOUND


def _portal(method, token, action, query, ip, read, store):
    if agency.limited("badtoken", ip, agency.BAD_TOKEN_PER_MINUTE):
        return _err("Too many attempts, try again in a minute.", 429)
    b = agency.bundle_for_token(store, token)
    if b is None:
        agency.note("badtoken", ip)
        return NOT_FOUND
    tkey = agency._tkey(token)
    if method == "GET" and action == "":
        return 200, "text/html; charset=utf-8", page(token, agency.portal_state(store, b)).encode()
    if method == "GET" and action == "state":
        return _json(200, agency.portal_state(store, b))
    if method == "GET" and action == "preview":
        mode = urllib.parse.parse_qs(query).get("mode", ["branded"])[0]
        uri = agency.logo_data_uri(store, b["bundle_id"]) if b.get("logo") else None
        return 200, "text/html; charset=utf-8", agency.sample_html(
            "unbranded" if mode == "unbranded" else "branded", b.get("brand") or {}, uri).encode()
    if method != "POST":
        return NOT_FOUND
    if action in ("run", "bulk", "rebrand"):
        if agency.limited("run", tkey, agency.RUN_PER_MINUTE):      # nothing is consumed on a 429
            return _err("Too many requests, try again in a minute.", 429)
        agency.note("run", tkey)
    try:
        if action == "logo":
            agency.save_logo(store, b, read(agency.MAX_LOGO_BODY))
            return _json(200, {"status": "saved"})
        if action == "bulk":
            d = _obj(read(agency.MAX_CSV_BODY + 2048))
            made = agency.submit_many(store, b, d.get("csv", ""), bool(d.get("confirm_rerun")),
                                      "unbranded" if d.get("mode") == "unbranded" else "branded")
            return _json(200, {"status": "accepted", "started": len(made), **_counts(store, b)})
        d = _obj(read(agency.MAX_JSON_BODY))
        if action == "run":
            # only the client fields are read: a bundle id, a slot number or branding in the body is ignored
            agency.submit(store, b, d, bool(d.get("confirm_rerun")))
            return _json(200, {"status": "accepted", **_counts(store, b)})
        if action == "brand":
            return _json(200, {"status": "saved", "brand": agency.save_brand(store, b, d)})
        if action == "rebrand":
            n = agency.rebrand(store, b, str(d.get("order_id", "")), d)
            return _json(200, {"status": "rebranded", "rebrands": n})
    except agency.NoReportsLeft as e:
        return _err(str(e), 409)
    except ValueError as e:                  # AgencyError and the size limit: plain messages, never internals
        return _err(str(e) if isinstance(e, agency.AgencyError) or str(e) == TOO_BIG else "Please send the form again.")
    except Exception as e:
        print("agency error:", type(e).__name__, file=sys.stderr)
        return _err("Something went wrong.", 500)
    return NOT_FOUND


def _counts(store, b):
    c = agency.counts(store, agency.get_bundle(store, b["bundle_id"]))
    return {"used": c["used"], "left": c["left"], "total": c["total"]}


def page(token, st):
    """The portal page. Every agency-supplied string is escaped."""
    rows = "".join(
        f"<tr><td>{r['n']}</td><td>{E(r['business'])}</td><td>{E(r['city'])}</td><td>{E(r['status'])}</td><td>"
        + (f"<a href='/r/{E(r['token'])}'>Open</a> · <a href='/r/{E(r['token'])}.pdf'>PDF</a>" if r["ready"] else "")
        + "</td></tr>" for r in st["reports"])
    br = st["brand"]
    niches = "".join(f"<option value='{E(k)}'>{E(agency_label(k))}</option>" for k in agency.NICHES)
    note = "This bundle is closed: reports not yet started were returned." if st["frozen"] else ""
    return f"""<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="robots" content="noindex,nofollow">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Your reports</title>
<link rel="stylesheet" href="/assets/style.css"></head><body><section><div class="wrap" style="max-width:860px">
<h1>Your client reports</h1><p class="small">{BASE_TEXT.format(n=st['total'])}</p><p><b>{st['left']}</b> of {st['total']} reports left. {E(note)}</p>
<h2>Brand</h2><form id="brand">
<label>Name <input name="name" maxlength="80" value="{E(br.get('name', ''))}"></label>
<label>Colour <input name="accent" maxlength="7" placeholder="#1D4ED8" value="{E(br.get('accent', ''))}"></label>
<label>Contact line <input name="contact_line" maxlength="120" value="{E(br.get('contact_line', ''))}"></label>
<button>Save brand</button></form>
<form id="logo"><label>Logo (PNG or JPEG, up to 300 KB) <input type="file" name="f" accept="image/png,image/jpeg"></label><button>Upload logo</button></form>
<p><a href="/agency/p/{E(token)}/preview?mode=branded" target="_blank">SAMPLE preview, branded</a> ·
<a href="/agency/p/{E(token)}/preview?mode=unbranded" target="_blank">SAMPLE preview, unbranded</a></p>
<h2>Run one report</h2><form id="run">
<label>Business <input name="business" maxlength="120" required></label>
<label>City <input name="city" placeholder="Austin, TX" required></label>
<label>Type <select name="niche">{niches}</select></label>
<label>Website <input name="website"></label>
<label>Prepared for <input name="prepared_for" maxlength="120"></label>
<label>Output <select name="mode"><option value="branded">Your brand</option><option value="unbranded">Unbranded</option></select></label>
<label><input type="checkbox" name="confirm_rerun"> Run again for a client done in the last 30 days</label>
<button>Run report</button></form>
<h2>Run a list (CSV, up to 25 rows: business, city, type, website)</h2>
<form id="bulk"><textarea name="csv" rows="5" style="width:100%"></textarea><button>Run list</button></form>
<p id="msg" role="status"></p>
<h2>Reports</h2><table class="sheet"><tr><th>#</th><th>Business</th><th>City</th><th>Status</th><th></th></tr>{rows}</table>
</div></section><script>
const T={json.dumps(token)};const msg=document.getElementById('msg');
async function post(a,body,raw){{const r=await fetch('/agency/p/'+T+'/'+a,{{method:'POST',body:raw?body:JSON.stringify(body)}});
const j=await r.json();msg.textContent=j.error||'Done.';if(r.ok)location.reload();}}
function fd(f){{const o={{}};new FormData(f).forEach((v,k)=>o[k]=v);return o;}}
for(const id of ['brand','run','bulk'])document.getElementById(id).onsubmit=e=>{{e.preventDefault();const o=fd(e.target);
if(o.confirm_rerun)o.confirm_rerun=true;post(id,o);}};
document.getElementById('logo').onsubmit=e=>{{e.preventDefault();const f=e.target.f.files[0];if(f)post('logo',f,true);}};
</script></body></html>"""


def agency_label(key):
    from aivis.niches import NICHES, niche_label
    return niche_label(NICHES[key].label)


BASE_TEXT = ("{n} automated AI Visibility reports for your agency's own client work. Each report is generated from one "
             "business's details (name, trade, city). Delivered as a PDF you can put under your own logo. No cash value; "
             "unused reports do not expire into money. We never contact your clients.")
BANNED_WORDS = ("lead generation", "prospect", "pitch", "outreach", "cold email", "credits", "wallet", "balance")


def bundle_page(raw):
    """agency.html while AIVIS_AGENCY=1: the pricing section is rewritten to the bundle prices read from the product
    map (and the buy buttons from config.js keys that have a URL). With the flag off the file is served unchanged."""
    text = raw.decode("utf-8")
    rows = []
    links = products.agency_pay_links()
    for key, n in products.AGENCY_PAY_KEYS.items():
        price = products.AGENCY_BUNDLE_PRICES_USD[n]
        buy = f'<a class="btn" data-pay="{key}" href="{E(links[key])}">Buy</a>' if key in links else ""
        rows.append(f'<tr><td>{n} report{"s" if n != 1 else ""}</td><td class="amt">${price}</td><td>{buy}</td></tr>')
    closed = "" if products.agency_product_ids() else " Checkout is not connected yet."
    section = ('<section id="pricing"><div class="wrap"><h2>Report bundles</h2>'
               f'<p class="sub">{BASE_TEXT.format(n="1, 5, 10 or 25")} US clients only.</p>'
               '<table class="sheet"><tr><th>Bundle</th><th>You pay</th><th></th></tr>' + "".join(rows) + "</table>"
               f'<p class="small" style="margin-top:12px">Each report is used when it starts and is returned if the run fails.{closed}'
               ' See the <a href="agency-terms.html">bundle terms</a>.</p></div></section>')
    text = re.sub(r'<section id="pricing">.*?</section>', lambda m: section, text, count=1, flags=re.S)
    return text.encode("utf-8")
