---
id: BUG-051
kind: BUG
status: done
owner_bot: dom-architect
approval: "Gavriel 2026-10-21 ~18:30 IDT (docs bug fix under the build freeze)"
priority: P2
build_order: 6
depends_on: [CR-071]
max_rounds: 2
---
# BUG-051: `POST /snapshots/dynadot` has row and price limits that aren't in the docs

## Why
On 2026-10-21 (data_date 2026-10-21, aftermarket, 83,339 rows) the first upload got 422 `VALIDATION_ERROR` with two issues: `rows: Too big: expected array to have <=50000 items`, and `rows.43571.price_cents: Too big: expected number to be <=2000000000` (one real Dynadot listing, naonu.com, priced at $56.8M). `docs/contract/endpoints.md` and `docs/releases/v5.22.0.md` say "up to 50,000 rows per call" only in passing and say nothing of a price cap. A box script can't tell the two failures apart without parsing the message text.

## Rules
- R-1 Document both limits in `endpoints.md` under `POST /snapshots/dynadot`: at most **50,000 rows per call**; every price field (`price_cents`, `final_price_cents`) at most **2,000,000,000** cents (about $20M).
- R-2 Each limit gets its own error code inside the 422: `ROWS_LIMIT` (with `details.max_rows`, `details.received_n`) and `PRICE_CAP` (with `details.max_cents` and the row indexes, at most 20). The whole call is still refused, nothing is stored (as today).
- R-3 Other validation errors keep `VALIDATION_ERROR`. The limits appear in `GET /openapi.json` (`maxItems`, `maximum`).

## Acceptance tests (via the API)
- AT-1 Given 50,000 valid aftermarket rows with `dry_run: true`, Then 201 with `received_n: 50000`.
- AT-2 (negative) Given 50,001 rows, Then 422 with code `ROWS_LIMIT`, `details.max_rows: 50000`, `details.received_n: 50001`, and `GET /snapshots` shows nothing stored.
- AT-3 (negative) Given one row with `price_cents: 2000000001` among valid rows, Then 422 with code `PRICE_CAP`, `details.max_cents: 2000000000`, the row index listed, nothing stored.
- AT-4 Given a row with `price_cents: 2000000000`, Then it is accepted (the cap is inclusive).
- AT-5 `GET /openapi.json` shows `maxItems: 50000` on `rows` and `maximum: 2000000000` on the price fields; `endpoints.md` states both.

## Out of scope
- Raising either limit; storing prices above the cap (the box leaves such rows out and logs them).

## Questions (max 3)
1. Would you rather clamp or flag over-cap prices instead of refusing the call? Default: refuse with `PRICE_CAP`.

## DVIR items
None.

## Changes
- 2026-10-21 18:40 IDT: filed (Gavriel's decision, 2026-10-21 ~18:30 IDT).

<!-- DOM writes below this line -->

## DOM answer (2026-10-21 16:25 UTC): built in v5.32.0
- **Verdict:** accepted as filed (R-1..R-3). Tag `v5.32.0` was pushed at 16:20 UTC, after the 15:00 UTC save and the 16:00 UTC seal, so the deploy did not restart the server in the middle of either. The Mac host deploys after CI; please confirm on `/health`.
- **R-1:** `endpoints.md` `POST /snapshots/dynadot` states both limits: 50,000 rows per call, and every price field at most 2,000,000,000 cents, inclusive.
- **R-2:**
  - 422 `ROWS_LIMIT` `details: {max_rows, received_n}`.
  - 422 `PRICE_CAP` `details: {max_cents, rows: [indexes, up to 20], over_n}`. `over_n` was added beyond the CR so you know when more than 20 rows are over.
  - The row limit is checked first. The whole call is refused and nothing is stored. Every other problem stays `VALIDATION_ERROR`.
- **R-3:** `GET /openapi.json` already showed `maxItems: 50000` and `maximum: 2000000000`; a test now pins them.
- **Q1:** refuse with `PRICE_CAP`, the default. A clamped price would put a made-up number into the sealed sha256, and flagging would store a value the column was not meant to hold. Leave such rows out, as you do.
- **Tests:** DS532-1 covers AT-1..AT-5: 50,000 rows pass with `dry_run`, 50,001 gives `ROWS_LIMIT`, `naonu.com`'s $56.8M gives `PRICE_CAP` with index 1, exactly 2,000,000,000 is accepted, nothing is stored, and the OpenAPI limits are shown. The full suite is green.

## Gavriel live check of v5.32.0 (2026-10-21 19:30 IDT)
- `/health` showed 5.32.0 at 19:26 IDT (bots token). All calls `dry_run: true`, kind `aftermarket`, test data_date 2026-01-01.
- **Pass, all five:** AT-1 50,000 rows: 201, `received_n` 50000. AT-2 50,001 rows: 422 `ROWS_LIMIT` `{max_rows: 50000, received_n: 50001}`. AT-3 one row at 2,000,000,001: 422 `PRICE_CAP` `{max_cents: 2000000000, rows: [1], over_n: 1}`. AT-4 exactly 2,000,000,000: 201, accepted. AT-5 `/openapi.json` has `maxItems: 50000` and `maximum: 2000000000`. A decimal price still gives `VALIDATION_ERROR`, and `GET /snapshots` for 2026-01-01 shows nothing stored.
- **Q1:** agreed, refuse with `PRICE_CAP`; the box keeps leaving over-cap rows out and logging them. The box upload script can now branch on the code instead of the message text.
- **Status:** closed from my side.
