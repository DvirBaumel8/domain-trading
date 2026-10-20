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
- R-8 `dynadotAftermarketSnapshot` (daily): the Dynadot $500+ Buy-Now listings snapshot (`download_all_listings` or paged `get_listings` with `show_other_registrar=yes`), one row per listing with `listing_id`, `price_cents` (dollars converted), `first_seen`/`data_date`. Pulled read-only **from the box by DOM Architect**, at most **5 Dynadot calls a day** in total, and uploaded through the shared non-money data route; DOM seals it like the GoDaddy files (`source: bot_upload`, sha256, 409 `SNAPSHOT_SEALED`). Rows under $500 are dropped.
- R-9 `dynadotClosedAuctions` (daily): Dynadot `get_closed_auctions` rows (domain, end time, bid count, final price in cents), same box pull, same cap, same upload route and sealing.
- R-10 `godaddyAuctionEnd`: for each GoDaddy auction in the inventory files, keep its final state (`bid_count`, `final_price_cents`, `end_time`) when it leaves the files, so 0-bid endings can be labelled unsold (CR-075).
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

- AT-10 Given a box upload for D with source `dynadot_aftermarket`, When `GET /snapshots?date=D&source=dynadot_aftermarket`, Then `status:"complete"`, sha256 set, `source:"bot_upload"`, every row `price_cents` >= 50000, duplicate `listing_id` 0.
- AT-11 Given a box upload for D with source `dynadot_closed_auctions`, Then each row has `bid_count` and `final_price_cents` (cents), and the manifest is sealed.
- AT-12 Given a fixture GoDaddy auction present on D-1 and gone on D, When `GET /snapshots?date=D&source=godaddy_auction_end`, Then that auction appears with its last `bid_count` and `final_price_cents`.
- AT-13 (negative) Given a Dynadot upload for D is already sealed, When a second upload for D arrives, Then 409 `SNAPSHOT_SEALED` and the sha256 is unchanged; an upload carrying a row priced under $500 to `dynadot_aftermarket` drops that row and reports `dropped_below_floor_n`.

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
- 2026-10-21 00:00 IDT (Gavriel): Dynadot `not_configured` accepted; no key will be created. Instead the bots already have a read-only Dynadot connector (expired closeouts and aftermarket listings). Proposed, inside this CR: a BOTS-token `POST /snapshots/dynadot` where Buyer posts that day's closeout list once a day, which DOM then seals, parses and scores exactly like the GoDaddy files (same manifest, 409 `SNAPSHOT_SEALED`, `DATASAVE_MISSED` if nothing arrives by the retry). If you'd rather not, keep `not_configured` and say so; GoDaddy-only is fine for v5.21.0. 7-day raw and your build order confirmed.
- 2026-10-21 00:00 IDT: DOM response accepted (7-day raw, 15:00 UTC GitHub Actions schedule, Dynadot steps `not_configured`). Dynadot follow-up: Gavriel's side has a read-only Dynadot connector with an expired-closeouts listing, so Buyer can fetch the Dynadot closeout list and hand it to DOM. Please add a WRITE-token upload for that day's Dynadot rows (e.g. `POST /snapshots/dynadot` with the rows; DOM seals the manifest with sha256 and `source: bot_upload`), so `source=dynadot` works without a server key. No buys, no money; if you see a problem with this, say so here (Gavriel).
- 2026-10-20 (Gavriel): Dynadot stays bot-side, with no key. DOM Architect pulls closeouts and the aftermarket sample read-only from the box (at most 5 calls a day) and uploads the rows through the shared non-money `data` route. DOM seals and stores them as it does GoDaddy. DOM's own Dynadot steps stay `not_configured`. Please name or confirm the upload route and its format in your response.

- 2026-10-21 00:14 IDT: R-8, R-9, R-10, AT-10..AT-13 added: Dynadot $500+ snapshot and closed auctions (box pull by DOM Architect, <=5 calls/day, shared non-money data route), GoDaddy final bid count and price per auction (Dvir approved the data program (knowledge/data-program-v1.md) at 00:12 IDT Oct 21, via Gavriel).

<!-- DOM writes below this line -->

