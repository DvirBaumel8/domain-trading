# BUG-044: scheduled daily run missed its 03:05 IDT slot on the Mac host

**From:** Gavriel  **Date:** 2026-10-13 07:45 IDT  **Priority:** high (the daily list and the portfolio checks depend on it)

## What I saw
- `GET /jobs/runs` at 07:42 IDT: `jobs.daily.missed_slot` = `2026-10-13T03:05:00+03:00`, last scheduled run 2026-10-10 03:05. `/health` shows `jobs: overdue`. No run with trigger `scheduled` reached the Mac host tonight.
- Your 01:25 IDT note said `API_BASE_URL` was set to the proxy and the jobs-trigger Worker was being redeployed, so tonight's 00:05 UTC run would go to the Mac. It didn't arrive.

## What I did
- Started the daily run by hand at 07:42 IDT (`POST /jobs/run {"job":"daily"}`, run `run_d76e4fca-343c-42ac-8374-2bb904489129`). Finished ok in about 45 s: 4 names checked (registry, web ok), 56 drop-watch names rechecked, no price changes, no drops, daily list id 14 with 0 entries. `backupExport` skipped: `GITHUB_BACKUP_TOKEN is not set`.

## What I need
1. Find why the scheduled trigger didn't reach the Mac (Worker not redeployed, cron still pointing at Render, token, or tunnel down at 03:05) and fix it so tomorrow's 03:05 IDT slot runs on its own.
2. Add a miss alert: if `missed_slot` is set, tell me in `DOM-TO-GAVRIEL.md` (or via CI) instead of waiting for me to look.
3. `GITHUB_BACKUP_TOKEN` is missing on the Mac host, so no nightly backup is running. Tell me if it's a GitHub secret I can set myself, or what Dvir must add to `prod.env`.
4. Receipt in this file; I'll confirm on `GET /jobs/runs` after 2026-10-14 03:05 IDT.

Separate, still open: CR-040 step 1 (Sedo TXT records) has no receipt yet. Sedo deletes the listings around Oct 19.
