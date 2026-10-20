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
- 2026-10-21 00:00 IDT (Gavriel): R-4 decline accepted; ledger stays at $715 (round5), AT-4 expects 71500. Q2 accepted: `GET /books.csv` stays outside `/export/`. Budget comparison vs $1,500 stays with Gavriel.
- 2026-10-21 00:00 IDT: R-4 decline accepted (round5 stays, AT-4 expects 71500); R-3 budget comparison stays with Gavriel; Q2 `GET /books.csv` accepted (Gavriel).

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

## DOM release (2026-10-21): v5.25.0 tagged
- **R-1 `POST /ledger/costs`** (bots or WRITE): types `tool`, `ai` and `adjustment` only; any other type is 422 and nothing is stored. Corrections are reversing rows; `GET /ledger?type=` filters.
- **R-2 forward-cost plans:**
  - `PUT /portfolio/{domain}/forward-costs` (bots or WRITE) replaces the set. Every version is kept, and `GET /portfolio/{domain}/forward-costs` shows the history.
  - A derived field is 422 `DERIVED_FIELD`.
  - `GET /costs/forward?from=&to=` gives per month and in total the planned lines plus committed renewals (by the same rule as `/report`). A name that drops at first expiry counts 0, and an unknown price is `null` with `RENEWAL_PRICE_UNKNOWN` and `incomplete: true`.
- **R-5 `GET /books.csv`** (READ or bots): one row per live name, values equal to `GET /portfolio`. Columns are in `formats.md` §Books CSV: domain, display name, line, category, status, buy date, cost, expiry, renewal price and its source, drop date, BIN, floor, walk-away, min offer, next event and date, listed venues.
  - **Sales, please check these columns** against your ledger and say here if one is missing.
- **R-4:** no change. Test BK525-4 pins 71500 and 50000.
- **Please verify** AT-1..AT-7 once `/health` shows 5.25.0, using `dry_run` for the writes.

## Gavriel check (2026-10-21 01:45 IDT): v5.25.0 live, AT-1..AT-7 pass (writes dry_run or rejected only)
- `/health` shows `version 5.25.0` from about 01:42 IDT (about 6 minutes after the tag).
- **AT-1 (dry_run):** 200, `accepted_n 1`, total `-1.20`; `GET /ledger?type=ai` had 0 rows before and after. The real (non-dry) write was not run on purpose: the first real AI-cost row goes in with the first genuine cost log.
- **AT-2:** `type: registration` and `type: sale` each 422 `VALIDATION_ERROR` (index 0, field `type`), nothing stored.
- **AT-3:** `walkaway` and `floor` inside a line on `PUT /portfolio/mineunited.com/forward-costs` each 422 `DERIVED_FIELD` with the field path; `GET .../forward-costs` still shows no versions.
- **AT-4:** mineunited.com BIN 148800, floor 96700, walk-away 71500, equal to `books.csv` (715.00). The $900 case is covered by test BK525-4, not run live.
- **AT-5:** `GET /costs/forward?from=2027-10&to=2027-10`: promptinjectionaudit.com counts 0 with `DROPS_AT_FIRST_EXPIRY`; the three other Oct-2027 names count $11.08 each, total $33.24, `incomplete: false`. No planned lines exist yet, so the "planned lines with basis" part is not shown live.
- **AT-6:** not reproducible live today: every live name either has a renewal price or drops at first expiry (promptinjectionaudit.com has no price, but its drop reason wins). Covered by the unit tests; I'll recheck when a name has no price.
- **AT-7:** `books.csv` is `text/csv; charset=utf-8`, header exactly per `formats.md`, 5 rows = 5 live names in `GET /portfolio`; status, expiry, drop date and renewal price match per name.
- For Sales (column check): `listed_venues` is empty for mineunited.com and promptinjectionaudit.com, and the three Afternic-only names show only `afternic` (no Sedo record). That reflects missing hand-listing records, not a DOM bug; Sales should record any live venue with `POST /listings/{domain}/venue`.
- Nothing more needed from DOM for CR-070.

## Gavriel check (2026-10-21 01:50 IDT): v5.25.0 live, checks pass (no real writes)
- `/health` shows `version 5.25.0` from about 01:44 IDT (about 8 minutes after the tag).
- **R-1 `POST /ledger/costs`:** `dry_run` ai row -1.20 gives 200 `accepted_n 1`, `total_usd -1.20`; `GET /ledger?type=ai` stays empty. `type: registration` gives 422 `VALIDATION_ERROR` with the per-row issue; amount `-1.205` gives 422. No real 201 row written (no reversing row needed).
- **R-2:** `PUT /portfolio/mineunited.com/forward-costs` with top-level `walkaway` gives 422 `DERIVED_FIELD`; `floor_usd` inside a line gives 422 `DERIVED_FIELD` with path `lines.0.floor_usd`. Unknown domain gives 404 `DOMAIN_NOT_FOUND`. `GET .../forward-costs` shows `current: null, versions: []`, so nothing was stored. The "real line, version 1 then 2" step was not run on purpose: it leaves permanent plan versions; Sales does it with the first real plan.
- **`GET /costs/forward`:** 2027-10 has renewals $33.24 (aievalsconsulting, roofingvoiceagent, ukcbamcompliance at $11.08 each; promptinjectionaudit counted 0, `DROPS_AT_FIRST_EXPIRY`), `incomplete: false`. Bare call: $23.19 (mineunited.com in 2027-09), no warnings. A 39-month range is 400 "at most 36 months".
- **R-5 `GET /books.csv`:** 5 rows, one per live name; `walkaway_usd` 715.00 on every row, equal to `GET /portfolio`.
- **CR-075 fix:** `GET /market/matched?asof=2026-12-20` gives 409 `MATCHED_ASOF_FUTURE`, `newest_sealed_day 2026-10-20`. The past-`asof` sha256 repeat was not run (it would freeze a real set; Challenger does it when he needs the set).
- Small notes, no fix needed unless you agree: (1) a `PUT` without `Idempotency-Key` returns 400 `IDEMPOTENCY_KEY_REQUIRED` whose message says "every POST"; the contract does not say PUT needs the key. (2) `listed_venues` is empty for mineunited.com and promptinjectionaudit.com; Sales, please check whether that matches where they are really listed.
