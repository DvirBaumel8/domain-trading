"""Twelve static guide pages: /guide/<trade-slug>-<metro-slug>.

Zero AI cost and nothing measured: every page is built from text and data already in the repo
(the engine's TEMPLATES and niche labels/services, plus the fixed place lists below). No model call,
no network call, no stored answer data. Nothing reads a file named by a request: a request path is only
compared with the allow-list built here. Same render-at-request pattern as discovery.trade_page.
`python site/guides.py OUTDIR` writes the same pages to files for review.
"""
import html as _html
import random
import re
import sys
import os

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import discovery                                  # noqa: E402  (trade slugs, site config, origin, check price)
from aivis.prompts import TEMPLATES               # noqa: E402

TRADE_SLUGS = ("dentists", "personal-injury-lawyers", "roofing-companies", "plumbers")
METROS = (
    ("austin-tx", "Austin, TX", ("Austin", "Round Rock", "Cedar Park", "Lakeway", "Liberty Hill", "Georgetown"), "TX"),
    ("phoenix-az", "Phoenix, AZ", ("Phoenix", "Scottsdale", "Tempe", "Mesa", "Gilbert", "Chandler"), "AZ"),
    ("raleigh-durham-nc", "Raleigh-Durham, NC", ("Raleigh", "Durham", "Cary", "Chapel Hill"), "NC"),
)
QUESTION_COUNT = 8
SEED = 1                                          # fixed: the same questions on every build
PAGE_DATE = "27 November 2026"
INTENTS = ("best", "service", "cost")             # no need / attribute / near: those can imply health, legal or safety claims
# Words no page may carry (the tests use this list too). Templates that contain one are skipped.
FORBIDDEN = (r"\bbest\b", r"\btop\b", r"top-rated", r"#1", r"guarantee", r"ranked", r"review", r"\d\s*%")
_FORBIDDEN_RE = re.compile("|".join(FORBIDDEN), re.I)

# Official register block: dropped. No state licence or bar lookup page could be confirmed in a real browser
# on 27 Nov 2026 (see the PR description), so none is shown. Add (trade slug, metro slug) -> (url, label) here
# only after Dvir confirms the page in a browser.
REGISTERS = {}


def pages():
    """[(path slug, trade slug, niche, metro tuple)] for the 12 pages, in a fixed order."""
    out = []
    for ts in TRADE_SLUGS:
        niche = discovery.trade_by_slug(ts)
        if niche is None:
            raise ValueError("unknown trade slug " + ts)
        for m in METROS:
            out.append((f"{ts}-{m[0]}", ts, niche, m))
    return out


def guide_paths():
    return [f"/guide/{s}" for s, _, _, _ in pages()]


def guide_entries():
    """[(path, link text)] for llms.txt."""
    return [(f"/guide/{s}", h1(n, m)) for s, _, n, m in pages()]


def h1(niche, metro):
    return f"How customers ask AI for a {niche.label} in {metro[1]}: example questions"


def questions(niche, metro):
    """8 example questions from the engine TEMPLATES, deterministic, no model call."""
    _, _, places, state = metro
    tpls = sorted({t for i in INTENTS for t in TEMPLATES[i] if not _FORBIDDEN_RE.search(t)})
    services = [s for s in niche.services if not _FORBIDDEN_RE.search(s)]
    rng = random.Random(f"guide|{niche.key}|{metro[0]}|{SEED}")
    rng.shuffle(tpls)
    out, seen, i = [], set(), 0
    while len(out) < QUESTION_COUNT and i < 200:
        city = f"{places[i % len(places)]}, {state}"
        text = tpls[i % len(tpls)].format(label=niche.label, plural=niche.plural, city=city,
                                          service=rng.choice(services))
        i += 1
        if text not in seen:
            seen.add(text)
            out.append(text)
    return out


