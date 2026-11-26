"""A29: listing rules for this Actor (the repo-wide tests/test_listing.py runs the same rules; these name the Actor's own)."""
import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
ACTOR = json.loads((ROOT / ".actor" / "actor.json").read_text())
README = (ROOT / "README.md").read_text()
FORBIDDEN = re.compile(r"(?i)n8n|zapier|fastest|#1\b|\bbest\b(?!-)|guaranteed")


def test_a29_title_and_text_limits():
    assert ACTOR["title"] == "AI Brand Mention Check: ChatGPT, Gemini & Claude" and len(ACTOR["title"]) < 60
    assert len(ACTOR["seoTitle"]) <= 60 and len(ACTOR["seoDescription"]) <= 160 and 0 < len(ACTOR["description"]) <= 300
    assert ACTOR["name"] == "ai-brand-mention-check" and ACTOR["version"] == "0.1"


def test_a29_readme_first_screen_and_end():
    assert README.splitlines()[0] == f"# {ACTOR['title']}"
    first = README.split("\n## ", 1)[0]
    assert "**Returns**" in first and "**Cost:**" in first and "Pricing tab" in first
    example = json.loads(re.search(r"```json\n(.*?)\n```", first, re.S).group(1))
    assert set(example) <= set(json.loads((ROOT / ".actor" / "input_schema.json").read_text())["properties"])
    props = set(json.loads((ROOT / ".actor" / "dataset_schema.json").read_text())["fields"]["properties"])
    assert set(re.findall(r"`(\w+)`", re.search(r"\*\*Returns\*\*(.*)", first).group(1))) <= props
    assert README.strip().split("\n## ")[-1].startswith("Permissions")


def test_a29_no_dollar_amounts_or_banned_words_in_any_text_file():
    for p in [ROOT / "README.md", ROOT / "CHANGELOG.md", *(ROOT / ".actor").glob("*.json")]:
        text = p.read_text()
        assert not re.search(r"\$\s?\d", text) and not FORBIDDEN.search(text), p
    assert not re.search(r"https?://(?!(?:apify|console\.apify)\.com)", README)  # no off-Apify links


def test_a29_memory_and_run_options():
    assert ACTOR["minMemoryMbytes"] == 256 and ACTOR["defaultRunOptions"] == {"memoryMbytes": 256, "timeoutSecs": 600}


def test_input_schema_shape():
    schema = json.loads((ROOT / ".actor" / "input_schema.json").read_text())
    assert schema["required"] == ["brand"] and schema["properties"]["engines"]["items"]["enum"] == ["chatgpt", "gemini", "claude"]
    assert {k: v["prefill"] for k, v in schema["properties"].items() if "prefill" in v} == {
        "brand": "Asana", "domain": "asana.com", "category": "project management software", "promptCount": 3,
        "engines": ["chatgpt", "gemini", "claude"], "includeAnswerText": True}


def test_dataset_schema_lists_every_row_field():
    from helpers import drive, inp
    row = drive(inp(promptCount=1, engines=["claude"])).rows[0]
    ds = json.loads((ROOT / ".actor" / "dataset_schema.json").read_text())["fields"]
    assert set(row) == set(ds["properties"]) and set(ds["required"]) == {"brand", "engine", "prompt", "status", "checkedAt"}


def test_no_prices_and_self_contained_and_only_two_dependencies():
    for p in (ROOT / "src").glob("*.py"):
        text = p.read_text()
        assert not re.search(r"ai-visibility-check|ai_visibility|from aivis|import aivis", text), p
    reqs = (ROOT / "requirements.txt").read_text().split()
    assert reqs == ["apify>=4.3.0,<5", "httpx>=0.27"]
    assert "pillow" not in (ROOT / "requirements.txt").read_text().lower()
