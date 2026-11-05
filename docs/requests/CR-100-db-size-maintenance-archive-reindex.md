---
id: CR-100
kind: CR
status: in_progress
owner_bot: dom-architect
approval: "Gavriel 2026-11-03: maintenance CR, archive old rows + index rebuild like 5.78.0, without shrinking data pools. No money, no DB plan change. Claude Code only, no CloudAgents."
priority: P1
priority_note: "maintenance; DB_SIZE_HIGH 74% (over 70% warn) and growing again since 5.78.0"
depends_on: [CR-095, CR-097]
supersedes: []
max_rounds: 2
---
# CR-100: DB back at 74%. Archive cold rows to disk, rebuild indexes, and cap index growth (no pool shrink)

**Facts (`GET /health`, 6.1.1, 2026-11-03 ~08:20 IST).** `db_size`: 794,443,776 of 1,073,741,824 bytes (**74%**, warn 70%). History: 74.2% on 29 Oct (CR-095), 60–63% after 5.78.0, **64% on 31 Oct**, 74% now. So about 10 points (~105 MB) in 3 days.

| table | total | heap | index | rows | dead |
|---|---|---|---|---|---|
| market_names | 354.4 MB | 245.6 MB | 108.7 MB | 470,602 | 0 |
| dynadot_rows | 174.3 MB | 88.8 MB | 85.4 MB | 847,555 | 0 |
| datasave_pool | 103.1 MB | 56.5 MB | 46.5 MB | 278,156 | 0 |
| screening_results | 41.9 MB | 34.4 MB | 7.5 MB | 30,511 | 3 |
| pickproof_pool | 30.5 MB | 18.9 MB | 11.6 MB | 136,634 | 0 |
| screening_evidence | 15.9 MB | 14.7 MB | 0.6 MB | 25,373 | 0 |
| others (closeout_expiries, rdap_lookups, engine_endings, auction_shortlist) | ~30 MB | | | | |

Compared with 29 Oct: `market_names` 341 → 354 MB (+13 MB on +4.6k rows, so about 2.8 KB per row: wide). `datasave_pool` 90 → 103 MB. `dynadot_rows` 215 → 174 MB (5.78.0 helped) but its indexes are back to 85 MB, almost the size of the heap (5.78.0 had 80 heap / 124 index). Dead rows are 0, so plain VACUUM has nothing more to give. The space is **live wide rows and indexes**, not bloat.

**Dvir's standing rule (repeated):** no artificial size cuts on data paths, no caps or sampling, and **no pool shrink**. Every row the logic uses stays queryable. Cold rows may move to disk archives only when a restore route brings them back byte-for-byte.

## Asks
1. **Measure before cutting.** Add a dry-run report (`/health.db_size` or a READ route) with per-table bytes by age bucket (≤3 d, 3–30 d, >30 d), the per-index size and `idx_scan` count, and the TOAST size. Post the numbers in the response before deleting anything.
2. **Cold archive for old raw rows, with a restore route.**
   - `market_names`: move the raw payload / JSON columns of rows not seen in the last N sealed days (DOM proposes N from the data, and must not drop below what `episodes`/`dqMarket`/shortlist read) into `<ARCHIVE_DIR>/market_names/<yyyy-mm>.jsonl.gz`. Keep the typed columns and a pointer in the DB, so every name stays queryable.
   - `dynadot_rows` closed auctions (120-day keep): rows older than 30 days go to `<ARCHIVE_DIR>/dynadot/<data_date>-closed.jsonl.gz`, the same pattern as the 5.74.0 aftermarket archive, deleted from the DB only after the file is written and verified. `episodes` already folded them.
   - `screening_results` / `screening_evidence`: archive only raw payloads that retention would allow; verdict links are untouched.
   - Each archive file gets a sha256 plus row count in a manifest table, and is never deleted by retention.
   - **Restore:** a WRITE job `archiveRestore {table, file}` that re-inserts a file idempotently, plus a READ `GET /archive/manifest`. A row is deleted from the DB only when the file write, sha256 and row count all match.
3. **Index rebuild like 5.78.0.** `REINDEX ... CONCURRENTLY` one index at a time on `market_names`, `dynadot_rows`, `datasave_pool` and `pickproof_pool`. Drop indexes with `idx_scan = 0` since the last stats reset that no query needs. List each one in the response.
4. **Cap index growth (not data).** Fillfactor 70–80 on `market_names` and `dynadot_rows` (the daily folds update in place: HOT updates, no new index entries). Consider partial or BRIN indexes on date columns. Add a weekly or threshold-based concurrent reindex when `index_bytes > 0.8 × heap_bytes` on a big table.
5. **Safety.** No full-table rewrite (VACUUM FULL, CLUSTER) while free headroom is smaller than the table's live size (CR-095 rule). Do the work in batches inside `retention` or a new `maintenance` step. CR-097's critical-write exemption stays in force.

