"""Search/AI discoverability: sitemap, llms.txt, JSON-LD, FAQ and one landing page per trade.

Everything here is built at request time from one place: the PRODUCTS and FAQ constants below
and the NICHES registry. Nothing reads a file named by a request; trade slugs are an allow-list.
"""
import html as _html
import json
import os
import re
import sys
from xml.sax.saxutils import escape as _xml

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "engine"))
from aivis.niches import NICHES         # noqa: E402
from aivis.prompts import generate_prompts  # noqa: E402

# One-time products as listed on Polar (USD, whole dollars). Schema and tests read this table.
PRODUCTS = (
    {"name": "AI Visibility Check", "price": 149,
     "description": "Asks ChatGPT, Gemini and Claude local-business questions for your trade and city and records who is named."},
    {"name": "Google Maps Visibility Check", "price": 149,
     "description": "Review of your Google Maps profile with a map-visibility baseline."},
    {"name": "Listings Consistency Audit", "price": 249,
     "description": "Check of the directories AI assistants read, listed, wrong or missing, with an ordered checklist."},
    {"name": "AI Content Pack", "price": 249,
     "description": "Site crawl, a priority table, page rewrites and ready-to-paste structured data."},
    {"name": "AI Visibility Bundle", "price": 397,
     "description": "The AI Visibility Check, Maps check, Listings audit and Content Pack together."},
)
CHECK_PRICE = PRODUCTS[0]["price"]
COMING_SOON_PLANS = ("Visibility", "Growth", "Dominate")   # monthly plans: never get an offer in the schema

# Visible FAQ and FAQPage JSON-LD are both generated from this list (plain text answers).
FAQ = (
    ("What does the AI Visibility Check do?",
     "We ask ChatGPT, Gemini and Claude the questions customers in your trade and city might ask, count how often "
     "your business is named, list who is named instead, and check those names against official registers where we can."),
    ("What do I get, and when?",
     "A written report with how often each assistant names you, who is named instead, and a prioritized fix list. "
     "It is delivered in 2 business days."),
    ("What does it cost?",
     f"The AI Visibility Check is ${CHECK_PRICE}, one time, in US dollars, paid at checkout through Polar."),
    ("Are the monthly plans available?",
     "Not yet. The Visibility, Growth and Dominate monthly plans are coming soon and cannot be bought today."),
    ("Which businesses is it for?",
     "US businesses only. Enter a US city and state, such as Austin, TX."),
    ("Can you promise that an AI assistant will recommend my business?",
     "No. AI answers change from one ask to the next, so we report how often you are named, with a range. "
     "We never promise a ranking."),
    ("What is the refund policy?",
     "If we do not email you the report within 5 business days after we have both your payment and a completed intake "
     "form, you get a full refund. We do not refund a delivered report only because an assistant still does not name "
     "your business. See the refund policy for the full text."),
)

PUBLIC_PAGES = ("/", "/agency.html", "/sample-report.html", "/privacy.html", "/terms.html", "/refunds.html")

# ---- origin helper -------------------------------------------------------------------------------
_LABEL = r"[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?"
_HOST_RE = re.compile(rf"{_LABEL}(?:\.{_LABEL})*(?::[0-9]{{1,5}})?")
_BASE_RE = re.compile(rf"https?://{_LABEL}(?:\.{_LABEL})*(?::[0-9]{{1,5}})?")


def public_origin(host=None, forwarded_proto=None, env=None):
    """Site origin without a trailing slash, or "" when nothing safe is known (links then stay relative).

    Order: AIVIS_PUBLIC_BASE_URL (if it is a plain http(s) origin), else the Host header (only if it
    is a strict hostname[:port]) with the scheme from X-Forwarded-Proto (http/https, default https).
    Unvalidated header text is never returned.
    """
    env = os.environ if env is None else env
    base = (env.get("AIVIS_PUBLIC_BASE_URL") or "").strip().rstrip("/")
    if base:
        return base if _BASE_RE.fullmatch(base.lower()) else ""
    h = (host or "").strip().lower()
    if not h or len(h) > 260 or not _HOST_RE.fullmatch(h):
        return ""
    proto = (forwarded_proto or "").strip().lower()
    return f"{proto if proto in ('http', 'https') else 'https'}://{h}"


# ---- config.js (the one source of the checkout link, brand and public contact) --------------------
def site_config(path=None):
    path = path or os.path.join(HERE, "assets", "config.js")
    with open(path, encoding="utf-8") as fh:
        text = fh.read()
    out = {}
    for key in ("brand", "payLinkCheck", "contactEmail"):
        m = re.search(rf'\b{key}\s*:\s*"([^"]*)"', text)
        out[key] = m.group(1) if m else ""
    return out


