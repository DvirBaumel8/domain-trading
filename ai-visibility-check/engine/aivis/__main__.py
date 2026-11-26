"""CLI.  python -m aivis --help"""
import argparse
import json
import os
import sys
import zlib

from .audit import run_audit
from .niches import NICHES, get_niche
from .prompts import generate_prompts
from . import config
from .providers import MockProvider, Business, PollinationsProvider
from .report import to_html, to_markdown
from .roster import from_csv, from_nppes
from .signals import fetch_and_analyze
from .store import Store


def _roster(args, niche):
    if args.roster == "nppes":
        if not niche.npi_taxonomy:
            sys.exit(f"niche {niche.key} has no NPPES taxonomy; pass --roster file.csv")
        city, state = [s.strip() for s in args.city.split(",")]
        return [e.name for e in from_nppes(niche.npi_taxonomy, city, state, limit=args.roster_limit)]
    if args.roster and os.path.exists(args.roster):
        return [e.name for e in from_csv(args.roster)]
    return []


def _write(path, text):
    with open(path, "w", encoding="utf-8") as f:
        f.write(text)


def cmd_prompts(a):
    for p in generate_prompts(get_niche(a.niche), a.city, a.n, a.seed):
        print(f"[{p.intent}] {p.text}")


def cmd_cost(a):
    calls = a.prompts * a.repeats
    total = 0.0
    for prov in a.providers.split(","):
        c = config.cost_per_call(prov) * calls
        total += c
        print(f"{prov:11s} {calls} calls x ${config.cost_per_call(prov):.3f} = ${c:.2f}")
    print(f"TOTAL per audit: ${total:.2f}")


def cmd_audit(a):
    niche = get_niche(a.niche)
    names = _roster(a, niche)
    providers = []
    for name in a.providers.split(","):
        if name == "mock":
            roster = names or [a.target]
            rng_strength = {n: 1.0 + (zlib.crc32(n.encode()) % 7) for n in roster}
            rng_strength[a.target] = a.mock_target_strength
            providers.append(MockProvider([Business(n, rng_strength[n]) for n in roster], seed=a.seed,
                                          referees=niche.referees))
        elif name == "pollinations":
            providers.append(PollinationsProvider())
        else:
            sys.exit(f"provider {name!r} is paid and disabled in this prototype (needs Dvir's yes).")
    signals = fetch_and_analyze(a.website, a.city) if a.website else None
    res = run_audit(niche, a.city, a.target, names, providers, a.prompts, a.repeats, a.seed, signals)
    os.makedirs(a.out, exist_ok=True)
    slug = a.target.lower().replace(" ", "-")[:40]
    md, ht = to_markdown(res), to_html(res)
    _write(os.path.join(a.out, f"{slug}.md"), md)
    _write(os.path.join(a.out, f"{slug}.html"), ht)
    st = Store(os.path.join(a.out, "runs.sqlite"))
    st.save(niche.key, a.city, a.target, [p.name for p in providers], len(res.prompts), a.repeats,
            res.score.score, res.records, label=a.label)
    raw = [{"provider": x.provider, "mode": x.mode, "prompt": x.prompt, "intent": i, "repeat": x.run,
            "text": x.text, "mentions": [[m.raw, m.position, m.roster_name] for m in ms]}
           for x, ms, i in res.records]
    _write(os.path.join(a.out, f"{slug}.answers.json"), json.dumps(raw, indent=1))
    print(md)
    print(f"[saved to {a.out}; roster={len(names)} names; answers={res.score.total_answers}; "
          f"errors={len(res.errors)}; cost=${res.cost_usd:.2f}]")


def cmd_rescore(a):
    """Re-parse saved answers (no new queries) with the current parser."""
    from .providers.base import Answer
    from .parse import find_mentions
    from .score import score_audit
    from .reasons import build_findings
    from .audit import AuditResult
    from .prompts import Prompt
    niche = get_niche(a.niche)
    names = _roster(a, niche)
    if a.target not in names:
        names.append(a.target)
    raw = json.load(open(a.answers))
    records = []
    for x in raw:
        ans = Answer(x["provider"], "", x["prompt"], x["text"], [], x["mode"], 0.0, x.get("repeat", 0))
        records.append((ans, find_mentions(ans.text, names, city=a.city), x["intent"]))
    sc = score_audit(a.target, records)
    res = AuditResult(niche, a.city, a.target, sorted({Prompt(x["prompt"], x["intent"]) for x in raw}, key=str),
                      records, sc, build_findings(sc, niche), [], 0.0)
    os.makedirs(a.out, exist_ok=True)
    _write(os.path.join(a.out, "report.md"), to_markdown(res))
    _write(os.path.join(a.out, "report.html"), to_html(res))
    out = [{"provider": r.provider, "prompt": r.prompt, "mentions": [[m.raw, m.roster_name] for m in ms]}
           for r, ms, _ in records]
    _write(os.path.join(a.out, "mentions.json"), json.dumps(out, indent=1))
    v = sum(1 for _, ms, _ in records for m in ms if m.verified)
    u = sum(1 for _, ms, _ in records for m in ms if not m.verified)
    print(to_markdown(res))
    print(f"[rescored {len(records)} answers; verified mentions={v}; unverified={u}]")


def cmd_roster_cache(a):
    niche = get_niche(a.niche)
    names = _roster(a, niche)
    _write(a.out, "name\n" + "\n".join('"' + n.replace('"', "'") + '"' for n in names) + "\n")
    print(f"saved {len(names)} names to {a.out}")


