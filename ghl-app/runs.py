"""The run engine: twice-a-month AI visibility runs per location, with spend caps.

Trigger: POST /cron/tick with header X-Cron-Secret (env GHL_CRON_SECRET). A tick does due work only and is
safe to repeat: every run has a unique (location, key) claimed before any call is made.
Run keys: "install" (right after install) and "YYYY-MM-01" / "YYYY-MM-15" (UTC). Never a double run.

Storage: the module uses STORE, an object with the methods of MemStore below. The real store module can
supply one with set_store(); until then MemStore (in memory) is used. Locations are dicts:
  {id, agency_id, name, category, city, plan: "trial"|"paid", installed_at: ISO UTC, active: bool}

AI calls go through CALLERS[engine](prompt, location) -> {"text": str, "sources": [url]}; tests replace them.
Ideas reused from ai-visibility-check/engine/aivis (not imported, files untouched): list/bold candidate
extraction (parse.py), 'best X in Y' prompt phrasing (prompts.py), per-call price table (config.py).
"""
import hmac, json, os, re, threading, urllib.request
from datetime import datetime, timezone

import config

MAX_PROMPTS = 10
EXCERPT_CHARS = 300
ENGINES = ("openai", "anthropic", "perplexity")

# Flat USD per call, search included (sources: AVC config.py, 26 Nov 2026: web search about $10 per 1,000 calls,
# plus a few hundred tokens at small-model rates). Check against real billing after the first live run.
PRICE_PER_CALL_USD = {"openai": 0.0095, "anthropic": 0.0098, "perplexity": 0.0060}
MODELS = {"openai": "gpt-4o-mini", "anthropic": "claude-haiku-5-5", "perplexity": "sonar"}

_lock = threading.RLock()


# ---------- storage (replaceable) ----------
class MemStore:
    def __init__(self):
        self.locations, self.prompts, self.runs = {}, {}, {}   # runs: (location_id, key) -> run dict

    def add_location(self, loc):
        self.locations[loc["id"]] = dict(loc)

    def list_locations(self):
        return [dict(v) for v in self.locations.values()]

    def get_prompts(self, location_id):
        return self.prompts.get(location_id)

    def set_prompts(self, location_id, prompts):
        self.prompts[location_id] = [str(p).strip() for p in prompts if str(p).strip()][:MAX_PROMPTS]

    def claim_run(self, location_id, key, run):
        """Atomic insert; returns the stored run, or None when (location, key) already exists."""
        if (location_id, key) in self.runs:
            return None
        self.runs[(location_id, key)] = run
        return run

    def has_run(self, location_id, key):
        return (location_id, key) in self.runs

    def list_runs(self, location_id=None):
        return [r for (lid, _), r in self.runs.items() if location_id in (None, lid)]


STORE = MemStore()


def set_store(store):
    global STORE
    STORE = store


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


def prompts_for(location):
    custom = STORE.get_prompts(location["id"])
    return list(custom)[:MAX_PROMPTS] if custom else default_prompts(location)


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
    ym = now.strftime("%Y-%m")
    total = 0.0
    for run in STORE.list_runs(location_id):
        total += sum(c["cost_usd"] for c in run["calls"] if c["at"].startswith(ym))
    return round(total, 6)


def _over_cap(loc, now, cost):
    cfg = config.get()
    return (month_spend(now, loc["id"]) + cost > cfg["GHL_PER_LOCATION_CAP_USD"] + 1e-9
            or month_spend(now) + cost > cfg["GHL_MONTHLY_CAP_USD"] + 1e-9)


def cost_of_full_run(n_prompts, engine):
    return round(n_prompts * PRICE_PER_CALL_USD[engine], 6)


# ---------- the run ----------
def execute_run(loc, key, now):
    run = {"location_id": loc["id"], "key": key, "started_at": now.isoformat(), "status": "running",
           "engines": {}, "calls": []}
    if STORE.claim_run(loc["id"], key, run) is None:
        return None
    cfg = config.get()
    prompts = prompts_for(loc)
    capped = False
    for eng in ENGINES:
        if not cfg[eng.upper() + "_API_KEY"]:
            run["engines"][eng] = {"status": config.NOT_CONFIGURED}
            continue
        run["engines"][eng] = {"status": "ok"}
        for p in prompts:
            cost = PRICE_PER_CALL_USD[eng]
            if _over_cap(loc, now, cost):               # checked BEFORE the call
                capped = True
                run["engines"][eng]["status"] = "cap_reached"
                break
            rec = {"engine": eng, "prompt": p, "at": now.isoformat(), "cost_usd": cost}
            try:
                ans = CALLERS[eng](p, loc)
                rec.update(parse_answer(ans.get("text", ""), loc.get("name", ""), ans.get("sources", ())))
                rec["status"] = "ok"
            except Exception as e:                      # never echo the message: it could carry request details
                rec.update(status="error", error=type(e).__name__, cost_usd=0.0)
            run["calls"].append(rec)
        if capped:
            break
    run["status"] = "cap_reached" if capped else "complete"
    run["finished_at"] = _utc().isoformat()
    run["cost_usd"] = round(sum(c["cost_usd"] for c in run["calls"]), 6)
    return run


def tick(now=None):
    """Do due work only. Returns a summary; repeating it the same day starts nothing new."""
    now = _utc(now)
    out = {"enabled": config.get()["GHL_APP_ENABLED"], "started": [], "skipped_trial": []}
    if not out["enabled"]:
        return out
    with _lock:
        locs = [l for l in STORE.list_locations() if l.get("active", True)]
        allowed, per_agency = set(), {}
        for l in sorted(locs, key=lambda x: (str(x.get("installed_at", "")), str(x["id"]))):
            if l.get("plan") == "trial":
                n = per_agency.get(l.get("agency_id"), 0)
                if n < config.get()["GHL_TRIAL_MAX_LOCATIONS"]:
                    per_agency[l.get("agency_id")] = n + 1
                    allowed.add(l["id"])
        pkey, pstart = period_key(now)
        for l in locs:
            if l.get("plan") == "trial" and l["id"] not in allowed:
                out["skipped_trial"].append(l["id"])
                continue
            if not STORE.has_run(l["id"], "install"):
                key = "install"
            elif _parse_ts(l["installed_at"]) < pstart and not STORE.has_run(l["id"], pkey):
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
    secret = os.environ.get("GHL_CRON_SECRET", "")
    given = req.headers.get("X-Cron-Secret", "") if req.headers else ""
    if not secret or not hmac.compare_digest(secret.encode(), given.encode()):
        return 401, {"error": {"code": "unauthorized", "message": "Missing or wrong cron secret", "details": {}}}
    return 200, tick()


def register(routes):
    """routes maps (METHOD, path) -> handler(req) -> (status, json-able dict)."""
    routes[("POST", "/cron/tick")] = handle_tick
