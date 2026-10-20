# Ranked closeout and drop candidates (CR-072, v5.26.0)

Binding rules and test IDs. Interface: `docs/contract/endpoints.md` §`GET /candidates/closeouts`, `jobs.md` row `datasave` (step `scorePool`). Migration `1765800000000_v5-26-0.sql`.

## Where
- Filters: `src/modules/ops/closeouts/filters.ts` (`buildClassifier`, `FILTER_CODES`); name filters in `src/modules/selection/closeout-name.ts` (`closeoutNameChecker`).
- Step: `src/modules/ops/closeouts/score-pool.ts` (`scorePool`), called by `DatasaveJob.scorePool` (`ops/jobs/datasave/datasave.ts`), step list in `ops/jobs/runner.ts`.
- Offline score: `src/modules/engine/score.ts` `Scorer.scoreOffline` (the app's one `Scorer`, passed to `DatasaveJob` and `registerCloseouts` in `src/app.ts`).
- Route: `src/modules/ops/api/closeouts.ts` (`registerCloseouts`). Read-only; no POST exists.
- Columns: `datasave_pool` and `dynadot_rows` get `filter_code`, `scored_at`, `model_version` (`dynadot_rows` also `score`, `score_reason`); setting `settings.closeouts_filter_digits_hyphen` (default true).

## Rules
1. **Order (first failing code wins, each row counted once):** `SPELL-1`, `BRAND-1`, `BIGCO-1`, `TM_KILL`, `FORBIDDEN_TERM`, `DIGITS_OR_HYPHEN`, `OWNED`, `SALES_GRADED`.
2. **What each code reuses:** `SPELL-1` = `analyzeForm` (selection `form.ts`, the `form` check's function; non-geo lane S7, active selection settings and current word lists) returning FAIL (HAS_DIGIT outside a regime code, HAS_HYPHEN, UNKNOWN_TOKEN, SLD_TOO_LONG). `BRAND-1` = the `brand_lists` check's rule for the active `brand` list (a term equals one token or a run of consecutive non-geo tokens). `BIGCO-1` = the same rule for the active `bigco` list plus the current `bigco_names` rows. `TM_KILL` = the same rule for the current `tm_kills` terms (geo tokens count) and an exact match of the whole name. "Current" = not the target of a later row's `supersedes`. The term lookup is a set lookup (`closeout-name.ts`) that finds the same hits as `matchTerms` without a pass over every term for every name. A missing brand or bigco list filters nothing (the screening checks say UNKNOWN; here the row is not dropped for a missing list).
3. `FORBIDDEN_TERM`: an active (not retired) `forbidden_terms` term, letters and digits only, is a substring of the name (conservative: a substring also filters a longer word that contains it). `DIGITS_OR_HYPHEN`: a digit or hyphen in the name when the setting is on (after `SPELL-1`, so it catches the regime-code digits `SPELL-1` lets through). `OWNED`: the name is in `domains`, any status. `SALES_GRADED`: the name is in `engine_sales` or has a `market_names` episode with `outcome = sold` (CR-072 R-2 names `market_names`; the engine's sales table is the older source; both count).
4. **Scoring:** only rows that passed the filters; the active model through `Scorer.scoreOffline`: the model's probability (4 decimals) from the stored facts, `asof` = the IDT day of the run. No registry ask, no fetch, nothing written to `engine_endings`. Without a model: `score_reason NO_ACTIVE_MODEL`; those rows are scored by the first later run that finds a model. A name the model returns no number for: `SCORE_FAILED`, processed. A batch that throws: rows stay unprocessed and keep `SCORE_FAILED` until the next run. Scores are written once per row per day: a model retrained later does not re-score processed rows (the next day's pool uses it).
5. **Dynadot:** only a sealed `bot_upload` manifest day is processed; `source=dynadot` on a day without one is 409 `SNAPSHOT_MISSING`.
6. **Route:** snapshot of the day = sealed `complete` manifest (`godaddy_inventory` file `closeout_listings.json.zip`, `dynadot_closeouts` file `bot_upload`). Counts come from the stored `filter_code`; rows are sorted `score desc nulls last, price_cents, domain`. A row not yet processed counts as ranked with `score_reason NOT_SCORED_YET`. `max_price` is USD ($0.01..$40, at most 2 decimals, default 40), converted to cents. `all` merges the sources present; the sha is a map by source.
7. **Drops:** the kept rows (`drop_list_rows.kept`) of the `drop_lists` of the date, `.com` only, filtered and scored at read time by the same functions (small list); no price; `snapshot_sha256` null; the invariant holds. Default date = the newest list with `kept_n > 0`.
8. Read-only (R-7): buying stays `/buy` or `/portfolio/import`. A bots token's POST to the path is 403 (an unlisted POST fails closed), a WRITE token's 404.

## Tests
`tests/modules/ops/closeouts.test.ts`.
| ID | What |
|---|---|
| CC526-1 | AT-1: at most `limit` rows, score descending, ties by lower price then name, every row .com and <= 4000 cents; `.net` and over-cap rows not in the pool |
| CC526-2 | AT-2: bigco_names, tm_kills, forbidden term and brand list each filter with their own code, counted in `filtered_by` |
| CC526-3 | AT-3: 409 `SNAPSHOT_MISSING` for no sealed snapshot (date, default, source dynadot, drops) |
| CC526-4 | AT-4: `limit=500` and other bad queries are 400 `VALIDATION_ERROR` |
| CC526-5 | AT-5: Dynadot 1088 cents is "$10.88"; an unsealed upload is 409 |
| CC526-6 | AT-6: `pool_n - sum(filtered_by) = ranked_n` for godaddy, dynadot, all and a narrower `max_price`; `snapshot_sha256` equals `GET /snapshots` (a map for all) |
| CC526-7 | AT-7: no POST (bots 403, WRITE 404); GET open to bots and READ; 401 without a token |
| CC526-8 | the step stores the first failed filter, the score, model_version, scored_at; the filter order; processed rows are not touched twice |
| CC526-9 | scoring makes no outside call (fetch spy, registry ask spy, `engine_endings` unchanged) and gives the same scores twice |
| CC526-10 | no active model: null scores with `NO_ACTIVE_MODEL`, rows listed, unscored rows after scored ones, a later model scores them |
| CC526-11 | Dynadot closeouts are scored on a later run once the upload is sealed |
| CC526-12 | `source=drops`: kept names only, filtered and scored, no price, the invariant |
| CC526-14 | a scoring failure is score null with `SCORE_FAILED` (rows listed, filter code kept), retried next run; a name the scorer returns no number for is processed with the same reason |
| CC526-13 | the datasave job has the `scorePool` step right after the Dynadot steps |
