"""Buyer-style questions, built without any AI call."""
from __future__ import annotations

# (without a location, with a location). {c} = category, {l} = location.
TEMPLATES = (
    ("Which {c} would you recommend?", "Which {c} would you recommend in {l}?"),
    ("What are the most popular {c} right now?", "What are the most popular {c} in {l} right now?"),
    ("I need {c} for a small business. What should I choose and why?",
     "I need {c} in {l} for a small business. What should I choose and why?"),
    ("What are the main alternatives to the leading {c}?", "What are the main alternatives to the leading {c} in {l}?"),
    ("Which {c} do experts and reviewers rate highest?", "Which {c} in {l} do experts and reviewers rate highest?"),
    ("Which {c} is easiest to start with for a beginner?", "Which {c} in {l} is easiest to start with for a beginner?"),
    ("Which {c} offers good value for money?", "Which {c} in {l} offers good value for money?"),
    ("What {c} do startups usually pick?", "What {c} in {l} do startups usually pick?"),
)


def generate_prompts(category: str, count: int, location: str = "") -> list[str]:
    """The first `count` questions (1 to 8) for the category, with ' in {location}' forms when a location is given."""
    index = 1 if location else 0
    return [t[index].format(c=category, l=location) for t in TEMPLATES[:max(0, min(count, len(TEMPLATES)))]]
