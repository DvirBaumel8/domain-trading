"""Offline doubles: a recording HTTP transport, a DNS stub, a fake clock, fake ffmpeg, fake engines, fake billing."""
from __future__ import annotations

import asyncio
import json
import shutil
from pathlib import Path
from types import SimpleNamespace
from urllib.parse import urlsplit

import httpx

from src import media
from src.billing import Billing
from src.engines import Engine, EngineError, Result
from src.net import Net
from src.runner import Deps

ROOT = Path(__file__).resolve().parents[1]
FIX = ROOT / "tests" / "fixtures"
CANARIES = {"GROQ_API_KEY": "gsk_CANARY_groq_1111", "ASSEMBLYAI_API_KEY": "aaiCANARY2222assembly",
            "GEMINI_API_KEY": "AIzaCANARY3333gemini", "OPENAI_API_KEY": "sk-CANARY-4444-openai"}
PUBLIC_IP = "93.184.216.34"
HAS_FFMPEG = bool(shutil.which("ffmpeg") and shutil.which("ffprobe"))


class Web:
    """httpx.MockTransport router: exact URL (with query) first, then URL without query. Records every request."""

    def __init__(self):
        self.routes: dict[str, object] = {}
        self.requests: list[httpx.Request] = []

    def add(self, url: str, resp) -> None:
        self.routes[url] = resp

    async def handle(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        url = str(request.url)
        p = urlsplit(url)
        r = self.routes.get(url) or self.routes.get(f"{p.scheme}://{p.netloc}{p.path}")
        if r is None:
            return httpx.Response(404, text="not found")
        if callable(r):
            r = r(request)
            if asyncio.iscoroutine(r):
                r = await r
        if isinstance(r, list):  # a queue of answers, the last one repeats
            r = r.pop(0) if len(r) > 1 else r[0]
            if callable(r):
                r = r(request)
        return r

    def hosts(self) -> list[str]:
        return [r.url.host for r in self.requests]

    def client(self) -> httpx.AsyncClient:
        return httpx.AsyncClient(transport=httpx.MockTransport(self.handle), headers={"User-Agent": "PodcastTranscriberActor/0.1 (Apify Actor)"})


def resolver(mapping: dict | None = None):
    mapping = mapping or {}

    async def resolve(host: str) -> list[str]:
        if host in mapping:
            v = mapping[host]
            if isinstance(v, Exception):
                raise v
            return [v]
        return [PUBLIC_IP]
    return resolve


class Clock:
    def __init__(self):
        self.t = 1000.0
        self.sleeps: list[float] = []

    def __call__(self) -> float:
        return self.t

    async def sleep(self, s: float) -> None:
        self.sleeps.append(s)
        self.t += max(s, 0)
        await asyncio.sleep(0)


def net(web: Web, clock: Clock | None = None, mapping=None, **kw) -> Net:
    clock = clock or Clock()
    return Net(web.client(), resolver=resolver(mapping), sleep=clock.sleep, clock=clock, **kw)


def audio(body: bytes = b"ID3" + b"\x00" * 2000, ctype: str = "audio/mpeg", **kw) -> httpx.Response:
    return httpx.Response(200, content=body, headers={"content-type": ctype}, **kw)


def xml(path_or_text, status: int = 200) -> httpx.Response:
    body = (FIX / path_or_text).read_bytes() if isinstance(path_or_text, str) and (FIX / path_or_text).exists() else path_or_text
    if isinstance(body, str):
        body = body.encode()
    return httpx.Response(status, content=body, headers={"content-type": "application/rss+xml"})


class FakeMedia:
    """ffprobe/ffmpeg stand-in. `durations` maps a substring of the audio URL (written into the file) to seconds."""

    def __init__(self, duration: float = 120.0, silences=None):
        self.duration, self.sil = duration, silences or []
        self.calls: list[str] = []

    async def probe(self, path: Path) -> float:
        self.calls.append("probe")
        return self.duration

    async def reencode(self, src: Path, dst: Path) -> Path:
        self.calls.append("reencode")
        shutil.copy(src, dst)
        return dst

    async def silences(self, path: Path):
        return self.sil

    def plan(self, duration, sil):
        return media.plan(duration, sil)

    async def cut(self, src: Path, chunk, dst: Path) -> Path:
        dst.write_text(json.dumps({"start": chunk.start, "end": chunk.end}))
        return dst


def chunk_of(path: Path) -> dict:
    return json.loads(Path(path).read_text())


class FakeEngine(Engine):
    """Answers with one word per second of the chunk ("w<absolute second>"), or runs `behave(chunk) -> Result`."""

    def __init__(self, name="fake", behave=None, speakers=False, client=None, sleep=None):
        self.name, self.model, self.speakers, self.timestamps = name, f"{name}-model", speakers, True
        self.behave = behave
        self.calls: list[dict] = []

    @property
    def key(self):
        return "x"

    async def transcribe(self, path, *, language, speakers, words):
        c = chunk_of(path)
        self.calls.append(c)
        r = self.behave(c) if self.behave else per_second(c, speakers)
        if asyncio.iscoroutine(r):
            r = await r
        r.model = self.model
        return r


def per_second(c: dict, speakers: bool = False, until: float | None = None) -> Result:
    ws = []
    t = int(c["start"]) if c["start"] == int(c["start"]) else int(c["start"]) + 1
    end = c["end"] if until is None else c["start"] + until
    while t < end:
        ws.append({"word": f"w{t}.", "start": t - c["start"], "end": t - c["start"] + 0.5, "speaker": "spk_1" if speakers else None})
        t += 1
    segs = [{"start": w["start"], "end": w["end"], "text": w["word"], "speaker": w["speaker"]} for w in ws]
    return Result(segs, ws, "en", "fake-model")


def failing(transient=True, msg="HTTP 429"):
    def f(c):
        raise EngineError(msg, transient=transient)
    return f


class Charges:
    def __init__(self, limit: dict | None = None, short: dict | None = None):
        self.calls: list[tuple[str, int, str]] = []
        self.limit, self.short = limit or {}, short or {}

    async def charge(self, event, count, key):
        self.calls.append((event, count, key))
        got = min(count, self.short.get(event, count))
        return SimpleNamespace(charged_count=got, event_charge_limit_reached=got < count, chargeable_within_limit={})

    def max(self, event):
        return self.limit.get(event)

    def events(self):
        return [(e, n) for e, n, _k in self.calls]


def deps(web: Web, *, engines=None, fake_media=None, charges=None, paying=True, clock=None, mapping=None, summariser=None,
         tmp: Path | None = None, logs: list | None = None) -> tuple[Deps, SimpleNamespace]:
    clock = clock or Clock()
    charges = charges or Charges()
    out = SimpleNamespace(rows=[], kv={}, status=[], charges=charges, logs=logs if logs is not None else [], clock=clock)

    async def push(row):
        out.rows.append(row)

    async def set_value(k, v, ct):
        out.kv[k] = (v, ct)

    async def set_status(m):
        out.status.append(m)

    engines = engines if engines is not None else [FakeEngine()]
    d = Deps(net=net(web, clock, mapping), push=push, set_value=set_value, set_status=set_status,
             billing=Billing(charges.charge, charges.max, log=out.logs.append), log=out.logs.append, paying=paying,
             kv_store_id="STORE1", media=fake_media or FakeMedia(), engines=lambda speakers: engines, summariser=summariser,
             clock=clock, sleep=clock.sleep, workdir=tmp)
    return d, out


def run(coro):
    return asyncio.run(coro)
