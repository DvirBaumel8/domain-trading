# Daily data save (CR-071, v5.21.0)

Binding rules and test IDs for the `datasave` job. The interface is `docs/contract/jobs.md` (row `datasave`), `endpoints.md` (§Daily data saves) and `reports.md` (`DATASAVE_MISSED`).

## Where
- Job code: `src/modules/ops/jobs/datasave/` (`datasave.ts` = the five steps; `zip.ts` = streaming zip reader, no dependency; `json-stream.ts` = streaming reader of `{meta, data:[...]}`, no dependency). Wired in `src/app.ts` (`datasaveJob` of the `JobRunner`); plan in `ops/jobs/runner.ts` (job kind `datasave`, lock `job:datasave`).
- Retry: `ops/queue.ts` `retryDatasave` (run level `not_before`, set when the run is finalized and its `godaddyInventory` step failed; `claim()` skips a run whose `not_before` is in the future by the app clock; `enqueue` for an open waiting run clears `not_before`).
- Routes: `ops/api/snapshots.ts` (`GET /snapshots`, `GET /snapshots/missing`). Health value and report warning use `reporting/datasave-state.ts` (`datasaveStatus`, `missingDays`).
- Schedule: `.github/workflows/datasave.yml` (cron `0 15 * * *`).
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

## Dynadot (TODO, not built)
No Dynadot key exists on the server (CR-003 left it out; DOM can't create one). `dynadotCloseouts` / `dynadotAftermarket` return `{source, status: "not_configured", reason}` and nothing else. When a key exists: closeouts = all pages, one call at a time at least 5 s apart, dedupe by domain, `price_cents` as given; aftermarket = at most 5 read-only calls, dollars to cents; both into manifests with `status`. Do not guess at Dynadot's API before then. Gavriel's proposal of a bot-side upload route `POST /snapshots/dynadot` (CR-071, 21 Oct 2026 notes) is open and not built.

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
