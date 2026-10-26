# Daily data save (CR-071, v5.21.0; Dynadot uploads and auction endings v5.22.0)

Binding rules and test IDs for the `datasave` job. The interface is `docs/contract/jobs.md` (row `datasave`), `endpoints.md` (§Daily data saves) and `reports.md` (`DATASAVE_MISSED`).

## Where
- Job code: `src/modules/ops/jobs/datasave/` (`datasave.ts` = the eight steps (v5.23.0: `episodes`, `dqMarket`, rules in `market.md`; v5.28.0: `pickproofLabels` last (ninth step), rules in `pickproof.md`; v5.26.0: `scorePool` after the Dynadot steps, `closeouts.md`); `zip.ts` = streaming zip reader, no dependency; `json-stream.ts` = streaming reader of `{meta, data:[...]}`, no dependency). Wired in `src/app.ts` (`datasaveJob` of the `JobRunner`); plan in `ops/jobs/runner.ts` (job kind `datasave`, lock `job:datasave`).
- Retry: `ops/queue.ts` `retryDatasave` (run level `not_before`, set when the run is finalized and its `godaddyInventory` step failed; `claim()` skips a run whose `not_before` is in the future by the app clock; `enqueue` for an open waiting run clears `not_before`).
- Routes: `ops/api/snapshots.ts` (`GET /snapshots`, `GET /snapshots/missing`). Health value and report warning use `reporting/datasave-state.ts` (`datasaveStatus`, `missingDays`).
- Schedule: `.github/workflows/datasave.yml` (cron `0 15 * * *`; GitHub starts it 3-4 hours late). v5.46.0: the Mac host starts it at 15:05 UTC itself, `scripts/local-host/datasave-trigger.sh` through the LaunchAgent `com.domaintrading.datasave` (hourly at :05, the script decides by the UTC clock; same Idempotency-Key as the workflow; runbook "Local host"). GitHub stays as the backup.
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
16. Health (v5.50.0, P8: a kind is also quiet when none was sealed in the last 3 days, test DS550-1): a kind is watched only after its first upload ever; the due data date is today's UTC date from 16:00 UTC (the 15:00 run plus the 60-minute retry), else yesterday's. A due kind without a sealed upload makes `ok` into `partial` and is listed in `DATASAVE_MISSED` (`dynadot_missing`).
17. The `dynadotCloseouts` / `dynadotAftermarket` steps stay `not_configured` and add `bot_upload` for today's UTC date.

## GoDaddy auction endings (v5.22.0, R-10)
18. The four auction files of `datasave.godaddy_files` are streamed into `godaddy_auctions` (zip.ts + json-stream.ts): `.com`, not adult, a valid end time, and price >= `settings.datasave_auction_min_cents` (5.41.0; default 10000 = $100, CHECK >= 100, migration only; was the fixed 50000) now OR the domain is already followed (open row). A domain in several files merges (max bids, max price, latest end). At most one open row per domain (partial unique index); an ended row is history, a later auction of the same name is a new row. Storage rule (5.41.0): nothing is kept for auctions that never reached `datasave_auction_min_cents`. `market_names` keeps its own $500 floor (`market/common.ts` `MIN_CENTS`, `market.md` rule 1): the market code filters `godaddy_auctions` by `MIN_CENTS` itself, so the lower floor adds no market rows.
19. Ending: when every configured auction file of the data date is `complete`, open rows with `last_seen < data_date` and `end_time <=` the files' Last-Modified become `ended = true, final_state_at = data_date`; `last_bid_count` and `last_price_cents` stay as the final state. With a failed or missing auction file nothing ends. A parse failure of an auction file is `partial` (rows null, error), never complete, and never blocks the closeouts. Read through `GET /snapshots?source=godaddy_auction_end&date=`.
20. Retention: ended rows by `final_state_at`, open rows by `last_seen`, `datasave_auction_keep_days` (120).
21. Step summary: `auctions_seen_n` (rows read this run), `tracked_n`, `ended_today_n`, `ended_now_n`, `auction_end_detection`.

