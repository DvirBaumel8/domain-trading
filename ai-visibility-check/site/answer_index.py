"""Public "AI answer index" pages built ONLY from stored files data/answer-index/<slug>.json.

Route (hooked into server.py): GET /ai-answers/<slug>. The slug map is built from the validated files; a
request path is only looked up in that map and never used to open a file. Nothing is asked of any AI or
search service here, at build or at request time: the page is rendered from the stored JSON. Every number on
the page is computed from the `answers` in the file (the stored `counts` must agree with them, else the file
is skipped). No provider module is imported.
"""
import datetime, html, json, os, re, sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import discovery, cities                                 # noqa: E402  (origin helper, trade slugs, shared head/foot)

INDEX_DIR = os.path.join(HERE, "data", "answer-index")   # tests point this at a temp folder
SCHEMA = "local-ai-answer-index/1"
SITE_NAME = cities.SITE_NAME
MAX_FILE = 2_000_000
ENGINES = (("openai", "an OpenAI model"), ("claude", "an Anthropic Claude model"))
SHORT = {"hvac": "HVAC", "plumber": "plumbing"}          # short trade names for the title
_SLUG = re.compile(r"[a-z0-9]+(?:-[a-z0-9]+)*")
_KEY = re.compile(r"[a-z0-9_-]{1,40}")
_CITY = re.compile(r"[A-Za-z][A-Za-z .'-]{1,39}, [A-Z]{2}")
_MODEL = re.compile(r"\(([A-Za-z0-9._-]{1,60})\)")
_MONTHS = ("Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec")


def e(s):
    return html.escape(str(s), quote=True)


def _int(v, lo, hi):
    return isinstance(v, int) and not isinstance(v, bool) and lo <= v <= hi


def _str(v, lo, hi):
    return isinstance(v, str) and lo <= len(v.strip()) <= hi


def _date(s):
    if not isinstance(s, str) or not re.fullmatch(r"\d{4}-\d{2}-\d{2}", s):
        return None
    try:
        return datetime.date.fromisoformat(s)
    except ValueError:
        return None


def _trade(t):
    """-> validated trade dict with computed numbers, or None."""
    if not isinstance(t, dict) or not _str(t.get("label"), 2, 60):
        return None
    for_slug = t.get("for_slug")
    if not (isinstance(for_slug, str) and _SLUG.fullmatch(for_slug) and discovery.trade_by_slug(for_slug)):
        return None
    qs, n = t.get("questions"), t.get("answers_per_engine")
    if not _int(n, 1, 50) or not isinstance(qs, list) or len(qs) != n or not all(_str(q, 3, 300) for q in qs):
        return None
    answers = t.get("answers")
    if not isinstance(answers, list) or len(answers) != 2 * n:
        return None
    named = {k: [] for k, _ in ENGINES}                  # engine -> one name set per answer
    seen = set()
    for a in answers:
        if not isinstance(a, dict) or a.get("engine") not in named or not _int(a.get("q"), 1, n):
            return None
        if (a["engine"], a["q"]) in seen or not isinstance(a.get("names"), list) or len(a["names"]) > 60:
            return None
        seen.add((a["engine"], a["q"]))
        if not all(_str(x, 1, 120) for x in a["names"]):
            return None
        named[a["engine"]].append({x.strip() for x in a["names"]})
    per = {k: {} for k in named}                         # engine -> name -> answers naming it
    for k, sets in named.items():
        for s in sets:
            for x in s:
                per[k][x] = per[k].get(x, 0) + 1
    both = set(per["openai"]) & set(per["claude"])
    distinct = set(per["openai"]) | set(per["claude"])
    counts = t.get("counts")
    if not distinct or not isinstance(counts, list) or len(counts) != len(distinct):
        return None
    rows = []
    for r in counts:
        if not (isinstance(r, list) and len(r) == 3 and isinstance(r[0], str)
                and _int(r[1], 0, n) and _int(r[2], 0, n)):
            return None
        if (per["openai"].get(r[0], 0), per["claude"].get(r[0], 0)) != (r[1], r[2]):
            return None                                  # stored counts must agree with the stored answers
        rows.append((r[0], r[1], r[2]))
    if {r[0] for r in rows} != distinct:
        return None
    avg = {k: sum(len(s) for s in sets) / n for k, sets in named.items()}
    return {"label": t["label"].strip(), "for_slug": for_slug, "questions": [q.strip() for q in qs], "n": n,
            "rows": rows, "distinct": len(distinct), "engine_n": {k: len(per[k]) for k in per},
            "both": [r[0] for r in rows if r[0] in both], "avg": avg}


