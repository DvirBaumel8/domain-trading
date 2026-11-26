"""Polished one-page client report (HTML, print-ready for PDF).

render(result, sample=..., anonymize=..., brand=..., run_note=...)
- sample=True adds a SAMPLE ribbon and a box explaining exactly how the data
  was made. It makes no claim about engines that were not used.
- anonymize=True replaces every business name except the target label with
  'Practice A', 'Practice B'... (for public pages).
"""
import datetime as _dt
import html
import string

from .niches import niche_label
from .report import GRADE_LABEL

E = html.escape

CSS = """
*{box-sizing:border-box}body{margin:0;background:#f4f6fb;font-family:Inter,'Segoe UI',Arial,sans-serif;color:#111827}
.page{position:relative;max-width:820px;margin:24px auto;background:#fff;border-radius:14px;padding:34px 40px;
box-shadow:0 6px 24px rgba(17,24,39,.08);overflow:hidden}
.ribbon{position:absolute;top:22px;right:-46px;transform:rotate(45deg);background:#f59e0b;color:#fff;font-weight:800;
letter-spacing:.12em;padding:6px 60px;font-size:12px}
.brand{display:flex;align-items:center;gap:10px;color:#4f46e5;font-weight:800;font-size:14px;letter-spacing:.04em}
.brand i{display:inline-block;width:22px;height:22px;border-radius:6px;background:linear-gradient(135deg,#6366f1,#06b6d4)}
h1{font-size:26px;margin:10px 0 2px}.sub{color:#6b7280;font-size:13px}
.notice{margin:16px 0;border:1px solid #fcd34d;background:#fffbeb;border-radius:10px;padding:10px 14px;font-size:12.5px;color:#78350f}
.grid{display:grid;grid-template-columns:200px 1fr;gap:22px;margin-top:18px;align-items:center}
.gauge{width:180px;height:180px;border-radius:50%;display:grid;place-items:center;
background:conic-gradient(var(--c) calc(var(--v)*1%),#e5e7eb 0)}
.gauge div{width:136px;height:136px;border-radius:50%;background:#fff;display:grid;place-items:center;text-align:center}
.gauge b{font-size:40px;display:block}.gauge span{font-size:11px;color:#6b7280}
.kpis{display:grid;grid-template-columns:repeat(3,1fr);gap:10px}
.kpi{background:#f9fafb;border-radius:10px;padding:12px}.kpi b{font-size:22px;display:block}.kpi span{font-size:11.5px;color:#6b7280}
h2{font-size:15px;margin:24px 0 8px;text-transform:uppercase;letter-spacing:.06em;color:#374151}
table{width:100%;border-collapse:collapse;font-size:12.5px}th,td{text-align:left;padding:7px 8px;border-bottom:1px solid #eef0f4}
th{color:#6b7280;font-weight:600;font-size:11.5px}
.bar{height:9px;border-radius:5px;background:#e0e7ff}.bar i{display:block;height:9px;border-radius:5px;background:#6366f1}
.q{background:#f9fafb;border-left:3px solid #6366f1;border-radius:6px;padding:10px 12px;font-size:12.5px}
.warn{background:#fef2f2;border-left:3px solid #ef4444}
ol{padding-left:18px;font-size:12.8px}ol li{margin-bottom:8px}.tag{display:inline-block;font-size:10.5px;border-radius:999px;
padding:1px 8px;margin-left:6px;background:#eef2ff;color:#3730a3}.tag.e{background:#ecfdf5;color:#065f46}
.foot{margin-top:22px;font-size:11px;color:#6b7280;border-top:1px solid #eef0f4;padding-top:10px}
@page{size:Letter;margin:10mm}@media print{body{background:#fff}.page{box-shadow:none;margin:0;border-radius:0;padding:6px 8px;zoom:.78}h2{margin:14px 0 6px}.ribbon{top:14px}}
"""


def _alias_map(names, keep):
    letters = list(string.ascii_uppercase) + [a + b for a in string.ascii_uppercase for b in string.ascii_uppercase]
    out, i = {}, 0
    for n in names:
        if n == keep or n in out:
            continue
        out[n] = f"Practice {letters[i]}"
        i += 1
    return out


