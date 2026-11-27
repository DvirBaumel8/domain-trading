"""Staged workflow copies in apify-actors/ci/ (offline text/yaml checks)."""
import re
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
STAGED = ROOT / "apify-actors" / "ci"
INSTALLED = ROOT / ".github" / "workflows"
NAMES = ["ci.yml", "claude.yml", "claude-code-review.yml", "avc-tests.yml", "apify-actors.yml"]


def text(name):
    return (STAGED / name).read_text()


def block(s, key):
    """Top-level-ish block text from `key:` to the next line indented no deeper."""
    m = re.search(rf"^( *){key}:\n((?:\1 +.*\n|\n)*)", s, re.M)
    assert m, key
    return m.group(2)


def secrets(s):
    return set(re.findall(r"secrets\.\w+", s))


@pytest.mark.parametrize("name", NAMES)
def test_exists(name):
    assert (STAGED / name).is_file()


def test_ci_triggers_and_steps():
    s = text("ci.yml")
    on = block(s, "on")
    for trig in ("push", "pull_request"):
        part = re.search(rf"^  {trig}:\n((?:    .*\n)+)", on, re.M)
        assert part, trig
        for p in ("apify-actors/**", "docs/**", "ai-visibility-check/**"):
            assert p in part.group(1), (trig, p)
    assert "workflow_call" in on
    assert "npm run check-state" in s and "npx tsc --noEmit" in s
    assert "github.event_name == 'pull_request'" in s


@pytest.mark.parametrize("name", ["claude.yml", "claude-code-review.yml"])
def test_claude_files(name):
    s = text(name)
    assert "concurrency:" in s
    assert "anthropics/claude-code-action@v1" in s
    assert block(s, "permissions") == block((INSTALLED / name).read_text(), "permissions")


@pytest.mark.parametrize("name", ["avc-tests.yml", "apify-actors.yml"])
def test_ruff(name):
    s = text(name)
    assert "ruff check ai-visibility-check apify-actors" in s
    assert s.index("ruff check") < s.index("pytest -q")


def test_avc_unchanged_parts():
    s = text("avc-tests.yml")
    assert "PYTHONPATH: ai-visibility-check/engine" in s
    assert "--disable-socket" in s
    assert s.count("python -m pytest") == 2


@pytest.mark.parametrize("name", NAMES)
def test_no_new_secrets(name):
    assert secrets(text(name)) <= secrets((INSTALLED / name).read_text())