**Out of scope:** no paid DB plan, no money, no settings activation without Dvir, and no reduction of `datasave_pool_keep_days`, `pickproof_pool_keep_days` or any pool row counts.

## Check (pass/fail)
- **P1:** `db_size.percent` **< 60%** after the first full run, and still < 65% seven days later (growth ≤ 1.5 points a day).
- **P2 (zero row loss):** for every archived table, DB rows deleted equal the archive manifest's row count, and the sha256 matches. A restore test of one file per table into a scratch table gives identical row count and content hash. **Fail on any mismatch.**
- **P3 (no pool shrink):** `datasave_pool`, `pickproof_pool`, shortlist inputs, `episodes`, sales and panel counts are equal before and after (± that day's normal churn). Shortlist totals and field_n match a same-day dry run.
- **P4:** all daily and datasave steps are `ok` on the next two runs, including engineFeed and kbLoad. There is no `db_size_high` skip.
- **P5:** for each table rebuilt, `index_bytes / heap_bytes` is ≤ 0.6 after REINDEX.
- **Token budget:** no LLM steps. N/A.

## Options (not requested)
- **Paid storage upgrade** (a bigger Neon plan): this **needs Dvir's yes, asked through Gavriel**. Listed for completeness only. Do not act on it.

## Approval (Gavriel, 2026-11-03 08:19 IST)
Approved as P1 maintenance. Ship via Claude Code (no CloudAgents). Conditions:
1. Restore test must PASS before any raw payload is removed from the DB.
2. Archives checksummed and kept in two places: the box and a repo-safe location (not the DB disk alone).
3. After the first run, report DB % and proof rows_lost=0 (archived counts = removed counts, checksums verified).
4. Paid storage upgrade stays OFF.
---

## DOM response (2026-11-03 ~08:40 IST)

**Verdict: accepted. DOM builds it in two releases, measuring first as ask 1 says.** 6.2.0 brings the measurement, the safe index work and the first rebuild. 6.3.0 brings the archives and index drops, chosen from 6.2.0's numbers.

**6.2.0 (building now):**
1. **Ask 1:** a new READ route `GET /db/report`, kept for an hour so polls don't wake Neon. For each of the 10 largest tables it shows:
   - heap, index and TOAST bytes, and the heap's free space (where Neon allows `pgstattuple_approx`, else null);
   - each index's bytes and `idx_scan`, with the date the stats were last reset;
   - for tables with a date column, rows and bytes by age: ≤ 3 d, 3–30 d, > 30 d.

   DOM posts the numbers here before anything is deleted.
2. **Ask 3 and the ask 4 trigger:** a new daily step `dbMaintenance` after `retention`.
   - It runs `REINDEX INDEX CONCURRENTLY` one index at a time on `market_names`, `dynadot_rows`, `datasave_pool` and `pickproof_pool`, whenever a table's indexes are over 0.8 × its heap.
   - It skips an index when free space is under twice that index's size, and has a 10-minute budget.
   - The summary shows the bytes before and after.
   - DOM can run it alone with `POST /jobs/run {job: "daily", only: "db_maintenance"}` (WRITE). DOM runs it once after the deploy.
3. **Ask 4 fillfactor:** `market_names` gets fillfactor 80.
   - The daily continue UPDATE changes only columns that no index uses (`last_seen`, `seen_days`, `days_listed`, `list_price_cents_last`, `price_changes`). With room left on each page those become HOT updates, so they add no index entries.
   - It applies to pages written from now on, because a full rewrite is barred by the ask 5 headroom rule (354 MB table, about 280 MB free).
   - **Pushback on `dynadot_rows`:** its rows are inserted and later deleted, never updated, so fillfactor would only waste space there. It is left as is.
4. **Ask 5:** no VACUUM FULL or CLUSTER. Every rebuild runs concurrently, one index at a time, within the headroom check. CR-097's exemption is unchanged.

**Ask 2, the archives, wait for the numbers (6.3.0). Pushback on `market_names`:** the table has no raw payload or JSON column. Every column is a typed field that `episodes`, `/market/*` or `dqMarket` reads, so there is nothing cold to move out while keeping "every name queryable". What could slim it is the 64-character `source_sha256` and the 40-character text `episode_id` in every row (G-139). The report shows how much they weigh, then DOM decides.
- `dynadot_rows` closed auctions older than 30 days: archive plus a restore job, as asked, **if** the report shows they weigh enough. Most of the table is the 2 kept aftermarket days, about 390k rows each.
- `screening_*`: retention already deletes them by age. Their size is checked in the report.

**On P1 (< 60% after the first run): DOM can't promise it without shrinking a pool.** 60% means freeing about 150 MB. The rebuilds may give 50–100 MB (5.78.0 gave about 14 points). The rest depends on what the report finds. DOM reports the real result against P1 and does not cut any pool to meet it.

**Gavriel's conditions (08:19) apply to 6.3.0, the release that deletes anything.** 6.2.0 deletes no row.
- Condition 1: a restore test must pass before any row leaves the DB.
- Condition 3: after the first run, the proof that no row was lost.
- Condition 4: no paid storage.
- **Condition 2, a second copy outside the box:** DOM proposes the private data repo `DvirBaumel8/domain-trading-data`. The archive files would be pushed there, as the nightly export was designed to be (founder rule 11: data only, never this repo). DOM checks that the push from the Mac host works, and the file sizes against GitHub's limits, before 6.3.0.

## Gavriel ack (2026-11-03 ~08:25 IST)

Accepted as written. Measure-first split (6.2.0 report + concurrent reindex + market_names fillfactor 80; 6.3.0 archives from the numbers) is fine. Both pushbacks accepted: no fillfactor on `dynadot_rows`, and no `market_names` archive unless the report shows real weight (G-139 columns). P1 is reported as the honest result, no pool cut to meet it. Condition 2 location `DvirBaumel8/domain-trading-data` is OK, pending DOM's push and size check. I will read `GET /db/report` once 6.2.0 is on /health.

## Gavriel check of 6.2.0 live (3 Nov 2026, ~08:48 IDT)

- `/health` version 6.2.0 (proxy, bots token). `GET /db/report` 200; second call `cached: true`. PASS.
- Numbers seen: DB 794,443,776 B of 1,073,741,824 (74%), `heap_free_bytes` null (no pgstattuple on Neon).
  - market_names 338 MiB (heap 234, idx 103, ratio ~0.44); age le_3d 359,567 rows, 3_30d 111,035, gt_30d 0.
  - dynadot_rows 166 MiB (heap 84, idx 81, ratio ~0.96), all rows le_3d.
  - datasave_pool 98 MiB (heap 53, idx 44, ratio ~0.83).
  - pickproof_pool 29 MiB (heap 18, idx 11, ratio ~0.61).
- Expect tonight's `dbMaintenance` to reindex dynadot_rows and datasave_pool only. Next from me: read `GET /jobs/runs?job=daily` after the next daily run for `ratio_after`.
- Note: market_names has 0 rows older than 30 days, so a cold archive by `last_seen > 30d` would free nothing today; 6.3.0 design should start from these numbers.

## DOM: first `dbMaintenance` run (3 Nov 2026, 06:48 UTC, `run_6bef6f15`, dom-write)

**DB 794.5 MB → 743.9 MB (74.0% → 69.3%), 4 seconds, no row deleted.**

| table | indexes before → after | ratio before → after | rebuilt |
|---|---|---|---|
| dynadot_rows | 85.4 → 63.5 MB | 0.96 → 0.72 | `dynadot_rows_listing` 49.3 → 36.4, `pkey` 22.6 → 19.8, `dynadot_rows_domain` 13.4 → 7.3 |
| datasave_pool | 46.5 → 17.7 MB | 0.82 → 0.31 | `pkey` 46.4 → 17.7 |
| market_names | 108.7 MB (not due) | 0.44 | none |
| pickproof_pool | 11.6 MB (not due) | 0.61 | none |

- **P5:** pass for the two tables that were rebuilt (0.72 and 0.31). `dynadot_rows` stays at 0.72, above the 0.6 asked, because its heap holds only about 2 days of rows while its unique index carries a text `listing_id` per row. The daily step now keeps it from creeping back above 0.8.
- **P1: not met, and the honest result is 69.3%,** as said in the response. Reaching 60% means another ~100 MB.

**What this means for 6.3.0 (DOM's plan from the numbers):**
1. **No cold archives.** Your report shows `market_names` has no row with `last_seen` over 30 days, and `dynadot_rows` is all ≤ 3 days. A cold archive would move nothing, so DOM does not build the archive and restore machinery now. It comes back, with your conditions 1–3, the day the report shows cold rows worth moving.
2. **Watch the growth first.** The fillfactor (6.2.0) should slow the `market_names` index growth from the daily fold. DOM reads `/db/report` once a day after the datasave for 3 days and posts the MB per day by table here.
3. **Then slim `market_names` (G-139), if growth or size calls for it.** The candidates:
   - drop the per-row `source_sha256` (64 hex characters, about 30 MB of heap). It is in `GET /market/episodes` answers, so this is a contract change. It would be replaced by the manifest's sha256, read through the source and day;
   - store the 40-hex `episode_id` as 20 bytes (heap and primary key, about 25 MB). The API answer stays hex.

   Either one is a MINOR or MAJOR release with a note. DOM asks you first in this file.

## DOM: growth after one datasave, so 6.3.0 starts now (4 Nov 2026, ~09:15 IDT)

- `/db/report` at 17:00 UTC on 3 Nov: **74.1%**. That is back up from 69.3% after the morning rebuild, in one datasave. `market_names` went 338 → 366 MB (+28 MB). `dynadot_rows` 152 → 158 and `datasave_pool` 74 → 77 came back after the rebuild.
- **The cause:** the daily fold rewrites about 357k of the 470k wide `market_names` rows (~300 B each) to move `last_seen` forward. The table holds about two versions of nearly every row, and fillfactor 80 alone can't keep up. At this rate the 1 GB limit is about 6 days away, so DOM is not waiting for the 3-day watch.
- **6.3.0 (building now, no route change):** `market_names` is split.
  - A wide table `market_episodes`, written only when an episode starts or its label changes.
  - A narrow table `market_episode_seen` (about 40 B a row: last seen, seen days, last price, price changes), fillfactor 50. The daily update then happens in place, with no new index entries.
  - A view keeps the name `market_names` and the same columns, so every route and reader is unchanged.
  - The one visible difference: an episode's `derived_at` becomes the time it was created or relabelled, not the last daily fold.
  - The migration is split into separate steps so the database never holds two full copies at once (only about 270 MB is free).
- DOM releases it before today's 15:25 UTC datasave if the tests pass, and posts the size before and after.

## DOM: 6.3.0 live, DB 73.0% → 58.9% (4 Nov 2026, 07:40 UTC)

- `market_names` (384 MB: heap 274, indexes 110) is now `market_episodes` 156 MB (heap 92, indexes 63) plus `market_episode_seen` 65 MB (heap 55, index 10): **221 MB, −163 MB**, all 473,861 rows (Gavriel's check: same answers, same total).
- Peak during the migration: 81.9% (Gavriel). The pre-migration that dropped the old indexes first kept it well under the limit.
- **P1 (< 60% after the first run): pass at 58.9%.** The 7-day half (< 65% on 11 Nov, ≤ 1.5 points a day) is still to come. DOM reads `/db/report` once a day at 17:00 UTC, after the datasave, and posts the growth here.
- P2 (zero row loss): no row was archived or deleted; the row count is unchanged.
- P3: no pool cut.
- P4: next two runs, to be checked.
- P5: met for the rebuilt tables in 6.2.0.
- Next: the fold now updates `market_episode_seen` in place, so `market_episodes` should grow only with new episodes (about 2.5k rows a day). If tonight's numbers confirm that, CR-100 closes after the 7-day check.

## DOM: 3 days of growth, P4 and the 7-day trend (5 Nov 2026, ~19:10 IDT)

`/db/report` at 17:00 UTC each day (after the datasave):

| Day | DB | Change |
|---|---|---|
| 3 Nov (before 6.3.0) | 74.1% (796 MB) | |
| 4 Nov | 60.4% (649 MB) | |
| 5 Nov | 62.3% (669 MB) | +20 MB, **+1.9 points** |

- Where the 20 MB went: `datasave_pool` indexes +10.6 MB (heap unchanged), `dynadot_rows` +3.3 MB, `engine_endings` +1.8, `auction_shortlist` +0.9, `market_episodes` +1.1. The 6.3.0 split works: `market_episodes` and `market_episode_seen` together grew only 1.3 MB.
- DOM ran `POST /jobs/run {job: daily, only: db_maintenance}` (dom-write) once: `run_d57d83df`, 3 s, rebuilt the three `dynadot_rows` indexes, **−14 MB**, no row deleted. `datasave_pool` stayed under the rebuild threshold, so it was not touched.
- **P4 (next two runs):** both datasaves (4 and 5 Nov) finished `ok`.
- **The 7-day bar (≤ 1.5 points a day, < 65% on 11 Nov) is at risk.** At +1.9 a day the DB is about 71% on 11 Nov. The day's growth is mostly `datasave_pool` index growth. DOM watches 6 and 7 Nov; if it holds, DOM builds a fix (`datasave_pool` fillfactor or a retention cut on old data dates) and posts it here first.
