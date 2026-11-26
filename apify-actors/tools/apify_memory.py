#!/usr/bin/env python3
"""Post-push step: set defaultRunOptions.memoryMbytes = 256 on the 3 new actors.

`apify push` does not apply actor.json defaultRunOptions, so Apify keeps 4096.
Usage: apify_memory.py <actor-folder-name> ...   (token from APIFY_TOKEN, never printed)
Sends PUT /v2/acts/{id} with only {"defaultRunOptions": {...}}: the current run options are read
first and only memoryMbytes is changed (build and timeout are kept). Never touches isPublic,
categories, pricing or SEO text. Exit 1 on any failure, 2 on bad usage.
"""
from __future__ import annotations

import json
import os
import sys
import urllib.request

from apify_guard import ALLOWED, BASE, fetch

TARGET_MB = 256


def put(path: str, token: str, body: dict) -> dict:
    req = urllib.request.Request(
        f"{BASE}{path}", data=json.dumps(body).encode(), method="PUT",
        headers={"Authorization": f"Bearer {token}", "Accept": "application/json", "Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.loads(r.read())["data"]


def set_memory(name: str, token: str, fetch_fn=fetch, put_fn=put) -> int:
    """Set memory for one actor; returns the memory Apify reports afterwards."""
    actor = fetch_fn(name, token)
    options = dict(actor.get("defaultRunOptions") or {})
    options["memoryMbytes"] = TARGET_MB
    updated = put_fn(f"/v2/acts/{actor['id']}", token, {"defaultRunOptions": options})
    return int((updated.get("defaultRunOptions") or {}).get("memoryMbytes", -1))


def main(argv: list[str], fetch_fn=fetch, put_fn=put) -> int:
    token = os.environ.get("APIFY_TOKEN", "")
    if not token:
        print("APIFY_TOKEN is not set", file=sys.stderr)
        return 2
    names = argv or list(ALLOWED)
    if any(n not in ALLOWED for n in names):
        print("actor not in the allow-list", file=sys.stderr)
        return 2
    bad = 0
    for name in names:
        try:
            got = set_memory(name, token, fetch_fn, put_fn)
        except Exception as e:  # never echo the request: it carries the token
            print(f"{name}: memory update failed ({type(e).__name__})", file=sys.stderr)
            bad = 1
            continue
        if got != TARGET_MB:
            print(f"{name}: memory is {got} MB after update, expected {TARGET_MB}", file=sys.stderr)
            bad = 1
            continue
        print(f"{name}: defaultRunOptions.memoryMbytes = {TARGET_MB}")
    return bad


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