## In-range auctions with bids (v5.37.0)
29a. `parseAuctions` also fills `godaddy_auctions_live` in the same stream pass: `.com`, not adult, valid end time, `numberOfBids >= settings.datasave_auction_live_min_bids` (1) and price not null and `<= settings.s8_max_price_cents` (read at run time, never hard-coded, so the band follows the cap). Per row: end time, type, price, bids, `domainAge`, `valuation` (price string to cents), `pageviews` (absent, negative or over int4 = null). It does not change `godaddy_auctions` (the $500+ followed rows), the closeouts pool, episodes or pick-proof.
29b. Merge: a domain in several rows or files keeps the highest price and bid count, the latest end time and the first non-null type, age, valuation and pageviews. The four files are parsed one after the other for the same data date, so rows are upserted on (data_date, domain) with `greatest()`/`coalesce()`, never delete-then-insert; running a day again adds nothing. Batches of 5,000.
29c. Step summary adds `live_kept_n` (rows upserted this run across the files) and `live_band_max_cents`. Retention (`snapshotRetention`): rows with `data_date < today(UTC) - datasave_auction_live_keep_days` (7) are deleted (not append-only); the summary adds `auctions_live_cutoff_date`, `auctions_live_deleted`. The table is not in the backup. Read by `GET /auctions/live` (`market.md`).

