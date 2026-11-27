"""Shared test helpers: vendor-shaped fakes behind httpx.MockTransport, a fake clock, and a driver for runner.run."""
import asyncio
import json
import pathlib
import sys

import httpx

ROOT = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from src import extract, providers, runner  # noqa: E402

FIX = pathlib.Path(__file__).parent / "fixtures"
CANARIES = {"OPENAI_API_KEY": "sk-CANARY-1", "GEMINI_API_KEY": "gm-CANARY-2", "ANTHROPIC_API_KEY": "an-CANARY-3"}
LIST_ANSWER = "Top picks:\n\n1. **Asana** - flexible task views\n2. **Trello** - simple boards\n3. **Monday.com** - workflows\n"


def openai_payload(text, urls=(), search=True):
    out = [{"type": "web_search_call", "status": "completed"}] if search else []
    out.append({"type": "message", "content": [{"type": "output_text", "text": text, "annotations": [{"type": "url_citation", "url": u} for u in urls]}]})
    return {"output": out}


def anthropic_payload(text, urls=(), search=True):
    return {"content": [{"type": "text", "text": text, "citations": [{"type": "web_search_result_location", "url": u} for u in urls]}],
            "usage": {"server_tool_use": {"web_search_requests": 1 if search else 0}}}


def gemini_payload(text, urls=(), search=True):
    meta = {"webSearchQueries": ["q"] if search else [], "groundingChunks": [{"web": {"uri": u, "title": "x"}} for u in urls]}
    return {"candidates": [{"content": {"parts": [{"text": text}]}, "groundingMetadata": meta}]}


def extractor_for(text):
    """What a model would return: bold or list names in order."""
    return {"brands": extract.heuristic_brands(text), "sentiment": "positive"}


class Fake:
    """Fake providers. `answer(engine, prompt)` -> text; `urls`/`search` per engine; `behave[engine](n, request)` may return a Response."""

    def __init__(self, answer=None):
        self.answer = answer or (lambda engine, prompt: LIST_ANSWER)
        self.urls = {}
        self.search = {}
        self.behave = {}
        self.extractor = lambda text: extractor_for(text)
        self.calls = []          # (engine, kind)
        self.counts = {}

    async def handler(self, request):
        host = request.url.host
        body = json.loads(request.content)
        if host == "api.openai.com":
            engine = "chatgpt" if "tools" in body else "extractor"
        else:
            engine = "claude" if host == "api.anthropic.com" else "gemini"
        self.calls.append(engine)
        n = self.counts[engine] = self.counts.get(engine, 0) + 1
        if engine in self.behave:
            r = self.behave[engine](n, request)
            if asyncio.iscoroutine(r):
                r = await r
            if r is not None:
                return r
        if engine == "extractor":
            text = str(body["input"]).split(providers.DATA_START, 1)[-1].split(providers.DATA_END, 1)[0]
            out = self.extractor(text)
            return httpx.Response(200, json=out if isinstance(out, httpx.Response) else openai_payload(out if isinstance(out, str) else json.dumps(out), search=False))
        prompt = body.get("input") or (body.get("messages") or [{}])[0].get("content") or body["contents"][0]["parts"][0]["text"]
        text = self.answer(engine, prompt)
        build = {"chatgpt": openai_payload, "claude": anthropic_payload, "gemini": gemini_payload}[engine]
        return httpx.Response(200, json=build(text, self.urls.get(engine, ()), self.search.get(engine, True)))

    def client(self):
        return httpx.AsyncClient(transport=httpx.MockTransport(self.handler))

    def count(self, engine):
        return self.calls.count(engine)


class Clock:
    """A fake clock. sleep() lets quick fakes finish first, then moves time forward."""

    def __init__(self):
        self.t = 0.0

    def __call__(self):
        return self.t

    async def sleep(self, secs):
        target = self.t + secs
        for _ in range(60):
            await asyncio.sleep(0)
        self.t = max(self.t, target)


class Result:
    def __init__(self):
        self.ok = self.msg = None
        self.rows, self.pushes, self.statuses, self.summary = [], [], [], None

    @property
    def charged(self):
        return [r for r, c in self.pushes if c]

    @property
    def uncharged(self):
        return [r for r, c in self.pushes if not c]


def drive(inp, fake=None, *, pricing=None, limit_after=None, clock=None):
    fake = fake or Fake()
    clock = clock or Clock()
    res = Result()
    res.fake, res.clock = fake, clock

    async def push(row, charge):
        res.pushes.append((row, charge))
        return bool(charge and limit_after is not None and len(res.charged) >= limit_after)

    async def status(m):
        res.statuses.append(m)

    async def summ(s):
        res.summary = s

    async def go():
        async with fake.client() as c:
            return await runner.run(inp, client=c, push=push, set_status=status, set_summary=summ, pricing=pricing,
                                    sleep=clock.sleep, clock=clock)
    res.ok, res.msg = asyncio.run(go())
    res.rows = [r for r, _ in res.pushes]
    return res


BASE = {"brand": "Asana", "domain": "asana.com", "category": "project management software", "promptCount": 3}


def inp(**kw):
    d = dict(BASE)
    d.update(kw)
    return {k: v for k, v in d.items() if v is not None}
