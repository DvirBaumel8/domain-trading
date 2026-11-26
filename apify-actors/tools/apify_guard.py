#!/usr/bin/env python3
"""Post-push check for `apify-push`: the actor must be private and carry no pricing. GET-only.

Usage: apify_guard.py <actor-folder-name> ...   (token from APIFY_TOKEN, never printed)
Fails (exit 1) if isPublic is true or any pricing info exists. Prints id, name and build version,
and writes them to the job summary plus a ready line for docs/requests/DOM-TO-GAVRIEL.md.
"""
from __future__ import annotations

import json
import os
import sys
import urllib.error
import urllib.request
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo

BASE = "https://api.apify.com"
ALLOWED = ("wayback-domain-history", "broken-link-auditor", "bulk-pagespeed-checker")
PRICE_KEY_HINTS = ("pric", "monetiz")


def problems(actor: dict) -> list[str]:
    """Reasons this actor is not private-and-unpriced (empty list = ok)."""
    out = []
    if actor.get("isPublic") is True:
        out.append("isPublic is true")
    if actor.get("pricingInfos"):
        out.append("pricingInfos is not empty")
    for key, value in actor.items():
        if key != "pricingInfos" and any(h in key.lower() for h in PRICE_KEY_HINTS) and value not in (None, False, [], {}, ""):
            out.append(f"pricing field set: {key}")
    return out


def build_version(actor: dict) -> str:
    tagged = actor.get("taggedBuilds") or {}
    latest = tagged.get("latest") or {}
    return str(latest.get("buildNumber") or (actor.get("versions") or [{}])[-1].get("versionNumber") or "unknown")


def summary_line(actor: dict, now: datetime) -> str:
    return (f"- {now:%Y-%m-%d %H:%M} IST (DOM): pushed PRIVATE, unpublished, no price: `{actor.get('name')}` "
            f"id `{actor.get('id')}` build `{build_version(actor)}`.")


def get(path: str, token: str) -> dict:
    req = urllib.request.Request(f"{BASE}{path}", headers={"Authorization": f"Bearer {token}", "Accept": "application/json"})
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.loads(r.read())["data"]


def fetch(name: str, token: str, get_fn=get) -> dict:
    """Resolve by `me~name`; on 404 use `<username>~name` with the username from /v2/users/me."""
    try:
        return get_fn(f"/v2/acts/me~{name}", token)
    except urllib.error.HTTPError as e:
        if e.code != 404:
            raise
    username = get_fn("/v2/users/me", token).get("username")
    if not username:
        raise LookupError("no username from /v2/users/me")
    return get_fn(f"/v2/acts/{username}~{name}", token)


def main(argv: list[str], fetch_fn=fetch) -> int:
    token = os.environ.get("APIFY_TOKEN", "")
    if not token:
        print("APIFY_TOKEN is not set", file=sys.stderr)
        return 2
    names = argv or list(ALLOWED)
    if any(n not in ALLOWED for n in names):
        print("actor not in the allow-list", file=sys.stderr)
        return 2
    now = datetime.now(ZoneInfo("Asia/Jerusalem"))
    lines, bad = [], 0
    for name in names:
        try:
            actor = fetch_fn(name, token)
        except Exception as e:  # never echo the request: it carries the token
            print(f"{name}: GET failed ({type(e).__name__})", file=sys.stderr)
            bad = 1
            continue
        found = problems(actor)
        if found:
            print(f"{name}: FAIL: {'; '.join(found)}", file=sys.stderr)
            bad = 1
            continue
        print(f"{name}: ok, private, no pricing (id {actor.get('id')}, build {build_version(actor)})")
        lines.append(summary_line(actor, now))
    if lines and not bad:
        text = "\n".join(lines) + "\n"
        summary = os.environ.get("GITHUB_STEP_SUMMARY")
        if summary:
            with open(summary, "a") as f:
                f.write("### Pushed private\n\nAppend to `docs/requests/DOM-TO-GAVRIEL.md` (via PR):\n\n" + text)
        Path("dom-to-gavriel-line.md").write_text(text)
    return bad


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
