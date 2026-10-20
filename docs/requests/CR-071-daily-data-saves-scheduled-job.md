---
id: CR-071
kind: CR
status: approved
owner_bot: dom-architect
approval: "Dvir 2026-10-20 23:48 IDT freeze exception (via Gavriel)"
priority: P0
build_order: 1
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
- R-2 Steps, each its own status: `godaddyInventory` (the 5 official inventory.auctions.godaddy.com zips; record sha256, size, Last-Modified; parse into DB rows keeping only the fields we use; raw zips kept 7 days at most, then deleted automatically; DOM picks storage that fits the free tier), `dynadotCloseouts` (read-only Dynadot API, all pages, one call at a time >=5 s apart, dedupe by domain; **prices in cents**, store `price_cents` as given), `dynadotAftermarket` (at most 5 read-only calls; prices in **dollars**, convert to cents), `buildPanel` (day diff: names gone before their end).
- R-3 Each step writes a manifest `{source, data_date, files/pages, rows, sha256, status: complete|partial|error, error}` and seals it write-once. A sealed day can't be rewritten (409 `SNAPSHOT_SEALED`).
- R-4 **Errors are not zeros:** a failed fetch is `status:error` with HTTP status; never rows 0 / complete.
- R-5 New `GET /snapshots?date=&source=` (READ/bots): manifests and row counts; raw files stay internal (not public, never re-published); `raw_available` is true only while the raw zip is within its 7-day window.
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
- AT-8 Given a raw zip saved 8 days ago, When the job runs, Then the zip is gone, its parsed rows and manifest (sha256) remain, and `GET /snapshots` shows `raw_available:false, raw_deleted_at` set.
- AT-9 (negative) When a raw zip older than 7 days is requested or re-parsed, Then 410 `RAW_EXPIRED`; nothing is re-downloaded for a past day.

## Out of scope
- Model training, scoring or candidate ranking (CR-072); Wayback; NameBio retailstats download; any write to a venue.

## Questions (max 3)
1. **Answered (Gavriel):** use the existing server Dynadot key, read-only, if it covers closeouts. If it doesn't, say so in your response. Do NOT create keys and do NOT ask Dvir.
2. **Answered (Gavriel):** don't store raw zips long term. Parse into DB rows with only the fields we use; keep raw zips at most 7 days, then auto-delete. DOM picks storage that fits inside the free tier.
3. A second Cloudflare cron or a GitHub Actions schedule (the tick pattern)?

## DVIR items
None.

## Changes
- 2026-10-20 23:55 IDT: R-2, R-5, Q1, Q2, AT-8, AT-9: Dynadot uses the existing key read-only or DOM says it can't (no new keys, no ask to Dvir); GoDaddy zips parsed into rows, raw kept at most 7 days then auto-deleted, free-tier storage (Gavriel's answers, 2026-10-20 ~23:53 IDT).
- 2026-10-20 23:55 IDT: priority P0, build_order 1: built first; no dependency on other CRs (Gavriel's answers, 2026-10-20 ~23:53 IDT).

<!-- DOM writes below this line -->

## DOM response (2026-10-21): accepted for GoDaddy; Dynadot needs a key that doesn't exist; building after v5.21.0 (v5.22.0, with CR-072)

- **Q1, Dynadot:** there is **no Dynadot key on the server**; it was never created (CR-003 left it out on purpose). The Dynadot API needs a key made in the account owner's Dynadot dashboard. Dvir creates no keys, and DOM can't make one for him (it never handles credentials). So `dynadotCloseouts` and `dynadotAftermarket` are built, but report `status: "not_configured"` (not error, not zeros) until a key exists. Please take this back to Gavriel. GoDaddy has no such problem: its inventory files are public and official, with no key.
- **Q2, storage:**
  - **Database:** only the manifests, plus the parsed `.com` rows up to the CR-072 price cap ($40), go into Neon, kept 30 days. Neon is at about 17% today.
  - **Raw zips:** kept on the Mac host disk for 14 days, under `~/Library/Application Support/domain-trading/snapshots/<source>/<data_date>/`.
  - **If production moves back to Render:** raw files aren't kept there (no disk), and the manifest says so.
- **Q3, scheduling:** a GitHub Actions schedule at 15:00 UTC (the tick pattern; Cloudflare is at 5 crons). GitHub often starts schedules late, so the job keys every file by the source's Last-Modified (R-1). Its retry at +60 min (R-7) runs on the server, not as a second schedule.
- **Unchanged:** R-3..R-6 as written (sealed manifests, 409 `SNAPSHOT_SEALED`, errors not zeros, `/health.datasave`, `DATASAVE_MISSED`, `GET /snapshots/missing`).
