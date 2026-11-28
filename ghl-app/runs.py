"""The run engine: twice-a-month AI visibility runs per location, with spend caps.

Trigger: POST /cron/tick with header X-Cron-Secret (env GHL_CRON_SECRET). A tick does due work only and is
safe to repeat: every run has a unique (location, key) claimed before any call is made.
Run keys: "install" (right after install) and "YYYY-MM-01" / "YYYY-MM-15" (UTC). Never a double run.

Storage: the shared Store (store.get_store()). Its run_claims table makes the (location, key) claim atomic;
every call's cost is written to the spend table, and the caps read spend back from there. Locations are dicts:
  {id, agency_id, name, category, city, plan: "trial"|"paid", installed_at: ISO UTC, active: bool}

AI calls go through CALLERS[engine](prompt, location) -> {"text": str, "sources": [url]}; tests replace them.
Ideas reused from ai-visibility-check/engine/aivis (not imported, files untouched): list/bold candidate
extraction (parse.py), 'best X in Y' prompt phrasing (prompts.py), per-call price table (config.py).
"""
import hmac, json, re, threading, urllib.request
from datetime import datetime, timezone

import config
import store

MAX_PROMPTS = 10
EXCERPT_CHARS = 300
ENGINES = ("openai", "anthropic", "perplexity")

# Flat USD per call, search included (sources: AVC config.py, 26 Nov 2026: web search about $10 per 1,000 calls,
# plus a few hundred tokens at small-model rates). Check against real billing after the first live run.
PRICE_PER_CALL_USD = {"openai": 0.0095, "anthropic": 0.0098, "perplexity": 0.0060}
MODELS = {"openai": "gpt-4o-mini", "anthropic": "claude-haiku-5-5", "perplexity": "sonar"}

_lock = threading.RLock()


# ---------- prompts ----------
def default_prompts(location):
    cat = (location.get("category") or "").strip().lower()
    city = (location.get("city") or "").strip()
    if not cat or not city:
        return []
    t = [f"best {cat} in {city}", f"top-rated {cat} in {city}", f"who is the best {cat} in {city}?",
         f"can you recommend a good {cat} in {city}?", f"most trusted {cat} near me in {city}",
         f"{cat} in {city} with the best reviews", f"affordable {cat} in {city}",
         f"I just moved to {city}. Which {cat} should I go to?", f"compare the best {cat} in {city}",
         f"{cat} open now in {city}"]
    return t[:MAX_PROMPTS]


def prompt_items(location):
    """[(prompt_id, text)]: the location's own prompts, else the defaults with negative ids (never stored)."""
    custom = store.get_store().list_prompts(location["id"])
    if custom:
        return [(p["id"], p["text"]) for p in custom][:MAX_PROMPTS]
    return [(-i, t) for i, t in enumerate(default_prompts(location), 1)]


def prompts_for(location):
    return [t for _, t in prompt_items(location)]


# ---------- parsing ----------
_LEAD = re.compile(r"^\s*(?:\d+[.)]|[-*•–]|#{1,4})\s+")
_BOLD = re.compile(r"\*\*([^*]{2,80})\*\*")
_URL = re.compile(r"https?://[^\s)\]>\"']+")
_SUFFIX = re.compile(r"\b(llc|inc|pllc|pc|ltd|co|corp|llp|the)\b")


def _norm(s):
    s = _SUFFIX.sub(" ", s.lower().replace("&", " and "))
    return re.sub(r"\s+", " ", re.sub(r"[^a-z0-9' ]+", " ", s)).strip()


def _candidates(text):
    out, seen = [], set()
    for line in text.splitlines():
        found = _BOLD.findall(line) or ([_LEAD.sub("", line)] if _LEAD.match(line) else [])
        for c in found:
            c = re.split(r"\s+[–—-]\s+|:\s|\s\(|\s\|\s", c.strip().strip("*_`\"' "), maxsplit=1)[0].strip("*_`\"'.:; ")
            n = _norm(c)
            if n and len(n) >= 3 and len(n.split()) <= 9 and n not in seen:
                seen.add(n)
                out.append(c)
    return out


