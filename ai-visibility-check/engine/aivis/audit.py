"""Orchestrates one audit: prompts -> providers x repeats -> parse -> score -> findings."""
from collections import Counter
from dataclasses import dataclass, field

from .niches import Niche
from .parse import find_mentions
from .prompts import generate_prompts
from .providers.base import ProviderError
from .reasons import build_findings
from .score import score_audit


class SpendCapExceeded(RuntimeError):
    """Real vendor usage so far went over the order cap; the run was stopped."""
    def __init__(self, spent, cap):
        super().__init__(f"real usage ${spent:.4f} exceeds the order cap ${cap:.2f}")
        self.spent, self.cap = spent, cap


@dataclass
class AuditResult:
    niche: Niche
    city: str
    target: str
    prompts: list
    records: list
    score: object
    findings: list
    errors: list
    cost_usd: float
    has_register: bool = False   # True only if the niche has an NPI taxonomy (buyer competitors never count)
    outcomes: list = field(default_factory=list)   # one dict per question: provider, prompt_no, run, ok, reason

    def reason_counts(self) -> dict:
        """{'ok': n, '<reason>': n, ...}: reason codes only, no text."""
        return dict(Counter("ok" if o["ok"] else o["reason"] for o in self.outcomes))


def run_audit(niche, city, target, roster_names, providers, n_prompts=30, repeats=3, seed=0,
              signals=None, target_reviews=None, competitor_reviews=None, max_errors=10, real_cap_usd=None):
    has_register = bool(niche.npi_taxonomy)
    if target not in roster_names:
        roster_names = list(roster_names) + [target]
    prompts = generate_prompts(niche, city, n_prompts, seed)
    records, errors, cost, real, outcomes = [], [], 0.0, 0.0, []
    for prov in providers:
        prov_errors, stopped = 0, False
        for pi, p in enumerate(prompts, 1):
            for r in range(repeats):
                try:
                    ans = prov.ask(p.text, city=city, run=r)
                except ProviderError as e:
                    errors.append(f"{prov.name}: {e}")
                    outcomes.append({"provider": prov.name, "prompt_no": pi, "run": r, "ok": False,
                                     "reason": getattr(e, "reason", "error")})
                    prov_errors += 1
                    if prov_errors >= max_errors:    # stop this provider entirely
                        stopped = True
                        break
                    continue
                cost += ans.cost_usd
                real += (ans.usage or {}).get("cost_usd", 0.0)
                if real_cap_usd is not None and real > real_cap_usd + 1e-9:
                    raise SpendCapExceeded(real, real_cap_usd)
                try:
                    mentions = find_mentions(ans.text, roster_names, city=city)
                except Exception:       # a malformed answer must not stop the run
                    errors.append(f"{prov.name}: parse_error")
                    outcomes.append({"provider": prov.name, "prompt_no": pi, "run": r, "ok": False,
                                     "reason": "parse_error"})
                    continue
                outcomes.append({"provider": prov.name, "prompt_no": pi, "run": r, "ok": True, "reason": ""})
                records.append((ans, mentions, p.intent))
            if stopped:
                break
    sc = score_audit(target, records)
    findings = build_findings(sc, niche, signals, target_reviews, competitor_reviews)
    return AuditResult(niche, city, target, prompts, records, sc, findings, errors, cost, has_register, outcomes)


def result_from_saved(niche, city, target, raw_answers, roster_names):
    """Rebuild an AuditResult from saved answers (no new queries)."""
    from .providers.base import Answer
    from .prompts import Prompt
    names = list(roster_names)
    has_register = bool(niche.npi_taxonomy)
    if target not in names:
        names.append(target)
    records = []
    for x in raw_answers:
        ans = Answer(x["provider"], "", x["prompt"], x["text"], x.get("citations", []), x["mode"], 0.0, x.get("repeat", 0))
        records.append((ans, find_mentions(ans.text, names, city=city), x["intent"]))
    sc = score_audit(target, records)
    prompts = []
    for x in raw_answers:
        p = Prompt(x["prompt"], x["intent"])
        if p not in prompts:
            prompts.append(p)
    return AuditResult(niche, city, target, prompts, records, sc, build_findings(sc, niche), [], 0.0, has_register)
