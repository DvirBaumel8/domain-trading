---
id: BUG-051
kind: BUG
status: approved
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
