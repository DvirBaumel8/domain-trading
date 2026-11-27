"""Search/AI discoverability: sitemap, llms.txt, JSON-LD, FAQ and one landing page per trade.

Everything here is built at request time from products.py (names, prices), the FAQ constant below
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
sys.path.insert(0, HERE)
import products                         # noqa: E402

# Names and prices come ONLY from products.py (the Polar map). This table holds wording, keyed by order type.
# The Maps line is the visible table's wording and must not be stronger than it ("once we have access").
DESCRIPTIONS = {
    "base": "Whether ChatGPT, Gemini or Claude name you; who they name instead; a prioritized fix list.",
    "maps": "Name, address, phone, categories, services and description checked; 4 posts; a map-visibility "
            "baseline once we have access.",
    "listings_check": "The audit only: 17 directories AI assistants read, listed, wrong or missing, plus an ordered "
                      "checklist, delivered as a report.",
    "listings": "The audit plus a ready-to-paste corrected-listing pack: fixed name, address, phone, hours and "
                "description texts for each directory, and a step list you follow to apply them.",
    "content": "Full-site crawl, a priority table, rewrites for 5 pages, and ready-to-paste structured data.",
    "bundle": "AI Visibility Check + Google Maps Visibility Check + Listings with fix pack + AI Content Pack.",
}
PRODUCT_ORDER = ("base", "maps", "listings_check", "listings", "content", "bundle")
CHECK_PRICE = products.TYPES["base"]["price_usd"]
BASE_NAME = products.site_name(products.TYPES["base"])
COMING_SOON_PLANS = ("Visibility", "Growth", "Dominate")   # monthly plans: never get an offer in the schema


def addon_offers_enabled():
    """The ONE switch for every add-on checkout link and add-on `offers` entry on discovery and city pages.
    It is main's ADDONS_CHECKOUT helper (on unless the env value is exactly 'off') and nothing else."""
    return products.addons_checkout_on()


def product_list():
    """[{type, name, price, description}] from products.py, in display order."""
    return [{"type": t, "name": products.site_name(products.TYPES[t]), "price": products.TYPES[t]["price_usd"],
             "description": DESCRIPTIONS[t]} for t in PRODUCT_ORDER]


def offer_types():
    """Order types that may carry a price or an offer on the pages built here."""
    return PRODUCT_ORDER if addon_offers_enabled() else ("base",)


def pay_keys():
    """config.js buy-button keys that the pages built here may use."""
    allowed = set(offer_types())
    return [k for k, t in products.PAY_KEYS.items() if t in allowed]


# Visible FAQ (home page) and the FAQPage JSON-LD are both generated from this list (plain text answers).
# Every claim is one the pages already make (index.html, refunds.html).
FAQ = (
    ("Can you guarantee that ChatGPT will recommend my business?",
     "No, and nobody honestly can. AI assistants change their answers constantly. We measure how often you're named, "
     "show you what the businesses being named have in common, and help you fix what's in your control. "
     "Then we re-measure with the same questions."),
    ("Is this what I'd see if I asked ChatGPT myself?",
     "Close, but not identical. Answers vary by person, location and time \u2014 identical lists repeat in under 1% of "
     "runs (SparkToro, January 2026). That's why we ask many questions several times and report a rate with a range, "
     "instead of one screenshot."),
    ("Which AI assistants do you check?",
     "The paid report checks ChatGPT, Gemini and Claude with their web-search features turned on. The free quick check "
     "is AI output from one AI model with web search, asked once for the businesses it would name, so treat it as a first look."),
    ("What do the fixes involve?",
     "Mostly the basics AI assistants read: complete and consistent profiles on the sites they cite for your trade "
     "(Google, Yelp, Healthgrades, Avvo and so on), clear service and city information on your website, and honest "
     "review requests to real customers. Studies link these to being named; none prove a guaranteed effect, and we say "
     "which evidence is stronger."),
    ("Do you post fake reviews or spam forums?",
     "Never. Fake reviews are illegal under the FTC's rule, and undisclosed forum posting backfires. We only work with "
     "real customers and truthful content."),
    ("Are you affiliated with OpenAI, Google or Anthropic?",
     "No. We're an independent service. Product names belong to their owners."),
    ("What do you do with my data?",
     "We use your business details to run your check and your email to identify your order. We don't sell data. "
     "See the privacy policy."),
    ("What do I get, and when?",
     "A one-page report: how often you're named, who's named instead, the likely reasons, and a prioritized fix list. "
     "The AI Visibility Check is delivered in 2 business days."),
    ("What does it cost?",
     f"The AI Visibility Check is ${CHECK_PRICE}, one time, in US dollars, paid at checkout."),
    ("Are the monthly plans available?",
     "Not yet. The Visibility, Growth and Dominate monthly plans are coming soon: use \u201cComing soon - join "
     "waitlist\u201d under a plan and we will tell you when it opens."),
    ("Which businesses is it for?",
     "US businesses only. Enter a US city and state, such as Austin, TX."),
    ("What is the refund policy?",
     "If we do not deliver within 5 business days after we have both your payment and a completed intake form, "
     "you get a full refund. We do not refund a delivered report solely because an AI assistant still does not name "
     "your business. See the refund policy."),
)
_FAQ_LINKS = (("privacy policy", "/privacy.html"), ("refund policy", "/refunds.html"))

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
    """brand, base checkout URL and public contact: the same sources server.config_js() uses
    (there is no static assets/config.js any more)."""
    from site_config import SUPPORT_EMAIL
    return {"brand": "AI Visibility Check", "payLinkCheck": products.PAY_LINKS["payLinkCheck"],
            "contactEmail": SUPPORT_EMAIL}


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