def cmd_sample(a):
    """Polished sample report from a saved free run (no new queries)."""
    from .audit import result_from_saved
    from .report_pro import render
    niche = get_niche(a.niche)
    names = [e.name for e in from_csv(a.roster)]
    res = result_from_saved(niche, a.city, a.target, json.load(open(a.answers)), names)
    note = (a.note or "Made from a free test run on 25 Nov 2026: one AI model answering from memory (no web search), "
            "20 customer questions, 1 repeat, names checked against 479 Austin dental practices in the US NPI registry.")
    html_ = render(res, sample=True, anonymize=True, target_label=a.label, run_note=note, date=a.date)
    os.makedirs(os.path.dirname(a.out) or ".", exist_ok=True)
    _write(a.out, html_)
    print(f"wrote {a.out}; score={res.score.score}; answers={res.score.total_answers}")


def cmd_order(a):
    from .order import Order, run_order, estimate_cost, DEFAULT_CAP_USD, OrderError
    from .report_pro import render
    o = Order.from_dict(json.load(open(a.intake)))
    niche = get_niche(o.niche)
    names = []
    if a.roster:
        names = [e.name for e in from_csv(a.roster)]
    elif niche.npi_taxonomy and not a.dry_run:
        city, state = [x.strip() for x in o.city.split(",")]
        names = [e.name for e in from_nppes(niche.npi_taxonomy, city, state, limit=1000)]
    try:
        res, log = run_order(o, mode=a.mode, cap_usd=DEFAULT_CAP_USD if a.cap is None else a.cap, roster=names, out_dir=a.out, dry_run=a.dry_run,
                             render=lambda r: render(r, sample=(a.mode != "paid"),
                                                     run_note=("Free quick check: one AI model answering from memory, "
                                                               "no web search." if a.mode == "free" else "Simulated data.")))
    except OrderError as e:
        sys.exit(f"order refused: {e}")
    print(json.dumps(log, indent=1))


def cmd_smoke(a):
    if os.environ.get("CI"):
        sys.exit("smoke refused: it makes real paid calls and never runs in CI")
    from .smoke import run_smoke, format_smoke
    rows = run_smoke(a.engines.split(","))
    print(format_smoke(rows))
    if any(not r["ok"] for r in rows):
        sys.exit(1)


def main(argv=None):
    ap = argparse.ArgumentParser(prog="aivis")
    sub = ap.add_subparsers(dest="cmd", required=True)
    p = sub.add_parser("prompts"); p.add_argument("--niche", required=True); p.add_argument("--city", required=True)
    p.add_argument("--n", type=int, default=30); p.add_argument("--seed", type=int, default=0)
    p.set_defaults(fn=cmd_prompts)
    c = sub.add_parser("cost"); c.add_argument("--prompts", type=int, default=30)
    c.add_argument("--repeats", type=int, default=3); c.add_argument("--providers", default=",".join(config.PAID_ENGINES))
    c.set_defaults(fn=cmd_cost)
    au = sub.add_parser("audit")
    au.add_argument("--niche", required=True, choices=sorted(NICHES)); au.add_argument("--city", required=True)
    au.add_argument("--target", required=True); au.add_argument("--providers", default="mock")
    au.add_argument("--prompts", type=int, default=30); au.add_argument("--repeats", type=int, default=3)
    au.add_argument("--roster", default=""); au.add_argument("--roster-limit", type=int, default=60)
    au.add_argument("--website", default=""); au.add_argument("--seed", type=int, default=0)
    au.add_argument("--mock-target-strength", type=float, default=0.5)
    au.add_argument("--label", default=""); au.add_argument("--out", default="out-reports")
    au.set_defaults(fn=cmd_audit)
    rs = sub.add_parser("rescore")
    rs.add_argument("--niche", required=True); rs.add_argument("--city", required=True)
    rs.add_argument("--target", required=True); rs.add_argument("--answers", required=True)
    rs.add_argument("--roster", default="nppes"); rs.add_argument("--roster-limit", type=int, default=1000)
    rs.add_argument("--out", required=True)
    rs.set_defaults(fn=cmd_rescore)
    rc = sub.add_parser("roster-cache")
    rc.add_argument("--niche", required=True); rc.add_argument("--city", required=True)
    rc.add_argument("--roster", default="nppes"); rc.add_argument("--roster-limit", type=int, default=1000)
    rc.add_argument("--out", required=True); rc.set_defaults(fn=cmd_roster_cache)
    sm = sub.add_parser("sample")
    sm.add_argument("--niche", required=True); sm.add_argument("--city", required=True)
    sm.add_argument("--target", required=True); sm.add_argument("--label", default="Sample Dental Practice")
    sm.add_argument("--answers", required=True); sm.add_argument("--roster", required=True)
    sm.add_argument("--note", default=""); sm.add_argument("--date", default="2026-11-25")
    sm.add_argument("--out", required=True); sm.set_defaults(fn=cmd_sample)
    od = sub.add_parser("order", help="run one customer order (free | paid | mock) with a cost cap")
    od.add_argument("--intake", required=True, help="intake JSON (see orders/example-intake.json)")
    od.add_argument("--mode", default="free", choices=["free", "paid", "mock"])
    od.add_argument("--cap", type=float, default=None, help="max USD this order may spend (paid mode; default 12, AIVIS_ORDER_CAP_USD overrides)")
    od.add_argument("--roster", default="", help="CSV of local business names (else NPPES if the niche has one)")
    od.add_argument("--dry-run", action="store_true", help="show plan, cost and key readiness; call nothing")
    od.add_argument("--out", default="orders"); od.set_defaults(fn=cmd_order)
    sk = sub.add_parser("smoke", help="one minimal real call per paid engine; prints model, ok/error, usage (costs cents)")
    sk.add_argument("--engines", default=",".join(config.PAID_ENGINES)); sk.set_defaults(fn=cmd_smoke)
    a = ap.parse_args(argv)
    a.fn(a)


if __name__ == "__main__":
    main()
