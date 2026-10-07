# Jobs (contract v2.2.0)

The service runs **no timers of its own**. All scheduled work goes through one route, called by a Cloudflare Worker cron (`jobs-trigger/`). Since 2.1.0 the cron fires **once a day** (00:05 UTC) and runs `daily` only; `tick` stays callable by hand. Bots don't call it; they see the results in `GET /audit` and `GET /report`.

## `POST /jobs/run`
- **Auth:** `Authorization: Bearer <JOB_TRIGGER_TOKEN>` only. READ and WRITE bot tokens are refused (401), and the job token works on no other route (401). If the server has no job token configured → **503** `JOBS_DISABLED` (for any POST to this route, even without a token).
- **Headers:** `Idempotency-Key` required (the Worker sends `<job>-<scheduled time in ms>`). Same key + same body → the stored response is replayed and the job doesn't run again.
- **Body (strict):** `{"job": "tick"}` or `{"job": "daily"}`. `daily` runs the `tick` steps first, then its own (so a manual `daily` is the full run; `tick` alone is the old hourly subset). Anything else → **422** `VALIDATION_ERROR`.
- **200** (even when a step failed):
  ```
  { job: "tick"|"daily", skipped: bool, started_at: ISO, finished_at: ISO,
    steps: { <step>: { ok: bool, skipped?: true, error?: string, summary: object|null } } }
  ```
  - `skipped: true` with `steps: {}`: the same job was already running in this instance.
  - Each step is isolated: a failing step (`ok: false`, `error` = a message of at most 200 characters with secrets redacted) doesn't stop the next one. A step has `skipped: true` only when its own summary says so (already running, not due, or backup not configured). A step with nothing to do (an empty price or drop job) returns `ok: true` without `skipped`.
  - `summary` is the step's own result object (counts and names, see below). Its fields are informational, not part of the contract.
- **Audit:** one `audit_log` row with scope `job` and a summary such as `tick: ok`, `daily: failed backupExport` or `daily: skipped`.
- **Rate limit:** 10 calls per minute for the job token.

## Reading the runs (2.1.0)
- `GET /jobs/runs` (READ) lists every run recorded since 2.1.0 with its trigger and the full step results; `POST /jobs/preview` (WRITE) shows what `priceJob` and `dropJob` would do on a chosen day (`endpoints.md`). Both are read-only toward registrars and marketplaces.
- **Overdue:** `/report` raises the error warning `JOB_OVERDUE` and `GET /health` shows `jobs: "overdue"` when no `daily` run has finished in the last **26 hours** (a constant in the service, `JOBS_OVERDUE_HOURS`; a change needs a release). A run started by hand counts; `tick`, a skipped overlap and a preview do not.

## Schedules (Cloudflare Worker cron, UTC)

| Job | Cron | Steps, in order |
|---|---|---|
| `tick` | **by hand only** (`POST /jobs/run {"job":"tick"}`); no schedule since 2.1.0. Its steps are the first three steps of `daily` | `reconciler`: finishes purchases in `register_sent`/`unknown` (books them from the registrar's invoice, or fails them once the name is still absent and RDAP says unregistered after 30 min), fails `created` purchases older than 10 min, and fetches missing receipts. It never registers anything. Then `nsVerifier`: the public-DNS nameserver check of every domain with a lander target, at most once per 24 h (`skipped` otherwise). Then `screeningResume`: screening runs still `running` that no worker in this instance is on (the service slept) are finalised `partial` when past their `deadline_at` (every unfinished check UNKNOWN `TIMEOUT`), else resumed when their last row is older than 120 s |
| `daily` | **once a day, 00:05 UTC** (the only cron). Steps in order: the three `tick` steps (`reconciler`, `nsVerifier`, `screeningResume`, described in the `tick` row), then `priceJob`: applies due `price_schedule` rows (drops, final push, delist) to listed names (a pricing hold pauses the price rows, never the delist); never calls a registrar or marketplace. Then `dropJob`: names past `drop_date` → `dropped`. Then `registrarCheck`: is every name still in the registrar account (`DOMAIN_LEFT_ACCOUNT` in `/report`); read-only. Then `referenceRefresh`: the daily reference data (the popularity list for TYPO-1, the IANA RDAP bootstrap, cache pruning; NameBio is a disabled stub), paced and read-only toward the outside, never a registrar call (`selection.md` §Reference data refresh); a sub-step that failed keeps the previous snapshot and makes the step `ok: false` while the others still run. Then `backupExport`: the nightly data export to a private repo (`skipped` when it isn't configured) |

Summary objects: `reconciler` `{booked, failed, abandoned, receipts, skipped}`, `nsVerifier` `{checked, verified, cleared, unknown, skipped}`, `screeningResume` `{resumed: [run_id], finalized: [run_id]}`, `priceJob` `{today, dryRun, skipped, applied[], superseded[], failed[], held[], delisted[], cancelled[]}`, `dropJob` `{today, dryRun, skipped, dropped[], failed[]}`, `registrarCheck` `{dryRun, skipped, checked, present, absent, errors, newlyAbsent[]}`, `referenceRefresh` `{popularity: {list_id, list_date, rows} | {skipped, reason}, namebio: {skipped, reason}, iana: {refreshed} | {skipped, reason}, pruned, errors[]}` (`popularity` is the Majestic Million list for TYPO-1; a failed sub-step is `{ok: false, error}` there and in `errors`), `backupExport` `{skipped?, reason?, committed?, commit?, files?, changed?}`.

**Cold start:** the Worker waits 90 s. A Worker-side timeout doesn't mean the job failed; the `/audit` row is the record.

**Which day a job acts (2.2.0, CR-006 Q-2, Q-3).** A run's `today` is the IDT calendar date at the moment it runs (00:05 UTC = 03:05 IDT, 02:05 in winter).
- `priceJob` applies a row on the first run whose `today` is on or after its `due_on`. The final push changes only the BIN; the floor and walk-away stay (`endpoints.md` §Pricing version).
- `dropJob` marks a name `dropped` on the first run whose `today` is **after** `drop_date` (the name still exists on `drop_date` itself). Example: `drop_date` 2027-10-04 → dropped by the run at 03:05 IDT on 2027-10-05. `POST /jobs/preview` shows it from that day.
- **Late rows (a missed run, an outage):** the next run takes every `planned` row of the current plan that is due. If a `delist` is among them, the name is delisted and every other open row is cancelled. Otherwise the rows are checked newest first: a row that fails the price rules becomes `failed`, the newest valid row is applied, and the older due rows become `superseded` (so the name jumps to the newest due price and never replays older drops). A pricing hold pauses all of this except the delist. `POST /jobs/preview` for a later day assumes the same: it shows what the next run on that day would do with every row due by then.

**What bots can rely on:** a stuck purchase (`register_sent` / `unknown`) resolves by the next daily run, up to about 24 hours (it keeps counting against the caps and holds the name meanwhile); to settle it sooner, start a run by hand (`POST /jobs/run`, job token); a scheduled price change is in the DB by about 00:10 UTC on its due day (IDT date) and reaches a marketplace only when a bot uploads the next export; `/report` warnings reflect the last daily run. Every scheduled run is recorded in `GET /audit` (scope `job`, one row per run, idempotency key `daily-<scheduled time in ms>`).
