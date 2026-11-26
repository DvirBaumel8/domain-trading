"""Local fake of the 4 paid AI APIs (OpenAI Responses, Perplexity, Gemini, Claude web search).
Returns canned answers in each vendor's real response shape, so the REAL paid provider code
(engine/aivis/providers/paid.py) parses them. No network, no cost, no real keys."""
import hashlib, io, json, random, re, urllib.parse, urllib.request

REAL_URLOPEN = urllib.request.urlopen
POOLS = {}          # niche-key -> list of business names (set by the runner)
TARGET = {"name": ""}
CALLS = []          # (vendor, prompt) log
REQUESTS = []       # (vendor, url, body) as the provider sent it, for shape checks (never headers)
NO_GROUNDING = {"on": False}   # True: Gemini answers without groundingMetadata (free-tier key)

HALLUC = ["Bright Smile Studio", "Premier Care Group", "Lone Star Family Care", "Apex Local Pros"]
TARGET_RATE = {"openai": 0.30, "perplexity": 0.45, "gemini": 0.20, "claude": 0.10}
SOURCES = ["https://www.yelp.com/search", "https://www.google.com/maps", "https://www.healthgrades.com/",
           "https://www.angi.com/", "https://www.threebestrated.com/"]


def _answer(vendor, prompt, pool, target):
    rng = random.Random(hashlib.sha256((vendor + prompt).encode()).hexdigest())
    k = rng.randint(3, 6)
    names = rng.sample(pool, min(k, len(pool)))
    if rng.random() < TARGET_RATE[vendor]:
        names.insert(rng.randint(0, len(names)), target)
    if rng.random() < 0.10:
        names.insert(rng.randint(0, len(names)), rng.choice(HALLUC))
    lines = ["Here are some well-regarded options:"]
    for i, n in enumerate(names, 1):
        lines.append(f"{i}. **{n}** - highly rated, recent reviews are positive.")
    lines.append("Please confirm availability and read recent reviews before booking.")
    return "\n".join(lines), rng.sample(SOURCES, 2)


class _Resp(io.BytesIO):
    def __enter__(self): return self
    def __exit__(self, *a): return False


def fake_urlopen(req, timeout=None, *a, **kw):
    url = req.full_url if hasattr(req, "full_url") else str(req)
    host = urllib.parse.urlsplit(url).netloc
    if host not in ("api.openai.com", "api.perplexity.ai", "generativelanguage.googleapis.com", "api.anthropic.com"):
        return REAL_URLOPEN(req, timeout=timeout, *a, **kw)      # website fetch / NPPES: real, read-only, free
    body = json.loads(req.data.decode())
    REQUESTS.append((host, url, body))
    pool, target = POOLS["cur"], TARGET["name"]
    if host == "api.openai.com":
        prompt = body["input"]; text, cites = _answer("openai", prompt, pool, target); v = "openai"
        out = {"output": [{"type": "web_search_call"}, {"type": "message", "content": [
            {"type": "output_text", "text": text, "annotations": [{"type": "url_citation", "url": c} for c in cites]}]}],
            "usage": {"input_tokens": 5200, "output_tokens": 480, "total_tokens": 5680}}
    elif host == "api.perplexity.ai":
        # Agent API shape (POST /v1/agent): output[] with search_results + message, usage with tokens
        prompt = body["input"]; text, cites = _answer("perplexity", prompt, pool, target); v = "perplexity"
        out = {"model": body["model"], "output": [
            {"type": "search_results", "results": [{"title": "t", "url": c} for c in cites]},
            {"type": "message", "content": [{"type": "output_text", "text": text, "annotations": []}]}],
            "usage": {"input_tokens": 2100, "output_tokens": 520}}
    elif host == "generativelanguage.googleapis.com":
        prompt = body["contents"][0]["parts"][0]["text"]; text, cites = _answer("gemini", prompt, pool, target); v = "gemini"
        cand = {"content": {"parts": [{"text": text}]}}
        if not NO_GROUNDING["on"]:
            cand["groundingMetadata"] = {"webSearchQueries": ["q"], "groundingChunks": [{"web": {"uri": c}} for c in cites]}
        out = {"candidates": [cand], "usageMetadata": {"promptTokenCount": 30, "candidatesTokenCount": 400,
                                                       "thoughtsTokenCount": 900}}
    else:
        prompt = body["messages"][0]["content"]; text, cites = _answer("claude", prompt, pool, target); v = "claude"
        out = {"content": [{"type": "server_tool_use"}, {"type": "text", "text": text,
                                                          "citations": [{"url": c} for c in cites]}],
               "usage": {"input_tokens": 5100, "output_tokens": 510, "server_tool_use": {"web_search_requests": 1}}}
    CALLS.append((v, prompt))
    return _Resp(json.dumps(out).encode())
