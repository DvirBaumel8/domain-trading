#!/usr/bin/env python3
"""Check for `apify-push`: the price must be unchanged by the push and the run memory must be 256 MB. GET-only.

Usage:
  apify_guard.py [--allow-live] --snapshot FILE <actor-folder-name> ...   before the push: record isPublic and pricing
  apify_guard.py [--allow-live] --before FILE <actor-folder-name> ...     after the push: compare, check memory
(token from APIFY_TOKEN, never printed). Fails (exit 1) if the pricing differs from the snapshot or
defaultRunOptions.memoryMbytes != 256. A public, already-priced actor passes when its pricing is unchanged.
An actor that did not exist before the push counts as unpriced. Nothing is ever written to Apify.
Prints id, name and build version, and writes them to the job summary plus a ready line for docs/requests/DOM-TO-GAVRIEL.md.
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
LIVE = ("bulk-dns-email-auth-checker", "sitemap-url-extractor", "bulk-domain-availability-checker", "domain-checkup-report")


def allowed_names(allow_live: bool = False) -> tuple:
    """The 3 newer actors; the 4 older live ones only with an explicit flag."""
    return ALLOWED + LIVE if allow_live else ALLOWED
PRICE_KEY_HINTS = ("pric", "monetiz")
TARGET_MEMORY_MB = 256


def price_snapshot(actor: dict | None) -> dict:
    """What the push must not change: isPublic and every pricing field. A missing actor is private and unpriced."""
    actor = actor or {}
    prices = {k: v for k, v in actor.items() if any(h in k.lower() for h in PRICE_KEY_HINTS) and v not in (None, False, [], {}, "")}
    return {"isPublic": bool(actor.get("isPublic")), "pricing": prices}


def problems(actor: dict, before: dict | None = None) -> list[str]:
    """Reasons to fail (empty list = ok): pricing changed since `before` (none given = was unpriced), or memory is not 256."""
    out = []
    was = (before if before is not None else price_snapshot(None))["pricing"]
    if price_snapshot(actor)["pricing"] != was:
        out.append("pricing changed by the push")
    memory = (actor.get("defaultRunOptions") or {}).get("memoryMbytes")
    if memory != TARGET_MEMORY_MB:
        out.append(f"defaultRunOptions.memoryMbytes is {memory}, expected {TARGET_MEMORY_MB}")
    return out


def build_version(actor: dict) -> str:
    tagged = actor.get("taggedBuilds") or {}
    latest = tagged.get("latest") or {}
    return str(latest.get("buildNumber") or (actor.get("versions") or [{}])[-1].get("versionNumber") or "unknown")


def summary_line(actor: dict, now: datetime) -> str:
    return (f"- {now:%Y-%m-%d %H:%M} IST (DOM): pushed, visibility and price untouched: `{actor.get('name')}` "
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


def _missing(e: Exception) -> bool:
    return isinstance(e, urllib.error.HTTPError) and e.code == 404


def parse(argv: list[str]) -> tuple[bool, str | None, str | None, list[str]]:
    allow_live, snap, before, names = False, None, None, []
    it = iter(argv)
    for a in it:
        if a == "--allow-live":
            allow_live = True
        elif a == "--snapshot":
            snap = next(it, None)
        elif a == "--before":
            before = next(it, None)
        else:
            names.append(a)
    return allow_live, snap, before, names


def main(argv: list[str], fetch_fn=fetch) -> int:
    token = os.environ.get("APIFY_TOKEN", "")
    if not token:
        print("APIFY_TOKEN is not set", file=sys.stderr)
        return 2
    allow_live, snap, before_file, names = parse(argv)
    allowed = allowed_names(allow_live)
    names = names or list(ALLOWED)
    if any(n not in allowed for n in names):
        print("actor not in the allow-list", file=sys.stderr)
        return 2
    if snap:  # before the push
        shots = {}
        for name in names:
            try:
                shots[name] = price_snapshot(fetch_fn(name, token))
            except Exception as e:
                if not _missing(e):
                    print(f"{name}: GET failed ({type(e).__name__})", file=sys.stderr)
                    return 1
                shots[name] = price_snapshot(None)  # not on Apify yet: the push creates it, unpriced
        Path(snap).write_text(json.dumps(shots, sort_keys=True))
        print(f"snapshot saved for {len(shots)} actor(s)")
        return 0
    befores = json.loads(Path(before_file).read_text()) if before_file else {}
    now = datetime.now(ZoneInfo("Asia/Jerusalem"))
    lines, bad = [], 0
    for name in names:
        try:
            actor = fetch_fn(name, token)
        except Exception as e:  # never echo the request: it carries the token
            print(f"{name}: GET failed ({type(e).__name__})", file=sys.stderr)
            bad = 1
            continue
        found = problems(actor, befores.get(name))
        if found:
            print(f"{name}: FAIL: {'; '.join(found)}", file=sys.stderr)
            bad = 1
            continue
        print(f"{name}: ok, pricing unchanged, memory {TARGET_MEMORY_MB} MB (id {actor.get('id')}, build {build_version(actor)})")
        lines.append(summary_line(actor, now))
    if lines and not bad:
        text = "\n".join(lines) + "\n"
        summary = os.environ.get("GITHUB_STEP_SUMMARY")
        if summary:
            with open(summary, "a") as f:
                f.write("### Pushed\n\nAppend to `docs/requests/DOM-TO-GAVRIEL.md` (via PR):\n\n" + text)
        Path("dom-to-gavriel-line.md").write_text(text)
    return bad


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
