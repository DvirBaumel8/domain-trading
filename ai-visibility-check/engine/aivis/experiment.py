"""Fix-impact experiment helpers: difference-in-differences on mention rates.

Design (see ../../03-experiment.md): pick matched businesses, randomly assign
half to 'treated' (we apply fixes) and half to 'control' (nothing), measure
both before and after with the SAME prompts and repeats, and compare the
change. The mock provider lets us check the analysis and the sample size
before spending money on real queries.
"""
import math
import random
from dataclasses import dataclass

from .parse import find_mentions


def mention_rates(provider, prompts, roster_names, repeats=3, city=""):
    """Per business: share of answers naming it."""
    counts = {n: 0 for n in roster_names}
    total = 0
    for p in prompts:
        text = p.text if hasattr(p, "text") else str(p)
        for r in range(repeats):
            ans = provider.ask(text, city=city, run=r)
            total += 1
            for m in find_mentions(ans.text, roster_names, city=city):
                if m.roster_name:
                    counts[m.roster_name] += 1
    return {n: (c / total if total else 0.0) for n, c in counts.items()}, total


def assign(names, seed=0, n_treated=None):
    """Random assignment after sorting so arms are balanced on order given."""
    rng = random.Random(seed)
    names = list(names)
    rng.shuffle(names)
    k = n_treated if n_treated is not None else len(names) // 2
    return set(names[:k]), set(names[k:])


@dataclass
class DiDResult:
    effect: float          # change(treated) - change(control), in mention-rate points
    ci: tuple
    treated_change: float
    control_change: float
    n_treated: int
    n_control: int


def did(before: dict, after: dict, treated: set, control: set, n_boot=2000, seed=0) -> DiDResult:
    def mean_change(group):
        xs = [after[n] - before[n] for n in group]
        return sum(xs) / len(xs) if xs else 0.0
    t, c = mean_change(treated), mean_change(control)
    rng = random.Random(seed)
    tl, cl = list(treated), list(control)
    boots = []
    for _ in range(n_boot):
        ts = [rng.choice(tl) for _ in tl]
        cs = [rng.choice(cl) for _ in cl]
        boots.append(sum(after[n] - before[n] for n in ts) / len(ts) - sum(after[n] - before[n] for n in cs) / len(cs))
    boots.sort()
    lo, hi = boots[int(0.025 * n_boot)], boots[int(0.975 * n_boot) - 1]
    return DiDResult(t - c, (lo, hi), t, c, len(tl), len(cl))


def min_detectable_effect(p: float, answers_per_wave: int, per_arm: int, between_sd: float = 0.05,
                          z_alpha=1.96, z_power=0.84) -> float:
    """Rough MDE (80% power, 5% two-sided) for the DiD of mention rates.
    Variance per business change = 2*p(1-p)/n (sampling, two waves) + between-business drift^2."""
    var_change = 2 * p * (1 - p) / answers_per_wave + between_sd ** 2
    se = math.sqrt(2 * var_change / per_arm)
    return (z_alpha + z_power) * se
