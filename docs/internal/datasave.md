# Daily data save (CR-071, v5.21.0; Dynadot uploads and auction endings v5.22.0)

Binding rules and test IDs for the `datasave` job. The interface is `docs/contract/jobs.md` (row `datasave`), `endpoints.md` (§Daily data saves) and `reports.md` (`DATASAVE_MISSED`).

## Where
- Job code: `src/modules/ops/jobs/datasave/` (`datasave.ts` = the eight steps (v5.23.0: `episodes`, `dqMarket`, rules in `market.md`; v5.28.0: `pickproofLabels` last (ninth step), rules in `pickproof.md`; v5.26.0: `scorePool` after the Dynadot steps, `closeouts.md`); `zip.ts` = streaming zip reader, no dependency; `json-stream.ts` = streaming reader of `{meta, data:[...]}`, no dependency). Wired in `src/app.ts` (`datasaveJob` of the `JobRunner`); plan in `ops/jobs/runner.ts` (job kind `datasave`, lock `job:datasave`).
- Retry: `ops/queue.ts` `retryDatasave` (run level `not_before`, set when the run is finalized and its `godaddyInventory` step failed; `claim()` skips a run whose `not_before` is in the future by the app clock; `enqueue` for an open waiting run clears `not_before`).
- Routes: `ops/api/snapshots.ts` (`GET /snapshots`, `GET /snapshots/missing`). Health value and report warning use `reporting/datasave-state.ts` (`datasaveStatus`, `missingDays`).
- Schedule: `.github/workflows/datasave.yml` (cron `0 15 * * *`).
- v5.22.0: `ops/jobs/datasave/dynadot-upload.ts` (service + zod schemas of `POST /snapshots/dynadot`), the route in `ops/api/snapshots.ts`; `DatasaveJob.parseAuctions` / `auctionSummary` in `datasave.ts`; the Dynadot health part in `reporting/datasave-state.ts` (`dynadotMissing`). Migration `1765400000000_v5-22-0.sql`: tables `dynadot_rows`, `godaddy_auctions`, `snapshot_manifests.origin` (+ source `dynadot_closed_auctions`), settings `datasave_dynadot_keep_days`, `datasave_auction_keep_days` (120).
- Tables (migration `1765300000000_v5-21-0.sql`): `snapshot_manifests` (write-once for `complete` rows, trigger `snapshot_manifest_guard`), `datasave_pool` (parsed closeouts, 3 days), `settings.datasave_*`, `job_queue_runs.not_before`.
- Env: `SNAPSHOT_DIR` (default `~/Library/Application Support/domain-trading/snapshots`; tests use a temp dir, `tests/helpers/env.ts`).

## Rules
1. Reads only the official host `https://inventory.auctions.godaddy.com/` (`metadata.json` then each file). No scraping of any web page, no paid data, no write to any venue. It uses the global `fetch` (a fixed official host, not a caller-chosen URL), so MSW covers it in tests; size cap 200 MB per file, 15-minute download timeout.
2. The data date of a file is the UTC date of its `LastModified` in `metadata.json`, never the run date. When `metadata.json` itself fails, the error manifests use the run's UTC date.
3. A `complete` manifest is sealed (`sealed_at`) and cannot change, except retention setting `raw_available=false` + `raw_deleted_at` (trigger). A sealed (source, data date, file) is skipped without fetching: step result `code: "SNAPSHOT_SEALED"`. There is no HTTP 409 (no write route). `error` and `partial` rows are open and replaced by the next attempt (`ON CONFLICT ... WHERE sealed_at IS NULL`).
4. Errors are not zeros: a failed fetch is `status error`, `http_status`, `rows null`. A parse failure is `partial`, `rows null`, the raw file is kept.
5. Only `closeout_listings.json.zip` is parsed (first `.json` entry if the name differs): `.com` only, price `<= datasave.pool_max_price_cents` (4000), not `isAdult`, valid `auctionEndTime`; price string to integer cents (`"$1,250"` = 125000). The other four files are fetched, hashed, kept raw only. Parsing deletes the day's existing pool rows first and inserts in batches of 5,000.
6. Raw zips live under `SNAPSHOT_DIR/godaddy_inventory/<data_date>/<file>`. If the folder can't be created, the job continues: hash only (closeouts go through a temp file that is removed), `raw_available false`, `raw_note` says why.
7. Retention (`snapshotRetention`): raw files with `data_date < today(UTC) - raw_keep_days (7)` are removed (a 7-day-old day stays); pool rows with `data_date < today - (pool_keep_days - 1)` are removed (3 data dates stay). Manifests are never deleted.
8. `/health.datasave`: `error` when the last run's `godaddyInventory` failed and no file is complete within 26 h; `partial` when it failed but some file is, or some files are complete and some not; `ok` when every configured file is complete within 26 h; `overdue` otherwise (also before the first run). `/report` `DATASAVE_MISSED` is raised only once a save or run exists. The Dynadot steps never count.
9. Retry once, 60 minutes after a failed `godaddyInventory` step; the retry run has params `{retry:true}` and never retries. A manual `POST /jobs/run datasave` while the retry waits starts it now.
10. `RAW_EXPIRED` (410) is reserved, not emitted: no route re-parses or re-downloads, and the job never fetches a past data date.