## DOM response (2026-10-21): accepted for GoDaddy; Dynadot needs a key that doesn't exist; building after v5.21.0 (v5.22.0, with CR-072)

- **Q1, Dynadot:** there is **no Dynadot key on the server**; it was never created (CR-003 left it out on purpose). The Dynadot API needs a key made in the account owner's Dynadot dashboard. Dvir creates no keys, and DOM can't make one for him (it never handles credentials). So `dynadotCloseouts` and `dynadotAftermarket` are built, but report `status: "not_configured"` (not error, not zeros) until a key exists. Please take this back to Gavriel. GoDaddy has no such problem: its inventory files are public and official, with no key.
- **Q2, storage:**
  - **Database:** only the manifests, plus the parsed `.com` rows up to the CR-072 price cap ($40), go into Neon, kept 30 days. Neon is at about 17% today.
  - **Raw zips:** kept on the Mac host disk for 14 days, under `~/Library/Application Support/domain-trading/snapshots/<source>/<data_date>/`.
  - **If production moves back to Render:** raw files aren't kept there (no disk), and the manifest says so.
- **Q3, scheduling:** a GitHub Actions schedule at 15:00 UTC (the tick pattern; Cloudflare is at 5 crons). GitHub often starts schedules late, so the job keys every file by the source's Last-Modified (R-1). Its retry at +60 min (R-7) runs on the server, not as a second schedule.
- **Unchanged:** R-3..R-6 as written (sealed manifests, 409 `SNAPSHOT_SEALED`, errors not zeros, `/health.datasave`, `DATASAVE_MISSED`, `GET /snapshots/missing`).

## DOM (2026-10-21): following Gavriel's answers (23:53 IDT)
- **Raw zips:** kept for **7 days**, not the 14 in DOM's response above, then deleted automatically. AT-8 and AT-9 apply: 410 `RAW_EXPIRED`, and no re-download for a past day.
- **Dynadot:** confirmed again that there is no existing key, so the two Dynadot steps report `not_configured`.
- **Build order:** yours, starting with this CR (now as v5.21.0), then CR-070, 072, 073 and 074, each released as soon as it's built. The version numbers in DOM's other responses move up to follow this order.

## DOM (2026-10-21): please confirm "the 5 files"
GoDaddy's inventory host lists 39 files (`metadata.json`). DOM's default (setting `datasave.godaddy_files`, about 177 MB, close to your ~180 MB):
- `closeout_listings.json.zip`
- `all_expiring_auctions.json.zip`
- `all_biddable_auctions.json.zip`
- `all_listings_ending_today.json.zip`
- `5_letter_auctions.json.zip`

If `run_daily.sh` uses different files, list them here and DOM changes the setting.

**What is parsed into the database:** only the closeouts, as `.com` names up to $40 that aren't adult. Fields: domain, price in cents, end time and data date, kept for 3 days. That's about 158k `.com` rows a day, so keeping more days won't fit the free 1 GiB database. The other four files are fetched, hashed and kept raw for 7 days. The manifests and the CR-073 draws are kept for good.

## Gavriel (2026-10-21): the 5 files
Four of DOM's five match. The fifth is different: `run_daily.sh` (via `snapshot.py` and `freeze_inventory.py`) saves `auctions_ending_today.json.zip`, not `5_letter_auctions.json.zip`. Please set `datasave.godaddy_files` to:
- `closeout_listings.json.zip`
- `all_expiring_auctions.json.zip`
- `all_biddable_auctions.json.zip`
- `all_listings_ending_today.json.zip`
- `auctions_ending_today.json.zip`

Source: box copy for 2026-10-20 in `data/raw/godaddy_inventory/2026-10-20/` is these five files, 171 MB total (19 + 72 + 54 + 23 + 4.1 MB).
Parse plan accepted: closeouts only into the DB (.com, up to $40, not adult, 3 days), the other four raw for 7 days, manifests and CR-073 draws kept for good.

## DOM release (2026-10-21): v5.21.0 tagged (GoDaddy part)

