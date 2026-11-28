"""Speech-to-text adapters (Groq, AssemblyAI, Gemini; OpenAI only as text-without-timestamps, never selectable here).

Each adapter turns one audio chunk into the same internal shape: segments (seconds from the chunk start) and optional
words. The key travels only in a request header and never appears in an error, a log line or a result.
"""
from __future__ import annotations

import asyncio
import base64
import re
from dataclasses import dataclass, field
from pathlib import Path

import httpx

from . import config

END_SENTENCE = re.compile(r"[.!?…。！？]['\")\]]*$")


class EngineError(Exception):
    def __init__(self, message: str, transient: bool):
        super().__init__(message)
        self.transient = transient


class NotSelectable(Exception):
    """The engine cannot give what was asked for (for example timestamps)."""


@dataclass
class Result:
    segments: list[dict]
    words: list[dict] | None = None
    language: str | None = None
    model: str = ""
    meta: dict = field(default_factory=dict)


def _offset(v) -> float:
    """Gemini durations: "4s", "4.200s", or a number."""
    if isinstance(v, (int, float)):
        return float(v)
    s = str(v).strip()
    return float(s[:-1]) if s.endswith("s") else float(s)


def words_to_segments(words: list[dict], max_words: int = 40, gap: float = 1.5) -> list[dict]:
    """Group words into sentence segments: a new segment after . ! ?, a long pause, a speaker change or 40 words."""
    segs, cur = [], []
    for i, w in enumerate(words):
        if cur and (w.get("speaker") != cur[-1].get("speaker") or w["start"] - cur[-1]["end"] > gap):
            segs.append(cur)
            cur = []
        cur.append(w)
        if END_SENTENCE.search(w["word"]) or len(cur) >= max_words or i == len(words) - 1:
            segs.append(cur)
            cur = []
    return [{"start": c[0]["start"], "end": c[-1]["end"], "text": " ".join(x["word"] for x in c), "speaker": c[0].get("speaker")}
            for c in segs if c]


def _status(r: httpx.Response, name: str) -> None:
    if r.status_code == 429 or r.status_code >= 500:
        raise EngineError(f"{name}: HTTP {r.status_code}", transient=True)
    if r.status_code >= 400:
        raise EngineError(f"{name}: HTTP {r.status_code}", transient=False)


def parse_gemini(data: dict) -> Result:
    words, text, lang = [], "", None
    for cand in data.get("candidates") or []:
        for part in (cand.get("content") or {}).get("parts") or []:
            at = part.get("audioTranscription")
            if isinstance(at, dict):
                text = at.get("text") or text
                lang = at.get("languageCode") or at.get("language") or lang
                for w in at.get("words") or []:
                    words.append({"word": str(w["word"]), "start": _offset(w["startOffset"]), "end": _offset(w["endOffset"]),
                                  "speaker": (f"spk_{w['speaker']}" if str(w.get("speaker", "")).isdigit() else w.get("speaker")) or None})
            elif part.get("text") and not text:
                text = part["text"]
    if not words:
        raise EngineError("gemini: no timestamps in the answer", transient=False)
    return Result(words_to_segments(words), words, (lang or None) and lang[:2].lower(), data.get("modelVersion") or "gemini-3.5-transcribe")


def parse_groq(data: dict) -> Result:
    segs = []
    for s in data.get("segments") or []:
        segs.append({"start": float(s["start"]), "end": float(s["end"]), "text": str(s.get("text", "")).strip(), "speaker": None,
                     "no_speech_prob": s.get("no_speech_prob"), "avg_logprob": s.get("avg_logprob"),
                     "compression_ratio": s.get("compression_ratio")})
    words = [{"word": w["word"].strip(), "start": float(w["start"]), "end": float(w["end"]), "speaker": None}
             for w in data.get("words") or []] or None
    if not segs and not words:
        if (data.get("text") or "").strip():
            raise EngineError("groq: no timestamps in the answer", transient=False)
        return Result([], None, _lang(data.get("language")), "whisper-large-v3-turbo")
    return Result(segs or words_to_segments(words), words, _lang(data.get("language")), "whisper-large-v3-turbo")


LANG_NAMES = {"english": "en", "hebrew": "he", "spanish": "es", "german": "de", "french": "fr", "italian": "it",
              "portuguese": "pt", "dutch": "nl", "russian": "ru", "arabic": "ar", "japanese": "ja", "chinese": "zh"}


def _lang(v) -> str | None:
    if not v:
        return None
    s = str(v).strip().lower()
    return LANG_NAMES.get(s, s[:2] if len(s) >= 2 else None)


def parse_assemblyai(data: dict) -> Result:
    if data.get("status") == "error":
        raise EngineError("assemblyai: transcription error", transient=False)
    words = [{"word": w["text"], "start": w["start"] / 1000, "end": w["end"] / 1000,
              "speaker": f"spk_{_spk(w['speaker'])}" if w.get("speaker") else None} for w in data.get("words") or []]
    utter = data.get("utterances")
    if utter:
        segs = [{"start": u["start"] / 1000, "end": u["end"] / 1000, "text": u["text"].strip(),
                 "speaker": f"spk_{_spk(u['speaker'])}" if u.get("speaker") else None} for u in utter]
    else:
        segs = words_to_segments(words)
    return Result(segs, words or None, _lang(data.get("language_code")), _used_model(data))


def _used_model(data: dict) -> str:
    used = data.get("speech_model_used")
    if not used:
        models = data.get("speech_models")
        used = models[0] if isinstance(models, list) and models and isinstance(models[0], str) else data.get("speech_model")
    return used if isinstance(used, str) and used else "universal-2"


