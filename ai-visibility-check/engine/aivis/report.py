"""One-page report (Markdown and a print-friendly HTML)."""
import html
import math

from .niches import niche_label

GRADE_LABEL = {"strong-correlation": "strong link in studies", "some-evidence": "some evidence",
               "hygiene": "basic hygiene (small or no proven effect alone)", "weak/none": "unproven"}


def _example(result, limit=1):
    for ans, mentions, intent in result.records:
        names = [m.roster_name or m.raw for m in mentions][:5]
        if names and result.target not in names:
            return ans.prompt, ans.provider, names
    return None


def to_markdown(result) -> str:
    s = result.score
    lines = [f"# AI visibility check: {result.target}",
             f"**{niche_label(result.niche.label)} in {result.city}** · {len(result.prompts)} customer questions × "
             f"{len({a.provider for a, _, _ in result.records})} AI tool(s) × repeats = {s.total_answers} answers",
             "", f"## Score: {s.score}/100",
             "How often AI tools name you when customers ask (higher is better).", "",
             "| AI tool | Mode | Named you | 95% range |", "|---|---|---|---|"]
    for p in s.providers:
        lines.append(f"| {p.provider} | {p.mode} | {p.target_hits}/{p.answers} ({p.rate:.0%}) | "
                     f"{p.ci[0]:.0%}–{p.ci[1]:.0%} |")
    if any(p.mode != "web-search" for p in s.providers):
        lines.append("")
        lines.append("_Note: 'simulated' and 'model-memory' rows are not what real ChatGPT users see "
                     "(no live web search). Paid report uses live web-search modes._")
    lines += ["", "## Who AI recommends instead", "| Business | Named in |", "|---|---|"]
    for n, c, share in s.competitors[:7]:
        lines.append(f"| {n} | {share:.0%} of answers |")
    ex = _example(result)
    if ex:
        lines += ["", f"**Example.** Asked “{ex[0]}”, {ex[1]} named: {', '.join(ex[2])}. Not you."]
    lines += ["", "## Likely reasons and what to fix"]
    for i, f in enumerate(result.findings, 1):
        lines.append(f"{i}. **{f.reason}** Fix: {f.fix} _(Evidence: {f.evidence} · {GRADE_LABEL[f.grade]} · "
                     f"effort {f.effort})_")
    lines += ["", "## How to read this",
              "AI answers change every time (identical lists <1% of the time, SparkToro 2026), so we ask many "
              "questions several times and report how often you are named, not a rank. We never promise a "
              "ranking. No fake reviews, no spam."]
    if result.errors:
        lines += ["", f"_Provider errors: {len(result.errors)} (first: {result.errors[0]})_"]
    return "\n".join(lines) + "\n"


def to_html(result) -> str:
    md = to_markdown(result)
    body = []
    in_table = False
    for line in md.splitlines():
        esc = html.escape(line)
        esc = esc.replace("**", "")
        if line.startswith("|"):
            cells = [c.strip() for c in line.strip("|").split("|")]
            if set("".join(cells)) <= set("-"):
                continue
            if not in_table:
                body.append("<table>")
                in_table = True
            body.append("<tr>" + "".join(f"<td>{html.escape(c).replace('**', '')}</td>" for c in cells) + "</tr>")
            continue
        if in_table:
            body.append("</table>")
            in_table = False
        if line.startswith("# "):
            body.append(f"<h1>{esc[2:]}</h1>")
        elif line.startswith("## "):
            body.append(f"<h2>{esc[3:]}</h2>")
        elif line.strip():
            body.append(f"<p>{esc}</p>")
    if in_table:
        body.append("</table>")
    css = ("body{font-family:Inter,Arial,sans-serif;max-width:780px;margin:24px auto;color:#111;font-size:13px}"
           "h1{font-size:22px}h2{font-size:16px;margin-top:18px;border-bottom:1px solid #ddd}"
           "table{border-collapse:collapse;width:100%}td{border:1px solid #ddd;padding:4px 6px}")
    return f"<!doctype html><html><head><meta charset='utf-8'><style>{css}</style></head><body>{''.join(body)}</body></html>"
