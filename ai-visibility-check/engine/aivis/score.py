"""Scores. Position in an AI list is close to meaningless (SparkToro 2026);
we report how OFTEN a business is named across many prompts and repeats."""
import math
from collections import Counter, defaultdict
from dataclasses import dataclass, field


def wilson(k: int, n: int, z: float = 1.96):
    if n == 0:
        return (0.0, 0.0)
    p = k / n
    d = 1 + z * z / n
    c = p + z * z / (2 * n)
    m = z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n))
    return (max(0.0, (c - m) / d), min(1.0, (c + m) / d))


@dataclass
class ProviderScore:
    provider: str
    mode: str
    answers: int
    target_hits: int
    rate: float
    ci: tuple
    avg_position: float
    unverified_share: float


@dataclass
class AuditScore:
    target: str
    score: int                    # 0-100
    providers: list
    competitors: list             # [(name, answers_naming_it, share_of_answers)]
    share_of_voice: float
    total_answers: int
    by_intent: dict = field(default_factory=dict)


def score_audit(target: str, records) -> AuditScore:
    """records: iterable of (Answer, [Mention], intent)."""
    per = defaultdict(lambda: {"n": 0, "hits": 0, "pos": [], "mentions": 0, "unverified": 0, "mode": ""})
    comp = Counter()
    intent_stats = defaultdict(lambda: [0, 0])
    total_mentions = target_mentions = total = 0
    for ans, mentions, intent in records:
        total += 1
        p = per[ans.provider]
        p["n"] += 1
        p["mode"] = ans.mode
        names_this_answer = set()
        hit = False
        for m in mentions:
            p["mentions"] += 1
            total_mentions += 1
            if not m.verified:
                p["unverified"] += 1
                continue
            if m.roster_name == target:
                hit = True
                target_mentions += 1
                p["pos"].append(m.position)
            else:
                names_this_answer.add(m.roster_name)
        comp.update(names_this_answer)
        intent_stats[intent][1] += 1
        if hit:
            p["hits"] += 1
            intent_stats[intent][0] += 1
    providers = []
    for name, p in sorted(per.items()):
        rate = p["hits"] / p["n"] if p["n"] else 0.0
        providers.append(ProviderScore(name, p["mode"], p["n"], p["hits"], rate, wilson(p["hits"], p["n"]),
                                       (sum(p["pos"]) / len(p["pos"])) if p["pos"] else float("nan"),
                                       (p["unverified"] / p["mentions"]) if p["mentions"] else 0.0))
    score = round(100 * sum(x.rate for x in providers) / len(providers)) if providers else 0
    competitors = [(n, c, c / total if total else 0.0) for n, c in comp.most_common()]
    sov = target_mentions / total_mentions if total_mentions else 0.0
    by_intent = {k: (v[0] / v[1] if v[1] else 0.0) for k, v in intent_stats.items()}
    return AuditScore(target, score, providers, competitors, sov, total, by_intent)
