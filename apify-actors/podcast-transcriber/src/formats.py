"""Transcript text formats: parse publisher transcripts (VTT, SRT, JSON, plain text) and write TXT, SRT, VTT, JSON."""
from __future__ import annotations

import html
import json
import re

TIME = re.compile(r"(?:(\d+):)?(\d{1,2}):(\d{2})[.,](\d{1,3})")
CUE = re.compile(r"^\s*((?:\d+:)?\d{1,2}:\d{2}[.,]\d{1,3})\s*-->\s*((?:\d+:)?\d{1,2}:\d{2}[.,]\d{1,3})")
TAG = re.compile(r"<[^>]+>")
SPEAKER_TAG = re.compile(r"^<v\s+([^>]+)>")


def seconds(t: str) -> float:
    m = TIME.fullmatch(t.strip())
    if not m:
        raise ValueError(t)
    h, mi, s, ms = m.groups()
    return int(h or 0) * 3600 + int(mi) * 60 + int(s) + int(ms.ljust(3, "0")) / 1000


def _cues(text: str) -> list[dict]:
    out, cur = [], None
    for line in text.splitlines():
        m = CUE.match(line)
        if m:
            cur = {"start": seconds(m.group(1)), "end": seconds(m.group(2)), "text": "", "speaker": None}
            out.append(cur)
        elif cur is not None and line.strip():
            raw = line.strip()
            sp = SPEAKER_TAG.match(raw)
            if sp and not cur["speaker"]:
                cur["speaker"] = sp.group(1).strip()
            t = html.unescape(TAG.sub("", raw)).strip()
            cur["text"] = (cur["text"] + " " + t).strip()
        elif not line.strip():
            cur = None
    return [c for c in out if c["text"]]


def parse_publisher(body: bytes, mime: str) -> list[dict]:
    """Segments from a publisher transcript; [] when it cannot be used (then the audio path runs)."""
    mime = (mime or "").split(";")[0].strip().lower()
    if mime == "text/html":
        return []
    text = body.decode("utf-8-sig", errors="replace")
    if text.lstrip()[:15].lower().startswith(("<!doctype", "<html")):
        return []
    if mime == "application/json" or text.lstrip().startswith("{"):
        try:
            data = json.loads(text)
        except ValueError:
            return []
        segs = data.get("segments") if isinstance(data, dict) else None
        out = []
        for s in segs or []:
            try:
                out.append({"start": float(s["startTime"]), "end": float(s.get("endTime", s["startTime"])),
                            "text": str(s.get("body", "")).strip(), "speaker": s.get("speaker")})
            except (KeyError, TypeError, ValueError):
                return []
        return [s for s in out if s["text"]]
    if "-->" in text:
        return _cues(text)
    plain = " ".join(text.split())
    return [{"start": 0.0, "end": 0.0, "text": plain, "speaker": None}] if plain else []


def valid_publisher(segs: list[dict]) -> bool:
    words = sum(len(s["text"].split()) for s in segs)
    if not segs or words < 20:
        return False
    return all(b["start"] >= a["start"] for a, b in zip(segs, segs[1:]))


def full_text(segs: list[dict]) -> str:
    return " ".join(s["text"].strip() for s in segs if s["text"].strip())


def _ts(t: float, sep: str) -> str:
    ms = int(round(max(t, 0.0) * 1000))
    h, ms = divmod(ms, 3600000)
    m, ms = divmod(ms, 60000)
    s, ms = divmod(ms, 1000)
    return f"{h:02d}:{m:02d}:{s:02d}{sep}{ms:03d}"


def _line(s: dict) -> str:
    return f"{s['speaker']}: {s['text']}" if s.get("speaker") else s["text"]


def to_txt(segs: list[dict]) -> str:
    if any(s.get("speaker") for s in segs):
        return "\n".join(_line(s) for s in segs) + "\n"
    return full_text(segs) + "\n"


def to_srt(segs: list[dict]) -> str:
    return "\n".join(f"{i}\n{_ts(s['start'], ',')} --> {_ts(s['end'], ',')}\n{_line(s)}\n" for i, s in enumerate(segs, 1))


def to_vtt(segs: list[dict]) -> str:
    return "WEBVTT\n\n" + "\n".join(f"{_ts(s['start'], '.')} --> {_ts(s['end'], '.')}\n{_line(s)}\n" for s in segs)


def to_json(row: dict, words: list[dict] | None) -> str:
    keep = {k: row.get(k) for k in ("episodeTitle", "durationSeconds", "language", "engine", "text", "segments")}
    if words is not None:
        keep["words"] = words
    return json.dumps(keep, ensure_ascii=False, indent=1)


CONTENT_TYPES = {"txt": "text/plain; charset=utf-8", "srt": "application/x-subrip; charset=utf-8",
                 "vtt": "text/vtt; charset=utf-8", "json": "application/json; charset=utf-8"}
