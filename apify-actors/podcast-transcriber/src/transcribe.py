"""Chunks -> engines with fail-over and the silent-truncation guard -> one merged, filtered transcript (spec §4.5)."""
from __future__ import annotations

import asyncio
from collections import Counter
from dataclasses import dataclass
from pathlib import Path

from . import config, media
from .engines import Engine, EngineError, NotSelectable, Result, words_to_segments
from .net import SourceError

TRUNCATION_RATIO = 0.85


@dataclass
class Merged:
    segments: list[dict]
    words: list[dict] | None
    language: str | None
    engine: str
    dropped: dict


def hallucination_filter(segs: list[dict]) -> tuple[list[dict], dict]:
    """Drop Whisper's likely hallucinations (spec §4.5.6) and collapse runs of 3+ identical segments to one."""
    counts = {"no_speech": 0, "compression": 0, "repeats": 0}
    kept = []
    for s in segs:
        nsp, lp, cr = s.get("no_speech_prob"), s.get("avg_logprob"), s.get("compression_ratio")
        if nsp is not None and lp is not None and nsp > 0.6 and lp < -1.0:
            counts["no_speech"] += 1
            continue
        if cr is not None and cr > 2.4:
            counts["compression"] += 1
            continue
        kept.append(s)
    out, i = [], 0
    while i < len(kept):
        j = i
        key = " ".join(kept[i]["text"].lower().split())
        while j + 1 < len(kept) and " ".join(kept[j + 1]["text"].lower().split()) == key:
            j += 1
        run = j - i + 1
        if run >= 3:
            counts["repeats"] += run - 1
            out.append(kept[i])
        else:
            out.extend(kept[i:j + 1])
        i = j + 1
    return out, counts


def clean(s: dict) -> dict:
    return {"start": round(s["start"], 3), "end": round(s["end"], 3), "text": s["text"].strip(), "speaker": s.get("speaker")}


class Transcriber:
    def __init__(self, engines: list[Engine], *, sleep=asyncio.sleep, cutter=media.cut, timeout: float = config.ENGINE_TIMEOUT_SECS,
                 tries: int = config.ENGINE_TRIES, log=print, parallel: int = 2):
        self.engines, self.sleep, self.cutter, self.timeout, self.tries, self.log = engines, sleep, cutter, timeout, tries, log
        self.sem = asyncio.Semaphore(parallel)

    async def _call(self, eng: Engine, path: Path, opts: dict) -> Result:
        last = None
        for attempt in range(self.tries):
            try:
                return await asyncio.wait_for(eng.transcribe(path, **opts), timeout=self.timeout)
            except asyncio.TimeoutError:
                last = EngineError(f"{eng.name}: no answer in time", transient=True)
            except EngineError as e:
                last = e
                if not e.transient:
                    break
            if attempt < self.tries - 1:
                await self.sleep(min(2.0 ** (attempt + 1), 30.0))
        raise last or EngineError(f"{eng.name}: failed", transient=True)

    def _truncated(self, res: Result, chunk: media.Chunk, sil) -> bool:
        ends = [s["end"] for s in res.segments if s["text"].strip()]
        last = max(ends) if ends else 0.0
        if last >= TRUNCATION_RATIO * chunk.duration:
            return False
        return not media.tail_is_silent(sil, chunk.start + last, chunk.end)

    async def _chunk(self, src: Path, chunk: media.Chunk, sil, opts: dict, workdir: Path) -> tuple[list[tuple[media.Chunk, Result]], str]:
        """Returns the (sub)chunk results and the engine name; raises SourceError('stt_failed') if every engine failed."""
        async with self.sem:
            path = await self.cutter(src, chunk, workdir / f"chunk-{chunk.index}-{int(chunk.start)}.mp3")
        try:
            for eng in self.engines:
                try:
                    async with self.sem:
                        res = await self._call(eng, path, opts)
                    if not self._truncated(res, chunk, sil):
                        return [(chunk, res)], eng.name
                    self.log(f"chunk {chunk.index}: {eng.name} answer stops early; retrying at half length")
                    mid = chunk.start + chunk.duration / 2
                    halves = [media.Chunk(chunk.index, chunk.start, mid, chunk.keep_from),
                              media.Chunk(chunk.index, mid, chunk.end, mid)]
                    parts = []
                    for h in halves:
                        async with self.sem:
                            hp = await self.cutter(src, h, workdir / f"chunk-{h.index}-{int(h.start)}-half.mp3")
                        try:
                            async with self.sem:
                                hr = await self._call(eng, hp, opts)
                        finally:
                            hp.unlink(missing_ok=True)
                        if self._truncated(hr, h, sil):
                            raise EngineError(f"{eng.name}: answer stops early", transient=False)
                        parts.append((h, hr))
                    return parts, eng.name
                except (EngineError, NotSelectable) as e:
                    self.log(f"chunk {chunk.index}: {e}; trying the next engine")
            raise SourceError("stt_failed", "Speech-to-text failed on every engine.")
        finally:
            path.unlink(missing_ok=True)

    async def run(self, src: Path, chunks: list[media.Chunk], sil, *, language: str | None, speakers: bool, words: bool,
                  workdir: Path, duration: float) -> Merged:
        if not self.engines:
            raise SourceError("stt_failed", "No speech-to-text engine is configured.")
        opts = {"language": language, "speakers": speakers, "words": words}
        outs = await asyncio.gather(*(self._chunk(src, c, sil, opts, workdir) for c in chunks))
        parts = [p for o in outs for p in o[0]]
        by_engine = Counter()
        all_segs, all_words, langs = [], [], Counter()
        prev_end = 0.0
        for (chunk, res), eng in zip(parts, [o[1] for o in outs for _ in o[0]]):
            segs = [dict(s, start=s["start"] + chunk.start, end=s["end"] + chunk.start) for s in res.segments]
            segs = [s for s in segs if s["start"] >= chunk.keep_from - 0.05 and s["start"] <= chunk.end + 2.0]
            if res.words is not None:
                ws = [dict(w, start=w["start"] + chunk.start, end=w["end"] + chunk.start) for w in res.words]
                ws = [w for w in ws if w["start"] >= chunk.keep_from - 0.05 and w["start"] <= chunk.end + 2.0]
                if chunk.keep_from > chunk.start:  # hard-cut overlap: rebuild segments from the kept words
                    segs = words_to_segments(ws)
                all_words.extend(ws)
            for s in segs:
                if s["start"] < prev_end - 1.0:
                    if prev_end - s["start"] > 5.0:
                        raise SourceError("stt_failed", "Timestamps went backwards between chunks.")
                    s["start"] = prev_end
                s["end"] = max(s["end"], s["start"])
                prev_end = max(prev_end, s["start"])
            all_segs.extend(segs)
            by_engine[eng] += sum(len(s["text"].split()) for s in segs)
            if res.language:
                langs[res.language] += chunk.duration
        all_segs.sort(key=lambda s: s["start"])
        filtered, dropped = hallucination_filter(all_segs)
        if any(dropped.values()):
            self.log(f"filtered segments: {dropped}")
        if not any(s["text"].strip() for s in filtered):
            raise SourceError("stt_failed", "The engine returned no speech.")
        name = by_engine.most_common(1)[0][0] if by_engine else self.engines[0].name
        model = next((r.model for (_c, r), e in zip(parts, [o[1] for o in outs for _ in o[0]]) if e == name), name)
        return Merged([clean(s) for s in filtered], all_words if words and all_words else None,
                      langs.most_common(1)[0][0] if langs else None, model, dropped)
