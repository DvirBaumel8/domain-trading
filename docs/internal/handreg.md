# Hand-registration paper test (F47, v5.66.0)

Binding rules and test IDs. Interface: `docs/contract/endpoints.md` §Hand-registration paper test, `jobs.md` row `datasave` (step `handregLabels`). Migration `1768600000000_v5-66-0.sql`. Dvir approved the test on 27 Oct 2026. Source: findings F47 (`docs/internal/loop/findings-actions-2026-10-25.md`). Everything the module reports is **a proxy, not profit**.

**Question.** Do AI-assisted hand-picked new-registration names get registered by someone else (and sell) more often than random names from the same pool? A free paper test: nobody registers anything, nothing is bought. It mirrors the pick-proof (`pickproof.md`): picks sealed against a same-size random control, labels months later, picks vs control. It is separate from the pick-proof: it runs even though `pickproof_enabled` is false (the replay switched the pick-proof off).

## Where
- `src/modules/pickproof/handreg.ts` (submit and seal, `drawControl`, views, report), `handreg-labels.ts` (the datasave step), `api/handreg.ts` (routes, `registerHandreg`, called from `src/app.ts`). Imports only what pickproof already imports: `src/core` (`mt19937.ts`, `rdap.ts`, `rdap-cache.ts`, `dates.ts`), `stats.ts` (Fisher), `draw.ts` (`byteOrder`), `recipe.ts` (`sha256Hex`), Kysely.
- Tables: `handreg_weeks` (week PK = Monday UTC, pool_n, pool_sha256, picks_n, seed bigint, control_sha256, submitted_by, sealed_at), `handreg_names` (week, domain, arm pick|control, rank, rdap_at_seal available|registered|unknown), `handreg_labels` (week, domain, horizon m6|m12, label, checked_at, created_at_rdap, reason, attempts). Settings (migration only): `handreg_max_pool` 2000, `handreg_max_picks` 30, `handreg_labels_max_per_run` 200. Triggers: `handreg_weeks` and `handreg_names` reject UPDATE and DELETE (`reject_mutation`); labels are the only table that moves. None in the backup.
- Route class: `POST /handreg/weeks` is `allowed` for a bots token in `BOTS_ROUTES` (a list of names, no money, no listing); WRITE also works. The GETs are READ, WRITE or bots (a data token gets 403).