def page(path_slug, origin=""):
    """HTML bytes (still holding {{BUSINESS_ADDRESS}}) for an allow-listed guide slug, else None."""
    entry = next((p for p in pages() if p[0] == path_slug), None)
    if entry is None:
        return None
    _, tslug, niche, metro = entry
    e, cfg = _html.escape, discovery.site_config()
    brand, url = cfg["brand"], f"{origin}/guide/{path_slug}"
    title = h1(niche, metro)
    desc = (f"Example questions customers could ask an AI assistant for {niche.plural} in {metro[1]}, "
            f"with a note on what a check measures. Examples only: no measured result.")
    qs = "".join(f"<li>“{e(q)}”</li>" for q in questions(niche, metro))
    reg = REGISTERS.get((tslug, metro[0]))
    register = (f'<h2>Official register</h2>\n<p>Check any name against the official register. '
                f'<a href="{e(reg[0], quote=True)}" rel="noopener">{e(reg[1])}</a></p>\n' if reg else "")
    related = []
    if path_slug == "dentists-austin-tx":
        related.append('<li><a href="/city/dentists-austin-tx">Dated snapshot of AI answers for dentists in Austin, TX</a></li>')
    for s, ts, n, m in pages():
        if ts == tslug and m[0] != metro[0]:
            related.append(f'<li><a href="/guide/{s}">{e(n.plural.capitalize())} in {e(m[1])}</a></li>')
    for s, ts, n, m in pages():
        if m[0] == metro[0] and ts != tslug:
            related.append(f'<li><a href="/guide/{s}">{e(n.plural.capitalize())} in {e(m[1])}</a></li>')
    pay = cfg["payLinkCheck"] or "#"
    page_html = f"""<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>{e(title)} — {e(brand)}</title>
<meta name="description" content="{e(desc, quote=True)}">
<link rel="canonical" href="{e(url, quote=True)}">
<meta property="og:type" content="website"><meta property="og:site_name" content="{e(brand, quote=True)}">
<meta property="og:title" content="{e(title, quote=True)}"><meta property="og:description" content="{e(desc, quote=True)}">
<meta property="og:url" content="{e(url, quote=True)}">
<link rel="stylesheet" href="/assets/style.css"></head>
<body>
<nav><div class="wrap"><a class="logo" href="/"><i></i>{e(brand)}</a>
<div class="links"><a href="/#how">How it works</a><a href="/sample-report.html">Sample report</a><a href="/#pricing">Pricing</a><a class="btn" href="/#check">Free check</a></div></div></nav>
<section><div class="wrap">
<h1>{e(title)}</h1>
<p class="sub">As of {PAGE_DATE}, AI assistants answer from memory and their answers change from one ask to the next. This page does not show any measured result: the questions below are examples, not results.</p>
<h2>Example questions</h2>
<p>Questions of this kind, with places around {e(metro[1])}:</p>
<ul>{qs}</ul>
<h2>What a check measures</h2>
<p>We ask each assistant the questions your customers ask, several times, and count how often your business is named. <a href="/for/{e(tslug)}">What the check does for {e(niche.plural)}</a> · <a href="/sample-report.html">See the sample report</a> · <a class="btn ghost" href="/#check">Run a free quick check</a></p>
<p class="small"><a data-pay="payLinkCheck" href="{e(pay, quote=True)}">The AI Visibility Check</a> is ${discovery.CHECK_PRICE}, one time. US businesses only.</p>
{register}<h2>Related</h2>
<ul>{"".join(related)}</ul>
</div></section>
<footer><div class="wrap">
<p>© 2026 Dvir Baumel · {e(cfg['contactEmail'])} · <span class="addr">{{{{BUSINESS_ADDRESS}}}}</span></p>
<p><a href="/privacy.html">Privacy</a> · <a href="/terms.html">Terms</a> · <a href="/refunds.html">Refunds</a> · <a href="/">Home</a> · Not affiliated with OpenAI, Google or Anthropic.</p>
</div></footer>
<script src="/assets/ref.js"></script><script src="/assets/config.js"></script><script src="/assets/app.js"></script>
</body></html>
"""
    return page_html.encode()


def route_slug(path):
    """The slug of a /guide/<slug> path, or None (the slug is only ever compared with the allow-list)."""
    m = re.fullmatch(r"/guide/([a-z0-9-]{1,80})", path)
    return m.group(1) if m else None


if __name__ == "__main__":
    out = sys.argv[1] if len(sys.argv) > 1 else "guide-out"
    os.makedirs(out, exist_ok=True)
    for s, *_ in pages():
        with open(os.path.join(out, s + ".html"), "wb") as fh:
            fh.write(page(s, os.environ.get("AIVIS_PUBLIC_BASE_URL", "").rstrip("/")))
    print(f"wrote {len(pages())} pages to {out}")