# ---- trades ---------------------------------------------------------------------------------------
def trades():
    """[(slug, niche)] from the registry; slug = plural label, lowercase, hyphenated."""
    out, seen = [], set()
    for n in NICHES.values():
        slug = re.sub(r"[^a-z0-9]+", "-", n.plural.lower()).strip("-")
        if slug in seen:
            raise ValueError("duplicate trade slug " + slug)
        seen.add(slug)
        out.append((slug, n))
    return out


def trade_by_slug(slug):
    for s, n in trades():
        if s == slug:
            return n
    return None


def trade_paths():
    return [f"/for/{s}" for s, _ in trades()]


def trade_title(niche):
    return f"AI visibility for {niche.plural}"


def example_prompts(niche, count=4):
    """Real prompts from the engine templates, one per intent, with a generic city."""
    seen, out = set(), []
    for p in generate_prompts(niche, "your city", n=80):
        if p.intent in ("best", "service", "need", "cost") and p.intent not in seen:
            seen.add(p.intent)
            out.append(p.text)
    return out[:count]


# ---- JSON-LD --------------------------------------------------------------------------------------
def _ld_script(obj):
    s = json.dumps(obj, ensure_ascii=True, separators=(",", ":"))
    s = s.replace("<", "\\u003c").replace(">", "\\u003e").replace("&", "\\u0026")
    return f'<script type="application/ld+json">{s}</script>'


def faq_ld():
    return {"@type": "FAQPage",
            "mainEntity": [{"@type": "Question", "name": q,
                            "acceptedAnswer": {"@type": "Answer", "text": a}} for q, a in FAQ]}


def home_jsonld(origin=""):
    cfg = site_config()
    org = {"@type": "Organization", "name": cfg["brand"]}
    if origin:
        org["url"] = origin + "/"
    if cfg["contactEmail"]:
        org["contactPoint"] = {"@type": "ContactPoint", "contactType": "customer support", "email": cfg["contactEmail"]}
    products = [{"@type": "Product", "name": p["name"], "description": p["description"],
                 "brand": {"@type": "Brand", "name": cfg["brand"]},
                 "offers": {"@type": "Offer", "price": str(p["price"]), "priceCurrency": "USD",
                            "availability": "https://schema.org/InStock"}} for p in PRODUCTS]
    return _ld_script({"@context": "https://schema.org", "@graph": [org, *products, faq_ld()]})


def faq_section_html():
    items = "".join(f"<details><summary>{_html.escape(q)}</summary><p>{_html.escape(a)}</p></details>" for q, a in FAQ)
    return f'<section id="common-questions"><div class="wrap"><h2>Common questions</h2>{items}</div></section>'


def trades_section_html(prefix="/"):
    links = " · ".join(f'<a href="{prefix}for/{s}">{_html.escape(n.plural[:1].upper() + n.plural[1:])}</a>' for s, n in trades())
    return (f'<section id="trades"><div class="wrap"><h2>AI visibility by trade</h2>'
            f'<p class="sub">The same check, with example questions for your trade.</p><p>{links}</p></div></section>')


TOKENS = {
    b"{{HOME_JSONLD}}": lambda origin: home_jsonld(origin),
    b"{{FAQ_SECTION}}": lambda origin: faq_section_html(),
    b"{{TRADES_SECTION}}": lambda origin: trades_section_html(),
}


def fill_tokens(raw, origin=""):
    """Replace the discovery tokens of a static page (no-op for pages without them)."""
    for tok, fn in TOKENS.items():
        if tok in raw:
            raw = raw.replace(tok, fn(origin).encode())
    return raw


# ---- sitemap / llms.txt ---------------------------------------------------------------------------
def sitemap_xml(origin=""):
    paths = list(PUBLIC_PAGES) + trade_paths()
    urls = "".join(f"<url><loc>{_xml(origin + p)}</loc></url>" for p in paths)
    return ('<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">'
            + urls + "</urlset>\n")


def robots_txt(origin=""):
    lines = ["User-agent: *", "Allow: /"] + [f"Disallow: /{d}/" for d in ("data", "api", "r", "status", "free")]
    if origin:
        lines.append(f"Sitemap: {origin}/sitemap.xml")
    return "\n".join(lines) + "\n"


def llms_txt(origin=""):
    cfg = site_config()
    o = origin
    lines = [f"# {cfg['brand']}", "",
             "> Checks whether ChatGPT, Gemini and Claude name a US local business when customers ask for a "
             "recommendation, who they name instead, and what to fix.", "",
             "## Product",
             f"- [{cfg['brand']}]({o}/): what the check does and the free quick check",
             f"- [Pricing]({o}/#pricing): one-time products; the monthly plans are coming soon",
             f"- [Sample report]({o}/sample-report.html): an example report with business names hidden",
             f"- [For agencies]({o}/agency.html): white-label reports", "",
             "## Trades"]
    lines += [f"- [AI visibility for {n.plural}]({o}/for/{s})" for s, n in trades()]
    lines += ["", "## Help",
              f"- [Common questions]({o}/#common-questions)",
              f"- [Refund policy]({o}/refunds.html)",
              f"- [Terms]({o}/terms.html)",
              f"- [Privacy]({o}/privacy.html)", ""]
    if cfg["contactEmail"]:
        lines += ["## Contact", f"Email {cfg['contactEmail']}", ""]
    return "\n".join(lines)


