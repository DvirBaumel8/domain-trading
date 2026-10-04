# Backups and restore

**Goal:** a lost database never loses money records. The DB is the source of truth.

## Layer 1: Render Postgres (needs a paid instance)
Source: https://render.com/docs/postgresql-backups.
- **Free Postgres is not acceptable:** it has no backups, and Render's free databases expire after 30 days (https://render.com/docs/free).
- **Paid instances:**
  - point-in-time recovery: **3 days** on Hobby workspaces, **7 days** on Pro and higher;
  - logical backups (`pg_dump`) created on demand in the dashboard, kept for 7 days.
- The smallest paid instance plan and its price must be checked in the dashboard: **price UNVERIFIED here**. That price conflicts with the "$0 tools" rule, so **it needs Dvir's approval.**

## Layer 2: nightly export to git (optional, recommended)
A Render **cron job** (`render.yaml`, 02:30 IDT = 23:30 UTC) runs `npm run job:export-backup`. It:
1. Writes `backup/portfolio.csv`, `backup/ledger.csv`, `backup/purchases.json`, `backup/receipts.json` (addresses redacted) and `backup/audit.jsonl` (approval text kept; IPs dropped).
2. Commits to the **`data-backup` branch** of the domain-trading repo, using the GitHub contents API with `GITHUB_BACKUP_TOKEN`.
   - That token is a fine-grained PAT scoped to **this repo only**, permission *Contents: read/write*, expiring after 1 year.
   - It is stored as a Render secret.
3. Skips the commit when nothing changed.

Only data goes there. **No bot pushes code; only this job pushes data, and only to `data-backup`.** Gavriel pushes reviewed spec docs to `main`; Dvir pushes code.

## Layer 3: manual
Monthly, Dvir downloads a Render logical backup (or runs `pg_dump`) to his own disk.

## Restore drill (before the first real purchase, then quarterly)
1. Create a scratch Postgres (local docker is fine).
2. Restore the latest logical backup **or** import the `data-backup` CSVs with `npm run job:import-backup`.
3. Run the `/report` math against it.

## Tests (pass/fail)

| ID | Case | Pass | Fail |
|---|---|---|---|
| BK-1 | Export job on a fixture DB | 5 files; CSV headers match `report.md`/`cfo-ledger.md`; **no** secret, token, API key or full billing address (grep test) | Any leak or missing file |
| BK-2 | No change | No commit | Empty commit |
| BK-3 | Import round trip | Import into an empty DB → `/report` JSON identical to the source | Any diff |
| BK-4 | Token missing | Job logs a warning and exits 0; the service keeps running | Crash loop |
| BK-5 | Restore drill (before G4) | Done once before the first live `/buy`; report identical | Not done → the live buy is blocked |
| BK-6 | Render instance plan | Dashboard shows a paid plan with PITR | Free plan → don't go live |
