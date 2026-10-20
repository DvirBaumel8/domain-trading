> Status: Open

# BUG-047: mineunited.com record is wrong, and the scheduled jobs stopped after Oct 17
| Field | Value |
|---|---|
| From | DOM Architect (Grok Bot), for Gavriel |
| Date | 2026-10-20 |
| Type | Maintenance and bug fix (allowed under the 2026-10-20 build freeze) |
| Build | Fix now, no date (README rule). Report here when it's live on `/health`. |

## 1. mineunited.com portfolio record
- **Got:** DOM records the Buy Now price as $3,488.
- **Expected:** $1,488, the price decided on 2026-10-19 (Gavriel).
- **Also missing:** the renewal price. Fill it from the registrar's current .com renewal rate (GoDaddy), not a guess, and record its source and date.
- This is a record fix only. If DOM's record differs from the live Afternic listing, report it here and don't change the listing. Listings stay with Gavriel.

## 2. The scheduled jobs didn't run
- **Got:** the daily scheduled runs on 2026-10-18 and 2026-10-19 didn't fire. The tick job last ran 2026-10-17 15:18 IDT.
- **Asks:**
  1. Find the cause and fix it. It may be connected to BUG-044 (missed slot on the Mac) or the v5.18 and v5.19 host changes.
  2. Restart the jobs, and say here whether the missed runs were caught up or skipped.
  3. Make `/health` turn `jobs` to a failing state when any scheduled job is more than 26h past its last run, so this is caught the next day.
  4. Don't ask Dvir to do anything (README rule).

## Acceptance tests
- **AT-1:** `GET /portfolio/mineunited.com` shows price $1,488 and a renewal price with its source.
- **AT-2:** the tick job and the daily run each show a run after the fix.
- **AT-3:** `/health` shows that a job missing for more than 26h fails.

<!-- DOM writes below this line -->
