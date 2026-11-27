"""Task example files (offline): 10 tasks per Actor, each input valid against the Actor's input_schema.json.

Small built-in validator (type, required, unknown fields, minimum/maximum, enum, array items); no dependency, no network.
"""
import json
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
FILES = sorted((ROOT / "task-examples").glob("*.json"))
TYPES = {"string": str, "boolean": bool, "array": list, "object": dict}


def _check(value, spec, path):
    """Return a list of problems for value against a property spec."""
    t = spec.get("type")
    errs = []
    if t == "integer":
        if isinstance(value, bool) or not isinstance(value, int):
            return [f"{path}: not an integer"]
    elif t == "number":
        if isinstance(value, bool) or not isinstance(value, (int, float)):
            return [f"{path}: not a number"]
    elif t in TYPES and (not isinstance(value, TYPES[t]) or (t != "boolean" and isinstance(value, bool))):
        return [f"{path}: not a {t}"]
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        if "minimum" in spec and value < spec["minimum"]:
            errs.append(f"{path}: below minimum")
        if "maximum" in spec and value > spec["maximum"]:
            errs.append(f"{path}: above maximum")
    if "enum" in spec and value not in spec["enum"]:
        errs.append(f"{path}: not in enum")
    if t == "array" and isinstance(spec.get("items"), dict):
        for i, v in enumerate(value):
            errs += _check(v, spec["items"], f"{path}[{i}]")
    return errs


def validate(inp, schema):
    props = schema.get("properties", {})
    errs = [f"missing required {k}" for k in schema.get("required", []) if k not in inp]
    for k, v in inp.items():
        if k not in props:
            errs.append(f"unknown field {k}")
        else:
            errs += _check(v, props[k], k)
    return errs


def test_every_in_scope_actor_has_a_file():
    assert len(FILES) == 6


@pytest.mark.parametrize("path", FILES, ids=lambda p: p.stem)
def test_task_examples(path):
    data = json.loads(path.read_text(encoding="utf-8"))
    assert data["actor"] == path.stem
    assert data["title"].strip()
    schema = json.loads((ROOT / data["actor"] / ".actor" / "input_schema.json").read_text(encoding="utf-8"))
    tasks = data["tasks"]
    assert len(tasks) == 10
    names = [t["name"] for t in tasks]
    assert len(set(names)) == 10
    for t in tasks:
        assert 0 < len(t["name"]) <= 60, t["name"]
        assert t["description"].strip(), t["name"]
        assert validate(t["input"], schema) == [], t["name"]


def test_validator_catches_problems():
    schema = {"required": ["a"], "properties": {"a": {"type": "integer", "minimum": 1, "maximum": 3},
                                                "m": {"type": "string", "enum": ["x"]}}}
    assert validate({"a": 2, "m": "x"}, schema) == []
    assert validate({}, schema)
    assert validate({"a": 4}, schema) and validate({"a": 0}, schema) and validate({"a": True}, schema)
    assert validate({"a": 1, "m": "y"}, schema) and validate({"a": 1, "z": 1}, schema)


@pytest.mark.parametrize("path", sorted(ROOT.glob("*/README.md")), ids=lambda p: p.parent.name)
def test_readme_lists_the_example_tasks(path):
    f = ROOT / "task-examples" / f"{path.parent.name}.json"
    if not f.exists():
        pytest.skip("no task examples")
    text = path.read_text(encoding="utf-8")
    for t in json.loads(f.read_text(encoding="utf-8"))["tasks"]:
        assert f"- **{t['name']}**: {t['description']}\n" in text
