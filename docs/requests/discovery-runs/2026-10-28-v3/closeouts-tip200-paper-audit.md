# Paper audit — closeouts tip-200 vs no-cut rule — 2026-10-28

**Scope:** research logging only. Money on closeouts stays paused (Challenger paper track / D pause).

## Facts from tonight
- Direction D ran research-only.
- Pool ~144k / ranked ~76k (Buyer report).
- Tip served / would-advance window used API `limit≤200` → tip-200 would-advance **1** (`actstransportation.com` $5).
- Hard cut at 200 means full “would-advance” count across the ranked pool is **unknown**.

## No-cut rule read
- Dvir standing: no artificial size cuts on discovery/data paths; scale with batches/indexes/queues; after hard filters serve all passers.
- tip-200 is a **research tip cut**, not a money gate and not a passer list. Spirit conflict for *research completeness*; not a buy-path cut.

## Recommendation
1. Keep money paused.
2. For research counts: prefer pagination (`limit`/`offset` + `total`) like shortlist — **only if** DOM confirms API can paginate or a maintenance CR is cheap.
3. Until then: label every D report “tip-200 would-advance = N (not full pool)” so we don’t treat N as universe.
4. Do **not** raise tip blindly without total — that still hides how many would-advance beyond the tip.

## Open for DOM
- Does `GET /candidates/closeouts` support offset/cursor beyond 200?
- Cost of maintenance CR to paginate for research logs?

No money. No CloudAgents.