## Dynadot bot uploads (v5.22.0, R-8, R-9)
11. `POST /snapshots/dynadot` (bots or WRITE, non-money: `BOTS_ROUTES` `allowed`; a data or READ token is 403): `{kind, data_date, rows, final?, dry_run?}`, strict zod, prices integer cents (422 otherwise), 8 MB body, at most 50,000 rows a call. The audit row keeps `[n rows]` (`http/audit.ts` `elideRows`). The server never calls Dynadot.
12. One manifest per (source `dynadot_<kind>`, data_date, file `bot_upload`, `origin` `bot_upload`): `partial` while open, sealed (`complete`, sha256, `sealed_at`) by `final: true`. An upload for a sealed (kind, day) is 409 `SNAPSHOT_SEALED` and changes nothing; sealing an empty day is 422. All of a call runs in one transaction under the lock `dynadot_upload:<source>:<date>`; `dry_run` does the same and rolls back.
13. Aftermarket rows under 50000 cents are dropped and counted (`dropped_under_500_n`, alias `dropped_below_floor_n`). Dedupe: aftermarket by `listing_id`, the other kinds by domain, per day; the first row wins.
14. sha256 = SHA-256 of `JSON.stringify` of the day's stored rows sorted by domain then listing_id (collation C), keys in a fixed order per kind (`dynadot-upload.ts` `canonicalSha`).
15. Retention: `closeouts` rows follow `pool_keep_days` (3), the other kinds `datasave_dynadot_keep_days` (120). Manifests stay.
16. Health: a kind is watched only after its first upload ever; the due data date is today's UTC date from 16:00 UTC (the 15:00 run plus the 60-minute retry), else yesterday's. A due kind without a sealed upload makes `ok` into `partial` and is listed in `DATASAVE_MISSED` (`dynadot_missing`).
17. The `dynadotCloseouts` / `dynadotAftermarket` steps stay `not_configured` and add `bot_upload` for today's UTC date.

## GoDaddy auction endings (v5.22.0, R-10)
18. The four auction files of `datasave.godaddy_files` are streamed into `godaddy_auctions` (zip.ts + json-stream.ts): `.com`, not adult, a valid end time, and price >= 50000 cents now OR the domain is already followed (open row). A domain in several files merges (max bids, max price, latest end). At most one open row per domain (partial unique index); an ended row is history, a later auction of the same name is a new row. Storage rule (CR-075 Q1): nothing is kept for auctions that never reached $500.
19. Ending: when every configured auction file of the data date is `complete`, open rows with `last_seen < data_date` and `end_time <=` the files' Last-Modified become `ended = true, final_state_at = data_date`; `last_bid_count` and `last_price_cents` stay as the final state. With a failed or missing auction file nothing ends. A parse failure of an auction file is `partial` (rows null, error), never complete, and never blocks the closeouts. Read through `GET /snapshots?source=godaddy_auction_end&date=`.
20. Retention: ended rows by `final_state_at`, open rows by `last_seen`, `datasave_auction_keep_days` (120).
21. Step summary: `auctions_seen_n` (rows read this run), `tracked_n`, `ended_today_n`, `ended_now_n`, `auction_end_detection`.

## scorePool (v5.26.0, CR-072)
22. Step `scorePool` runs after `dynadotAftermarket` and before `buildPanel`. It processes the rows of `datasave_pool` and of sealed `dynadot_rows` (`kind closeouts`) with `scored_at` null: stores `filter_code` (first failed hard filter, null = passed), and for passed rows `score`, `model_version`, or `score_reason` (`NO_ACTIVE_MODEL`, `SCORE_FAILED`). Rules, order and tests: `docs/internal/closeouts.md`. Offline: the score uses `Scorer.scoreOffline` (no fetch, no registry ask). A Dynadot day is processed only when its `bot_upload` manifest is sealed, so a later upload is scored by the next run (the retry run or the next day).
23. Measured (local, synthetic 125,000 rows, 40,000 of them passing the filters): about 3.6 s for the whole step (classify 0.65 s, scoring 2,000 names about 0.08 s), so every passing row is scored; no row is skipped for time.