def _spk(label) -> int:
    s = str(label)
    return ord(s.upper()) - 64 if len(s) == 1 and s.isalpha() else int(s) if s.isdigit() else 1


def parse_openai(data: dict, want_timestamps: bool = True) -> Result:
    if want_timestamps and not data.get("segments"):
        raise NotSelectable("openai gpt-transcribe returns no timestamps; it cannot be used for timestamped output")
    return Result([{"start": 0.0, "end": 0.0, "text": data.get("text", ""), "speaker": None}], None, _lang(data.get("language")), "gpt-transcribe")


class Engine:
    name = ""
    model = ""
    speakers = False
    timestamps = True

    def __init__(self, client: httpx.AsyncClient, sleep=asyncio.sleep):
        self.client, self.sleep = client, sleep

    @property
    def key(self) -> str:
        return config.key(self.name)

    async def transcribe(self, path: Path, *, language: str | None, speakers: bool, words: bool) -> Result:  # pragma: no cover
        raise NotImplementedError

    async def _post(self, url: str, **kw) -> httpx.Response:
        try:
            r = await self.client.post(url, timeout=config.ENGINE_TIMEOUT_SECS, **kw)
        except httpx.TimeoutException:
            raise EngineError(f"{self.name}: timeout", transient=True) from None
        except httpx.HTTPError as e:
            raise EngineError(f"{self.name}: {type(e).__name__}", transient=True) from None
        _status(r, self.name)
        return r


class Groq(Engine):
    name, model = "groq", "whisper-large-v3-turbo"
    URL = "https://api.groq.com/openai/v1/audio/transcriptions"

    async def transcribe(self, path, *, language, speakers, words):
        form = {"model": self.model, "response_format": "verbose_json", "timestamp_granularities[]": ["segment", "word"] if words else ["segment"]}
        if language:
            form["language"] = language
        with open(path, "rb") as fh:
            r = await self._post(self.URL, headers={"Authorization": f"Bearer {self.key}"}, data=form,
                                 files={"file": (path.name, fh, "audio/mpeg")})
        return parse_groq(r.json())


class AssemblyAI(Engine):
    name, model, speakers = "assemblyai", "universal-2", True
    BASE = "https://api.assemblyai.com/v2"
    POLL_EVERY = 3.0
    MAX_POLLS = 1200

    async def transcribe(self, path, *, language, speakers, words):
        if not self.key:
            raise EngineError("assemblyai: ASSEMBLYAI_API_KEY is not set", transient=False)
        h = {"authorization": self.key}
        r = await self._post(f"{self.BASE}/upload", headers=h, content=path.read_bytes())
        body = {"audio_url": r.json()["upload_url"], "speaker_labels": bool(speakers), "speech_models": [self.model]}
        if language:
            body["language_code"] = language
        else:
            body["language_detection"] = True
        job = (await self._post(f"{self.BASE}/transcript", headers=h, json=body)).json()
        for _ in range(self.MAX_POLLS):
            try:
                g = await self.client.get(f"{self.BASE}/transcript/{job['id']}", headers=h, timeout=60)
            except httpx.HTTPError as e:
                raise EngineError(f"assemblyai: {type(e).__name__}", transient=True) from None
            _status(g, self.name)
            data = g.json()
            if data.get("status") in ("completed", "error"):
                return parse_assemblyai(data)
            await self.sleep(self.POLL_EVERY)
        raise EngineError("assemblyai: still processing", transient=True)


class Gemini(Engine):
    name, model, speakers = "gemini", "gemini-3.5-transcribe", True
    URL = "https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent"

    async def transcribe(self, path, *, language, speakers, words):
        cfg = {"wordTimestamps": True}
        if speakers:
            cfg["speakerDiarization"] = True
        if language:
            cfg["languageCode"] = language
        body = {"contents": [{"parts": [{"inlineData": {"mimeType": "audio/mpeg", "data": base64.b64encode(path.read_bytes()).decode()}}]}],
                "generationConfig": {"audioTranscriptionConfig": cfg}}
        r = await self._post(self.URL.format(model=self.model), headers={"x-goog-api-key": self.key}, json=body)
        data = r.json()
        fin = ((data.get("candidates") or [{}])[0]).get("finishReason")
        if fin and fin not in ("STOP", "MAX_TOKENS"):
            raise EngineError(f"gemini: finishReason {fin}", transient=False)
        return parse_gemini(data)


class OpenAI(Engine):
    """Kept for completeness: gpt-transcribe gives no timestamps, so it is refused for this Actor's output."""
    name, model, timestamps = "openai", "gpt-transcribe", False

    async def transcribe(self, path, *, language, speakers, words):
        raise NotSelectable("openai gpt-transcribe returns no timestamps; it cannot be used for timestamped output")


ADAPTERS = {"groq": Groq, "assemblyai": AssemblyAI, "gemini": Gemini, "openai": OpenAI}


def chain(client: httpx.AsyncClient, speakers: bool, order: list[str] | None = None, sleep=asyncio.sleep,
          adapters: dict | None = None, log=None) -> list[Engine]:
    """The engines to try, in order: only those with a key, only timestamped ones, speaker-capable first when asked."""
    adapters = adapters or ADAPTERS
    order = order if order is not None else config.engine_order()
    if speakers:
        order = [e for e in config.SPEAKER_ENGINES if e in adapters]
    out = []
    for name in order:
        cls = adapters.get(name)
        if cls is None:
            continue
        eng = cls(client, sleep=sleep)
        if not eng.timestamps:
            if log:
                log(f"engine {name} skipped: no timestamps")
            continue
        if not eng.key:
            continue
        out.append(eng)
    return out