def validate(d):
    """-> page dict, or None if the file is not publishable (no valid data_date, malformed, inconsistent)."""
    try:
        if not isinstance(d, dict) or d.get("schema") != SCHEMA:
            return None
        slug, city, date = d.get("slug"), d.get("city"), _date(d.get("data_date"))
        if not (isinstance(slug, str) and _SLUG.fullmatch(slug) and isinstance(city, str)
                and _CITY.fullmatch(city) and date):
            return None
        method, eng, usage, trades = d.get("method"), d.get("engines"), d.get("usage"), d.get("trades")
        if not _str(method, 1, 2000) or not isinstance(eng, dict) or not isinstance(usage, dict):
            return None
        models, use = {}, {}
        for k, _ in ENGINES:
            lab = eng.get(k, {}).get("label") if isinstance(eng.get(k), dict) else None
            m = _MODEL.search(lab) if isinstance(lab, str) and len(lab) <= 200 else None
            u = usage.get(k)
            if not m or not isinstance(u, dict) or not all(_int(u.get(f), 0, 10**9) for f in
                                                           ("calls", "input_tokens", "output_tokens", "web_searches")):
                return None
            models[k], use[k] = m.group(1), {f: u[f] for f in ("calls", "input_tokens", "output_tokens", "web_searches")}
        if not isinstance(trades, dict) or not 1 <= len(trades) <= 4:
            return None
        out = {}
        for key, t in trades.items():
            tr = _trade(t) if isinstance(key, str) and _KEY.fullmatch(key) else None
            if tr is None:
                return None
            out[key] = tr
        return {"slug": slug, "city": city, "date": date, "method": method.strip(), "models": models,
                "usage": use, "trades": out}
    except Exception:
        return None


def load_pages(directory=None):
    """slug -> page, from the valid files only (sorted by file name; first slug wins)."""
    directory = directory or INDEX_DIR
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


def date_text(m):
    d = m["date"]
    return f"{d.day} {_MONTHS[d.month - 1]} {d.year}"


def _short(m):
    return " and ".join(SHORT.get(k, t["label"]) for k, t in m["trades"].items())


def headline(m):
    return f"Which businesses AI assistants named for {_short(m)} in {m['city']} (checked {date_text(m)})"


def describe(m):
    return (f"What two AI assistants answered to {sum(t['n'] for t in m['trades'].values())} fixed questions "
            f"about {_short(m)} in {m['city']} on {date_text(m)}: the business names they gave. "
            f"Stored AI output, not a recommendation or a ranking of quality.")


def public_entries():
    """[(path, link text)] of the valid pages, for the sitemap / llms.txt (empty when no valid file)."""
    ms = load_pages()
    return [(f"/ai-answers/{s}", headline(ms[s])) for s in sorted(ms)]


def public_paths():
    return [p for p, _ in public_entries()]


