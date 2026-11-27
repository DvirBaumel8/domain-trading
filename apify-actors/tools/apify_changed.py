#!/usr/bin/env python3
"""Which LIVE actors changed in a commit range. Prints their folder names, space separated (empty = push nobody).

Usage: apify_changed.py <before-sha> <after-sha>
A change that touches only private actors, other folders or the workflow file selects nothing. No network.
"""
from __future__ import annotations

import subprocess
import sys

from apify_guard import LIVE

ZERO = "0" * 40


def select(files: list[str]) -> list[str]:
    """Live actors (in allow-list order) with at least one changed file under apify-actors/<name>/."""
    return [n for n in LIVE if any(f.startswith(f"apify-actors/{n}/") for f in files)]


def changed_files(before: str, after: str) -> list[str]:
    if before and before != ZERO:
        cmd = ["git", "diff", "--name-only", before, after]
    else:  # new branch or unknown base: just the head commit
        cmd = ["git", "show", "--name-only", "--format=", after]
    return subprocess.run(cmd, check=True, capture_output=True, text=True).stdout.split()


def main(argv: list[str]) -> int:
    if len(argv) != 2:
        print("usage: apify_changed.py <before> <after>", file=sys.stderr)
        return 2
    print(" ".join(select(changed_files(*argv))))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
