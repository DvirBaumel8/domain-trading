#!/usr/bin/env python3
"""Sync the Store text keys of each actor.json to Apify. Run from Dvir's machine right after `apify push`.

Sends only TEXT_KEYS plus exampleRunInput (the input schema prefill; never prices, pricing model or visibility), then reads them back and fails on any difference.
The token comes from the APIFY_TOKEN environment variable and is never printed.
"""
from __future__ import annotations

import json
import os
import sys
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
BASE = "https://api.apify.com"
TEXT_KEYS = ("title", "description", "seoTitle", "seoDescription")
MAX_DESCRIPTION = 300  # Apify rejects a longer Store description
ACTOR_IDS = {
    "domain-checkup-report": "Hfr4MI0LjpkjEYXcA",
    "bulk-dns-email-auth-checker": "VnrYq91nbRYrRMmS1",
    "sitemap-url-extractor": "HcsxPAYrb95rOsOrQ",
    "bulk-domain-availability-checker": "mKqSGmlx8krmtqgpU",
}


def text_payload(actor_json: dict) -> dict:
    return {k: actor_json[k] for k in TEXT_KEYS if k in actor_json}


def example_run_input(name: str) -> dict | None:
    """Store "example run input": the input schema prefill, as Apify wants it ({body, contentType}). Text only."""
    schema = json.loads((ROOT / name / ".actor" / "input_schema.json").read_text())
    prefill = {k: v["prefill"] for k, v in schema.get("properties", {}).items() if "prefill" in v}
    if not prefill:
        return None
    return {"body": json.dumps(prefill, indent=2), "contentType": "application/json; charset=utf-8"}


def _same_example(want: dict, got) -> bool:
    try:
        return json.loads(want["body"]) == json.loads((got or {}).get("body", "null"))
    except (TypeError, ValueError):
        return False


def _request(method: str, path: str, token: str, body: dict | None = None) -> dict:
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(BASE + path, data=data, method=method)
    req.add_header("Authorization", f"Bearer {token}")
    if data is not None:
        req.add_header("Content-Type", "application/json")
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.loads(r.read())["data"]


def sync(name: str, actor_id: str, token: str, http=_request) -> list[str]:
    """Returns the keys that differ after the PUT (empty list = ok). Raises ValueError, before any HTTP call, if the description is over 300 characters."""
    want = text_payload(json.loads((ROOT / name / ".actor" / "actor.json").read_text()))
    desc = want.get("description", "")
    if len(desc) > MAX_DESCRIPTION:  # validate before any HTTP call
        raise ValueError(f"{name}: description is {len(desc)} characters, max {MAX_DESCRIPTION}")
    example = example_run_input(name)
    body = dict(want, exampleRunInput=example) if example else want
    http("PUT", f"/v2/actors/{actor_id}", token, body)
    got = http("GET", f"/v2/actors/{actor_id}", token)
    diff = [k for k, v in want.items() if got.get(k) != v]
    if example and not _same_example(example, got.get("exampleRunInput")):
        diff.append("exampleRunInput")
    return diff


def main() -> int:
    token = os.environ.get("APIFY_TOKEN", "")
    if not token:
        print("APIFY_TOKEN is not set", file=sys.stderr)
        return 2
    bad = 0
    for name, actor_id in ACTOR_IDS.items():
        try:
            diff = sync(name, actor_id, token)
        except Exception as e:  # never echo the request (it carries the token)
            print(f"{name}: failed ({type(e).__name__})", file=sys.stderr)
            bad = 1
            continue
        print(f"{name}: {'ok' if not diff else 'DIFFERS ' + ','.join(diff)}")
        bad |= bool(diff)
    return bad


if __name__ == "__main__":
    sys.exit(main())