def _trade_section(m, key, t):
    n, when = t["n"], date_text(m)
    qs = "".join(f"<li>{e(q)}</li>" for q in t["questions"])
    rows = "".join(f"<tr><td>{e(nm)}</td><td>{o}</td><td>{c}</td></tr>" for nm, o, c in t["rows"])
    both = "".join(f"<li>{e(x)}</li>" for x in t["both"])
    both_block = (f'<p>Named by both:</p>\n<ul class="both">{both}</ul>\n' if both else "")
    return (f'<h2>{e(t["label"][0].upper() + t["label"][1:])} in {e(m["city"].split(",")[0])} — AI output, checked on {e(when)}</h2>\n'
            f'<h3>Questions asked</h3>\n<ol class="questions">{qs}</ol>\n'
            f'<h3>Facts computed from the answers</h3>\n<ul>'
            f'<li>Distinct businesses named in total: {t["distinct"]}</li>'
            f'<li>Named by the OpenAI model: {t["engine_n"]["openai"]}</li>'
            f'<li>Named by the Claude model: {t["engine_n"]["claude"]}</li>'
            f'<li>Named by both: {len(t["both"])}</li></ul>\n{both_block}'
            f'<table><caption>Count = how many of the {n} answers contained the name. Not a quality ranking.</caption>'
            f'<thead><tr><th>Business (as named in the answers)</th><th>OpenAI: answers naming it (of {n})</th>'
            f'<th>Claude: answers naming it (of {n})</th></tr></thead><tbody>{rows}</tbody></table>\n'
            f'<p><a href="/for/{e(t["for_slug"])}">AI visibility for {e(t["label"])}: what the check measures</a></p>\n')


def page(m, base):
    """The one template function for the page. Contains the {{BUSINESS_ADDRESS}} token for render_page."""
    url = f"{base}/ai-answers/{m['slug']}"
    when = date_text(m)
    total_q = sum(t["n"] for t in m["trades"].values())
    eng = "; ".join(f"{name} ({m['models'][k]}), with web search" for k, name in ENGINES)
    use = "; ".join(f"{name}: {m['usage'][k]['calls']} answers, {m['usage'][k]['web_searches']} web searches, "
                    f"{m['usage'][k]['input_tokens']:,} input and {m['usage'][k]['output_tokens']:,} output tokens"
                    for k, name in (("openai", "OpenAI"), ("claude", "Claude")))
    sections = "".join(_trade_section(m, k, t) for k, t in m["trades"].items())
    shows = "".join(
        f'<li>{e(t["label"])}: {len(t["both"])} of {t["distinct"]} distinct businesses were named by both assistants. '
        f'Average names per answer: OpenAI model {t["avg"]["openai"]:.1f}, Claude model {t["avg"]["claude"]:.1f}.</li>'
        for t in m["trades"].values())
    body = (f'<section><div class="wrap">\n<h1>{e(headline(m))}</h1>\n'
            f'<p class="sub"><strong>AI output, checked on {e(when)}.</strong> This page shows what two AI assistants '
            f'answered to {total_q} fixed questions. It is not our recommendation and not a ranking of business quality.</p>\n'
            f'<div class="card"><h2>Method</h2>\n<p>Engines: {e(eng)}.</p>\n<p>{e(m["method"])}</p>\n'
            f'<p>Each question was asked once to each assistant. Answers change from one ask to the next. A mention can be '
            f'a caveat, not a recommendation. We did not verify the businesses.</p>\n'
            f'<p>What the run used: {e(use)}.</p></div>\n'
            f'{sections}'
            f'<h2>What this shows</h2>\n<ul>{shows}</ul>\n'
            f'<p>Not being named here does not mean a business is worse; it means these answers, on this date, did not name it.</p>\n'
            f'<h2>Check your own business</h2>\n'
            f'<p><a class="btn ghost" href="/#check">Run a free quick check</a></p>\n'
            f'<p>For agencies tracking several clients: <a href="/reserve">reserve a spot</a> for monthly tracking. '
            f'Reserving is free: no payment, no card.</p>\n'
            f'</div></section>\n')
    return cities._head(headline(m), describe(m), url) + cities._NAV + body + cities._FOOT


def route(path, headers):
    """-> None if not an /ai-answers route, else (status, content-type, body bytes). The path is only compared
    with the slug map; it never reaches the filesystem."""
    if not path.startswith("/ai-answers/"):
        return None
    ms = load_pages()
    parts = path[len("/ai-answers/"):].split("/")
    if len(parts) == 1 and parts[0] in ms:
        base = discovery.public_origin(headers.get("Host"), headers.get("X-Forwarded-Proto"))
        return 200, "text/html; charset=utf-8", page(ms[parts[0]], base).encode()
    return 404, "application/json", b'{"error": "not found"}'