## Engine feed (v5.41.0)
30. Step `engineFeed` runs after `buildPanel` (eleven steps; before `pickproofSeal`). It reads the tag rows and the ended auctions, then calls the engine's `storeUnsold` / `storeSales` (`ops` imports `engine/index.ts`): `by` = `datasave`, one `engine_uploads` row per kind per run (none when there is nothing new), multi-row inserts in chunks of 2,000, at most 20,000 rows per kind per run (the rest next day). The DB size guard (`guardDbSize`, 70% of 1 GB, same limit as the engine uploads) runs before each insert: over it the step stores nothing and says `status: db_size_high`.
- Step `auctionShortlist` runs after `engineFeed` (twelve steps; before `pickproofSeal`; step timeout 15 minutes): the daily shortlist of the best live GoDaddy auctions, endings fetch and automatic pre-bid. Rules, score and test ids: `docs/internal/auctions.md` "Shortlist" (AS545-*).
31. Unsold: `disappearances` rows with `source = godaddy_closeouts`, `tag = deleted`, a `.com` name, with no `engine_unsold` row for that (domain, `gone_date`). `observation_date` = `gone_date` (the day the name was seen missing; the RDAP check may be days later, and a point-in-time feature must not use a later date), type `dropped_after_held`, `caught_by_catcher` = true for `RE_REGISTERED`, false for `NOT_REGISTERED`, null for `STATUS:*`. Only the GoDaddy feed: Dynadot closeouts and market episodes are not fed.
32. Sold: `godaddy_auctions` rows with `ended`, `last_bid_count >= 1`, `last_price_cents >= datasave_auction_min_cents`, a `.com` name, and no `engine_sales` row of that name within 20 days of the end day (Israel). `price_cents` = `last_price_cents`, `sale_date` = the end day in Asia/Jerusalem, venue `godaddy`, source `godaddy_auctions_file`, `source_url` = `https://inventory.auctions.godaddy.com/metadata.json`. These are mostly investor-to-investor sales; `source` marks them for later separation (`engine.md`).
33. Regime priority: `buildPanel` loads the engine's regime test (`engine/regime.ts` `loadRegimeTest`) and `tagDisappearances` sorts the due names with in-regime names first (stable inside each group), so the daily cap (`disappearance_lookups_max_per_run`, 1,500) is spent on names the engine can train on. `tags.regime_due_n` counts them. If the test cannot be loaded the plain order is used.
34. Summary: `unsold_inserted_n`, `sales_inserted_n`, `skipped_dup_n` (already in the engine: unsold with the same domain and day, sales within 20 days, plus duplicates inside the call), `regime_n` (rows offered that are in the regime), `unsold_candidates_n`, `sales_candidates_n`, `rejected_n`, `unsold_upload_id`, `sales_upload_id`, `auction_min_cents`, `db_bytes_before` (null without the guard), `status` (`ok` | `db_size_high`).
35. Expected yield (from the code's numbers): unsold rows per day = the closeout names that left the list early that day and are RDAP `deleted`; the RDAP cap is 1,500 live lookups a day (about 6 minutes at 250 ms), so at most 1,500 new tags a day, in-regime first; the first run backfills every stored day pair of the 3-day pool. Sold rows per day = ended auctions with a bid at $100+ (the file lists tell the real count after the first run: `ended_today_n` and `sales_candidates_n`). The real figures are in the first runs' summaries.
- **Auction ends (v5.50.0, P6):** third part of `engineFeed`, after the sales: ended in-range auctions under the sold line with >= 1 bid go to `engine_auction_ends` (bands opening / low / mid); step result `auction_ends_candidates_n`, `auction_ends_inserted_n`. Rules and tests (EN-110..EN-112): `engine.md` "Auction ends".

## scorePool (v5.26.0, CR-072)
22. Step `scorePool` runs after `dynadotAftermarket` and before `buildPanel`. It processes the rows of `datasave_pool` and of sealed `dynadot_rows` (`kind closeouts`) with `scored_at` null: stores `filter_code` (first failed hard filter, null = passed), and for passed rows `score`, `model_version`, or `score_reason` (`NO_ACTIVE_MODEL`, `SCORE_FAILED`). Rules, order and tests: `docs/internal/closeouts.md`. Offline: the score uses `Scorer.scoreOffline` (no fetch, no registry ask). A Dynadot day is processed only when its `bot_upload` manifest is sealed, so a later upload is scored by the next run (the retry run or the next day).
23. Measured (local, synthetic 125,000 rows, 40,000 of them passing the filters): about 3.6 s for the whole step (classify 0.65 s, scoring 2,000 names about 0.08 s), so every passing row is scored; no row is skipped for time.

## Disappearance tags (v5.34.0, BUG-052)
24. `buildPanel` first calls `ops/closeouts/disappearances.ts` `tagDisappearances`. Collect: for every pair of consecutive stored days of `datasave_pool` (GoDaddy closeouts) and of sealed `dynadot_rows` closeouts uploads, a name on the earlier day with `ends_at` after the start of the later day and missing from the later day gets a `disappearances` row (`gone_date` = the later day, `prev_date` = the earlier). Every `market_names` row with `outcome_rule = DISAPPEARED` gets one too (`gone_date` = `last_seen` + 1, `episode_id`); a row whose episode is no longer DISAPPEARED (or whose `last_seen` moved) is deleted. Insert is `on conflict do nothing`, so the first run is the backfill (R-5) and later runs add only new pairs.
25. Baseline (R-3): an `rdap_cache` row with `registered` true and `checked_at` before `gone_date` (`baseline_source rdap_cache`), else the feed's registrar (`feed`: GoDaddy, family regex `godaddy|wildwestdomains` after removing non-letters; Dynadot `dynadot`). Episodes have no feed registrar: no cache row means `NO_BASELINE`.
26. Rule `tagOf` (R-2), in order: 404 → `deleted NOT_REGISTERED`; RDAP error → `unknown <reasonCode>`; a status with redemption / pending delete (`core/rdap.ts` `dropStatusOf`, also used by `pickproofLabels`) → `deleted STATUS:<status>`; created after `prev_date` → `deleted RE_REGISTERED`; no baseline → `unknown NO_BASELINE`; no registrar in RDAP → `unknown NO_REGISTRAR`; registrar outside the baseline (feed: family regex; cache: same name after removing non-alphanumerics) → `bought REGISTRAR_CHANGED:<before> -> <now>`; else `unknown SAME_REGISTRAR`. Verisign .com RDAP is thin (no registrant), and its `last changed` event moves on any update (renewal by the registrar, a status change), so there is no owner-change signal: bought rests on a registrar change only (Q1).
27. Lookups: a name not ending in `.com` is `unknown TLD_NOT_CHECKED`, final, without a lookup. Due = not final and not checked today (UTC), ordered never-checked first, closeouts before episodes, newest `gone_date` first. A cache answer counts only if `checked_at` is after the start of `gone_date` and inside `lookups_rdap_ttl_hours`; otherwise a live `rdapLookup` (250 ms apart) that fills the cache. At most `settings.disappearance_lookups_max_per_run` (1,500) live lookups (stop `CAP`); a 429 stops (`RATE_LIMITED`). Not counted in `lookup_usage`: the bots' rolling limit (200 a day) is for bot calls only (CR-074), and sharing it would starve both (G-118).
28. Final: `bought`, `deleted`, `TLD_NOT_CHECKED` at once; an `unknown` once 7 days have passed since its first check (R-4). Rows older than `settings.disappearance_keep_days` (120) after `gone_date` are deleted by the same call.
29. `buildPanel` then splits `gone_before_end_n` with `goneByTag` (rows of `godaddy_closeouts` with `gone_date` = the latest day: the same set as the count), adds `dynadot` (the two latest sealed uploads) and `tags` (the run summary). `GET /market/episodes` reads the tag by `episode_id` (`market/read.ts`). Step timeout 25 minutes (`runner.ts`).

## Closeout expiries (v5.46.0)
30. The unsold feed of v5.41.0 took only names that left the list **before** their end. A closeout nobody buys stays to its end date, so that gave 0 rows on the first live run. `buildPanel` now also calls `ops/closeouts/expiries.ts` `checkExpiries` after `tagDisappearances` (what the tags left of the shared 1,500 lookups). Table `closeout_expiries` (migration `1767100000000_v5-46-0.sql`, not in the backup): one row per (name, end time).
31. Collect: GoDaddy closeout pool rows (`.com`, in the engine's regime when the regime test loaded) whose end is already past or inside the next `datasave_pool_keep_days` days, while the pool still holds them (it keeps only 3 days); `on conflict do nothing`. `ends_on` = the end day in Israel.
32. Check: due from `ends_on + closeout_expiry_wait_days` (3), again every `closeout_expiry_recheck_days` (7) until decided or `closeout_expiry_max_days` (80) after the end; never-checked first, regime names first, through the shared RDAP cache and the Verisign host pacer; the cap is what `tags` left of `disappearance_lookups_max_per_run`. A name with a `disappearances` row at or before its end day (left the list early) is not here. Rule `expiryTagOf`: 404, a redemption / pending-delete status, or a registration created after the end = `dropped` (final; caught true only for the new registration); expiry date moved more than 90 days past the end = `held` (renewed or bought, final); otherwise `pending`, `unknown` at the max day. An RDAP error is not a check (asked again next run).
33. `engineFeed` writes `dropped` rows to `engine_unsold` (`dropped_after_held`, `observation_date` = `ends_on`), once (`fed_at`). Rows are pruned `disappearance_keep_days` after the end day. Details and the yield estimate: `closeouts.md` "Closeout expiries"; tests FX546-1..6.

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
| EF541-1..8 | `tests/modules/ops/engine-feed.test.ts`: unsold feed and caught flags, dedupe and no empty uploads, regime-first cap, sales feed (Israel end day, floor), the engine 20-day rule, `datasave_auction_min_cents` (default, CHECK, `parseAuctions`), DB size guard, upload id moves |
| DS521-17 | `GET /snapshots/missing` and query validation |
| DS521-18 | health partial with one failed file |
| DS521-19 | settings defaults |
| BG052-1 | AT-1: redemptionPeriod → deleted, reason names the status (`ops/disappearances.test.ts`) |
| BG052-2 | AT-2: pendingDelete, "pending delete", 404 → deleted |
| BG052-3 | AT-3: other registrar, active → bought; rdap_cache baseline used |
| BG052-4 | AT-4: same registrar / GoDaddy family → unknown, never bought; checked again next day |
| BG052-5 | AT-5: timeout, 5xx, cap → unknown, step ok, retried for 7 days then final; 429 stops |
| BG052-6 | AT-6: backfill over stored day pairs, retagged 3 / unknown 2, second run changes nothing |
| BG052-7 | AT-7: split sums to gone_before_end_n (GoDaddy and Dynadot); `/market/episodes` disappearance_tag |
| BG052-8 | RE_REGISTERED, NO_BASELINE, NO_REGISTRAR; a non-.com name is not looked up |
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

v5.37.0 tests: `tests/modules/ops/datasave.test.ts`.
| ID | What |
|---|---|
| DS537-1 | a $40 auction with 3 bids and a $250 one with 1 bid are kept with age, valuation, pageviews; 0 bids, $250.01, .net, adult are not; `godaddy_auctions` ($500+) unchanged |
| DS537-2 | the same domain in two auction files merges (max bids and price); a second run does not duplicate |
| DS537-3 | raising `settings.s8_max_price_cents` widens the band on the next run |
| DS537-4 | retention removes live rows older than `datasave_auction_live_keep_days` |

v5.26.0 tests: `tests/modules/ops/closeouts.test.ts` (CC526-*, table in `closeouts.md`).

## Mac trigger (v5.46.0)
`scripts/local-host/datasave-trigger.sh` (LaunchAgent `com.domaintrading.datasave`, `StartCalendarInterval` minute 5 of every hour, local time): exits at once before 15:00 UTC or when `~/.local/share/domain-trading-host/datasave-last-trigger` holds today's UTC date or the host is `PAUSED`; otherwise reads `JOB_TRIGGER_TOKEN` (and `LOCAL_HOST_PORT`, default 3100) from `prod.env` itself, checks `GET /health/ping`, and posts `{"job":"datasave"}` with `Idempotency-Key: datasave-<15:00 UTC in ms>` (the token travels in a private header file, not on the command line). Only a 202 writes the marker. Checked by hand against a local stub server (the repo has no shell-level test pattern); manual check in the runbook.

## Batching (v5.42.0)
Disappearance tags: one cache read for all due names (each row's TTL applied in code), the first live lookup alone (a 429 stops the run before more are sent), then 4 at a time through the Verisign host pacer (250 ms between starts); tag updates go out in batches of 300 and cache answers in one multi-row upsert; the cap counts a lookup when it is claimed, so it is exact. Test BK542-3 (313 queries before, 13 after for 100 lookups). v5.46.0: the expiry check uses the same batches (BK-style: one cache read, one unnest update per 300, one insert per 5,000).
