"""Local fake of the paid AI APIs (OpenAI Responses, Gemini, Claude web search; a legacy Perplexity shape is kept).
Returns canned answers in each vendor's real response shape, so the REAL paid provider code
(engine/aivis/providers/paid.py) parses them. No network, no cost, no real keys."""
import hashlib, io, json, random, re, urllib.request

REAL_URLOPEN = urllib.request.urlopen
POOLS = {}          # niche-key -> list of business names (set by the runner)
TARGET = {"name": ""}
CALLS = []          # (vendor, prompt) log
BODIES = []         # (vendor, request body) log, for tests that check model/tool/location fields

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
    pool, target = POOLS["cur"], TARGET["name"]
    if host == "api.openai.com":
        prompt = body["input"]; text, cites = _answer("openai", prompt, pool, target); v = "openai"
        out = {"output": [{"type": "web_search_call"}, {"type": "message", "content": [
            {"type": "output_text", "text": text, "annotations": [{"type": "url_citation", "url": c} for c in cites]}]}],
               "usage": {"input_tokens": 2000, "output_tokens": 500}}
    elif host == "api.perplexity.ai":
        prompt = body["messages"][0]["content"]; text, cites = _answer("perplexity", prompt, pool, target); v = "perplexity"
        out = {"choices": [{"message": {"content": text}}], "citations": cites}
    elif host == "generativelanguage.googleapis.com":
        prompt = body["contents"][0]["parts"][0]["text"]; text, cites = _answer("gemini", prompt, pool, target); v = "gemini"
        out = {"candidates": [{"content": {"parts": [{"text": text}]},
                               "groundingMetadata": {"webSearchQueries": ["q"], "groundingChunks": [{"web": {"uri": c}} for c in cites]}}],
               "usageMetadata": {"promptTokenCount": 2000, "candidatesTokenCount": 500, "thoughtsTokenCount": 1000}}
    else:
        prompt = body["messages"][0]["content"]; text, cites = _answer("claude", prompt, pool, target); v = "claude"
        out = {"content": [{"type": "server_tool_use"}, {"type": "text", "text": text,
                                                          "citations": [{"url": c} for c in cites]}],
               "usage": {"input_tokens": 3000, "output_tokens": 600, "server_tool_use": {"web_search_requests": 1}}}
    CALLS.append((v, prompt)); BODIES.append((v, body))
    return _Resp(json.dumps(out).encode())
