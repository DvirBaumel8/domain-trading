# Backups and restore

**Goal:** a lost database never loses money records. The DB is the source of truth.

**Free hosting (step 6; Dvir, 5 Oct 2026):** the database is **Neon free Postgres** (`00-architecture.md` §8). There is **no paid PITR**, so recovery rests on the nightly export (layer 1) and the restore drill (BK-5, before G4). The former BK-6 ("paid Render plan with PITR") is **replaced** by these two.

## Layer 1: nightly export to a private data repo
Runs as the last step of the `daily` job (`POST /jobs/run {"job":"daily"}`, 00:05 UTC, after price → drop → registrar check; `00-architecture.md` §6).
1. **Target:** the fixed branch **`data-backup`** of a **separate private repo**, `DvirBaumel8/domain-trading-data` (`GITHUB_BACKUP_REPO`). The branch is fixed in code, not configurable.
   - Config **refuses the code repo** (`DvirBaumel8/domain-trading`) as `GITHUB_BACKUP_REPO` (founder rule 11).
   - **Every run** first reads the repo's metadata and **refuses** to export if the repo isn't private on that run (or can't be read).
   - The repo must have at least one commit (initialize it with a README); an empty repo is an error.
2. **Writes through the GitHub git data API** (blobs, tree, commit, ref update without force), using `GITHUB_BACKUP_TOKEN`: a fine-grained PAT for **`domain-trading-data` only**, *Contents: read/write*, stored as a Render secret. Files that are no longer produced are deleted from the branch.
3. **Skips the commit when nothing changed** (the files are deterministic: rows in primary-key order, one repeatable-read snapshot).
4. Token or repo not set → the step logs a warning and reports `skipped`; the service keeps running.

**Files** (all under `backup/`):
- `portfolio.csv` (no walk-away), `ledger.csv` (the `report.md`/`cfo-ledger.md` header), `offers.csv`;
- `purchases.json` and `receipts.json` (registrar billing/account fields and addresses dropped), `sales.json`, `payouts.json`;
- `audit.jsonl` (approval text kept; client IPs dropped);
- **lossless** `tables/*.json` (every column and row) for `settings`, `deals`, `pricing_settings`, `domains`, `ledger_entries`, `listing_history`, `quotes`, `price_schedule`, `pricing_evidence`, `offer_imports`, `offers`, `export_runs`, `export_run_domains`, `export_uploads`, `registrar_presence`.
- **The tables include the private walk-away** (`domains.walkaway_cents`, history and schedule rows): a restore needs it. This is **internal storage only**, never a marketplace export; that is why the repo must stay private.
- Never exported: `api_tokens` and `idempotency_keys`.

Only data goes there. **No bot pushes code; only this job pushes data, and only to `data-backup` of the data repo.** Gavriel pushes reviewed spec docs to `main` of the code repo; Dvir pushes code.

## Layer 2: manual
Monthly, Dvir (or Gavriel) keeps a copy of the `data-backup` branch, or a `pg_dump` of the Neon database, on his own disk.

## Restore: `npm run job -- import-backup <dir>`
- Restores **into an empty database only**: it refuses if any of `domains`, `ledger_entries`, `deals`, `purchases`, `sales`, `offers` or `audit_log` has rows. Restore first, then create new tokens (tokens are not restored; `audit_log.token_id` becomes null).
- The target must be at the **same migration level** as the source (same columns; the `pricing_settings` versions the migrations seed must equal the backup's), else it refuses.
- One transaction; writes **one admin `audit_log` row** with the source dir and row counts.

## Restore drill (BK-5: before G4, then quarterly)
1. Create a scratch Postgres (local docker is fine) and run the migrations.
2. Clone `data-backup` of `domain-trading-data` and run `npm run job -- import-backup <dir>`.
3. Run the `/report` math against it and compare with production.

## Tests (pass/fail)

| ID | Case | Pass | Fail |
|---|---|---|---|
| BK-1 | Export on a fixture DB | The file set above; CSV headers match `report.md`/`cfo-ledger.md`; `portfolio.csv` has no walk-away; **no** secret, token, API key, IP or billing address (grep test) | Any leak or missing file |
| BK-2 | No change | No commit | Empty commit |
| BK-3 | Import round trip | Import into an empty DB → `/report` JSON identical to the source; one admin audit row | Any diff |
| BK-4 | Token or repo missing | Step `skipped` with a warning; the `daily` job and the service keep running | Crash, or other steps skipped |
| BK-5 | Restore drill (before G4) | Done once before the first live `/buy`; report identical | Not done → the live buy is blocked |
| BK-7 | Repo checks (mock GitHub): `GITHUB_BACKUP_REPO` = the code repo; the data repo reported public (or `visibility` ≠ private) on this run; metadata unreadable; ref update | Config error at startup / export refused, nothing written / refused / only `refs/heads/data-backup` is written, `force: false` | Any write to another repo or branch, or a public repo written |
| BK-8 | Import refusals: a DB with one `domains` row; a backup whose seeded `pricing_settings` version differs (migration mismatch) | Refused, nothing written / refused, nothing written | Partial import |
