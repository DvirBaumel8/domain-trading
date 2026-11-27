"""A29: listing rules for this Actor (the repo-wide tests/test_listing.py runs the same rules; these name the Actor's own)."""
import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
ACTOR = json.loads((ROOT / ".actor" / "actor.json").read_text())
README = (ROOT / "README.md").read_text()
FORBIDDEN = re.compile(r"(?i)n8n|zapier|fastest|#1\b|\bbest\b(?!-)|guaranteed")


def test_a29_title_and_text_limits():
    assert ACTOR["title"] == "AI Brand Mention Check: AI Assistant Answers" and len(ACTOR["title"]) < 60
    assert len(ACTOR["seoTitle"]) <= 60 and len(ACTOR["seoDescription"]) <= 160 and 0 < len(ACTOR["description"]) <= 300
    assert ACTOR["name"] == "ai-brand-mention-check" and ACTOR["version"] == "0.2"


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


PROVIDER_NAMES = re.compile(r"(?i)chatgpt|openai|gemini|google|claude|anthropic")


def _strings(node):
    if isinstance(node, str):
        yield node
    elif isinstance(node, dict):
        for k, v in node.items():
            if k not in ("enum", "default", "prefill"):  # engine ids are bare input values
                yield from _strings(v)
    elif isinstance(node, list):
        for v in node:
            yield from _strings(v)


def _marketing(readme: str) -> str:
    """The README without fenced JSON examples, and without a technical Providers section (one factual line, when present)."""
    text = re.sub(r"```.*?```", "", readme, flags=re.S)
    parts = re.split(r"(?m)^(?=## )", text)
    kept = []
    for part in parts:
        if part.startswith("## Providers"):
            assert len([ln for ln in part.splitlines()[1:] if ln.strip()]) == 1, "Providers section must be one factual line"
            continue
        kept.append(part)
    return "".join(kept)


def test_no_provider_or_product_names_in_listing_copy():
    for key in ("title", "seoTitle", "description", "seoDescription"):
        assert not PROVIDER_NAMES.search(ACTOR[key]), key
    assert not PROVIDER_NAMES.search(_marketing(README))
    for name in ("input_schema.json", "dataset_schema.json", "output_schema.json"):
        for text in _strings(json.loads((ROOT / ".actor" / name).read_text())):
            assert not PROVIDER_NAMES.search(text), (name, text)


def test_name_guard_catches_a_provider_name():
    assert PROVIDER_NAMES.search("Asks ChatGPT") and PROVIDER_NAMES.search("by Google") and not PROVIDER_NAMES.search("AI assistants")


def test_readme_says_answer_text_is_not_exported_and_flag_is_ignored():
    assert "includeAnswerText" in README and "ignored" in README
    returns = re.search(r"\*\*Returns\*\*(.*)", README).group(1)
    assert not {"snippet", "citedUrls", "answerText", "competitors"} & set(re.findall(r"`(\w+)`", returns))


def test_no_export_of_answer_text_in_rows_or_summary():
    from helpers import Fake, drive, inp
    text = "1. **Asana** - views\n2. **Trello** - boards\n"
    fake = Fake(lambda e, p: text)
    fake.urls = {"gemini": ["https://asana.com/x"], "chatgpt": ["https://example.org/y"], "claude": ["https://example.net/z"]}
    res = drive(inp(promptCount=1, includeAnswerText=True), fake)
    blob = json.dumps([res.rows, res.summary])
    assert not any(w in blob for w in ("Trello", "views", "boards", "https://", "example.org"))
    assert not {"answerText", "snippet", "citedUrls", "competitors"} & {k for r in res.rows for k in r}