def parse_answer(text, business_name, sources=()):
    """-> {mentioned, position, competitors, sources, excerpt}. Only a 300-char excerpt is kept."""
    text = text or ""
    me = _norm(business_name or "")
    cands = _candidates(text)
    position, comps = None, []
    for i, c in enumerate(cands, 1):
        n = _norm(c)
        if me and (n == me or me in n or (len(n) >= 5 and n in me)):
            position = position or i
        else:
            comps.append(c)
    mentioned = position is not None or bool(me and len(me) >= 3 and f" {me} " in f" {_norm(text)} ")
    urls = list(dict.fromkeys(list(sources or []) + _URL.findall(text)))[:10]
    low = text.lower()
    idx = low.find((business_name or "").lower()) if mentioned and business_name else -1
    start = max(0, idx - 100) if idx >= 0 else 0
    return {"mentioned": mentioned, "position": position, "competitors": comps[:10], "sources": urls,
            "excerpt": text[start:start + EXCERPT_CHARS]}


# ---------- engines (real HTTP; tests replace CALLERS) ----------
def _post(url, payload, headers):
    req = urllib.request.Request(url, data=json.dumps(payload).encode(), headers=headers, method="POST")
    with urllib.request.urlopen(req, timeout=60) as r:       # errors are caught by the caller, never echoed
        return json.loads(r.read().decode())


def _call_openai(prompt, loc):
    d = _post("https://api.openai.com/v1/responses",
              {"model": MODELS["openai"], "input": prompt, "max_output_tokens": 700,
               "tools": [{"type": "web_search", "search_context_size": "low",
                          "user_location": {"type": "approximate", "country": "US", "city": loc.get("city", "")}}]},
              {"Authorization": "Bearer " + config.get()["OPENAI_API_KEY"], "Content-Type": "application/json"})
    text, urls = "", []
    for item in d.get("output", []):
        for c in item.get("content", []) or []:
            if c.get("type") == "output_text":
                text += c.get("text", "")
                urls += [a["url"] for a in c.get("annotations", []) if a.get("url")]
    return {"text": text, "sources": urls}


def _call_anthropic(prompt, loc):
    d = _post("https://api.anthropic.com/v1/messages",
              {"model": MODELS["anthropic"], "max_tokens": 700, "messages": [{"role": "user", "content": prompt}],
               "tools": [{"type": "web_search_20250305", "name": "web_search", "max_uses": 1}]},
              {"x-api-key": config.get()["ANTHROPIC_API_KEY"], "anthropic-version": "2023-06-01",
               "content-type": "application/json"})
    text, urls = "", []
    for b in d.get("content", []):
        if b.get("type") == "text":
            text += b.get("text", "")
            urls += [c["url"] for c in b.get("citations", []) or [] if c.get("url")]
    return {"text": text, "sources": urls}


def _call_perplexity(prompt, loc):
    d = _post("https://api.perplexity.ai/chat/completions",
              {"model": MODELS["perplexity"], "max_tokens": 700, "messages": [{"role": "user", "content": prompt}]},
              {"Authorization": "Bearer " + config.get()["PERPLEXITY_API_KEY"], "Content-Type": "application/json"})
    text = ((d.get("choices") or [{}])[0].get("message") or {}).get("content", "")
    return {"text": text, "sources": list(d.get("citations") or [])}


CALLERS = {"openai": _call_openai, "anthropic": _call_anthropic, "perplexity": _call_perplexity}


# ---------- time, caps ----------
def _utc(now=None):
    return (now or datetime.now(timezone.utc)).astimezone(timezone.utc)


def _parse_ts(s):
    d = datetime.fromisoformat(str(s).replace("Z", "+00:00"))
    return d if d.tzinfo else d.replace(tzinfo=timezone.utc)


def period_key(now):
    """Latest scheduled slot (day 1 or 15, UTC) at or before now -> (key, start)."""
    day = 15 if now.day >= 15 else 1
    start = now.replace(day=day, hour=0, minute=0, second=0, microsecond=0)
    return start.strftime("%Y-%m-%d"), start


def month_spend(now, location_id=None):
    """Spend so far in now's UTC month, read from the Store (one location, or the whole app)."""
    return round(store.get_store().spend_total(now.strftime("%Y-%m"), location_id), 6)


def _over_cap(loc, now, cost):
    cfg = config.get()
    return (month_spend(now, loc["id"]) + cost > cfg["GHL_PER_LOCATION_CAP_USD"] + 1e-9
            or month_spend(now) + cost > cfg["GHL_MONTHLY_CAP_USD"] + 1e-9)


def cost_of_full_run(n_prompts, engine):
    return round(n_prompts * PRICE_PER_CALL_USD[engine], 6)


