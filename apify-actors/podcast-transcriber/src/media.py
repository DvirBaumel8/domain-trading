"""ffprobe / ffmpeg: measure, refuse DRM and streams, re-encode, find silences, plan and cut chunks (spec §4.4-§4.5)."""
from __future__ import annotations

import asyncio
import json
import re
from dataclasses import dataclass
from pathlib import Path

from . import config
from .net import SourceError

SILENCE_START = re.compile(r"silence_start:\s*(-?[\d.]+)")
SILENCE_END = re.compile(r"silence_end:\s*(-?[\d.]+)")


@dataclass
class Chunk:
    index: int
    start: float          # seconds from the start of the episode
    end: float
    keep_from: float      # words before this absolute time belong to the previous chunk (hard-cut overlap)
    path: Path | None = None

    @property
    def duration(self) -> float:
        return self.end - self.start


async def run(*args: str, timeout: float = 3600) -> tuple[int, str, str]:
    p = await asyncio.create_subprocess_exec(*args, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
    try:
        out, err = await asyncio.wait_for(p.communicate(), timeout=timeout)
    except asyncio.TimeoutError:
        p.kill()
        await p.wait()
        raise
    return p.returncode, out.decode(errors="replace"), err.decode(errors="replace")


async def probe(path: Path) -> float:
    """Duration in seconds, measured on the file. Raises not_audio / drm_protected / unsupported_stream."""
    with open(path, "rb") as fh:
        head = fh.read(1_000_000)
    if head.lstrip().startswith(b"#EXTM3U"):
        if b"#EXT-X-KEY" in head:
            raise SourceError("drm_protected", "The stream is encrypted. Protected audio is not supported.")
        raise SourceError("unsupported_stream", "Streaming playlists are not supported. Paste a direct audio file URL.")
    if path.suffix.lower() == ".m4p":
        raise SourceError("drm_protected", "Protected (FairPlay) audio is not supported.")
    code, out, err = await run("ffprobe", "-v", "error", "-show_entries", "format=duration:stream=codec_type",
                               "-show_entries", "stream_tags:format_tags", "-of", "json", str(path), timeout=120)
    low = err.lower()
    if "encrypt" in low or "drm" in low or "cenc" in low:
        raise SourceError("drm_protected", "The audio is encrypted. Protected audio is not supported.")
    if code != 0:
        raise SourceError("not_audio", "The file is not an audio or video file ffprobe can read.")
    data = json.loads(out or "{}")
    if not any(s.get("codec_type") == "audio" for s in data.get("streams", [])):
        raise SourceError("not_audio", "The file has no audio stream.")
    try:
        dur = float(data.get("format", {}).get("duration"))
    except (TypeError, ValueError):
        raise SourceError("not_audio", "The audio length could not be measured.") from None
    if dur <= 0:
        raise SourceError("not_audio", "The audio is empty.")
    return dur


async def reencode(src: Path, dst: Path) -> Path:
    """Mono, 16 kHz, 32 kbps MP3 (what every engine accepts, and small)."""
    code, _o, _e = await run("ffmpeg", "-nostdin", "-v", "error", "-y", "-i", str(src), "-vn", "-ac", "1", "-ar", "16000",
                             "-b:a", "32k", "-f", "mp3", str(dst))
    if code != 0:
        raise SourceError("not_audio", "The audio could not be decoded.")
    return dst


async def silences(path: Path, noise_db: int = -35, min_len: float = 0.4) -> list[tuple[float, float]]:
    _c, _o, err = await run("ffmpeg", "-nostdin", "-v", "info", "-i", str(path), "-af",
                            f"silencedetect=noise={noise_db}dB:d={min_len}", "-f", "null", "-")
    return parse_silences(err)


def parse_silences(log: str) -> list[tuple[float, float]]:
    out, start = [], None
    for line in log.splitlines():
        m = SILENCE_START.search(line)
        if m:
            start = max(0.0, float(m.group(1)))
        m = SILENCE_END.search(line)
        if m and start is not None:
            out.append((start, float(m.group(1))))
            start = None
    return out


def plan(duration: float, sil: list[tuple[float, float]], max_len: float = config.CHUNK_SECONDS,
         window: float = config.SILENCE_WINDOW, overlap: float = config.HARD_CUT_OVERLAP) -> list[Chunk]:
    """Chunks of at most `max_len`, cut in the middle of the longest silence in the `window` before each boundary.
    With no silence there: a hard cut, the next chunk starts `overlap` seconds earlier, and words before the cut are
    dropped from it at merge time (`keep_from`)."""
    chunks: list[Chunk] = []
    start = keep = 0.0
    while duration - start > max_len:
        limit = start + max_len
        lo = max(limit - window, start + 1.0)
        best = None
        for a, b in sil:
            a2, b2 = max(a, lo), min(b, limit)
            if b2 > a2 and (best is None or b2 - a2 > best[1] - best[0]):
                best = (a2, b2)
        if best:
            cut_at = (best[0] + best[1]) / 2
            chunks.append(Chunk(len(chunks), start, cut_at, keep))
            start = keep = cut_at
        else:
            chunks.append(Chunk(len(chunks), start, limit, keep))
            start, keep = limit - overlap, limit
    chunks.append(Chunk(len(chunks), start, duration, keep))
    return chunks


async def cut(src: Path, chunk: Chunk, dst: Path) -> Path:
    code, _o, _e = await run("ffmpeg", "-nostdin", "-v", "error", "-y", "-ss", f"{chunk.start:.3f}", "-t", f"{chunk.duration:.3f}",
                             "-i", str(src), "-c", "copy", str(dst))
    if code != 0:
        raise SourceError("stt_failed", "The audio could not be split.")
    return dst


def tail_is_silent(sil: list[tuple[float, float]], start: float, end: float, coverage: float = 0.9) -> bool:
    """True when at least `coverage` of [start, end] is silence."""
    if end <= start:
        return True
    covered = sum(max(0.0, min(b, end) - max(a, start)) for a, b in sil)
    return covered / (end - start) >= coverage
