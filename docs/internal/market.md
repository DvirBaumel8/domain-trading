# Market episodes, labels, matched sets, data quality (CR-075, v5.23.0)

Binding rules and test IDs for the `market` module. The interface is `docs/contract/endpoints.md` (§Market data), `jobs.md` (steps `episodes`, `dqMarket`), `reports.md` (`DQ_MARKET_FAIL`). Source request: `docs/requests/CR-075-market-names-episodes-and-labels.md` (R-1..R-8, AT-1..AT-10; DOM's storage answer at its end).

## Where
- `src/modules/market/` (imports no other module; reads the datasave tables through Kysely; ops and `app.ts` import `index.ts`): `common.ts` (bands, `episodeId`, name parts, tiers), `episodes.ts` (`runEpisodes`, `labelUnsold`), `sales.ts` (`parseSale`, `loadSales`, `SalesBody`), `matched.ts` (`buildMatched`, `matchedSet`), `dq.ts` (`runDqMarket`, `latestDq`, the thresholds), `coverage.ts` (`coverage`, `TARGETS`), `read.ts` (`listEpisodes`, `episodeOut`, `CLEAN_FEATURES`), `api/market.ts` (`registerMarket`: the routes).
- Ops: `DatasaveJob.episodes()` and `.dqMarket()` (`ops/jobs/datasave/datasave.ts`), plan in `ops/jobs/runner.ts` (the last two steps of job `datasave`). Health/report: `reporting/market-dq-state.ts` (`marketDqStatus`), `ops/api/health.ts` (`dq_market`), `reporting/report/warnings.ts` (`DQ_MARKET_FAIL`).
- Tables (migration `1765500000000_v5-23-0.sql`): `market_names` (derived, upserted), `market_sales` (append-only trigger), `market_dq_runs` (last 90), `market_matched_sets` (append-only trigger). None is in the backup (`backup-coverage` states why). Locks: `market_episodes`, `market_sales`, `market_matched`.
- No new schedule: the steps are the end of the 15:00 UTC `datasave` run (and its retry).

## Rules
1. **Storage (Q1).** Nothing under $500 (50000 cents) is stored in `market_names` (5.41.0: `godaddy_auctions` itself now keeps ended auctions from `settings.datasave_auction_min_cents`, $100 by default, for the engine feed; `episodes.ts` still filters it by `MIN_CENTS`, so this floor is unchanged). Sources: sales >= $500, Dynadot `aftermarket` rows (already >= $500), Dynadot `closed_auctions` with `final_price_cents` >= $500, GoDaddy `godaddy_auctions` rows that ended with `last_price_cents` >= $500. A sale under $500 is kept in `market_sales` (`below_floor_n`) but makes no episode. `market_names` is never pruned.
2. **Episode key.** `episode_id` = sha1(`name|venue|first_seen`), plus `|auction` / `|offer` / `|closeout` for a non-bin type (two simultaneous episodes of one name would collide). `first_seen`/`last_seen` are source data dates.
3. **Dynadot Buy-Now episodes** are built in SQL from the sealed days of `dynadot_aftermarket` (manifest `complete`): a name's consecutive sightings are one episode unless a sealed day lies between them (name absent) AND the gap is > 7 days (`GAP_DAYS`). Two sightings with no sealed day between never split (AT-1: D and D+61 with only those two days sealed). The price of a day is the lowest `price_cents` of the name; `price_changes` counts day-to-day changes inside the episode. If the oldest source rows were pruned (120 days), a derived episode that starts within 7 days after a stored episode of the same name/venue continues it (stored `episode_id`, `first_seen`, first price kept).
4. **Labels** (`labelUnsold`, recomputed on every run, never frozen): sold if a reported sale attaches (SOLD_REPORTED, wins over SOLD_BIDS) or the auction had >= 1 bid (SOLD_BIDS). Else: one sighting -> unknown `SEEN_ONCE`; still on the source (last sealed day - `last_seen` <= 7) -> span >= 60 `UNSOLD_60D`, >= 30 `UNSOLD_30D`, else unknown `TOO_SHORT`; gone from the source -> `UNSOLD_60D` only when span >= 60 and 90 days have passed since `first_seen`, else unknown `DISAPPEARED`. An ended auction with no bid has a span of at most a few days, so it is `SEEN_ONCE` / `DISAPPEARED` (never counted). `delisted` is reserved.
5. **Sale attach.** Sales are grouped by (name, venue, sale_date); the winner is the highest tier (A best), then the lowest id; the other sources go to `dup_sources` (the group's `dup_group` = sha1 of the key). A sale attaches to the episode of the same name with `first_seen <= sale_date <= last_seen + 90` (same venue first, then the latest `first_seen`); one episode takes one sale. No episode: a sold-only episode (`sale_only`, id from the sale date, listing_type from the row, default bin). Matched episode: `tier` = best of its snapshot tier and the sale tier.
6. **Tier.** GoDaddy official inventory files = `A`; Dynadot API data uploaded by the bots = `B`; a sale carries its own (required, A-D).
7. **`price_band`** from the sale price when sold, else the last list price: `500-999`, `1k-2.5k`, `2.5k-5k`, `5k-10k`, `10k+`.
8. **Idempotent.** The write compares each derived row with the stored one and writes only changes (`derived_at` stays); rows no longer derived (a sold-only episode a late listing now explains) are deleted. `feat_asof` is never written or cleared by the job.
9. **`POST /data/sales`**: parsed row by row with a reason; any bad row -> 422 for the whole call; a conflicting stored key with another price -> 409 `APPEND_ONLY` for the whole call; identical -> duplicate. `source`/`source_url` containing `namebio` (any case) and a missing `tier` are refused. PUT/PATCH/DELETE (also with `/{id}`) -> 405 `APPEND_ONLY` from a route-level `onRequest` hook (answers before the idempotency check). The audit row keeps `[n rows]` (`http/audit.ts` `elideRows`). In `BOTS_ROUTES` as `allowed` (all seven entries); under `DATA_PREFIX` so a data token may POST.
10. **Matched** (rule `m1`): positives = sold `.com`, `sale_date <= asof`, clean features; negatives = `UNSOLD_60D` `.com`, `first_seen <= asof - 60`, clean features, same band, same letters-only flag (`^[a-z]+$` of the name before the first dot), different name, `[first_seen, last_seen]` overlapping `sale_date -30 .. +30`; each negative once; per-positive Fisher-Yates with mulberry32 seeded by sha256(`asof|ratio|seed|positive episode_id`) (a local copy; the engine's `makeRng` is not exported across modules). Frozen in `market_matched_sets` on the first call; sha256 over `canonicalJson` of the payload. **v5.25.0:** an `asof` after the newest sealed source day (max `data_date` of complete `dynadot_aftermarket` / `dynadot_closed_auctions` manifests; today UTC when none) is 409 `MATCHED_ASOF_FUTURE` and nothing is stored (MK525-1); a set with 0 positives is returned `frozen: false`, `frozen_at: null` and is not stored (MK525-2); the migration `1765700000000_v5-25-0.sql` deletes the stored sets with 0 positives (MK525-3).
11. **dqMarket** (`dq.ts`): `duplicates`, `survivorship` (fails above 90% only after 30 sealed days), `leakage` (`feat_asof` > `first_seen` or > `sale_date`; rows excluded from matched), `price_sanity` (>10x day-to-day jump in the last 30 days; sale < $100; sale vs list >10x either way), `coverage` (dynadot_aftermarket and dynadot_closed_auctions; a sealed day of the last 7 under 50% of the median of the 7 days before, needing 3 prior days), `tier_present`. Any fail -> run status `alert` -> `/health.dq_market` and `DQ_MARKET_FAIL` (error). The step itself stays ok.
12. **Coverage targets**: 1,000 `unsold_30d` (UNSOLD_30D + UNSOLD_60D) by 2026-11-25; 2,000 `unsold_60d_matched` (negatives of a matched set for today, ratio 4, seed 1, not stored) by 2026-12-20.

13. **`GET /auctions/live`** (v5.37.0, `auctions-live.ts`, route in `api/market.ts`): read-only, READ or bots (a data token is 403, like `/market/episodes`). Reads `godaddy_auctions_live` (written by the datasave step `godaddyInventory`, rules 29a-29c in `datasave.md`) and `settings` (`s8_max_price_cents`, `datasave_auction_live_min_bids` = the `band`) through Kysely; imports no other module. Zod strict query: `date`, `max_price` (USD), `min_bids`, `ends_within_hours` (1..240), `type` (case-insensitive exact), `sort` (`end_time` | `bids` | `price`), `limit` (1..500), `offset`, `include_ended` (default false: `end_time` after the app clock). Default date = the latest stored data date; an empty table answers `data_date: null`.

## Tests
`tests/modules/market/market.test.ts`, `tests/modules/market/auctions-live.test.ts` (v5.37.0).
| ID | What |
|---|---|
| MK523-1 | AT-1 D and D+61 -> UNSOLD_60D, days_listed 61 |
| MK523-2 | AT-2 D and D+31 -> UNSOLD_30D, not in UNSOLD_60D |
| MK523-3 | AT-3 sale on D+20 -> SOLD_REPORTED with price and date |
| MK523-4 | AT-4 seen once / gone / too short -> unknown, in no matched class |
| MK523-5 | AT-5 PUT/PATCH/DELETE 405, changed price 409 APPEND_ONLY, identical repost duplicate, table triggers |
| MK523-6 | AT-6 matched twice same rows and sha, band/flag/window shared, frozen after new data |
| MK523-7 | AT-7 leakage fails, health alert, DQ_MARKET_FAIL, row excluded from matched |
| MK523-8 | AT-8 Dynadot day at 10% of the median fails coverage |
| MK523-9 | AT-9 coverage per source per day, labels, bands, targets, db_rows |
| MK523-10 | AT-10 NameBio source and missing tier -> 422 |
| MK523-11 | episodes twice: nothing written the second time |
| MK523-12 | gap > 7 days with an absent sealed day splits; <= 7 does not |
| MK523-13 | sale with no episode -> sold-only episode; under $500 stores no episode |
| MK523-14 | duplicate sale from three sources: highest tier, dup_sources |
| MK523-15 | GoDaddy / Dynadot auctions: SOLD_BIDS, no bids unknown, under $500 not stored, open auctions skipped |
| MK523-16 | pruned oldest source rows: the episode continues |
| MK523-17 | tokens (bots, WRITE, data ok; READ 403), dry_run, audit row count only |
| MK523-18 | query validation, data token 403, unauthenticated 401 |
| MK523-19 | the datasave job ends with episodes and dqMarket; health unknown -> ok |
| MK523-20 | price sanity flags |
| MK523-21 | left the source: unknown until 90 days, then UNSOLD_60D |
| MK523-22 | per-row reject reasons |

## v5.73.0 (BUG-062)

- `dq.ts` price sanity reads `min(price_cents)::bigint`: `dynadot_rows.price_cents` is int4, and a price times 10 over 2^31 (a listing over $2.1M) overflowed (`integer out of range` failed `dqMarket`, 28 Oct 2026). Test MK562-1 in `market.test.ts`.

## v5.37.0 tests (`auctions-live.test.ts`)
| ID | What |
|---|---|
| MK537-1 | default call: latest day, future end times only, sorted by end_time, display price, band |
| MK537-2 | filters max_price, min_bids, ends_within_hours, type, sort, limit, offset, include_ended, date |
| MK537-3 | 400 VALIDATION_ERROR (unknown parameter, bad values); empty table; READ and bots read, unauthenticated 401 |

## v5.25.0 follow-up tests
| ID | What |
|---|---|
| MK525-1 | future `asof` is 409 `MATCHED_ASOF_FUTURE`, nothing stored; the newest sealed day itself is accepted; with no sealed day the limit is today |
| MK525-2 | an empty set is not frozen; a later call with data freezes a non-empty set |
| MK525-3 | the migration deletes only sets with 0 positives (readFileSync check) |

Tests MK523-6 and MK523-7 now ask for `asof` on or before the newest sealed day (2026-12-01), not 2026-12-20.

## Batching (v5.42.0)
`loadSales` looks up the stored keys of a body with `unnest` arrays (5,000 a statement) and inserts the new rows 1,000 a statement, under the same `market_sales` lock and transaction; the 409 `APPEND_ONLY` rule, the in-body duplicate rule and the response are unchanged. Test BK542-1 (10,003 queries before, 9 after for 5,000 rows).
