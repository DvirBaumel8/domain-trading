"""Public city pages built ONLY from the market cache (data/markets/<niche>__<city>.json).

Routes (hooked into server.py): GET /city, /city/<slug>, /city/<slug>/card.svg.
The slug map is built from the validated cache files; a request path is only ever looked up in
that map and never used to open a file. Nothing here reads requests.jsonl, ref-hits.jsonl,
free-checks/ or any orders folder. Every number is computed from the cache file (or is the $149 price).
"""
import datetime, html, json, os, re, sys, urllib.parse
from xml.sax.saxutils import escape as _xml_escape

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import discovery                                       # noqa: E402  (origin helper, trade slugs)
MARKETS_DIR = os.path.join(HERE, "data", "markets")   # tests point this at a temp folder

SHOW_NAMES = False     # one switch; False (shipped) keeps every business name off the pages and the card
TOP_N = 5
PRICE = "$149"
SITE_NAME = "AI Visibility Check"
MAX_FILE = 2_000_000
_NICHE_KEY = re.compile(r"[a-z0-9_-]{1,40}")
_NICHE_LABEL = re.compile(r"[A-Za-z][A-Za-z &'-]{1,40}")
_CITY = re.compile(r"[A-Za-z][A-Za-z .'-]{1,39}, [A-Z]{2}")
_DATE = re.compile(r"\d{4}-\d{2}-\d{2}")
_SLUG = re.compile(r"[a-z0-9]+(?:-[a-z0-9]+)*")


def _slugify(text):
    return re.sub(r"[^a-z0-9]+", "-", text.lower()).strip("-")


def _valid_date(s):
    if not isinstance(s, str) or not _DATE.fullmatch(s):
        return False
    try:
        datetime.date.fromisoformat(s)
        return True
    except ValueError:
        return False


def _int(v, lo, hi):
    return isinstance(v, int) and not isinstance(v, bool) and lo <= v <= hi


def validate(d):
    """-> market dict with computed numbers, or None if the cache file is not publishable."""
    try:
        if not isinstance(d, dict):
            return None
        niche, label, city = d.get("niche"), d.get("niche_label"), d.get("city")
        note, date, answers = d.get("source_note"), d.get("data_date"), d.get("answers")
        if not (isinstance(niche, str) and _NICHE_KEY.fullmatch(niche)):
            return None
        if not (isinstance(label, str) and _NICHE_LABEL.fullmatch(label)):
            return None
        if not (isinstance(city, str) and _CITY.fullmatch(city)):
            return None
        if not (isinstance(note, str) and 0 < len(note.strip()) <= 400) or not _valid_date(date):
            return None
        if not isinstance(answers, list) or not answers or len(answers) > 500:
            return None
        sets = []
        for a in answers:
            names = a.get("names") if isinstance(a, dict) else None
            if not isinstance(names, list) or len(names) > 50:
                return None
            clean = set()
            for n in names:
                if not isinstance(n, str) or not n.strip() or len(n) > 120:
                    return None
                clean.add(n.strip())
            sets.append(clean)
        distinct = set().union(*sets)
        if not distinct:
            return None
        matched, unv = d.get("competitors"), d.get("unverified_pct")
        if not _int(matched, 0, len(distinct)) or not _int(unv, 0, 100):
            return None
        counts = {}
        for s in sets:
            for n in s:
                counts[n] = counts.get(n, 0) + 1
        top = sorted(counts.items(), key=lambda kv: (-kv[1], kv[0].lower()))[:TOP_N]
        slug = _slugify(label + " " + city)
        if not _SLUG.fullmatch(slug):
            return None
        return {"slug": slug, "niche": niche, "label": label, "city": city, "note": note, "date": date,
                "questions": len(answers), "distinct": len(distinct), "matched": matched,
                "unverified_pct": unv, "top": top}
    except Exception:
        return None


def load_markets(directory=None):
    """slug -> market, from the valid cache files only (sorted by file name; first slug wins)."""
    directory = directory or MARKETS_DIR
    out = {}
    try:
        files = sorted(os.listdir(directory))
    except OSError:
        return out
    for fn in files:
        p = os.path.join(directory, fn)
        if not fn.endswith(".json") or os.path.islink(p) or not os.path.isfile(p):
            continue
        try:
            if os.path.getsize(p) > MAX_FILE:
                continue
            with open(p, encoding="utf-8") as fh:
                m = validate(json.load(fh))
        except (OSError, ValueError):
            continue
        if m and m["slug"] not in out:
            out[m["slug"]] = m
    return out


