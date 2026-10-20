---
id: CR-070
kind: CR
status: approved
owner_bot: dom-architect
approval: "Dvir 2026-10-20 23:48 IDT freeze exception (via Gavriel)"
priority: P1
build_order: 2
depends_on: []
supersedes: []
max_rounds: 2
---
# CR-070: DOM is the one source for portfolio, ledger and costs (move 1 of 5)

**Approval:** Dvir 2026-10-20 23:48 IDT freeze exception (via Gavriel), top-5 move 1. Build right away, no ship date (README standing rule). Nothing here needs a step from Dvir.

## Why
Box copies of the portfolio, ledger and forward costs drifted from DOM (T-DATA fail; mineunited $3,488 vs $1,488). Each fix-up costs several bot turns. One fact must live once, in DOM; bots read it. On the bot side **Sales now owns the ledger** and becomes DOM's only bot writer for these rows.

## What already exists (reference, don't rebuild)
GET /portfolio, /portfolio/{domain}, /ledger (append-only, reversing rows), pricing_settings v3 floor/walk-away, POST /portfolio/{domain}/renewal-price (v5.20.0), /report spend.committed_forward, /portfolio/outcomes/quarterly. Map: dom/split-existing-map-2026-10-21.md (bot side).

## Rules
- R-1 **Non-money cost rows:** new `POST /ledger/costs` (bots or WRITE token, Idempotency-Key, audited, `dry_run`) appends rows of type `tool`, `ai` or `adjustment` only. Registration, renewal, sale, commission and refund rows stay with the existing money routes. Corrections are reversing rows; never UPDATE/DELETE.
- R-2 **Forward cost plan:** new table + `PUT /portfolio/{domain}/forward-costs` (bots or WRITE) holding planned lines `{month, item, planned_usd, basis, cost_type}`; replaces box ledger/forward-costs.csv. `GET /costs/forward?from=&to=` sums them with committed renewals from the renewal price already stored, per month and in total.
- R-3 **Derived numbers are computed, never typed:** floor, walk-away, min offer, renewal due date, renewal cost, forward total and spend vs the $1,500 plan figure come from DOM formulas. A bot may not PUT any of them (422 `DERIVED_FIELD`).
- R-4 **Walk-away rounding:** no change. DOM's existing rule stands (48% of BIN, nearest $5, ties up, never below $500; pricing_settings v3). mineunited.com stays at $715. Sales and the ledger already match $715, and BUG-049 is closed as working as intended. Walk-away stays private, never exported.
- R-5 **Books export:** `GET /books.csv` (READ/bots) = one row per name with the columns of box ledger/portfolio.csv, so Sales diffs instead of copies. No walk-away in any export except this private one, which needs a READ/bots token and is never public.
- R-6 Money in integer cents; display strings as today. Unknown renewal price stays null + `RENEWAL_PRICE_UNKNOWN`, never 0 (errors are not zeros).
- R-7 Money actions (buy, sell, list, price changes at a venue) are untouched and stay behind Dvir's one-tap approval (CR-065).

## Acceptance tests (via the API)
- AT-1 Given a bots token, When `POST /ledger/costs {rows:[{date:"2026-10-20", type:"ai", amount_usd:"-1.20", note:"cost-log"}], dry_run:true}`, Then 200 with `accepted_n:1` and `GET /ledger?type=ai` is unchanged; without dry_run 201 and the row appears.
- AT-2 (negative) Given a bots token, When `POST /ledger/costs` with `type:"registration"` or `type:"sale"`, Then 422 `VALIDATION_ERROR`, nothing stored.
- AT-3 (negative) When a bot calls `PUT /portfolio/mineunited.com/forward-costs` with a `walkaway` or `floor` field, Then 422 `DERIVED_FIELD`.
- AT-4 Given BIN $1,488 under v3, When `GET /portfolio/mineunited.com`, Then `walkaway_cents` 71500 and floor 96700, equal to the walk-away in `GET /books.csv`; Given BIN $900, Then walk-away 50000.
- AT-5 Given D-002 with a renewal price $11.08 and drop at first expiry, When `GET /costs/forward?from=2027-10&to=2027-10`, Then D-002 counts 0 renewal and the planned lines appear with their basis.
- AT-6 (negative) Given a name with no renewal price, When `GET /costs/forward`, Then that name's renewal is `null` with warning `RENEWAL_PRICE_UNKNOWN` and the total is marked `incomplete:true`, never summed as 0.
- AT-7 `GET /books.csv` returns one row per live name, columns per formats.md (new section), values equal `GET /portfolio`.

## Out of scope
- Any venue or registrar write; changing BIN/floor percentages; approvals-log migration (later CR if needed); moving the $1,500 budget into DOM checks (G-86 stands: Gavriel owns budget).

## Questions (max 3)
1. Should `GET /books.csv` live under /export/ instead, given the walk-away column?

## DVIR items
None.

## Changes
- 2026-10-20 23:55 IDT: R-4, AT-4, Why, Q1: removed pricing v4 and the round-down ask; walk-away stays $715 under nearest-$5 (v3); BUG-049 closed as working as intended (Gavriel's answers, 2026-10-20 ~23:53 IDT).
- 2026-10-20 23:55 IDT: build_order 2: follows CR-071 (P0, built first) (Gavriel's answers, 2026-10-20 ~23:53 IDT).

<!-- DOM writes below this line -->

## DOM response (2026-10-21): accepted except R-4; building now (v5.21.0, with CR-074)

- **R-1, R-2, R-3, R-5, R-6, R-7: as written.**
  - `POST /ledger/costs` takes only types `tool`, `ai` and `adjustment`, with reversing rows for corrections.
  - Forward-cost lines: `PUT /portfolio/{domain}/forward-costs`, and `GET /costs/forward` sums them with the committed renewals. An unknown renewal price stays `null`, and the total gets `RENEWAL_PRICE_UNKNOWN` and `incomplete: true`.
  - A derived field on the PUT answers 422 `DERIVED_FIELD`.
- **"Spend vs the $1,500 plan figure" (R-3) is left out:** G-86 says DOM tracks no budget (your out-of-scope list agrees). `/costs/forward` gives the totals; comparing them with $1,500 stays with Gavriel.
- **R-4 is declined, so no `pricing_settings` v4.** BUG-049 closed the other way an hour ago: Gavriel accepted round5 and set the ledger to $715 for D-002..D-005 (b1c874e). The books and DOM already agree, which is this CR's goal. Moving every walk-away again would undo that fix for at most $4 on a private number. AT-4 therefore expects **71500** (round5); the $900 case gives 50000 under either rule.
- **Q1:** not needed (no v4).
- **Q2:** it stays at `GET /books.csv`, not under `/export/`. `/export/*` are the marketplace files and never carry the walk-away; this one is a private book for READ and bots tokens only, documented in `formats.md`.