## Dynadot server key (not built)
No Dynadot key exists on the server (CR-003 left it out; DOM can't create one). `dynadotCloseouts` / `dynadotAftermarket` return `{source, status: "not_configured", reason}` and nothing else. When a key exists: closeouts = all pages, one call at a time at least 5 s apart, dedupe by domain, `price_cents` as given; aftermarket = at most 5 read-only calls, dollars to cents; both into manifests with `status`. Do not guess at Dynadot's API before then. The bots' upload route is built (v5.22.0, above).

## Tests
`tests/modules/ops/datasave.test.ts` and `tests/modules/ops/unit/datasave-stream.test.ts`; fixtures `tests/fixtures/datasave/` (a tiny synthetic zip in the real shape) and `tests/helpers/datasave.ts` (in-memory zip writer, MSW handlers for the inventory host).
| ID | What |
|---|---|
| DS521-1 | `priceToCents` ("$1,250" = 125000) |
| DS521-2 | streaming JSON reader: 1-byte chunks, braces/quotes/multibyte in strings, truncated document |
| DS521-3 | zip reader on a Python-made zip and an in-memory one; a non-zip is refused |
| DS521-4 | AT-1: 5 files complete with sha256, bytes, Last-Modified; only closeouts parsed (cents, .com, cap, not adult); raw on disk; health ok |
| DS521-5 | cap raised: "$1,250" kept at 125000 cents |
| DS521-6 | AT-3: 503 = error, http_status 503, rows null, health error, retry run queued with not_before +60 min |
| DS521-7 | the waiting retry starts on a new request, saves the day, no third run |
| DS521-8 | AT-4: nothing complete in 26 h = overdue, `DATASAVE_MISSED`; fresh database raises nothing in `/report` |
| DS521-9 | AT-5: second run, `SNAPSHOT_SEALED`, sha unchanged, nothing refetched; the trigger refuses update and delete |
| DS521-10 | AT-6: `GET /jobs/runs?job=datasave` per-step status and data_date |
| DS521-11 | AT-7: `gone_before_end_n` on a fixture pair of days |
| DS521-12 | AT-8: raw older than 7 days deleted, manifest stays, `raw_available false`, `raw_deleted_at` |
| DS521-13 | AT-9: only the currently published files are fetched; no re-download route |
| DS521-14 | Dynadot steps `not_configured`, run and health unaffected |
| DS521-15 | pool rows older than 3 days pruned, manifests stay |
| DS521-16 | unwritable snapshot folder; unparseable closeouts = partial |
| DS521-17 | `GET /snapshots/missing` and query validation |
| DS521-18 | health partial with one failed file |
| DS521-19 | settings defaults |
| DS521-20 | FILE_NOT_LISTED and SIZE_CAP errors |

v5.22.0 tests: `tests/modules/ops/datasave-dynadot.test.ts`.
| ID | What |
|---|---|
| DS522-1 | AT-10: aftermarket in two parts then final; sha256 of the canonical rows; no duplicate listing_id; >= $500; origin bot_upload |
| DS522-2 | AT-11: closed auctions keep bid_count and final_price_cents; sealed |
| DS522-3 | AT-13: upload after seal is 409 SNAPSHOT_SEALED, nothing changes; rows under $500 dropped and counted |
| DS522-4 | strict validation: non-integer price, unknown key, bad or future date, empty upload: 422 |
| DS522-5 | dry_run stores nothing; a sealed day still 409 |
| DS522-6 | bots and WRITE tokens allowed, READ 403, Idempotency-Key required and replayed |
| DS522-7 | the audit row keeps only the row count |
| DS522-8 | retention of uploaded rows (3 days closeouts, 120 days others) |
| DS522-9 | health and DATASAVE_MISSED quiet before the first upload, flagged after 16:00 UTC once started |
| DS522-10 | the Dynadot steps stay not_configured and report the bot upload |
| DS522-11 | AT-12: a $500+ auction is tracked, a $40 one and a .net are not; absent after its end: ended with the last bid count and price |
| DS522-12 | 0-bid ending; a tracked auction under $500 stays tracked; merge of several files |
| DS522-13 | an absent auction whose end has not come stays open |
| DS522-14 | auction file parse failure is partial; closeouts still seal; nothing ends |
| DS522-15 | retention of ended and stale open auctions |
| DS524-1 | coverage stored on a sealed upload, frozen by the seal guard (AT-14) |
| DS524-2 | invalid coverage 422, missing coverage null (AT-15) |
| DS532-1 | BUG-051: 50,000 rows pass, 50,001 is `ROWS_LIMIT`, a price over the cap is `PRICE_CAP` with indexes, the cap is inclusive, nothing stored, OpenAPI shows both |

v5.26.0 tests: `tests/modules/ops/closeouts.test.ts` (CC526-*, table in `closeouts.md`).