def public_entries():
    """[(path, link text)] of the valid city pages, for the sitemap / llms.txt (empty when no valid market)."""
    ms = load_markets()
    if not ms:
        return []
    return [("/city", "City snapshots of AI answers")] + [(f"/city/{s}", headline(ms[s])) for s in sorted(ms)]


def public_paths():
    """Valid public city paths (empty list when there are no valid markets: then /city is not linked either)."""
    return [p for p, _ in public_entries()]


def e(s):
    return html.escape(str(s), quote=True)


def _head(title, desc, canonical, extra=""):
    return (f'<!doctype html>\n<html lang="en"><head><meta charset="utf-8">'
            f'<meta name="viewport" content="width=device-width,initial-scale=1">\n'
            f'<title>{e(title)}</title>\n<meta name="description" content="{e(desc)}">\n'
            f'<link rel="canonical" href="{e(canonical)}">\n'
            f'<meta property="og:type" content="website"><meta property="og:site_name" content="{e(SITE_NAME)}">\n'
            f'<meta property="og:title" content="{e(title)}"><meta property="og:description" content="{e(desc)}">\n'
            f'<meta property="og:url" content="{e(canonical)}">\n'
            f'<meta name="twitter:card" content="summary"><meta name="twitter:title" content="{e(title)}">'
            f'<meta name="twitter:description" content="{e(desc)}">\n'
            f'{extra}<link rel="stylesheet" href="/assets/style.css"></head>\n')


_NAV = ('<body>\n<nav><div class="wrap"><a class="logo" href="/"><i></i>' + e(SITE_NAME) + '</a>'
        '<div class="links"><a href="/city">City snapshots</a><a class="btn" href="/#check">Free check</a></div></div></nav>\n')
_FOOT = ('<footer><div class="wrap">\n'
         '<p>© 2026 Dvir Baumel · <span class="addr">{{BUSINESS_ADDRESS}}</span></p>\n'
         '<p><a href="/privacy.html">Privacy</a> · <a href="/terms.html">Terms</a> · <a href="/refunds.html">Refunds</a>'
         ' · Not affiliated with OpenAI, Google or Anthropic.</p>\n</div></footer>\n'
         '<script src="/assets/ref.js"></script><script src="/assets/config.js"></script><script src="/assets/app.js"></script>\n</body></html>\n')


def headline(m):
    return f"Who does AI name for {m['label']} in {m['city']}?"


def describe(m):
    return (f"Snapshot of AI answers for {m['label']} in {m['city']} on {m['date']}: {m['questions']} questions asked, "
            f"{m['distinct']} businesses named. Not a ranking, rating or endorsement.")


def city_page(m, base):
    """The one template function for a city page. Contains the {{BUSINESS_ADDRESS}} token for render_page."""
    url = f"{base}/city/{m['slug']}"
    title = f"{headline(m)} Snapshot from {m['date']} | {SITE_NAME}"
    desc = describe(m)
    q = urllib.parse.quote
    share_text = f"{headline(m)} A snapshot of AI answers, not a ranking."
    mail = f"mailto:?subject={q(headline(m))}&body={q(share_text + ' ' + url)}"
    tw = f"https://twitter.com/intent/tweet?url={q(url, safe='')}&text={q(share_text)}"
    li = f"https://www.linkedin.com/sharing/share-offsite/?url={q(url, safe='')}"
    names = ""
    if SHOW_NAMES and m["top"]:
        rows = "".join(f"<li>{e(n)} — named in {c} of {m['questions']} answers</li>" for n, c in m["top"])
        names = (f'<h2>Names the AI produced most often</h2>\n<ol>{rows}</ol>\n'
                 f'<p class="sub">These are names the AI produced. Some may be closed, wrong or not real, and we have not '
                 f'verified them. Being listed here is not a ranking, rating or endorsement of any business.</p>\n')
    slug = discovery.trade_slug_for_niche(m["niche"])
    trade = (f'<p><a href="/for/{e(slug)}">AI visibility for {e(m["label"])}: what the check measures</a></p>\n'
             if slug else "")
    body = (f'<section><div class="wrap">\n<h1>{e(headline(m))}</h1>\n'
            f'<p class="sub">Snapshot of AI answers on {e(m["date"])}. Answers change, and this is not a ranking, '
            f'rating or endorsement of any business.</p>\n'
            f'<div class="card"><h2>The numbers</h2><ul>'
            f'<li>Questions asked: {m["questions"]}</li>'
            f'<li>Distinct businesses named: {m["distinct"]}</li>'
            f'<li>Of those, matched to the official roster: {m["matched"]}</li>'
            f'<li>Share of name mentions not matched to the roster: {m["unverified_pct"]}%</li>'
            f'<li>Data date: {e(m["date"])}</li></ul>\n'
            f'<p><strong>Source:</strong> {e(m["note"])}</p></div>\n'
            f'{names}'
            f'<h2>How to read this</h2>\n<p>We asked an AI model {m["questions"]} questions about {e(m["label"])} in '
            f'{e(m["city"])} and wrote down the businesses it named. "Matched" means the name was found in the official '
            f'roster of licensed businesses; "not matched" means it was not found there. A name that is not matched is not '
            f'proof of anything by itself. This page shows one moment: run the same questions on another day and the '
            f'answers can differ.</p>\n'
            f'{trade}'
            f'<h2>Check your own business</h2>\n'
            f'<p><a class="btn" data-pay="payLinkCheck" href="/#pricing">Get the full report — {PRICE}</a> &nbsp; '
            f'<a class="btn ghost" href="/#check">Run a free quick check</a></p>\n'
            f'<h2>Share this snapshot</h2>\n'
            f'<p><img src="/city/{e(m["slug"])}/card.svg" width="600" height="315" '
            f'alt="Report card: {e(headline(m))} {m["questions"]} questions, {m["distinct"]} businesses named, {e(m["date"])}"></p>\n'
            f'<p>Page link: <code>{e(url)}</code></p>\n'
            f'<p><a href="{e(mail)}">Email this page</a> · <a href="{e(tw)}" rel="noopener nofollow">Share on X</a> · '
            f'<a href="{e(li)}" rel="noopener nofollow">Share on LinkedIn</a></p>\n'
            f'<p><a href="/city">All city snapshots</a></p>\n</div></section>\n')
    return _head(title, desc, url) + _NAV + body + _FOOT


