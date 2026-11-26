"""Cheap, checkable website signals. Each one is labelled with how strong the
public evidence is, so the report never over-claims (see ../../03-experiment.md)."""
import json
import re
import urllib.request
from dataclasses import dataclass, field

AI_BOTS = ("GPTBot", "OAI-SearchBot", "ChatGPT-User", "PerplexityBot", "ClaudeBot", "Google-Extended")
LOCAL_TYPES = {"localbusiness", "dentist", "medicalbusiness", "medicalclinic", "legalservice", "attorney",
               "hvacbusiness", "plumber", "roofingcontractor", "electrician", "homeandconstructionbusiness",
               "dayspa", "healthandbeautybusiness", "veterinarycare", "physician", "realestateagent",
               "chiropractor", "professionalservice", "locksmith", "generalcontractor"}


@dataclass
class SiteSignals:
    url: str
    fetched: bool = False
    https: bool = False
    has_local_schema: bool = False
    has_faq_schema: bool = False
    has_review_schema: bool = False
    mentions_city: bool = False
    has_phone_text: bool = False
    blocked_bots: list = field(default_factory=list)
    title: str = ""
    error: str = ""


def _jsonld_types(html: str):
    types = set()
    for block in re.findall(r'<script[^>]+application/ld\+json[^>]*>(.*?)</script>', html, re.S | re.I):
        try:
            data = json.loads(block.strip())
        except Exception:
            continue
        stack = [data]
        while stack:
            x = stack.pop()
            if isinstance(x, dict):
                t = x.get("@type")
                for tt in (t if isinstance(t, list) else [t]):
                    if isinstance(tt, str):
                        types.add(tt.lower())
                stack.extend(x.values())
            elif isinstance(x, list):
                stack.extend(x)
    return types


def blocked_ai_bots(robots_txt: str) -> list:
    """AI bots that a robots.txt fully disallows (Disallow: /) by name or via '*'.
    Cited Lens (2026): sites blocking GPTBot were named 6.3% of the time vs 15.2%."""
    groups, cur_agents, cur_rules, last_was_agent = [], [], [], False
    for raw in robots_txt.splitlines():
        line = raw.split("#", 1)[0].strip()
        if ":" not in line:
            continue
        k, v = [s.strip() for s in line.split(":", 1)]
        k = k.lower()
        if k == "user-agent":
            if not last_was_agent and cur_agents:
                groups.append((cur_agents, cur_rules))
                cur_agents, cur_rules = [], []
            cur_agents.append(v.lower())
            last_was_agent = True
        elif k in ("disallow", "allow"):
            cur_rules.append((k, v))
            last_was_agent = False
    if cur_agents:
        groups.append((cur_agents, cur_rules))
    blocked = []
    for bot in AI_BOTS:
        named = [r for a, r in groups if bot.lower() in a]
        rules = named[0] if named else next((r for a, r in groups if "*" in a), [])
        if ("disallow", "/") in rules and ("allow", "/") not in rules:
            blocked.append(bot)
    return blocked


def analyze(url: str, html: str, robots_txt: str = "", city: str = "") -> SiteSignals:
    s = SiteSignals(url=url, fetched=True, https=url.lower().startswith("https://"))
    types = _jsonld_types(html)
    s.has_local_schema = bool(types & LOCAL_TYPES)
    s.has_faq_schema = "faqpage" in types
    s.has_review_schema = bool(types & {"aggregaterating", "review"})
    m = re.search(r"<title[^>]*>(.*?)</title>", html, re.S | re.I)
    s.title = re.sub(r"\s+", " ", m.group(1)).strip() if m else ""
    text = re.sub(r"<[^>]+>", " ", html)
    city_name = city.split(",")[0].strip().lower()
    s.mentions_city = bool(city_name) and city_name in text.lower()
    s.has_phone_text = bool(re.search(r"\(?\b\d{3}\)?[-.\s]\d{3}[-.\s]\d{4}\b", text))
    s.blocked_bots = blocked_ai_bots(robots_txt)
    return s


def fetch_and_analyze(url: str, city: str = "", timeout: float = 15.0, opener=None) -> SiteSignals:
    op = opener or urllib.request.urlopen
    hdr = {"User-Agent": "Mozilla/5.0 (aivis audit prototype)"}
    try:
        with op(urllib.request.Request(url, headers=hdr), timeout=timeout) as r:
            html = r.read(2_000_000).decode("utf-8", "replace")
    except Exception as e:
        return SiteSignals(url=url, error=f"fetch failed: {type(e).__name__}")
    robots = ""
    try:
        base = re.match(r"(https?://[^/]+)", url).group(1)
        with op(urllib.request.Request(base + "/robots.txt", headers=hdr), timeout=timeout) as r:
            robots = r.read(200_000).decode("utf-8", "replace")
    except Exception:
        pass
    return analyze(url, html, robots, city)
