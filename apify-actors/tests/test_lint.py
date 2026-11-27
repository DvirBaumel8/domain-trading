"""Repo-level lint gate (ruff.toml: F, B023, PLE). Skipped when ruff is not installed."""
import importlib.util
import subprocess
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]


@pytest.mark.skipif(importlib.util.find_spec("ruff") is None, reason="ruff not installed")
def test_ruff_clean():
    r = subprocess.run([sys.executable, "-m", "ruff", "check", "ai-visibility-check", "apify-actors"],
                       cwd=ROOT, capture_output=True, text=True)
    assert r.returncode == 0, r.stdout + r.stderr
