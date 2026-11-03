---
id: CR-100
kind: CR
status: open
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
