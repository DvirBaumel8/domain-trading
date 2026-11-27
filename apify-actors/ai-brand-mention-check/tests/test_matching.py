"""A1-A7: matching, snippet, and the parsers for the three vendors' shapes."""
import json
import re

import pytest

from helpers import FIX, Fake, drive, inp
from src import matching, providers


def names(brand, aliases=()):
    return matching.build_names(brand, list(aliases))


def mention(text, brand, domain=None, urls=(), aliases=()):
    return matching.find_mention(matching.clean(text), names(brand, aliases), domain, list(urls))


def test_fixture_shapes_parse():
    a = providers.parse_openai(json.loads((FIX / "openai_asana.json").read_text()))
    assert a.search_used and a.urls == ["https://asana.com/pricing", "https://trello.com/"] and "**Asana**" in a.text
    c = providers.parse_anthropic(json.loads((FIX / "anthropic_asana.json").read_text()))
    assert c.search_used and c.urls == ["https://asana.com/"] and c.text.startswith("Popular choices are **Asana**")
    g = providers.parse_gemini(json.loads((FIX / "gemini_asana.json").read_text()))
    assert g.search_used and g.urls[0] == "https://asana.com" and "Trello" in g.text


def test_a1_bold_list_item_is_listed_with_fixture_rank():
    fake = Fake(lambda e, p: "Top picks:\n\n1. **Trello** - boards\n2. **Asana** - views\n3. **Monday.com** - flows\n")
    res = drive(inp(engines=["chatgpt"], promptCount=1), fake)
    row = res.rows[0]
    assert row["mentioned"] is True and row["mentionType"] == "listed" and row["rank"] == 2 and row["listLength"] == 3
    assert row["competitorCount"] == 2


def test_a2_linear_workflow_is_not_the_brand():
    m = mention("a linear workflow suits small teams", "Linear", "linear.app")
    assert m.mentioned is False and m.mention_type == "none" and m.snippet is None


def test_a3_bold_list_linear_matches():
    m = mention("Options:\n- **Linear** is fast and focused\n- Jira", "Linear", "linear.app")
    assert m.mentioned is True and m.mention_type == "listed"


def test_a4_lowercase_prose_with_cited_domain_is_not_a_mention_but_is_cited():
    urls = ["https://linear.app/pricing"]
    assert mention("teams like linear for planning", "Linear", "linear.app", urls).mentioned is False
    assert matching.brand_cited(urls, "linear.app") is True
    fake = Fake(lambda e, p: "Teams often like linear for planning.")
    fake.urls["chatgpt"] = urls
    row = drive(inp(brand="Linear", domain="linear.app", engines=["chatgpt"], promptCount=1), fake).rows[0]
    assert row["mentioned"] is False and row["brandCited"] is True


def test_a5_notion_prose_only_is_not_a_mention_but_a_list_item_is():
    assert mention("Many teams use Notion for docs.", "Notion").mentioned is False
    assert mention("- Notion is good for docs", "Notion").mentioned is True
    # the domain in the text lifts the structure requirement, but the case must still be exact
    assert mention("Many teams use Notion for docs (notion.so).", "Notion", "notion.so").mentioned is True
    assert mention("Many teams use notion for docs (notion.so).", "Notion", "notion.so").mentioned is False


@pytest.mark.parametrize("text", ["Try Mailchimp today", "Try Mail Chimp today", "try MAIL   CHIMP"])
def test_a6_alias_matches_either_spelling(text):
    assert mention(text, "Mailchimp", aliases=["Mail Chimp"]).mentioned is True


def test_normalisation_and_word_boundaries():
    assert mention("As​ana is a tool", "Asana").mentioned is True          # zero-width character removed
    assert mention("Ａsana is a tool", "Asana").mentioned is True          # NFKC folds the full-width A
    assert mention("Asanas are yoga poses", "Asana").mentioned is False        # whole words only


def test_a7_snippet_is_a_verbatim_substring_and_short():
    long_line = "- **Asana** " + "word " * 120 + "end"
    text = "Intro line\n" + long_line + "\nOutro"
    m = mention(text, "Asana")
    flat = " ".join(text.split())
    assert m.snippet and len(m.snippet) <= 300 and "Asana" in m.snippet and m.snippet in flat
    short = mention("Intro\n- **Asana**   is   great\n", "Asana")
    assert short.snippet == "- **Asana** is great"
    assert mention("nothing here", "Asana").snippet is None


def test_a7_row_has_no_quoted_line_or_answer_text():
    row = drive(inp(engines=["claude"], promptCount=1)).rows[0]
    assert row["mentioned"] is True and not {"snippet", "answerText", "citedUrls", "competitors"} & set(row)


def test_common_word_list_is_bundled():
    words = matching.common_words()
    assert len(words) >= 19000 and {"linear", "notion", "apple", "mercury"} <= words and "asana" not in words
    assert "wordfreq" in (matching.__doc__ or "") and "CC BY-SA" in matching.__doc__
