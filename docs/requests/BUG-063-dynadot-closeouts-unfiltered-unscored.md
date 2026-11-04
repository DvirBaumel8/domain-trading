# BUG-063 — Dynadot closeouts rows never filtered or scored (all NOT_SCORED_YET, filtered_by all 0)

Filed by DOM Architect (Grok Bot), 2026-11-04 ~23:55 IDT. Read-only evidence from the API.

## Evidence (GET /candidates/closeouts, 2026-11-04)
- `source=dynadot`: pool_n 18,170, ranked_n 18,170, **every filtered_by code 0**; rows like `014229.com`, `059712580.com`, `069a3b0ddd36ba2f.com`, `0906vip11.com` pass (`filters_passed: true`, `words: []`) with `score: null, score_reason: NOT_SCORED_YET`. These must fail `SPELL-1` / `DIGITS_OR_HYPHEN` (setting default on).
- `source=all` default read is therefore topped by Dynadot numeric junk (null-score ties sorted by price, then name).
- `source=godaddy`: filters applied (SPELL-1 58,761 …), scores null with `NO_ACTIVE_MODEL` — by design per endpoints.md / internal/closeouts.md (CC526-10), not part of this bug.
- `GET /jobs/runs`: datasave 17:25 IDT `scorePool` ok (17.4 s, queries only `source = 'godaddy_closeouts'`); the later datasave 19:36 IDT (Dynadot top-up) has no `scorePool` step.

## Expected (contract)
endpoints.md §GET /candidates/closeouts: filters and scores are computed once per day by `scorePool` for "the GoDaddy closeouts pool and the sealed Dynadot closeouts upload". Hard filters must apply to Dynadot rows; `NOT_SCORED_YET` should be transient.

## Fix asks
1. `scorePool` processes sealed Dynadot closeouts rows of the date (filters + score/score_reason).
2. Run `scorePool` (filters at least) after any datasave step that seals or tops up Dynadot closeouts, including `only` runs.
3. No contract change.

## Tests
- BUG063-T1: Dynadot closeouts fixture with digit/hyphen names → counted in `DIGITS_OR_HYPHEN`/`SPELL-1`, not in rows.
- BUG063-T2: after scorePool, no Dynadot row has `NOT_SCORED_YET`; without a model they show `NO_ACTIVE_MODEL`.
- BUG063-T3: a Dynadot seal after scorePool already ran (late upload / `only` top-up) gets filtered+scored by the follow-up step.
- BUG063-T4: `pool_n - sum(filtered_by) = ranked_n` holds per source for `all`, `godaddy`, `dynadot`.
- BUG063-T5: GoDaddy behavior unchanged (regression).
