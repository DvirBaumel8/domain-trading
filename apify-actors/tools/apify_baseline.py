#!/usr/bin/env python3
"""Pre-push step of a live rebuild: record each actor's listing fields (GET-only) so `apify_guard.py --live` can compare after the push.

Usage: apify_baseline.py <out.json> <actor-folder-name> ...   (token from APIFY_TOKEN, never printed)
Fails (exit 1) if an actor is not public (it belongs on the private path) or a GET fails; exit 2 on bad usage / not allowed.
"""
from __future__ import annotations

import json
import os
import sys
from pathlib import Path

from apify_guard import LIVE, fetch, listing_view


def main(argv: list[str], fetch_fn=fetch) -> int:
    token = os.environ.get("APIFY_TOKEN", "")
    if not token or len(argv) < 2:
        print("usage: apify_baseline.py <out.json> <actor> ...  (APIFY_TOKEN must be set)", file=sys.stderr)
        return 2
    out, names = argv[0], argv[1:]
    if any(n not in LIVE for n in names):
        print("actor not allowed", file=sys.stderr)
        return 2
    baselines = {}
    for name in names:
        try:
            actor = fetch_fn(name, token)
        except Exception as e:  # never echo the request: it carries the token
            print(f"{name}: GET failed ({type(e).__name__})", file=sys.stderr)
            return 1
        if actor.get("isPublic") is not True:
            print(f"{name}: not public, use the private path", file=sys.stderr)
            return 1
        baselines[name] = listing_view(actor)
    Path(out).write_text(json.dumps(baselines))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