- **The `datasave` job:**
  - Steps `godaddyInventory` (your five files), `dynadotCloseouts` / `dynadotAftermarket` (`not_configured`), `buildPanel` and `snapshotRetention`.
  - Schedule: `.github/workflows/datasave.yml` at 15:00 UTC, with one server-side retry 60 min after a failed fetch.
  - New routes `GET /snapshots` and `GET /snapshots/missing`, `/health.datasave`, and the `/report` warning `DATASAVE_MISSED`. Details in `docs/releases/v5.21.0.md`.
- **Checked on the real file (20 Oct closeouts, offline):**
  - 305,445 rows read, 158,333 `.com`, and 125,395 kept (`.com`, ≤ $40, not adult).
  - No unreadable price.
  - About 1 s and under 100 MB of memory.
- **Please verify:** once `/health` shows 5.21.0, either wait for today's 15:00 UTC run or start it with `POST /jobs/run {"job":"datasave"}` (WRITE). Then run AT-1, AT-6 and AT-7 with `GET /snapshots?date=<data date>` and `GET /jobs/runs?job=datasave`.
- **Dynadot through the bots: accepted.** `POST /snapshots/dynadot` (bots or WRITE) will take that day's rows from your connector. DOM seals and stores them like the GoDaddy files, with `source: bot_upload`, the same manifest, `SNAPSHOT_SEALED` and `DATASAVE_MISSED`. It ships in the next release, with CR-070.

## DOM (2026-10-21): R-8..R-10 accepted, building now as v5.22.0

- **Upload route:** `POST /snapshots/dynadot` (bots or WRITE, `Idempotency-Key`, audited) with `{kind: "aftermarket" | "closed_auctions" | "closeouts", data_date, rows: [...]}`.
  - **Body limit:** 8 MB, like the engine bulk routes. Send several calls with the same `data_date` and `kind`, and finish with `"final": true`.
  - **Sealing:** DOM seals the day at `final` (sha256 over the rows in order, `source: bot_upload`). Any later upload for that day and kind answers 409 `SNAPSHOT_SEALED`.
  - **Aftermarket filter:** rows under $500 are dropped and counted.
  - **Price units:** prices are sent as `price_cents` (integer). Converting Dynadot's dollars to cents is the box's job, and DOM rejects non-integers.
- **R-10:** the `godaddyInventory` step also streams the auction files and keeps, per auction, the last state seen: bid count, price in cents and end time. When an auction leaves the files, its final state is stored, but only for auctions that reached $500 or more (see CR-075 Q1).
- **`DATASAVE_MISSED`:** it also covers a missing Dynadot upload once the 60-min retry has passed.

## Gavriel (2026-10-21 00:40 IDT): v5.21.0 live, first save checked

- `/health` shows 5.21.0, `datasave: "ok"` (it read `overdue` before the first save).
- The by-hand run `run_e6b4895b` (started 00:32:50 IDT, finished 00:33:28 IDT, ok) was not started by me: the shared bots key gets 401 on `POST /jobs/run`, as expected.
- **AT-1 pass:** `GET /snapshots?date=2026-10-20&source=godaddy_inventory` lists 5 files, all `complete` with sha256, bytes and `last_modified`; `rows` only on `closeout_listings` (125,395, same as your offline check). Pool row: `godaddy_closeouts` 125,395. No server paths in the answer.
- **AT-6 pass:** `GET /jobs/runs?job=datasave` lists the run with all five steps and `data_date: 2026-10-20` in the `godaddyInventory` summary. Dynadot steps are `not_configured`, as documented.
- **AT-7 not testable yet:** `buildPanel` says `no_previous_day`. I'll check `gone_before_end_n` after the 15:00 UTC run on 21 Oct.
- **Second-run sealing (`SNAPSHOT_SEALED`):** I can't start a run with the bots key. The 15:00 UTC run is on a new data date, so it won't test this. If you want it checked, please run a second by-hand run for 2026-10-20 and paste the step result, or tell me which key may start `datasave`.
- `GET /snapshots/missing` works; 2026-10-07..19 are missing, as expected (no backfill).
- Box side: I'll stop the bot-side GoDaddy saves once the 21 Oct run also shows 5 files `complete`.
