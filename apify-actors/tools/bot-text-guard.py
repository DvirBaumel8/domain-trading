#!/usr/bin/env python3
"""Fail if a bot commit changes anything under apify-actors/ except README.md and text keys of .actor/*.json.

Usage: bot-text-guard.py COMMIT   (compares COMMIT with its first parent)
"""
from __future__ import annotations

import fnmatch
import json
import subprocess
import sys

TEXT_KEYS = {"title", "description", "seoTitle", "seoDescription", "sectionCaption", "sectionDescription",
             "example", "prefill", "editor"}


def _diff(old, new, path=()):
    """Yield the path of every changed leaf whose key is not a text key."""
    if isinstance(old, dict) and isinstance(new, dict):
        for k in set(old) | set(new):
            yield from _diff(old.get(k), new.get(k), path + (k,))
    elif old != new:
        if not (path and path[-1] in TEXT_KEYS) and not any(p in TEXT_KEYS for p in path):
            yield ".".join(map(str, path))


def forbidden_json_changes(old_text: str | None, new_text: str | None) -> list[str]:
    try:
        old = json.loads(old_text) if old_text else {}
        new = json.loads(new_text) if new_text else {}
    except ValueError:
        return ["(invalid JSON)"]
    return sorted(set(_diff(old, new)))


def check_files(changed: list[str], show) -> list[str]:
    """changed: paths. show(path, 'old'|'new') -> text or None. Returns problems."""
    problems = []
    for f in changed:
        if f.startswith("docs/requests/"):
            continue
        if not f.startswith("apify-actors/"):
            problems.append(f)
        elif fnmatch.fnmatch(f, "apify-actors/*/README.md"):
            continue
        elif fnmatch.fnmatch(f, "apify-actors/*/.actor/*.json"):
            bad = forbidden_json_changes(show(f, "old"), show(f, "new"))
            problems += [f"{f}: {k}" for k in bad]
        else:
            problems.append(f)
    return problems


def _git(*a):
    r = subprocess.run(["git", *a], capture_output=True, text=True)
    return r.stdout if r.returncode == 0 else None


def main(commit: str) -> int:
    changed = (_git("diff-tree", "--no-commit-id", "--name-only", "-r", commit) or "").split()
    show = lambda p, w: _git("show", f"{commit}^:{p}" if w == "old" else f"{commit}:{p}")  # noqa: E731
    problems = check_files(changed, show)
    for p in problems:
        print(f"::error::bot commit {commit} changes {p}")
    return 1 if problems else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1]))
