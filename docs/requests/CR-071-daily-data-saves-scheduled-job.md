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
- R-8 `dynadotAftermarketSnapshot` (daily): a **fixed panel (frozen 2026-10-21)** of Dynadot Buy-Now listings (`list_aftermarket_listings`, `currency: USD`, `show_other_registrar: true`, `exclude_pending_sale: true`, `page_size: 10000`), pages **40, 78, 116, 154, 192, 230, 268, 306, 344, 382, 420, 458, 496, 534, 572** (15 pages, every 38th from 40). Why: the list (5.73M rows) is sorted by domain with digit names first; letters start near page 40 (`an…`), page 300 is `li…`, page 560 is `ye…`, the last page is about 573; there is no sort, filter or start key, and the page size above 10,000 often fails. One row per listing with `listing_id`, `price_cents` (dollars × 100) for `.com` names; rows under $500 are dropped by DOM; letters-only is selected at read time. Names are tracked by `listing_id`, not page (pages drift as listings change). Pulled read-only **from the box by DOM Architect** and uploaded through the shared non-money data route; DOM seals it like the GoDaddy files (`origin: bot_upload`, sha256, 409 `SNAPSHOT_SEALED`).
- R-8a **Call rules:** at most **20 read-only Dynadot calls a day** (the 15 panel pages, 1 closeouts page, the rest for retries), one at a time, at least 10 s apart (60 s after a `concurrent limit` or `downstream` error). Every call is logged on the box, failed ones included, and failed calls count against the cap. A page that still fails is left out and recorded in the coverage.
- R-8b **Partial seals:** a day is sealed even when some pages failed, with coverage metadata: `coverage: {partial: bool, calls_n: int, pages_planned: [int], pages_ok: [int], pages_failed: [int], rows_received_n: int}`. DOM stores it on the manifest and shows it in `GET /snapshots`. The route takes no `coverage` key today (422 `Unrecognized key`, checked 2026-10-21 with `dry_run`); please add it.
- R-9 `dynadotClosedAuctions`: **BLOCKED.** The account is barred from Dynadot's auction APIs ("Your account is restricted from using the apis related to auction", 2026-10-21). No bot contacts Dynadot; Gavriel raises auction access with Dvir. Until then, R-10 (GoDaddy auction endings) is the closed-auction source. The `closed_auctions` upload kind stays as built.
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
- AT-14 Given an upload with `final: true` and `coverage: {partial: true, calls_n: 18, pages_planned: [...15], pages_ok: [...14], pages_failed: [534], rows_received_n: 92000}`, When `GET /snapshots?date=D&source=dynadot_aftermarket`, Then the manifest is `complete`, `sealed: true`, and shows the same `coverage` object.
- AT-15 (negative) Given `coverage` with an unknown key, a non-integer page, or `pages_ok` not a subset of `pages_planned`, Then 422 `VALIDATION_ERROR` and nothing is stored; an upload without `coverage` still works, and its manifest shows `coverage: null`.

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
- 2026-10-21 01:20 IDT: R-8 is now a fixed 15-page panel (frozen); R-8a call rules (20 calls a day, one at a time, >=10 s apart, failed calls logged and counted); R-8b partial seals with `coverage` metadata (new upload field, AT-14, AT-15); R-9 blocked, R-10 is the closed-auction source (Gavriel's decision, 2026-10-21 ~00:58 IDT).

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

## DOM (2026-10-21): sealing check
DOM never starts runs on production (HARD RULE). The sealing proof is test **DS521-9**: a second run for a sealed day reports `SNAPSHOT_SEALED` per file, fetches nothing but `metadata.json`, and leaves the sha256 unchanged. The database trigger also refuses any update or delete of a sealed manifest. It can also be seen live without a by-hand run: if GoDaddy hasn't rebuilt its files by the time the 15:00 UTC run (or its retry) fires, the run sees the same `LastModified` and reports `SNAPSHOT_SEALED`. Only WRITE can start `datasave` by hand, and the bots key can't (as you saw). AT-7 after the 21 Oct run: agreed.

## Gavriel (2026-10-21 00:36 IDT): v5.21.0 verified live
- `/health` shows `version: 5.21.0`; `datasave` was `overdue` before the first run and is `ok` after it.
- **AT-1 pass.** By-hand `POST /jobs/run {"job":"datasave"}` (run_e6b4895b, 38 s): 5 files `complete`, data date 2026-10-20, `rows` only on closeouts (125,395, same as DOM's offline count). All five sha256 values match the box's own copies in `data/raw/godaddy_inventory/2026-10-20/` byte for byte.
- **AT-6 pass.** A second run the same day (run_00335025): every file `SNAPSHOT_SEALED`, sha256 unchanged, `sealed: true` in `GET /snapshots`.
- **AT-7 pass.** `GET /snapshots/missing` lists Oct 7 to Oct 19 as missing (expected: no backfill).
- `buildPanel` says `no_previous_day` (expected on day one). Dynadot steps `not_configured`, waiting for `POST /snapshots/dynadot` in v5.22.0.
- Box-side `run_daily.sh` saves keep running until the first scheduled 15:00 UTC run (Oct 21) completes; then Gavriel stops them.

## DOM release (2026-10-21): v5.22.0 tagged (R-8..R-10)

- **`POST /snapshots/dynadot`** (bots or WRITE):
  - Upload format: `docs/releases/v5.22.0.md` and `endpoints.md`.
  - Integer cents only; the 8 MB body limit; `final: true` seals the day; 409 `SNAPSHOT_SEALED` after that; `dry_run` stores nothing.
  - `origin: "bot_upload"` marks it on the manifest (`source` stays `dynadot_<kind>`).
- **R-10, GoDaddy auction endings:** a `.com` auction is tracked once it reaches $500, and ended auctions keep their final bid count and price. Read them with `GET /snapshots?source=godaddy_auction_end`.
  - **Checked offline on the real 21 Oct `all_expiring_auctions`:** 949 MB unzipped, 1,231,723 rows, 4.5 s, under 120 MB of memory, 35 auctions at $500+ tracked.
- **Health:** a Dynadot kind is watched only after its first upload. A missing sealed upload after 16:00 UTC turns `/health.datasave` to `partial` and adds `DATASAVE_MISSED`.
- **Please verify** once `/health` shows 5.22.0: AT-10..AT-13, starting with a `dry_run` upload.

## Gavriel check (2026-10-21 00:57 IDT): v5.22.0 live, dry-run pass

- `/health` shows 5.22.0, `datasave: ok`.
- **AT-13 floor part pass (dry_run):** aftermarket with 3 rows (one $400, one duplicate `listing_id`, domain upper-case): `received_n 3, accepted_n 1, duplicate_n 1, dropped_below_floor_n 1`, sha256 returned, `sealed: false`.
- **AT-11 shape pass (dry_run):** closed_auctions row with `bid_count` and `final_price_cents` accepted.
- Negative checks pass: string price is 422 `VALIDATION_ERROR`; future `data_date` is 422.
- `GET /snapshots` for both kinds shows nothing stored after the dry runs (as specified).
- **Not run yet, on purpose:** the real sealed upload (AT-10) and the second-upload 409 (AT-13 seal part). A real upload starts the `DATASAVE_MISSED` watch for that kind, so we do them with the first genuine Dynadot pull, not test rows.
- **AT-12:** no endings yet for 2026-10-19 (expected; the first endings appear the day after the first 5.22.0 datasave run). Recheck after the Oct 21 and Oct 22 runs.

## DOM release (2026-10-21): v5.24.0 tagged (R-8, R-8a, R-8b, R-9)
- **R-8b:** `POST /snapshots/dynadot` takes `coverage` (strict; AT-15 rules give 422). It is stored on the manifest, frozen by the seal and shown by `GET /snapshots`. Tests DS524-1 (AT-14) and DS524-2 (AT-15).
- **R-8 / R-8a:** the fixed 15-page panel and the call rules are on your side; DOM needs no change. Rows are kept per `listing_id` (unique per day), and letters-only is decided at read time.
- **R-9:** noted as blocked. The `closed_auctions` kind stays built, and R-10 is the closed-auction source.
- **Please run** AT-14 and AT-15 with `dry_run` once `/health` shows 5.24.0. The real sealed upload can wait for the first genuine pull.

## Gavriel check (2026-10-21 01:31 IDT): v5.24.0 live, AT-14 and AT-15 dry runs pass
- `/health` shows `version 5.24.0` at 01:29 IDT, `db ok`, `jobs ok`, `datasave ok`.
- **AT-14 (dry_run):** `POST /snapshots/dynadot` aftermarket, `data_date 2026-10-19`, `final: true`, the AT-14 `coverage` (15 pages planned, 14 ok, page 534 failed, `partial: true`): 201, `status complete`, `sealed false`, nothing stored (`GET /snapshots?date=2026-10-19&source=dynadot_aftermarket` is empty afterwards).
- **AT-15:** unknown key in `coverage` 422 `VALIDATION_ERROR`; `pages_ok` not in `pages_planned` 422; a non-integer page (1.5) 422. Same upload without `coverage`: 201.
- A sealed day still answers 409 `SNAPSHOT_SEALED` for a dry run with `coverage` (2026-10-20, 3,951 rows), and that older sealed manifest shows `coverage: null`, as specified.
- **Not run yet, on purpose:** the real sealed upload that shows `coverage` on `GET /snapshots`; it comes with the first genuine pull that sends `coverage`.
- Nothing more needed from DOM for R-8b. The CR-075 matched-set issue (empty set frozen for a future `asof`) is still open in CR-075.

## Gavriel check (2026-10-21 01:35 IDT): v5.24.0 live, AT-14 and AT-15 dry-run pass
- `/health` shows `version 5.24.0` from about 01:30 IDT (about 11 minutes after the tag).
- **AT-14 (dry_run):** aftermarket, `final: true`, the AT-14 `coverage` (15 pages planned, 14 ok, page 534 failed, `partial: true`): 201, `status complete`, `sealed: false`, nothing stored (`GET /snapshots` for that day is empty).
- **AT-15:** unknown key in `coverage`, a non-integer page, `pages_ok` outside `pages_planned`, and `pages_failed` outside `pages_planned`: each 422 `VALIDATION_ERROR` with the right path. An upload without `coverage` still gives 201.
- Already sealed 2026-10-20 aftermarket day shows `coverage: null` (expected, sealed before 5.24.0).
- Small note, no fix needed unless you agree: on a dry run `rows_stored_n` reports 1 although nothing is stored. Reporting 0 (or the stored total) on dry runs would be clearer.
- Not run yet, on purpose: the real sealed upload with coverage (AT-14 GET part); it goes with the first genuine panel pull.
