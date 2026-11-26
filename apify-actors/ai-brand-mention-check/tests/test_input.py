"""A11-A13: bad input stops the run before any call and charges nothing; domain; prompts."""
import json

import pytest

from helpers import Fake, drive, inp
from src import prompts, runner

BAD = [
    ("empty brand", {"brand": ""}, "brand"),
    ("1-char brand", {"brand": "A"}, "brand"),
    ("81-char brand", {"brand": "A" * 81}, "brand"),
    ("no category, no prompts", {"category": None}, "category"),
    ("no engines", {"engines": []}, "engines"),
    ("unknown engine", {"engines": ["bing"]}, "engines"),
    ("21 prompts", {"prompts": ["a long enough question"] * 21}, "prompts"),
    ("5-char prompt", {"prompts": ["short"]}, "prompts"),
    ("bad domain", {"domain": "not a domain"}, "domain"),
    ("6 aliases", {"aliases": ["aa", "bb", "cc", "dd", "ee", "ff"]}, "aliases"),
    ("promptCount 9", {"promptCount": 9}, "promptCount"),
    ("long location", {"location": "x" * 81}, "location"),
]


@pytest.mark.parametrize("label,extra,field", BAD, ids=[b[0] for b in BAD])
def test_a11_bad_input_fails_with_the_field_name_and_no_calls(label, extra, field):
    res = drive(inp(**extra))
    assert res.ok is False and field in res.msg
    assert res.fake.calls == [] and res.pushes == []


def test_a11_custom_prompts_make_category_optional():
    res = drive(inp(category=None, prompts=["Which task tool is easiest to learn?"], engines=["claude"]))
    assert res.ok and len(res.rows) == 1 and res.rows[0]["category"] is None


@pytest.mark.parametrize("raw,want", [
    ("https://www.Asana.com/pricing?x=1", "asana.com"), ("WWW.ASANA.COM", "asana.com"), ("asana.com/", "asana.com"),
    ("http://asana.com:8080/a#b", "asana.com"), ("app.asana.com", "app.asana.com")])
def test_a12_domain_normalisation(raw, want):
    cfg, err = runner.validate_input(inp(domain=raw))
    assert err is None and cfg["domain"] == want


def test_a13_generated_prompts_match_the_templates():
    c = "project management software"
    assert prompts.generate_prompts(c, 3) == [
        "Which project management software would you recommend?",
        "What are the most popular project management software right now?",
        "I need project management software for a small business. What should I choose and why?"]
    cfg, _ = runner.validate_input(inp(promptCount=3))
    assert cfg["prompts"] == prompts.generate_prompts(c, 3)
    located = prompts.generate_prompts(c, 3, "Austin, US")
    assert located[0] == "Which project management software would you recommend in Austin, US?"
    assert len(prompts.generate_prompts(c, 8)) == 8 and prompts.generate_prompts(c, 4)[3] == "What are the main alternatives to the leading project management software?"


def test_a13_location_is_sent_to_openai_and_claude_only():
    fake = Fake()
    bodies = {}
    for e in ("chatgpt", "claude"):
        fake.behave[e] = lambda n, req, e=e: bodies.setdefault(e, req.content.decode()) and None
    res = drive(inp(location="Austin, US", promptCount=1), fake)
    assert res.ok
    for e in ("chatgpt", "claude"):
        loc = [t for t in json.loads(bodies[e])["tools"]][0]["user_location"]
        assert loc == {"type": "approximate", "city": "Austin", "country": "US"}
    assert "Austin, US" in res.rows[0]["prompt"]