# ---------- the run ----------
def execute_run(loc, key, now):
    """Claim (location, key) atomically, then call each configured engine. None if nothing was started."""
    st = store.get_store()
    items = prompt_items(loc)
    if not items or not st.claim_run(loc["id"], key):
        return None
    cfg = config.get()
    run = {"location_id": loc["id"], "key": key, "started_at": now.isoformat(), "status": "running", "engines": {}}
    day, capped, total = now.strftime("%Y-%m-%d"), False, 0.0
    for eng in ENGINES:
        if not cfg[eng.upper() + "_API_KEY"]:
            run["engines"][eng] = {"status": config.NOT_CONFIGURED}
            continue
        status, answers, cost = "ok", [], 0.0
        for pid, p in items:
            price = PRICE_PER_CALL_USD[eng]
            if _over_cap(loc, now, price):              # checked BEFORE the call
                capped = True
                status = "cap_reached"
                break
            try:
                ans = CALLERS[eng](p, loc)
                parsed = parse_answer(ans.get("text", ""), loc.get("name", ""), ans.get("sources", ()))
                answers.append({"prompt_id": pid, **parsed})   # parsed has no full text: only a 300-char excerpt
                spent = price
            except Exception:                           # never echo the message: it could carry request details
                spent = 0.0
            if spent:
                st.add_spend(day, eng, spent, loc["id"])
                cost += spent
        if answers or cost:
            st.add_run(loc["id"], eng, status="done" if status == "ok" else status, cost_usd=cost,
                       started_at=now.isoformat(), answers=answers)
        run["engines"][eng] = {"status": status, "answers": len(answers)}
        total += cost
        if capped:
            break
    run["status"] = "cap_reached" if capped else "complete"
    run["cost_usd"] = round(total, 6)
    return run


def _trial_allowed(locs):
    """Ids of trial locations inside the per-agency trial limit (oldest installs first)."""
    allowed, per_agency = set(), {}
    for l in sorted(locs, key=lambda x: (str(x.get("installed_at", "")), str(x["id"]))):
        if l.get("plan") == "trial":
            n = per_agency.get(l.get("agency_id"), 0)
            if n < config.get()["GHL_TRIAL_MAX_LOCATIONS"]:
                per_agency[l.get("agency_id")] = n + 1
                allowed.add(l["id"])
    return allowed


def run_now(location_id, now=None):
    """On-demand run for one location, at most one per UTC day. -> {"started": bool, "reason"?, "status"?}."""
    now = _utc(now)
    st = store.get_store()
    loc = st.get_location(location_id)
    if not loc or not loc["active"]:
        return {"started": False, "reason": "not_installed"}
    with _lock:
        if loc["plan"] == "trial" and loc["id"] not in _trial_allowed([l for l in st.list_locations() if l["active"]]):
            return {"started": False, "reason": "trial_limit"}
        if not prompt_items(loc):
            return {"started": False, "reason": "no_prompts"}
        run = execute_run(loc, "manual-" + now.strftime("%Y-%m-%d"), now)
    if run is None:
        return {"started": False, "reason": "already_ran_today"}
    return {"started": True, "status": run["status"], "cost_usd": run["cost_usd"]}


def tick(now=None):
    """Do due work only. Returns a summary; repeating it the same day starts nothing new."""
    now = _utc(now)
    out = {"enabled": config.get()["GHL_APP_ENABLED"], "started": [], "skipped_trial": []}
    if not out["enabled"]:
        return out
    st = store.get_store()
    with _lock:
        locs = [l for l in st.list_locations() if l["active"]]
        allowed = _trial_allowed(locs)
        pkey, pstart = period_key(now)
        for l in locs:
            if l.get("plan") == "trial" and l["id"] not in allowed:
                out["skipped_trial"].append(l["id"])
                continue
            if not st.has_run(l["id"], "install"):
                key = "install"
            elif _parse_ts(l["installed_at"]) < pstart and not st.has_run(l["id"], pkey):
                key = pkey
            else:
                continue
            run = execute_run(l, key, now)
            if run:
                out["started"].append({"location_id": l["id"], "key": key, "status": run["status"],
                                       "cost_usd": run["cost_usd"]})
    return out


# ---------- route ----------
def handle_tick(req):
    secret = config.get()["GHL_CRON_SECRET"]
    given = req.headers.get("X-Cron-Secret", "") if req.headers else ""
    if not secret or not hmac.compare_digest(secret.encode(), given.encode()):
        return 401, {"error": {"code": "unauthorized", "message": "Missing or wrong cron secret", "details": {}}}
    return 200, tick()


def register(routes):
    """routes maps (METHOD, path) -> handler(req) -> (status, json-able dict)."""
    routes[("POST", "/cron/tick")] = handle_tick
