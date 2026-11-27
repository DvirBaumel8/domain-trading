#!/usr/bin/env python3
"""Post-push check for `apify-push`. GET-only.

Usage: apify_guard.py [--live --baseline FILE] <actor-folder-name> ...   (token from APIFY_TOKEN, never printed)
Private path (default, PRIVATE allow-list): fails (exit 1) if isPublic is true, any pricing info exists, or
defaultRunOptions.memoryMbytes != 256.
Live path (--live, LIVE allow-list, already public and priced): fails if isPublic is not true, if any listing field
(title, description, SEO text, categories, pricing) differs from the baseline taken before the push, if memory != 256, or if
broken-link-auditor timeoutSecs != 7200. Being public or priced is fine there.
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
PRIVATE = ("wayback-domain-history", "bulk-pagespeed-checker", "ai-brand-mention-check")  # stay private and unpriced
LIVE = ("bulk-domain-availability-checker", "sitemap-url-extractor", "broken-link-auditor")  # already public and priced
LIVE_TIMEOUTS = {"broken-link-auditor": 7200}  # timeoutSecs the live path sets and checks; other actors keep theirs
LISTING_FIELDS = ("isPublic", "title", "description", "seoTitle", "seoDescription", "categories", "pricingInfos")
PRICE_KEY_HINTS = ("pric", "monetiz")
TARGET_MEMORY_MB = 256


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
    memory = (actor.get("defaultRunOptions") or {}).get("memoryMbytes")
    if memory != TARGET_MEMORY_MB:
        out.append(f"defaultRunOptions.memoryMbytes is {memory}, expected {TARGET_MEMORY_MB}")
    return out


def listing_view(actor: dict) -> dict:
    """The fields a rebuild must leave alone: listing text, categories, visibility and every pricing-looking field."""
    view = {k: actor.get(k) for k in LISTING_FIELDS}
    for key, value in actor.items():
        if key not in view and any(h in key.lower() for h in PRICE_KEY_HINTS):
            view[key] = value
    return view


def live_problems(actor: dict, baseline: dict, name: str = "") -> list[str]:
    """Reasons a live rebuild went wrong (empty list = ok). Public and priced are expected, not problems."""
    out = []
    if actor.get("isPublic") is not True:
        out.append("isPublic is not true")
    now = listing_view(actor)
    for key in sorted(set(now) | set(baseline)):
        if key != "isPublic" and now.get(key) != baseline.get(key):
            out.append(f"{key} changed")
    options = actor.get("defaultRunOptions") or {}
    if options.get("memoryMbytes") != TARGET_MEMORY_MB:
        out.append(f"defaultRunOptions.memoryMbytes is {options.get('memoryMbytes')}, expected {TARGET_MEMORY_MB}")
    want = LIVE_TIMEOUTS.get(name)
    if want is not None and options.get("timeoutSecs") != want:
        out.append(f"defaultRunOptions.timeoutSecs is {options.get('timeoutSecs')}, expected {want}")
    return out


def build_version(actor: dict) -> str:
    tagged = actor.get("taggedBuilds") or {}
    latest = tagged.get("latest") or {}
    return str(latest.get("buildNumber") or (actor.get("versions") or [{}])[-1].get("versionNumber") or "unknown")


def summary_line(actor: dict, now: datetime, live: bool = False) -> str:
    kind = "rebuilt LIVE, still public, listing and price unchanged" if live else "pushed PRIVATE, unpublished, no price"
    return (f"- {now:%Y-%m-%d %H:%M} IST (DOM): {kind}: `{actor.get('name')}` "
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
    args, live, baseline_path = list(argv), False, None
    if "--live" in args:
        live = True
        args.remove("--live")
    if "--baseline" in args:
        i = args.index("--baseline")
        baseline_path = args[i + 1] if i + 1 < len(args) else None
        del args[i:i + 2]
    allowed = LIVE if live else PRIVATE
    names = args or list(allowed)
    if any(n not in allowed for n in names):
        print("actor not allowed", file=sys.stderr)
        return 2
    baselines = {}
    if live:
        try:
            baselines = json.loads(Path(baseline_path).read_text())
        except Exception:
            print("live check needs --baseline FILE from apify_baseline.py", file=sys.stderr)
            return 2
        if any(n not in baselines for n in names):
            print("baseline is missing an actor", file=sys.stderr)
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
        found = live_problems(actor, baselines[name], name) if live else problems(actor)
        if found:
            print(f"{name}: FAIL: {'; '.join(found)}", file=sys.stderr)
            bad = 1
            continue
        state = "live, listing and price unchanged" if live else "private, no pricing"
        print(f"{name}: ok, {state} (id {actor.get('id')}, build {build_version(actor)})")
        lines.append(summary_line(actor, now, live))
    if lines and not bad:
        text = "\n".join(lines) + "\n"
        summary = os.environ.get("GITHUB_STEP_SUMMARY")
        if summary:
            with open(summary, "a") as f:
                f.write(f"### Pushed {'live' if live else 'private'}\n\nAppend to `docs/requests/DOM-TO-GAVRIEL.md` (via PR):\n\n" + text)
        Path("dom-to-gavriel-line.md").write_text(text)
    return bad


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
