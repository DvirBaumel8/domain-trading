---
id: CR-072
kind: CR
status: approved
owner_bot: dom-architect
approval: "Dvir 2026-10-20 23:48 IDT freeze exception (via Gavriel)"
priority: P1
build_order: 3
depends_on: [CR-071, CR-075]
supersedes: []
max_rounds: 2
---
# CR-072: DOM filters and ranks closeout and drop candidates; Buyer gets top rows only (move 3 of 5)

**Approval:** Dvir 2026-10-20 23:48 IDT freeze exception (via Gavriel), top-5 move 3. Build right away, no ship date. No step for Dvir.

## Why
Buyer filters thousands of closeout rows with box scripts and reads them into context. Filtering in code and returning ~50 ranked rows is the biggest token saving in the split.

## What already exists (reference)
GET /candidates/daily (hand-reg screening list), POST /score (v12), /selection/drop-lists + dropWatch, tm_kills / bigco_names tables (not yet fed into checks), forbidden terms. Pool source: CR-071 snapshots.

## Rules
- R-1 New `GET /candidates/closeouts?date=&source=dynadot|godaddy|all&max_price=&limit=` (READ/bots). Default `max_price` $40, `limit` 50 (max 200). Pool = that day's sealed CR-071 snapshot, `.com` only.
- R-2 Hard filters in code, each a stable reason code: `SPELL-1`, `BRAND-1`, `BIGCO-1` (bigco_names), `TM_KILL` (tm_kills), `FORBIDDEN_TERM`, `DIGITS_OR_HYPHEN` (setting), `OWNED`, `SALES_GRADED` (already sold: reads `market_names` rows with `outcome=sold`, CR-075).
- R-3 Rank by v12 score (the active engine), ties by lower price then name. Each row: `{domain, source, price_cents, ends_at, score, rank, filters_passed, words}`.
- R-4 Response summary: `{pool_n, filtered_by: {code: n}, returned_n, snapshot_sha256}` so Buyer can cite the exact pool.
- R-5 Drop names: same endpoint with `source=drops` uses the kept drop-list names.
- R-6 A missing snapshot is 409 `SNAPSHOT_MISSING` (not an empty list); a score that failed is `score:null` with reason, not 0.
- R-7 Read-only. Buying stays /buy or /portfolio/import with Dvir's one-tap approval.

## Acceptance tests (via the API)
- AT-1 Given a sealed snapshot for D, When `GET /candidates/closeouts?date=D&limit=50`, Then <=50 rows sorted by score desc, every row `.com` and `price_cents <= 4000`.
- AT-2 Given a fixture name on bigco_names, Then it is absent and counted in `filtered_by.BIGCO-1`.
- AT-3 (negative) Given no snapshot for D, Then 409 `SNAPSHOT_MISSING`.
- AT-4 (negative) `limit=500` → 400 `VALIDATION_ERROR`.
- AT-5 Dynadot `price_cents` 1088 is shown as "$10.88" (cents, not dollars).
- AT-6 `summary.pool_n - sum(filtered_by) = ranked_n` and `snapshot_sha256` equals `GET /snapshots` for D.
- AT-7 (negative) A bots token can't buy from this route; there is no POST.

## Out of scope
- Tier A business judgment, picking, pricing proposals (stay with Buyer); any LLM call.

## Questions (max 3)
1. Is POST /score fast enough for ~20k rows/day, or should scoring run once in the CR-071 job and be stored?

## DVIR items
None.

## Changes
- 2026-10-20 23:55 IDT: build_order 3: follows CR-071 (P0, built first) (Gavriel's answers, 2026-10-20 ~23:53 IDT).
- 2026-10-21 00:00 IDT: DOM response accepted; Dynadot rows come from the bot upload asked for in CR-071 (Gavriel).

- 2026-10-21 00:14 IDT: R-2 `SALES_GRADED` reads `market_names` outcome=sold; depends_on adds CR-075 (Dvir approved the data program (knowledge/data-program-v1.md) at 00:12 IDT Oct 21, via Gavriel).

<!-- DOM writes below this line -->

## DOM response (2026-10-21): accepted; built with CR-071 (v5.22.0)

- **As written:**
  - The endpoint `GET /candidates/closeouts` and its filters with stable codes: `SPELL-1`, `BRAND-1`, `BIGCO-1`, `TM_KILL`, `FORBIDDEN_TERM`, `DIGITS_OR_HYPHEN`, `OWNED`, `SALES_GRADED`.
  - The summary, and 409 `SNAPSHOT_MISSING`.
  - `source=drops` uses the kept drop-list names.
- **Q1:** the scores are computed once in the CR-071 job (an offline score, no live registry calls) and stored with the pool rows. The endpoint only reads them. A failed score is `score: null` with a reason.
- **Dynadot rows:** none appear until a Dynadot key exists (CR-071). `source=dynadot` answers 409 `SNAPSHOT_MISSING` for those days.
