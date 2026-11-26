#!/usr/bin/env python3
"""Draws broken-link-auditor/logo.png (512x512, flat colours, a broken chain link). Standard library only.

Run: python3 tools/make_broken_link_logo.py [output.png]. The result is committed, so nothing runs at build time.
"""
from __future__ import annotations

import math
import struct
import sys
import zlib
from pathlib import Path

SIZE = 512
BG, LINK_A, LINK_B, SPARK = (30, 41, 59), (248, 250, 252), (249, 115, 22), (248, 250, 252)
R_OUT, STROKE, HALF = 62.0, 26.0, 33.0   # outer radius, ring width, half length of the straight part
SS = 3                                    # 3x3 samples per pixel for smooth edges


def ring(u: float, v: float, cu: float) -> bool:
    """A capsule-shaped ring centred on (cu, 0), lying along the u axis."""
    d = math.hypot(u - cu - max(-HALF, min(HALF, u - cu)), v)  # distance to the capsule's centre segment
    return R_OUT - STROKE <= d <= R_OUT


def spark(u: float, v: float) -> bool:
    """Two short bars across the gap, like fragments of the broken link."""
    return any(abs(u - cu) <= 7 and abs(v - cv) <= 26 for cu, cv in ((-4, -58), (6, 58)))


def colour(x: float, y: float) -> tuple[int, int, int]:
    u, v = ((x - 256) + (y - 256)) / math.sqrt(2), ((x - 256) - (y - 256)) / math.sqrt(2)
    if ring(u, v, -120):
        return LINK_A
    if ring(u, v, 120):
        return LINK_B
    return SPARK if spark(u, v) else BG


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
    out = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(__file__).resolve().parents[1] / "broken-link-auditor" / "logo.png"
    out.write_bytes(png(render()))
    print(f"wrote {out}")
