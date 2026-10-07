# Backups and restore

A lost database must never lose money records. Hosting is Neon free with **no paid PITR** (the former BK-6, paid PITR, is replaced by the nightly export and the BK-5 drill).

## Layer 1: nightly export to a private data repo (last step of `daily`)
- **Target:** the fixed branch **`data-backup`** (not configurable) of a **separate private repo**, `GITHUB_BACKUP_REPO` (`DvirBaumel8/domain-trading-data`). Config refuses the code repo (founder rule 11). **Every run** reads the repo's metadata and refuses unless it is private (or if it can't be read). The repo needs ≥ 1 commit (an empty repo is an error).
- Writes through the GitHub git data API (blobs, tree, commit, ref update **without force**) with `GITHUB_BACKUP_TOKEN` (fine-grained PAT, that repo only, Contents read/write). Files no longer produced are deleted from the branch; only `backup/*` is managed.
- No commit when nothing changed (deterministic files: primary-key order, one repeatable-read snapshot). Token or repo unset → the step is `skipped` with a warning; the service keeps running.
- **Files (`backup/`):** `portfolio.csv` (no walk-away), `ledger.csv` (the ledger CSV header), `offers.csv`; `purchases.json` and `receipts.json` (billing/account fields and addresses dropped), `sales.json`; `audit.jsonl` (approval text kept, client IPs dropped); `migrations.json` (the applied migration names, for the restore check); **lossless** `tables/*.json` for `settings`, `deals`, `pricing_settings`, `domains`, `ledger_entries`, `listing_history`, `quotes`, `price_schedule`, `pricing_evidence`, `offers`, `export_runs`, `export_uploads`, `registrar_presence`, and the CR-001 tables `selection_settings`, `selection_lists`, `screening_evidence` (the gzip text as bytea hex), `screening_runs`, `screening_results`, `manual_quotes`, and `sibling_method_approvals` (2.4.0). Not exported (operational): `job_runs`, `portfolio_checks`, `api_usage`. A restore checks that the settings versions and lists the migrations seed (selection v1 and its lists) carry the same values as the backup (`values` / `terms`; timestamps stay the new database's own) and keeps those rows. The tables include the private walk-away (a restore needs it): internal storage only, which is why the repo must stay private. Never exported: `api_tokens`, `idempotency_keys`.
- Only this job pushes data, and only to `data-backup` of the data repo. No bot pushes code.

## Layer 2: manual
Monthly, Dvir keeps a copy of the `data-backup` branch or a `pg_dump` of Neon on his own disk.

## Restore: `npm run job -- import-backup <dir>`
Into an **empty** database only (refuses if `domains`, `ledger_entries`, `deals`, `purchases`, `sales`, `offers` or `audit_log` has rows); the target must be at the **same migration level** (`backup/migrations.json` must equal the target's applied migrations, in order), else `MIGRATION_LEVEL_MISMATCH`. One transaction; one admin audit row with the source dir and counts. Tokens aren't restored (`audit_log.token_id` → null): create new ones after.

## Restore drill (BK-5: before G4, then quarterly)
Scratch Postgres + migrations → clone `data-backup` → `import-backup` → compare `/report` with production (steps: `docs/runbook.md`).

## Tests
| ID | Case | Pass |
|---|---|---|
| BK-1 | Export on a fixture DB | The file set above; CSV headers right; `portfolio.csv` without walk-away; no secret, token, key, IP or billing address (grep) |
| BK-2 | No change | No commit |
| BK-3 | Import round trip | `/report` JSON identical to the source; one admin audit row |
| BK-4 | Token or repo missing | Step `skipped` with a warning; the other steps and the service run |
| BK-5 | Restore drill before G4 | Done once before the first live `/buy`; report identical (not done → the live buy is blocked) |
| BK-7 | Mock GitHub: repo = the code repo; data repo public (or `visibility` ≠ private) on this run; metadata unreadable; the ref update | Config error at startup / refused, nothing written / refused / only `refs/heads/data-backup`, `force: false` |
| BK-8 | Import into a DB with one `domains` row; a backup with another seeded settings version | Refused, nothing written (both) |
