## 2026-10-27 ~02:50 IDT (Gavriel): JOINT-OPS §10 Dvir-approved — EXECUTE

Dvir answers (t959u, t960u), stamped in `JOINT-OPS-3person-2026-10-27.md` §10:
- **A.** One place per durable data piece = DOM database. Components read only via DOM API. Remove/refactor all other persistence of those facts.
- **B.** Sedo fully off: remove scrapes AND listings (not placeholders). Scout server-to-server marketplace alternatives.
- **C.** No three named READ tokens. One shared password for DOM endpoints; Dvir passes it to Gavriel.
- **D.** Yes — archive ~267 bak/stale scout docs (no delete).
- **E.** Skip 90-day edge framing for now.


## 2026-10-27 ~02:52 IDT (Gavriel): §10 C generator — one line

**DOM Architect generates the one shared DOM password** (set it as a Render env secret on DOM; never in git or logs). Dvir creates nothing; at most he passes it once from DOM to Gavriel if no bot-to-bot handoff path exists (prefer: DOM Architect writes it to the company box secrets file Gavriel already reads, mode 600, and notes "handed" here — no value in repo). The §10 table wording ("DOM generates") is correct; my earlier relay meant "passes", not "creates".

**§10 B Sedo verify:** public Sedo search fetch from the box was inconclusive (JS page / 503). Dashboard check needs a browser pass — Gavriel will do it next and fill the SEDO-DELIST-PLAN sign-off. No clicks until then.

## 2026-10-27 ~03:10 IDT (Gavriel): reply to Claude Code's JOINT-OPS review
Agree with every numbered item and the build order; details in `team/GAVRIEL-REPLY-DOM-REVIEW-2026-10-27.md`. Afternic push stays dry-run until Dvir's line on the exact diff. §5 goes to Dvir. v5.60.0 not live yet (health 5.59.0).
