---
id: CR-095
kind: CR
status: open
owner_bot: dom-architect
approval: "Gavriel confirmed 2026-10-29 ~19:25 IDT: retention/indexing/compaction only; no money; keep every row needed; no DB plan change. Claude Code only, no CloudAgents."
priority: P1
priority_note: "DB over the 70% warn line; engineFeed already skipped a day"
depends_on: []
supersedes: []
max_rounds: 2
---
# CR-095 — DB at 74% of 1 GB: free space by retention/compaction, and stop engineFeed losing a day

**Facts (2026-10-29).** `GET /health` `db_size`: 796,254,208 of 1,073,741,824 bytes (**74.2%**, warn 70%). Largest tables: `market_names` 341 MB (466k rows), `dynadot_rows` 215 MB (856k rows), `datasave_pool` 90 MB, `screening_results` 42 MB, `pickproof_pool` 31 MB. The datasave retry `run_9ea5e2fc` (19:12 IDT) step `engineFeed` returned `status: db_size_high` and stored nothing: **`expired_unsold_candidates_n: 900`** not saved for 29 Oct.

**Dvir's standing rule:** no artificial size cuts on data paths (no caps or sampling to fit). Scale by removing rows that are not needed or are kept elsewhere.

## Asks
1. **Retention of raw/duplicate rows that are archived elsewhere.** E.g. `dynadot_rows` days already written to the aftermarket archive (`snapshotRetention.aftermarket_archive.written`) and sealed with a sha256; superseded `datasave_pool` / `pickproof_pool` days; raw JSON duplicated in typed columns. Delete only what an archive or another table can rebuild; list each rule and its archive in the response.
2. **Compaction.** VACUUM (and reclaim bloat after the large deletes, e.g. 80,776 aftermarket rows on 28 Oct, 133,237 pool rows on 29 Oct); report bytes before/after.
3. **Indexes.** Drop unused or duplicate indexes on the big tables (index bytes count toward the limit); keep what queries need.
4. **Leaner storage of bulk rows** (`market_names`, `dynadot_rows`): narrower columns, or moving raw payloads into the existing archive files with a pointer, keeping every row the logic needs.
5. **engineFeed must not lose a day.** When it skips for `db_size_high`, record the skipped day as pending (visible in `/health` or `/report`), and backfill it on the first run with space. **Backfill 29 Oct (900 candidates)** once space allows.

**Out of scope:** no DB plan change and no money.

## Check
- `db_size.percent` under 60% after the change, with no loss of rows the logic uses (episodes, sales, panels, shortlist inputs unchanged in counts).
- `engineFeed` ok on the next datasave; 29 Oct candidates present (900, or the documented count).
- A skipped `engineFeed` day shows as pending until backfilled.

**Add (29 Oct, Gavriel):** the guard also blocked Buyer's CR-083 evidence POST (6 rows, 1.6 KB). The exemption for small critical writes is **CR-097** (P1, depends on this CR). Pending replay: `docs/requests/pending/2026-10-29-cr083-evidence-post-body.json`.
