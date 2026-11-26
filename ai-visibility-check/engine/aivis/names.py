"""'Names the AI gave': which businesses the AI named, and how often.

These are AI output. A name is only called a real listing when it matches an
official register; otherwise it stays unverified and is never a competitor.
"""
import html

from .parse import match_name, normalize

HEADING = "Names the AI gave (AI output, not verified)"
MATCH_YES = "matches a real listing"
MATCH_NO = "not found in the official register"
MATCH_UNKNOWN = "match not confirmed"
NO_REGISTER_NOTE = "no official register available for this type, names not verified"
UNAVAILABLE_NOTE = "could not verify names"
EMPTY_NOTE = "The AI did not name any businesses in its answers."
REGISTER_OK_NOTE = "Names are checked against the official register (NPI registry); a name that is not found there may still be real."
TOP = 10


def aggregate(per_answer, target="", city="", register="none", top=TOP):
    """per_answer: one list per answer of (name, matched) with matched True/False/None.

    register: 'ok' (a register was checked), 'none' (no register for this type), 'unavailable' (fetch failed).
    Returns the summary dict served to the page. Names are counted once per answer, case-insensitively;
    the user's own business is reported separately, never listed as a name.
    """
    answers = len(per_answer)
    named_in, count, label, matched = 0, {}, {}, {}
    for items in per_answer:
        seen, own = set(), False
        for name, m in items:
            name = (name or "").strip()
            key = normalize(name) or name.lower()
            if not key:
                continue
            if target and match_name(name, [target], city=city):
                own = True
                continue
            if key in seen:
                continue
            seen.add(key)
            label.setdefault(key, name)
            if register == "ok":        # True beats False beats unknown
                prev = matched.get(key)
                matched[key] = True if (prev is True or m is True) else (False if (prev is False or m is False) else None)
            else:
                matched[key] = None
            count[key] = count.get(key, 0) + 1
        named_in += own
    rows = []
    for key, c in sorted(count.items(), key=lambda kv: (-kv[1], label[kv[0]].lower())):
        m = matched[key]
        rows.append({"name": label[key], "answers": c, "matched": m,
                     "match": MATCH_YES if m is True else MATCH_NO if m is False else
                     MATCH_UNKNOWN if register == "ok" else ""})
    note = {"ok": REGISTER_OK_NOTE, "none": NO_REGISTER_NOTE, "unavailable": UNAVAILABLE_NOTE}[register]
    return {"heading": HEADING, "named_in": named_in, "answers": answers, "register": register,
            "register_note": note, "names": rows[:top], "distinct": len(rows),
            "matched_count": sum(1 for r in rows if r["matched"] is True),
            "empty_note": EMPTY_NOTE if not rows else ""}


def from_records(records, target, city, register):
    """Build the summary from audit records [(answer, mentions, intent)]."""
    return aggregate([[(m.raw, (m.roster_name is not None) if register == "ok" else None) for m in ms]
                      for _, ms, _ in records], target, city, register)


def to_html(summary) -> str:
    """Server-side section (report page). Everything is escaped."""
    E = html.escape
    h = [f"<h2>{E(summary['heading'])}</h2>"]
    if summary["answers"]:
        n = summary["named_in"]
        h.append(f"<p>Your business: {'named in %d of %d answers' % (n, summary['answers']) if n else 'not named'}.</p>")
    if summary["names"]:
        h.append("<table><tr><th>Name</th><th>Answers</th><th>Register</th></tr>")
        for r in summary["names"]:
            h.append(f"<tr><td>{E(r['name'])}</td><td>{r['answers']} of {summary['answers']}</td>"
                     f"<td>{E(r['match'])}</td></tr>")
        h.append("</table>")
    else:
        h.append(f"<p>{E(summary['empty_note'])}</p>")
    h.append(f"<p class='sub'>{E(summary['register_note'])}</p>")
    return "".join(h)
