# Jobs (contract v1.0.0)

The service runs **no timers of its own**. All scheduled work goes through one route, called by a Cloudflare Worker cron (`jobs-trigger/`). Bots don't call it; they see the results in `GET /audit` and `GET /report`.

## `POST /jobs/run`
- **Auth:** `Authorization: Bearer <JOB_TRIGGER_TOKEN>` only. READ and WRITE bot tokens are refused (401), and the job token works on no other route (401). If the server has no job token configured → **503** `JOBS_DISABLED`.
- **Headers:** `Idempotency-Key` required (the Worker sends `<job>-<scheduled time in ms>`). Same key + same body → the stored response is replayed and the job doesn't run again.
- **Body (strict):** `{"job": "tick"}` or `{"job": "daily"}`. Anything else → **422** `VALIDATION_ERROR`.
- **200** (even when a step failed):
  ```
  { job: "tick"|"daily", skipped: bool, started_at: ISO, finished_at: ISO,
    steps: { <step>: { ok: bool, skipped?: true, error?: string, summary: object|null } } }
  ```
  - `skipped: true` with `steps: {}`: the same job was already running in this instance.
  - Each step is isolated: a failing step (`ok: false`, `error` = a message of at most 200 characters with secrets redacted) doesn't stop the next one. A step that had nothing to do, or was already running, has `skipped: true`.
  - `summary` is the step's own result object (counts and names, see below). Its fields are informational, not part of the contract.
- **Audit:** one `audit_log` row with scope `job` and a summary such as `tick: ok`, `daily: failed backupExport` or `daily: skipped`.
- **Rate limit:** 10 calls per minute for the job token.

## Schedules (Cloudflare Worker cron, UTC)

| Job | Cron | Steps, in order |
|---|---|---|
| `tick` | `0 * * * *` (hourly) | `reconciler`: finishes purchases in `register_sent`/`unknown` (books them from the registrar's invoice, or fails them once the name is still absent and RDAP says unregistered after 30 min), fails `created` purchases older than 10 min, and fetches missing receipts. It never registers anything. Then `nsVerifier`: the public-DNS nameserver check of every domain with a lander target, at most once per 24 h (`skipped` otherwise) |
| `daily` | `5 0 * * *` (00:05) | `priceJob`: applies due `price_schedule` rows (drops, final push, delist) to listed names (a pricing hold pauses the price rows, never the delist); never calls a registrar or marketplace. Then `dropJob`: names past `drop_date` → `dropped`. Then `registrarCheck`: is every name still in the registrar account (`DOMAIN_LEFT_ACCOUNT` in `/report`); read-only. Then `backupExport`: the nightly data export to a private repo (`skipped` when it isn't configured) |

Summary objects: `reconciler` `{booked, failed, abandoned, receipts, skipped}`, `nsVerifier` `{checked, verified, cleared, unknown, skipped}`, `priceJob` `{today, dryRun, skipped, applied[], superseded[], failed[], held[], delisted[], cancelled[]}`, `dropJob` `{today, dryRun, skipped, dropped[], failed[]}`, `registrarCheck` `{dryRun, skipped, checked, present, absent, errors, newlyAbsent[]}`, `backupExport` `{skipped?, reason?, committed?, commit?, files?, changed?}`.

**Cold start:** the Worker waits 90 s. A Worker-side timeout doesn't mean the job failed; the `/audit` row is the record.

**What bots can rely on:** a stuck purchase resolves within about 90 minutes; a scheduled price change is in the DB by about 00:10 UTC on its due day (IDT date) and reaches a marketplace only when a bot uploads the next export; `/report` warnings reflect the last daily run.
