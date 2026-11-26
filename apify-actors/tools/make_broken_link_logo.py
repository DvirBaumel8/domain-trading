#!/usr/bin/env python3
"""Generate broken-link-auditor/logo.png (512x512): a broken chain link, flat colours. Standard library only.

Usage: python3 tools/make_broken_link_logo.py [OUTPUT]   (default: broken-link-auditor/logo.png)
Not needed at runtime: the PNG is committed.
"""
from __future__ import annotations

import math
import struct
import sys
import zlib
from pathlib import Path

SIZE = 512
BG = (30, 58, 138)        # deep blue
LINK = (248, 250, 252)    # near white
SPARK = (249, 115, 22)    # orange
SS = 2                    # 2x2 supersampling for smooth edges


def _seg_dist(px, py, ax, ay, bx, by):
    dx, dy = bx - ax, by - ay
    t = max(0.0, min(1.0, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)))
    return math.hypot(px - (ax + t * dx), py - (ay + t * dy))


def _ring(px, py, cx, cy, half_len, outer, inner):
    """Capsule ring whose long axis runs along the diagonal (1, 1)."""
    u = math.sqrt(0.5)
    ax, ay = cx - half_len * u, cy - half_len * u
    bx, by = cx + half_len * u, cy + half_len * u
    return inner <= _seg_dist(px, py, ax, ay, bx, by) <= outer


def _color(x, y):
    if _ring(x, y, 168, 168, 62, 52, 28) or _ring(x, y, 344, 344, 62, 52, 28):
        return LINK
    # three spark bars across the gap, centred on (256, 256)
    for ang in (-35, 45, 125):
        a = math.radians(ang)
        dx, dy = math.cos(a), math.sin(a)
        r0, r1 = 22, 52
        if _seg_dist(x, y, 256 + dx * r0, 256 + dy * r0, 256 + dx * r1, 256 + dy * r1) <= 7:
            return SPARK
    return BG


def render() -> bytes:
    rows = []
    for y in range(SIZE):
        row = bytearray([0])  # PNG filter type 0
        for x in range(SIZE):
            r = g = b = 0
            for sy in range(SS):
                for sx in range(SS):
                    c = _color(x + (sx + 0.5) / SS, y + (sy + 0.5) / SS)
                    r, g, b = r + c[0], g + c[1], b + c[2]
            n = SS * SS
            row += bytes((r // n, g // n, b // n, 255))
        rows.append(bytes(row))
    return b"".join(rows)


def png(raw: bytes) -> bytes:
    def chunk(tag: bytes, data: bytes) -> bytes:
        return struct.pack(">I", len(data)) + tag + data + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)
    ihdr = struct.pack(">IIBBBBB", SIZE, SIZE, 8, 6, 0, 0, 0)  # 8-bit RGBA
    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", ihdr) + chunk(b"IDAT", zlib.compress(raw, 9)) + chunk(b"IEND", b"")


if __name__ == "__main__":
    out = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(__file__).resolve().parents[1] / "broken-link-auditor" / "logo.png"
    out.write_bytes(png(render()))
    print(f"wrote {out}")
