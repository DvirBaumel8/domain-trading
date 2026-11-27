#!/usr/bin/env python3
"""Draws podcast-transcriber/logo.png (512x512, flat colours: a sound wave turning into text lines). Standard library only.

Run: python3 tools/make_podcast_logo.py [output.png]. The result is committed, so nothing runs at build time.
"""
from __future__ import annotations

import struct
import sys
import zlib
from pathlib import Path

SIZE = 512
BG, WAVE, TEXT = (17, 24, 39), (45, 212, 191), (248, 250, 252)
BARS = (40, 90, 150, 210, 120, 180, 70)   # bar heights of the sound wave (left half)
SS = 3                                     # 3x3 samples per pixel for smooth edges


def rounded_rect(x: float, y: float, x0: float, y0: float, x1: float, y1: float, r: float) -> bool:
    cx, cy = min(max(x, x0 + r), x1 - r), min(max(y, y0 + r), y1 - r)
    return (x - cx) ** 2 + (y - cy) ** 2 <= r * r and x0 <= x <= x1 and y0 <= y <= y1


def colour(x: float, y: float) -> tuple[int, int, int]:
    for i, h in enumerate(BARS):
        x0 = 64 + i * 26
        if rounded_rect(x, y, x0, 256 - h / 2, x0 + 16, 256 + h / 2, 8):
            return WAVE
    for j, w in enumerate((190, 150, 175, 120)):
        y0 = 178 + j * 44
        if rounded_rect(x, y, 262, y0, 262 + w, y0 + 22, 11):
            return TEXT
    return BG


def render() -> bytes:
    rows = []
    for y in range(SIZE):
        row = bytearray([0])
        for x in range(SIZE):
            acc = [0, 0, 0]
            for i in range(SS):
                for j in range(SS):
                    c = colour(x + (i + 0.5) / SS, y + (j + 0.5) / SS)
                    for k in range(3):
                        acc[k] += c[k]
            row += bytes(a // (SS * SS) for a in acc)
        rows.append(bytes(row))
    return b"".join(rows)


def png(raw: bytes) -> bytes:
    def chunk(tag: bytes, data: bytes) -> bytes:
        return struct.pack(">I", len(data)) + tag + data + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)
    return (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", SIZE, SIZE, 8, 2, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress(raw, 9)) + chunk(b"IEND", b""))


if __name__ == "__main__":
    out = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(__file__).resolve().parents[1] / "podcast-transcriber" / "logo.png"
    out.write_bytes(png(render()))
    print(f"wrote {out}")
