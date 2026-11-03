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