def trade_slug_for_niche(key):
    """Trade-page slug of a niche key (as in the market cache), or None when that niche has no trade page."""
    for s, n in trades():
        if n.key == key:
            return s
    return None


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
    priced = offer_types()
    items = []
    for p in product_list():
        item = {"@type": "Product", "name": p["name"], "description": p["description"],
                "brand": {"@type": "Brand", "name": cfg["brand"]}}
        if p["type"] in priced:           # add-ons carry no offer or price while the add-on switch is off
            item["offers"] = {"@type": "Offer", "price": str(p["price"]), "priceCurrency": "USD",
                              "availability": "https://schema.org/InStock"}
        items.append(item)
    return _ld_script({"@context": "https://schema.org", "@graph": [org, *items, faq_ld()]})


def _faq_answer_html(a):
    out = _html.escape(a)
    for text, href in _FAQ_LINKS:
        out = out.replace(text, f'<a href="{href}">{text}</a>', 1)
    return out


def faq_items_html():
    return "".join(f"<details><summary>{_html.escape(q)}</summary><p>{_faq_answer_html(a)}</p></details>" for q, a in FAQ)


def faq_section_html():
    """The one FAQ block of the home page ("Honest answers"); FAQPage JSON-LD is built from the same FAQ."""
    return f'<section id="faq"><div class="wrap"><h2>Honest answers</h2>{faq_items_html()}</div></section>'


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
def city_paths():
    import cities                       # lazy: cities imports this module
    return cities.public_paths()


def sitemap_xml(origin=""):
    paths = list(PUBLIC_PAGES) + trade_paths() + city_paths()
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
    cp = city_paths()
    if cp:
        import cities
        lines += ["", "## City snapshots (dated, not rankings)"] + [f"- [{t}]({o}{p})" for p, t in cities.public_entries()]
    lines += ["", "## Help",
              f"- [Honest answers (FAQ)]({o}/#faq)",
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
    faq = faq_items_html()
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
<p><a class="btn" data-pay="payLinkCheck" href="{e(pay, quote=True)}">Buy the {e(BASE_NAME)} — ${CHECK_PRICE}</a> &nbsp; <a class="btn ghost" href="/#check">Run a free quick check</a></p>
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
<p>${CHECK_PRICE}, one time, in US dollars. <a class="btn" data-pay="payLinkCheck" href="{e(pay, quote=True)}">Buy the {e(BASE_NAME)}</a> &nbsp; <a href="/#check">or run the free quick check first</a>.</p>
<p class="small">US businesses only. See the <a href="/refunds.html">refund policy</a>.</p>
</div></section>
<section id="faq"><div class="wrap"><h2>Honest answers</h2>{faq}</div></section>
<footer><div class="wrap">
<p>© 2026 Dvir Baumel · {e(cfg['contactEmail'])} · <span class="addr">{{{{BUSINESS_ADDRESS}}}}</span></p>
<p><a href="/privacy.html">Privacy</a> · <a href="/terms.html">Terms</a> · <a href="/refunds.html">Refunds</a> · <a href="/">Home</a> · Not affiliated with OpenAI, Google or Anthropic.</p>
</div></footer>
<script src="/assets/ref.js"></script><script src="/assets/config.js"></script><script src="/assets/app.js"></script>
</body></html>
"""
    return page.encode()
