# Historical replay and the daily archive (CR-081, v5.59.0)

Binding rules and test ids. Interface: `docs/contract/endpoints.md` §Historical replay, `jobs.md` row `datasave`. Source request: `docs/requests/CR-081-historical-replay.md`.

## Where
- `src/modules/ops/archive/godaddy-archive.ts`: `archiveZip` (write), `readArchive` (stream a day), `archivedDays`, `archiveStatus` (`/health.archive`).
- `src/modules/ops/replay/logic.ts` (the point-in-time logic: `dayRow`, `logicContext`, `liftAsOf`, `rankDay`, `randomGroup`), `outcomes.ts` (labels from later data), `report.ts` (rates, `too_small`, `bootstrap`, `did_well`), `run.ts` (`computeReplay`, `ReplayRunner`, `resolveSeed`, `refuseAsOf`), `api/replay.ts` (routes).
- `DatasaveJob.archiveFile` in `ops/jobs/datasave/datasave.ts`; `priceToCents` moved to `datasave-price.ts`. `shortlist.ts` exports `liftOf`.
- Config `ARCHIVE_DIR` (`config.archiveDir`, default a sibling `archive` of `SNAPSHOT_DIR`). Migration `1767900000000_v5-59-0.sql`: `settings.pickproof_enabled` (default false) and `replay_day_runs` (the older `replay_runs` belongs to the selection replay).

## Rules
1. **Archive.** After a file is saved, `all_biddable_auctions` and `closeout_listings` are written to `<ARCHIVE_DIR>/godaddy/<data_date>-<file base>.jsonl.gz`: one JSON line per row, domain ends in `.com`, price at most `settings.s8_max_price_cents` (read at run time), all fields, adult rows included. An existing file is skipped. A sealed day with its raw zip on disk is archived on the next run. A failure is `archive.error` in the summary and never fails the step. Nothing deletes the archive. `/health.archive`: `days_n` (both files), `first`, `last`, `missing_days`.
2. **Pick-proof off.** `settings.pickproof_enabled` false: `pickproofSeal` / `pickproofLabels` return `{status: "off", reason: "CR-081"}`; `ensureDay` refuses to freeze a new day (409 `PICKPROOF_STOPPED`, no `pickproof_pool` rows); picks for an unsealed day are 409 `PICKPROOF_STOPPED`. Sealed days and the read routes are unchanged. The off step also no longer shrinks or prunes old pool rows (`pickproofLabels` did): accepted, the rows are bounded to the days already frozen.
3. **Logic = today's logic on day D's data** (conflict with the CR text, resolved by DOM; see the CR response). Same functions as the auction shortlist: `closeoutNameChecker`, `adultFilter`, `personName`, `scoreAuction` v4 with the field percentile and the row's demand fields, `maxBidRule` with `positionFactor`. Auctions: bids at least 1, ending after 15:00 UTC of D and inside `shortlist_horizon_hours`, price at most the cap. Closeouts: no bid or horizon rule, same name rules and scoring. Endings are not asked (unknown, which the score allows); the brand-typo rule is not applied (v1). Owned names and open plans are not filtered (they are our later actions).
4. **Point in time.** The logic reads only the archived rows of day D, the frozen lists, `settings` and a lift table: the newest `lift_models` row trained at or before the end of D (UTC), else the table trained from the CR-002 seed alone, else none (score v2). A model trained after D is never used. No RDAP, no endings, no later file, no sales. `logic_version` = `replay-v1|<score version>|lift:<id or seed sha>|settings:<hash>`. Only `logic: "current"` is accepted; `as_of_date` is 422 `REPLAY_LOGIC_UNAVAILABLE` until recipe versions are stored per day.
5. **Random group.** The filtered field minus our top N, sorted by byte order and shuffled with `core/mt19937.ts` (MT19937 + Fisher-Yates, as the pick-proof draws), seeded from the first 8 hex digits of sha256(`seed|date`). Default seed `sha:<16 hex>` of sha256(archive file + `:kind`). Reproducible.
6. **Outcomes** (data stored after D, never in the logic): auctions `reached_100`, `beat_our_max` (final = the ended-auction tracker `godaddy_auctions` when it has the name, else the last archived row before the end, a lower bound; `ended` known only when the tracker says so or the end is before the newest archived day); closeouts `taken` from stored `closeout_expiries` tags (`held` true, `dropped` false, others unknown; `rdap.status` pending until D+30; no live lookup); retail `retail_sale` / `retail_500` from `market_sales` (not `closeout` listings) and `engine_sales` not from `godaddy_auctions_file`, with `retail.status: "no_data"` and no retail label when no such sale after D exists. Labels are reported side by side, never merged.
7. **Honest numbers.** Counts beside every rate; `too_small` when a label has fewer than 20 positives (ours + random); paired bootstrap of ours minus random (1,000 resamples, seeded, paired by position, both known), reporting `ours_win_share`, `tie_share`.
8. **Queue.** A run is a `replay_day_runs` row worked by an in-process worker, one at a time; `running` rows older than 30 minutes are queued again; `GET /replay/{date}` writes nothing.
9. No money, no outside call, nothing written but the run row. The D2 sealed rows are not read at all (R-6 is met by absence in v1).

## Tests (`tests/modules/ops/replay.test.ts`)
| ID | What |
|---|---|
| RPY81-1 | the step archives `.com` rows under the cap, all fields, gzip, name; cap is the setting; second run skips |
| RPY81-2 | an archive failure never fails the step (`archive.error`) |
| RPY81-3 | a sealed day with its raw zip is archived on the next run |
| RPY81-4 | `/health.archive` days, first, last, missing; retention does not delete the archive |
| RPY81-5 | `pickproofSeal` / `pickproofLabels` report off by default and run when enabled |
| RPY81-6 | a new pick day is not frozen while off (409 `PICKPROOF_STOPPED`); the datasave job still ends ok |
| RPY81-7 | `POST /replay/runs` auth, idempotency, validation, 404 `ARCHIVE_DAY_MISSING` |
| RPY81-8 | queue, worker, report read by READ and bots, list without report, error runs |
| RPY81-9 | `dry_run` answers the report and stores nothing |
| RPY81-10 | a run left `running` is queued again and finished |
| RPY81-11 | random group: same field, not our top N, reproducible, new seed draws others |
| RPY81-12 | the shortlist filters apply and are counted |
| RPY81-13 | point in time: picks, scores, parts, maximums of D identical with and without the D+1 file; only outcomes change |
| RPY81-14 | auction outcomes and bases; the tracker wins over the last archived row |
| RPY81-15 | retail: `no_data`, then labels from `market_sales` / `engine_sales` |
| RPY81-16 | closeouts: scoring without bids, RDAP pending then ready from stored tags |
| RPY81-17 | lift table as of D (model on or before D, else seed; never later) |
| RPY81-18 | paired bootstrap |
| RPY81-19 | counts beside rates; `too_small` under 20 positives; `did_well` features |
| RPY81-20 | `GET /replay/{date}`: newest finished run, `REPLAY_NOT_RUN`, `REPLAY_LOGIC_UNAVAILABLE`, no writes |
| RPY81-21 | picks for an unsealed day are 409 `PICKPROOF_STOPPED` |
