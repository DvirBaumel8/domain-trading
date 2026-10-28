# DOM Architect solo improve notes — discovery v3 Option 1 — 2026-10-28 ~21:05 IDT

Standing L&L for Gavriel merge. No money. No CloudAgents.

**Run facts (Buyer funnel):** health 5.74.0 · datasave=partial · field_n 747 · GET total 440 · judged 440 · unfinished 0 · full-stack passers 0 → FALLBACK. Directions A+B+D done; C parked. Pack rematerialized after workspace remount ~19:04 UTC.

## What went well
- Option 1 cadence held: one run after shortlist seal; completed on GD A+D despite datasave=partial (Dynadot GAP = blockers only — as locked).
- Same-day reuse of morning kills (~434 prior_morning_kill) kept unfinished at 0 without re-LLM of the whole field — correct token hygiene.
- Zero passers → honest FALLBACK top-5; rentguitar not re-carded; time_gate / USPTO FLAG stayed review-only.
- CR-083 kill id=15 survived the remount (API DB), unlike local files.

## Quality / reliability
1. **Run artifacts on box are fragile.** Remount wiped `sourcing/buyer-first/…` until rematerialize. Agree with Gavriel #1: persist **immediately** after seal — prefer git commit under `sourcing/buyer-first/<date>-v3/` (and/or upload key funnel+kills+PASSERS to a durable place). DOM API already kept CR-083; do **not** invent a new WRITE surface under freeze unless Dvir wants a tiny “run pack” snapshot CR later.
2. **datasave=partial still opaque on `/health`.** String `"partial"` alone doesn’t say which step (closeouts pages 46–48? aftermarket lock? GD race?). Reliability AI: expose last datasave step statuses / GAP reason on health or `GET /snapshots` so Buyer/Gavriel don’t guess. Maintenance/docs OK; Claude Code path only.
3. **Closeouts tip-200 (Gavriel #2).** `GET /candidates/closeouts` `limit≤200` is a hard tip cut for research “would-advance” while money paused. Conflicts with no-artificial-size-cut spirit for **research logging**, not for money. Paper audit first; if Dvir wants full would-advance counts, maintenance CR to paginate like shortlist (`limit`/`offset` + `total`) — no unpause money.

## Tokens / efficiency
4. **~434 prior_morning_kill (Gavriel #3).** Skip/reuse earlier is right. DOM-side soft help (hold under freeze unless needed): document that same-`data_date` re-runs should load prior kill/decline lists **before** meaning LLM; optional later READ of CR-083 kills filtered by domain list. No new WRITE.
5. **Shape features still held** (`token_n` / `has_digit` / `has_hyphen`) — still the best cheap token cut without shrinking `field_n`. Wait Dvir on-demand / Claude Code.
6. **field_n 747 vs total 440** — expected (ended / ineligible left out of serve). Keep reporting three numbers; don’t prune store.

## Process
7. Live `docs/bot-logic/04` still behind requests stamps (`775bfee7`) — Claude Code copy when convenient; bots-edit-only blocks bot push there.
8. rentguitar plan 1 still **open** (max $11); venue outbids are **not** auto-written — Gavriel posts `POST /auctions/plans/1/result` when auction ends (lost/won). Ledger only on import/buy.

## Suggested merge AIs (optional for Dvir)
| # | Idea | Kind | Hold? |
|---|---|---|---|
| 1 | Persist run pack off-box / git right after seal | Process (Buyer/Gavriel) | No freeze issue |
| 2 | Closeouts paginate / raise tip-200 for research counts | Paper audit → maybe maintenance CR | Freeze-ok if maintenance |
| 3 | Skip same-day prior kills before LLM | Buyer SOP (already mostly done) | Docs-only |
| 4 | Health/datasave step GAP detail | Maintenance / Claude Code | Yes under freeze until briefed |
| 5 | Shape features on shortlist | Maintenance CR | Hold for on-demand |
| 6 | Copy requests bot-logic → live `docs/bot-logic/` | Claude Code | When convenient |

No money. No CloudAgents.
