"""Pins the public listing to the live Store text (actor Hfr4MI0LjpkjEYXcA, build 0.1.6, read 27 Nov 2026).
A text change must update tests/live_listing_snapshot.json on purpose, which needs Dvir's OK."""
import hashlib
import json
from pathlib import Path

import pytest

ACTOR = Path(__file__).resolve().parents[1]
SNAPSHOT = json.loads((ACTOR / "tests" / "live_listing_snapshot.json").read_text(encoding="utf-8"))
ACTOR_JSON = json.loads((ACTOR / ".actor" / "actor.json").read_text(encoding="utf-8"))


@pytest.mark.parametrize("field", ["title", "description", "seoTitle", "seoDescription"])
def test_actor_json_text_matches_live(field):
    assert ACTOR_JSON[field] == SNAPSHOT[field]


def test_readme_matches_live_sha256():
    assert hashlib.sha256((ACTOR / "README.md").read_bytes()).hexdigest() == SNAPSHOT["readme_sha256"]