def render(result, sample=False, anonymize=False, brand="AI Visibility Check", target_label=None,
           run_note="", date=None) -> str:
    s = result.score
    target = result.target
    tlabel = target_label or target
    comp_names = [n for n, _, _ in s.competitors]
    unv = []
    for ans, ms, _ in result.records:
        for m in ms:
            if not m.verified:
                unv.append(m.raw)
    total_named = sum(len(ms) for _, ms, _ in result.records)
    alias = _alias_map(comp_names + unv, target) if anonymize else {}
    nm = lambda n: E(alias.get(n, tlabel if n == target else n))
    date = date or _dt.date.today().isoformat()
    color = "#ef4444" if s.score < 20 else "#f59e0b" if s.score < 50 else "#10b981"
    engines = ", ".join(sorted({f"{p.provider} ({p.mode})" for p in s.providers}))
    models = sorted({(a.provider, a.model) for a, _, _ in result.records if a.model})
    models_txt = ("Engines and exact models: " + "; ".join(f"{E(p)} {E(m)}" for p, m in models) +
                  f"; run date {E(date)}. ") if models else ""
    h = [f"<!doctype html><html lang='en'><head><meta charset='utf-8'><meta name='viewport' content='width=device-width,initial-scale=1'>"
         f"<title>{E(brand)} — {E(tlabel)}</title><style>{CSS}</style></head><body><div class='page'>"]
    if sample:
        h.append("<div class='ribbon'>SAMPLE</div>")
    h.append(f"<div class='brand'><i></i>{E(brand.upper())}</div>")
    h.append(f"<h1>{E(tlabel)}</h1><div class='sub'>{E(niche_label(result.niche.label))} · {E(result.city)} · "
             f"{len(result.prompts)} customer questions · {s.total_answers} AI answers · {E(date)}</div>")
    if sample:
        h.append("<div class='notice'><b>This is a sample report.</b> " + E(run_note) +
                 (" Business names are hidden on this public sample." if anonymize else "") +
                 " A paid report runs the AI assistants you "
                 "choose, on more questions and repeats; its numbers will differ from this sample.</div>")
    reg = getattr(result, "has_register", False)
    vr = 1 - (len(unv) / total_named) if total_named else 0
    kpi3 = (f"<div class='kpi'><b>{vr:.0%}</b><span>of named businesses matched an official register</span></div>" if reg else
            "<div class='kpi'><b>n/a</b><span>no official register to check names against for this trade</span></div>")
    h.append(f"<div class='grid'><div class='gauge' style='--v:{max(s.score,1)};--c:{color}'><div><div>"
             f"<b>{s.score}</b><span>out of 100<br>AI visibility</span></div></div></div><div><div class='kpis'>"
             f"<div class='kpi'><b>{sum(p.target_hits for p in s.providers)}/{s.total_answers}</b><span>answers that named this business</span></div>"
             f"<div class='kpi'><b>{len(comp_names)}</b><span>local competitors named instead</span></div>"
             f"{kpi3}</div>"
             f"<p class='sub' style='margin-top:10px'>Engines: {E(engines)}. We report how often you are named across many "
             f"questions, with a 95% range, because AI answers change every time.</p></div></div>")
    h.append("<h2>By AI assistant</h2><table><tr><th>Assistant</th><th>Mode</th><th>Named you</th><th>95% range</th></tr>")
    for p in s.providers:
        h.append(f"<tr><td>{E(p.provider)}</td><td>{E(p.mode)}</td><td>{p.target_hits}/{p.answers} ({p.rate:.0%})</td>"
                 f"<td>{p.ci[0]:.0%}–{p.ci[1]:.0%}</td></tr>")
    h.append("</table>")
    h.append("<h2>Who AI recommends instead</h2><table><tr><th>Business</th><th style='width:45%'>Share of answers</th><th></th></tr>")
    for n, c, share in s.competitors[:6]:
        h.append(f"<tr><td>{nm(n)}</td><td><div class='bar'><i style='width:{share*100:.0f}%'></i></div></td><td>{share:.0%}</td></tr>")
    h.append("</table>")
    ex = next(((a.prompt, a.provider, [m.roster_name or m.raw for m in ms][:5]) for a, ms, _ in result.records
               if ms and target not in [m.roster_name for m in ms]), None)
    if ex:
        h.append(f"<h2>Example answer</h2><div class='q'>Asked <b>“{E(ex[0])}”</b>, {E(ex[1])} named: "
                 f"{', '.join(nm(n) for n in ex[2])}. <b>Not you.</b></div>")
    if unv and reg:
        h.append(f"<h2>Names we could not verify</h2><div class='q warn'>{len(unv)} of {total_named} business names in "
                 f"these answers did not match any practice in the official register for {E(result.city)}. Some may be "
                 f"real businesses listed under another legal name; others may not exist. Customers asking AI may be "
                 f"sent to them.</div>")
    elif unv:
        h.append(f"<h2>Names we could not verify</h2><div class='q warn'>{len(unv)} of {total_named} business names in "
                 f"these answers: we could not check these names against a register for this trade. Some may be real "
                 f"businesses, others may not exist.</div>")
    h.append("<h2>Likely reasons and what to fix</h2><ol>")
    for f in result.findings:
        cls = "tag e" if f.grade == "strong-correlation" else "tag"
        h.append(f"<li><b>{E(f.reason)}</b><br>{E(f.fix)}<br><span class='sub'>Evidence: {E(f.evidence)}</span><br><span class='{cls}'>{E(GRADE_LABEL[f.grade])}</span>"
                 f"<span class='tag'>effort: {E(f.effort)}</span></li>")
    h.append("</ol>")
    h.append("<div class='foot'><b>Method.</b> Fixed set of real customer questions for this trade and city, asked to each "
             "assistant; " + ("every business name is checked against official registers (e.g. the US NPI registry). " if reg else
             "names are not checked against an official register for this trade. ") + "Identical AI "
             "lists repeat in under 1% of runs (SparkToro, Jan 2026), so we report rates, not ranks. We never promise a "
             "ranking and never use fake reviews. " + models_txt + "Not affiliated with OpenAI, Google or Anthropic.</div>")
    h.append("</div></body></html>")
    return "".join(h)
