#!/bin/bash
# One-command arm A submit for 2026-10-23 (Buyer; model Grok Bot; prompt Buyer profile + task 2026-10-22 19:10 IDT).
# Verifies the frozen code sha first, then pulls DOM's frozen 10-23 pool, ranks, and POSTs. Deadline 16:00 UTC = 19:00 IDT 2026-10-23.
set -e; cd "$(dirname "$0")"
echo "a66c99e431c5d46add42c76726ce4917497ae494ac061862f467732bb17b43c0  arm_a_v2.py" | sha256sum -c -
python3 arm_a_v2.py 2026-10-23 2026-10-23 --post
