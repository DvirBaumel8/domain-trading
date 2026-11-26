"""Deterministic simulated chatbot, for end-to-end tests and experiment design.

It is NOT evidence of what real chatbots say. It mimics the behaviour that
studies report: short lists (~4 names per answer, BrightLocal 2026), heavy
run-to-run randomness (<1% identical lists, SparkToro 2026), a few strong
names that appear most of the time, review volume as the strongest signal,
and the occasional made-up business.
"""
import random
from dataclasses import dataclass

from .base import Answer, Provider

BLURBS = [
    "known for consistently strong patient reviews",
    "praised for friendly staff and clear pricing",
    "a long-standing local favorite",
    "often mentioned for same-week appointments",
    "highly rated on Google and Yelp",
    "recommended for modern equipment and comfort",
]


@dataclass
class Business:
    name: str
    strength: float = 1.0       # latent 'AI prominence' (reviews, mentions, listings)
    website: str = ""


class MockProvider(Provider):
    name = "mock"
    mode = "simulated"

    def __init__(self, roster, seed: int = 0, list_len=(3, 6), hallucination_rate: float = 0.08,
                 temperature: float = 1.0, boosts=None, model: str = "mock-1", referees=("Yelp", "Google reviews")):
        if not roster:
            raise ValueError("mock provider needs a roster of businesses")
        self.roster = list(roster)
        self.seed = seed
        self.list_len = list_len
        self.hallucination_rate = hallucination_rate
        self.temperature = temperature
        self.boosts = dict(boosts or {})   # name -> multiplier (simulated fix effect)
        self.model = model
        self.referees = referees

    def _weights(self):
        return [max(1e-6, b.strength * self.boosts.get(b.name, 1.0)) ** (1.0 / self.temperature)
                for b in self.roster]

    def ask(self, prompt: str, city: str = "", run: int = 0) -> Answer:
        rng = random.Random(f"{self.seed}|{self.model}|{prompt}|{run}")
        k = rng.randint(*self.list_len)
        pool = list(self.roster)
        weights = self._weights()
        chosen = []
        while pool and len(chosen) < k:
            b = rng.choices(pool, weights=weights, k=1)[0]
            i = pool.index(b)
            pool.pop(i); weights.pop(i)
            chosen.append(b.name)
        if rng.random() < self.hallucination_rate:
            chosen.insert(rng.randint(0, len(chosen)), rng.choice(
                ["Bright Smile Studio", "Lone Star Family Care", "Premier Care Group"]))
        style = rng.choice(["numbered", "bullets", "prose"])
        lines = [f"Here are some options{(' in ' + city) if city else ''}:"]
        if style == "prose":
            body = ", ".join(chosen[:-1]) + (f" and {chosen[-1]}" if len(chosen) > 1 else chosen[0])
            lines = [f"Good options{(' in ' + city) if city else ''} include {body}. "
                     f"{chosen[0]} is {rng.choice(BLURBS)}."]
        else:
            for i, n in enumerate(chosen, 1):
                lead = f"{i}." if style == "numbered" else "-"
                lines.append(f"{lead} **{n}** – {rng.choice(BLURBS)}.")
        lines.append("Always check recent reviews and confirm availability.")
        cites = rng.sample(list(self.referees), k=min(2, len(self.referees)))
        return Answer(self.name, self.model, prompt, "\n".join(lines), cites, self.mode, 0.0, run)
