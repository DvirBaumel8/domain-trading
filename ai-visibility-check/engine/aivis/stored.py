"""A finished audit as plain JSON, and back. Re-branding a report re-renders from this: no engine call, no new answers.

to_dict() keeps exactly what report_pro.render() and report_pdf.build() read. The numbers never depend on the brand.
"""
import json
import math

from .audit import AuditResult
from .niches import get_niche
from .parse import Mention
from .prompts import Prompt
from .providers.base import Answer
from .reasons import Finding
from .score import AuditScore, ProviderScore


def _num(v):
    return None if isinstance(v, float) and math.isnan(v) else v


def to_dict(res, date):
    s = res.score
    return {
        "version": 1, "date": date, "niche": res.niche.key, "city": res.city, "target": res.target,
        "has_register": bool(res.has_register),
        "prompts": [[p.text, p.intent] for p in res.prompts],
        "score": {"target": s.target, "score": s.score, "total_answers": s.total_answers,
                  "share_of_voice": s.share_of_voice, "by_intent": s.by_intent,
                  "competitors": [[n, c, sh] for n, c, sh in s.competitors],
                  "providers": [{"provider": p.provider, "mode": p.mode, "answers": p.answers,
                                 "target_hits": p.target_hits, "rate": p.rate, "ci": list(p.ci),
                                 "avg_position": _num(p.avg_position), "unverified_share": p.unverified_share}
                                for p in s.providers]},
        "records": [[{"provider": a.provider, "model": a.model, "prompt": a.prompt, "mode": a.mode, "run": a.run},
                     [[m.raw, m.position, m.roster_name] for m in ms], intent] for a, ms, intent in res.records],
        "findings": [{"reason": f.reason, "fix": f.fix, "evidence": f.evidence, "grade": f.grade, "effort": f.effort}
                     for f in res.findings],
    }


def dumps(d):
    return json.dumps(d, sort_keys=True, indent=1)


def from_dict(d):
    sc = d["score"]
    providers = [ProviderScore(p["provider"], p["mode"], p["answers"], p["target_hits"], p["rate"], tuple(p["ci"]),
                               float("nan") if p["avg_position"] is None else p["avg_position"],
                               p["unverified_share"]) for p in sc["providers"]]
    score = AuditScore(sc["target"], sc["score"], providers, [tuple(c) for c in sc["competitors"]],
                       sc["share_of_voice"], sc["total_answers"], sc.get("by_intent", {}))
    records = [(Answer(a["provider"], a.get("model", ""), a["prompt"], "", [], a.get("mode", "unknown"), 0.0, a.get("run", 0)),
                [Mention(r, pos, rn) for r, pos, rn in ms], intent) for a, ms, intent in d["records"]]
    return AuditResult(get_niche(d["niche"]), d["city"], d["target"], [Prompt(t, i) for t, i in d["prompts"]],
                       records, score, [Finding(**f) for f in d["findings"]], [], 0.0, bool(d["has_register"]))