def index_page(ms, base):
    url = f"{base}/city"
    items = "".join(f'<li><a href="/city/{e(s)}">{e(headline(m))}</a> — data date {e(m["date"])}</li>'
                    for s, m in sorted(ms.items()))
    title = f"City snapshots of AI answers | {SITE_NAME}"
    desc = "Snapshots of what an AI model names for local businesses in a city, with the date of each snapshot. Not rankings."
    body = (f'<section><div class="wrap">\n<h1>City snapshots of AI answers</h1>\n'
            f'<p class="sub">Each page is a dated snapshot of one AI model answering from memory. Not a ranking, rating or '
            f'endorsement of any business.</p>\n<ul>{items}</ul>\n'
            f'<p><a class="btn ghost" href="/#check">Run a free quick check</a></p>\n</div></section>\n')
    return _head(title, desc, url) + _NAV + body + _FOOT


def card_svg(m):
    x = _xml_escape
    lines = [(70, 150, 54, "800", headline(m)),
             (70, 250, 30, "400", f"{m['label'].capitalize()} · {m['city']} · data date {m['date']}"),
             (70, 360, 44, "700", f"{m['questions']} questions asked"),
             (70, 430, 44, "700", f"{m['distinct']} distinct businesses named"),
             (70, 520, 28, "400", "Snapshot of AI answers, not a ranking"),
             (70, 580, 28, "700", SITE_NAME)]
    text = "".join(f'<text x="{a}" y="{b}" font-size="{c}" font-weight="{d}" fill="#0f172a">{x(t)}</text>'
                   for a, b, c, d, t in lines)
    return ('<?xml version="1.0" encoding="UTF-8"?>\n'
            '<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630" '
            'font-family="Inter, Segoe UI, Arial, sans-serif">'
            f'<title>{x(headline(m))}</title>'
            '<rect width="1200" height="630" fill="#f8fafc"/><rect width="1200" height="14" fill="#4f46e5"/>'
            f'{text}</svg>\n').encode("utf-8")


def route(path, headers):
    """-> None if not a city route, else (status, content-type, body bytes). `path` is the raw request path
    (no query). The path is only compared with the slug map; it never reaches the filesystem."""
    if path != "/city" and not path.startswith("/city/"):
        return None
    miss = (404, "application/json", b'{"error": "not found"}')
    ms = load_markets()
    base = discovery.public_origin(headers.get("Host"), headers.get("X-Forwarded-Proto"))
    if path == "/city":
        return (200, "text/html; charset=utf-8", index_page(ms, base).encode()) if ms else miss
    parts = path[len("/city/"):].split("/")
    if len(parts) == 1 and parts[0] in ms:
        return 200, "text/html; charset=utf-8", city_page(ms[parts[0]], base).encode()
    if len(parts) == 2 and parts[1] == "card.svg" and parts[0] in ms:
        return 200, "image/svg+xml", card_svg(ms[parts[0]])
    return miss
