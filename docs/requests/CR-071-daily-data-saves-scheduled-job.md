---
id: CR-071
kind: CR
status: approved
owner_bot: dom-architect
approval: "Dvir 2026-10-20 23:48 IDT freeze exception (via Gavriel)"
priority: P1
depends_on: []
supersedes: []
max_rounds: 2
---
# CR-071: daily data saves become a DOM scheduled job with an alert (move 2 of 5)

**Approval:** Dvir 2026-10-20 23:48 IDT freeze exception (via Gavriel), top-5 move 2. Build right away, no ship date. No step for Dvir. Links: BUG-047 (missed jobs), BUG-044 (daily run missed slot on the Mac).

## Why
The daily saves run by hand on a bot nudge (system/run_daily.sh on the bot box). They broke on Oct 20 and Oct 15-16 were lost for good (the sources overwrite daily, so no backfill). Every save also costs a bot turn plus a nudge.

## What already exists (reference)
The 00:05 UTC cron + tick, GET /jobs/runs, /health `jobs`/`jobs_last` (BUG-047), read-only outside fetches in daily steps, /engine/unsold and /data/* loads.

## Rules
- R-1 New job `datasave`, scheduled once a day at **15:00 UTC** (18:00 IDT summer, 17:00 IST winter; both after the ~14:40 UTC GoDaddy rebuild). Key files by the **source's data date** (Last-Modified), never the run date.
- R-2 Steps, each its own status: `godaddyInventory` (the 5 official inventory.auctions.godaddy.com zips; store raw, sha256, size, Last-Modified), `dynadotCloseouts` (read-only Dynadot API, all pages, one call at a time >=5 s apart, dedupe by domain; **prices in cents**, store `price_cents` as given), `dynadotAftermarket` (at most 5 read-only calls; prices in **dollars**, convert to cents), `buildPanel` (day diff: names gone before their end).
- R-3 Each step writes a manifest `{source, data_date, files/pages, rows, sha256, status: complete|partial|error, error}` and seals it write-once. A sealed day can't be rewritten (409 `SNAPSHOT_SEALED`).
- R-4 **Errors are not zeros:** a failed fetch is `status:error` with HTTP status; never rows 0 / complete.
- R-5 New `GET /snapshots?date=&source=` (READ/bots): manifests and row counts; raw files stay internal (not public, never re-published).
- R-6 **Alert:** `/health.datasave` = `ok | overdue | partial | error`; overdue when no complete GoDaddy or Dynadot save in 26 h; `/report` warning `DATASAVE_MISSED` with the missing sources/day; the missed day is listed in `GET /snapshots/missing`.
- R-7 Retry once at +60 min inside the same day. No paid data; no scraping of Sedo, Afternic or GoDaddy web pages (official inventory files only).

## Acceptance tests (via the API)
- AT-1 Given the job ran, When `GET /snapshots?date=<today>&source=godaddy_inventory`, Then 5 files with sha256, bytes and Last-Modified, `status:"complete"`.
- AT-2 When `GET /snapshots?date=<today>&source=dynadot_closeouts`, Then `rows` > 0, `price_unit:"cents"`, duplicate domains 0.
- AT-3 (negative) Given the GoDaddy fetch returns 503 (mock), Then the step is `status:"error"` with `http_status:503`, rows `null` (not 0), and `/health.datasave` is `error`.
- AT-4 (negative) Given no complete save for 26 h, When `GET /health`, Then `datasave:"overdue"` and `GET /report` carries `DATASAVE_MISSED`.
- AT-5 (negative) When a second save for a sealed day is attempted, Then 409 `SNAPSHOT_SEALED` and the manifest sha256 is unchanged.
- AT-6 `GET /jobs/runs?job=datasave` lists the run with per-step status and `data_date`.
- AT-7 `buildPanel` summary returns `gone_before_end_n` for the day diff (matches the box panel_diff for a fixture day).

## Out of scope
- Model training, scoring or candidate ranking (CR-072); Wayback; NameBio retailstats download; any write to a venue.

## Questions (max 3)
1. Dynadot adapter is disabled in /health. Can DOM use the existing server Dynadot key for read-only closeout calls, with no new key from Dvir? If a new key is needed, say so and we go back to Gavriel; Dvir creates no keys.
2. Where do ~180 MB/day of zips live (host disk vs data repo)? Neon is 1 GB.
3. A second Cloudflare cron or a GitHub Actions schedule (the tick pattern)?

## DVIR items
None.

<!-- DOM writes below this line -->