# ---- trade landing page ---------------------------------------------------------------------------
def trade_page(slug, origin=""):
    """HTML (bytes, still holding {{BUSINESS_ADDRESS}}) for an allow-listed slug, else None."""
    niche = trade_by_slug(slug)
    if niche is None:
        return None
    cfg, e = site_config(), _html.escape
    plural, title = niche.plural, trade_title(niche)
    brand = cfg["brand"]
    url = f"{origin}/for/{slug}"
    desc = (f"See whether ChatGPT, Gemini and Claude name your business when customers ask for {plural}. "
            f"The AI Visibility Check is ${CHECK_PRICE}, one time.")
    pay = cfg["payLinkCheck"] or "#"
    prompts = "".join(f"<li>“{e(t)}”</li>" for t in example_prompts(niche))
    ld = {"@context": "https://schema.org", "@graph": [
        {"@type": "WebPage", "name": title, "description": desc, "url": url},
        {"@type": "BreadcrumbList", "itemListElement": [
            {"@type": "ListItem", "position": 1, "name": "Home", "item": f"{origin}/"},
            {"@type": "ListItem", "position": 2, "name": title, "item": url}]}]}
    faq = "".join(f"<details><summary>{e(q)}</summary><p>{e(a)}</p></details>" for q, a in FAQ)
    cap = e(plural)
    page = f"""<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>{e(title)} — {e(brand)}</title>
<meta name="description" content="{e(desc, quote=True)}">
<link rel="canonical" href="{e(url, quote=True)}">
<meta property="og:type" content="website"><meta property="og:site_name" content="{e(brand, quote=True)}">
<meta property="og:title" content="{e(title, quote=True)}"><meta property="og:description" content="{e(desc, quote=True)}">
<meta property="og:url" content="{e(url, quote=True)}">
<link rel="stylesheet" href="/assets/style.css">
{_ld_script(ld)}</head>
<body>
<nav><div class="wrap"><a class="logo" href="/"><i></i>{e(brand)}</a>
<div class="links"><a href="/#how">How it works</a><a href="/sample-report.html">Sample report</a><a href="/#pricing">Pricing</a><a class="btn" href="/#check">Free check</a></div></div></nav>
<header class="hero"><div class="wrap"><div>
<h1>{e(title)}</h1>
<p class="lead">When customers ask ChatGPT, Gemini or Claude for {cap} in their city, the assistant names a few businesses. The AI Visibility Check measures whether yours is one of them, and who is named instead.</p>
<p><a class="btn" data-pay="payLinkCheck" href="{e(pay, quote=True)}">Buy the AI Visibility Check — ${CHECK_PRICE}</a> &nbsp; <a class="btn ghost" href="/#check">Run a free quick check</a></p>
</div></div></header>
<section><div class="wrap">
<h2>What the check does for {cap}</h2>
<p class="sub">We ask each assistant the questions your customers ask, several times, and count how often your business is named. Every name is checked against official registers where we can, so you see real competitors and names that match no registered business.</p>
<h3>Questions customers ask AI</h3>
<p>Examples of the questions we use for this trade:</p>
<ul>{prompts}</ul>
<h3>What you get</h3>
<ul><li>How often each assistant names your business, with a range</li><li>Who is named instead, and how often</li><li>Names that match no registered business</li><li>Likely reasons and a prioritized fix list, with the strength of evidence behind each fix</li></ul>
<p>The report is delivered in 2 business days. It is a measurement, not a ranking promise. <a href="/sample-report.html">See the sample report</a>.</p>
<h3>Price</h3>
<p>${CHECK_PRICE}, one time, in US dollars. <a class="btn" data-pay="payLinkCheck" href="{e(pay, quote=True)}">Buy the AI Visibility Check</a> &nbsp; <a href="/#check">or run the free quick check first</a>.</p>
<p class="small">US businesses only. See the <a href="/refunds.html">refund policy</a>.</p>
</div></section>
<section id="common-questions"><div class="wrap"><h2>Common questions</h2>{faq}</div></section>
<footer><div class="wrap">
<p>© 2026 Dvir Baumel · {e(cfg['contactEmail'])} · <span class="addr">{{{{BUSINESS_ADDRESS}}}}</span></p>
<p><a href="/privacy.html">Privacy</a> · <a href="/terms.html">Terms</a> · <a href="/refunds.html">Refunds</a> · <a href="/">Home</a> · Not affiliated with OpenAI, Google or Anthropic.</p>
</div></footer>
<script src="/assets/config.js"></script><script src="/assets/app.js"></script>
</body></html>
"""
    return page.encode()
