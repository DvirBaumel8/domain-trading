#!/usr/bin/env python3
"""Post-push step: set defaultRunOptions.memoryMbytes = 256 on a pushed actor (podcast-transcriber: 1024 and timeoutSecs 7200).

`apify push` does not apply actor.json defaultRunOptions, so Apify keeps 4096.
Usage: apify_memory.py [--live] <actor-folder-name> ...   (token from APIFY_TOKEN, never printed)
Default: the PRIVATE allow-list. --live: the LIVE allow-list; there broken-link-auditor also gets timeoutSecs 7200 (other actors keep theirs).
Sends PUT /v2/acts/{id} with only {"defaultRunOptions": {...}}: the current run options are read
first and only memoryMbytes (and, live, that one timeout) is changed (build is kept). Never touches isPublic,
categories, pricing or SEO text. Exit 1 on any failure, 2 on bad usage.
"""
from __future__ import annotations

import json
import os
import sys
import urllib.request

from apify_guard import BASE, LIVE, LIVE_TIMEOUTS, PRIVATE, PRIVATE_TIMEOUTS, fetch, target_memory

TARGET_MB = 256  # every actor except the ones in apify_guard.MEMORY_MB (podcast-transcriber: 1024)


def put(path: str, token: str, body: dict) -> dict:
    req = urllib.request.Request(
        f"{BASE}{path}", data=json.dumps(body).encode(), method="PUT",
        headers={"Authorization": f"Bearer {token}", "Accept": "application/json", "Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.loads(r.read())["data"]


def set_memory(name: str, token: str, fetch_fn=fetch, put_fn=put, live: bool = False) -> int:
    """Set memory (live: and the actor's timeout, if it has one) for one actor; returns the memory Apify reports afterwards."""
    actor = fetch_fn(name, token)
    options = dict(actor.get("defaultRunOptions") or {})
    options["memoryMbytes"] = target_memory(name)
    timeout = LIVE_TIMEOUTS.get(name) if live else PRIVATE_TIMEOUTS.get(name)
    if timeout is not None:
        options["timeoutSecs"] = timeout
    updated = put_fn(f"/v2/acts/{actor['id']}", token, {"defaultRunOptions": options})
    if timeout is not None and (updated.get("defaultRunOptions") or {}).get("timeoutSecs") != timeout:
        raise RuntimeError("timeout not applied")
    return int((updated.get("defaultRunOptions") or {}).get("memoryMbytes", -1))


def main(argv: list[str], fetch_fn=fetch, put_fn=put) -> int:
    token = os.environ.get("APIFY_TOKEN", "")
    if not token:
        print("APIFY_TOKEN is not set", file=sys.stderr)
        return 2
    live = "--live" in argv
    allowed = LIVE if live else PRIVATE
    names = [a for a in argv if a != "--live"] or list(allowed)
    if any(n not in allowed for n in names):
        print("actor not allowed", file=sys.stderr)
        return 2
    bad = 0
    for name in names:
        try:
            got = set_memory(name, token, fetch_fn, put_fn, live)
        except Exception as e:  # never echo the request: it carries the token
            print(f"{name}: memory update failed ({type(e).__name__})", file=sys.stderr)
            bad = 1
            continue
        if got != target_memory(name):
            print(f"{name}: memory is {got} MB after update, expected {target_memory(name)}", file=sys.stderr)
            bad = 1
            continue
        print(f"{name}: defaultRunOptions.memoryMbytes = {target_memory(name)}")
    return bad


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