## Rules
1. **One submission per week.** Week = the Monday (UTC) of the submission day. A second submission the same week is 409 `HANDREG_WEEK_SEALED`; a sealed week never changes. A dry run also checks this.
2. **Validation.** Names are trimmed and lower-cased and must be plain `.com` (SLD letters, digits, hyphens, no leading or trailing hyphen, at most 63 characters); the pool is de-duplicated; a pick twice is 422 `VALIDATION_ERROR`; a pick outside the pool is 422 `NOT_IN_POOL`; pool over `handreg_max_pool` or picks over `handreg_max_picks` is 422 `VALIDATION_ERROR`; a pool smaller than 2 x picks is 422 `HANDREG_POOL_TOO_SMALL`.
3. **Seal = pick and draw in one call.** The picks and the control are fixed in the same request, so the bots never see the control before they pick. `seed` = `crypto.randomInt(2**32)`, stored. **Control recipe:** sub-pool = pool minus the picks, sorted in byte order; `MT19937` initialised by the array `[seed]` (`src/core/mt19937.ts`); Fisher-Yates i from n-1 down to 1, j = `below(i+1)`; control = the first `picks_n` names, rank = position from 1. `pool_sha256` = SHA-256 of `JSON.stringify` of the byte-order-sorted pool; `control_sha256` = SHA-256 of `JSON.stringify` of the control in rank order. Anyone with the pool, picks and seed can redraw it (`drawControl`).
4. **RDAP at the seal.** Every pick and control name (at most 2 x `handreg_max_picks`) is looked up through the cached RDAP lookup, 250 ms between live asks; `registered` / `available` (404) / `unknown`. A 429 stops the lookups (the rest `unknown`); any error is `unknown`; the call never fails because of RDAP. Names `registered` at the seal are stored but left out of the report `n` and never labelled (they were never available).
5. **Store in one transaction** (`handreg_weeks` then `handreg_names`); a parallel submission that loses the race gets 409 `HANDREG_WEEK_SEALED` (unique violation).
6. **Dry run** (`dry_run: true`): same validation and week check, answer 200 `{dry_run: true, week, pool_n, picks_n, control_n, pool_sha256}`; no seed, no draw, no RDAP, nothing stored.
7. **Labels (`handregLabels`, datasave step right after `pickproofLabels`; it does not look at `pickproof_enabled`).** For every sealed name with `rdap_at_seal` not `registered`: horizon `m6` is due when week + 182 days <= today (UTC), `m12` when week + 365 days <= today. A label is missing, or `unknown` with fewer than 5 attempts (retried each run). Order: week, horizon, domain (oldest first). At most `handreg_labels_max_per_run` distinct names looked up per run (a name due at both horizons is looked up once), 250 ms between live asks, through the shared RDAP cache (a cached answer inside the TTL is fine for a 6-month label). Result: registered and its status list has neither `redemption period` nor `pending delete` (the pickproof rule 7, `dropStatusOf`) = `taken`; otherwise registered-but-dropping or not registered (404) = `not_taken`; error or timeout = `unknown` with the reason code. A 429 ends the run and stores no label for that name (an attempt is not burned). Returns `{status: ok|stopped, checked_n, due_n, ...}`; with nothing due `{status: "ok", checked_n: 0, due_n: 0}` and no outside call.
8. **Report** (`GET /handreg/report`): per horizon and arm `n` (not registered at the seal), `labelled_n` (`taken` or `not_taken`), `taken_n`, `taken_pct` (taken / labelled), `sold_n` (the name has a `market_sales` or `engine_sales` row dated after the week and up to week + horizon days), `unknown_n`, `pending_n` (no label yet). Comparison: one-sided Fisher exact (`stats.ts` `fisherGreater`), picks higher; `UNPOWERED` (no p) when picks + control taken events are under 10 or an arm has nothing labelled. `note: "proxy, not profit"`. **Decision:** `sold_n` is bounded by the horizon end so an m6 row never counts a sale from month 9 (the brief said "after the week"; this is a subset of that).
9. No money action, no AI call, no email, no marketplace call, no registrar call; the only outside call is the public RDAP host.

## Tests
`tests/modules/pickproof/handreg.test.ts` (RDAP mocked with MSW, `onUnhandledRequest: 'error'`).
| ID | What |
|---|---|
| HR66-1 | a submission seals picks and a same-size control: disjoint, a subset of the pool, reproducible from the stored seed, hashes |
| HR66-2 | second submission the same week 409 `HANDREG_WEEK_SEALED`, nothing changes; Monday boundary; next week is a new week |
| HR66-3 | `NOT_IN_POOL`, `HANDREG_POOL_TOO_SMALL` (exactly twice is enough), invalid name, pick twice; nothing stored |
| HR66-4 | dry run: 200, nothing stored, no draw, no RDAP |
| HR66-5 | scopes: data and read tokens 403 on the POST, bots and write allowed; the GETs; Idempotency-Key required |
| HR66-6 | registered at the seal is recorded and excluded from the report `n`; an RDAP error is `unknown` and never fails the call |
| HR66-7 | a 429 at the seal: the rest `unknown`, the call succeeds |
| HR66-8 | list of weeks with counts; 404 `HANDREG_WEEK_NOT_FOUND` |
| HR66-10 | nothing due: `{ok, 0, 0}` and no fetch; m6 due exactly on week + 182 |
| HR66-11 | m6 labels taken / not_taken (free, redemption) / unknown; registered-at-seal never asked |
| HR66-12 | a final label is not asked again; unknown retried up to 5 attempts |
| HR66-13 | m12 due on week + 365; one lookup serves both horizons |
| HR66-14 | a 429 ends the run, stores no label for it, the next run continues |
| HR66-15 | `handreg_labels_max_per_run` respected, oldest week first |
| HR66-16 | the datasave job has `handregLabels` right after `pickproofLabels` and runs while `pickproof_enabled` is false |
| HR66-20 | report counts per horizon and arm, `sold_n`, `pending_n`, `UNPOWERED` |
| HR66-21 | 10 or more taken events: a one-sided Fisher p |
| HR66-30 | sealed weeks and names are immutable in the database; labels move |
