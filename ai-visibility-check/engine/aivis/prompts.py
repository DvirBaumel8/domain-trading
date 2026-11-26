"""Generate realistic customer prompts for a niche + city.

Real people phrase things very differently, but AI tools still return
similar brand sets for the same underlying intent (SparkToro/Gumshoe, Jan
2026). So we cover several intents with varied phrasings instead of one
'best X in Y' query.
"""
import random
from dataclasses import dataclass

from .niches import Niche


@dataclass(frozen=True)
class Prompt:
    text: str
    intent: str   # best | service | need | attribute | comparison | near | cost


TEMPLATES = {
    "best": [
        "Who is the best {label} in {city}?",
        "What are the top-rated {plural} in {city}?",
        "Can you recommend a good {label} in {city}?",
        "I just moved to {city}. Which {label} should I go to?",
    ],
    "service": [
        "Where should I go for {service} in {city}?",
        "Who does the best {service} in {city}?",
        "Recommend a {label} in {city} for {service}.",
        "Which {plural} in {city} are good at {service}?",
        "Looking for {service} in {city}. Any trusted {plural}?",
    ],
    "need": [
        "I have {need}. Which {label} in {city} should I call?",
        "Need help with {need} in {city} - who do you recommend?",
        "What's a reliable {label} in {city} for {need}?",
    ],
    "attribute": [
        "Who is an {attribute} {label} in {city}?",
        "List a few {attribute} {plural} in {city}.",
        "My friend wants {attribute} {plural} in {city}. Suggestions?",
    ],
    "comparison": [
        "Compare the best {plural} in {city} for me.",
        "Which {label} in {city} has the best reviews, and why?",
    ],
    "near": [
        "{plural_cap} near {neighborhood}, {city}?",
        "Is there a good {label} close to {neighborhood} in {city}?",
    ],
    "cost": [
        "Which {label} in {city} has fair prices for {service}?",
    ],
}

DEFAULT_NEIGHBORHOODS = ("downtown", "the north side", "the south side", "the east side")


def _a_an(word: str) -> str:
    return "an" if word[:1].lower() in "aeiou" else "a"


def generate_prompts(niche: Niche, city: str, n: int = 30, seed: int = 0,
                     neighborhoods=DEFAULT_NEIGHBORHOODS) -> list:
    """Return n (20-40 recommended) unique prompts, deterministic for a seed."""
    if not 1 <= n <= 200:
        raise ValueError("n must be between 1 and 200")
    rng = random.Random(f"{niche.key}|{city}|{seed}")
    # Weighted intent mix: 'best' and 'service' dominate real local asks.
    weights = {"best": 4, "service": 4, "need": 3, "attribute": 3, "comparison": 2, "near": 2, "cost": 1}
    pool = [k for k, w in weights.items() for _ in range(w)]
    out, seen, tries = [], set(), 0
    while len(out) < n and tries < n * 50:
        tries += 1
        intent = rng.choice(pool)
        tpl = rng.choice(TEMPLATES[intent])
        attr = rng.choice(niche.attributes)
        text = tpl.format(
            label=niche.label, plural=niche.plural, plural_cap=niche.plural[:1].upper() + niche.plural[1:],
            city=city, service=rng.choice(niche.services), need=rng.choice(niche.needs),
            attribute=attr, neighborhood=rng.choice(neighborhoods),
        )
        text = text.replace(f"an {attr}", f"{_a_an(attr)} {attr}")
        if text not in seen:
            seen.add(text)
            out.append(Prompt(text, intent))
    return out
