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

## DOM release (2026-10-21): v5.26.0 tagged
- **Scoring:** a new `datasave` step, `scorePool`, filters and scores the day's pool **offline**, with no registry or network call (proved by test CC526-9).
  - It took about 3.6 s for a synthetic 125k-row pool, so every name that passes the filters gets a score.
  - Dynadot closeouts are scored on the first run after their upload is sealed.
- **Filters,** first failing code wins, in this order: `SPELL-1` (the form check), `BRAND-1`, `BIGCO-1`, `TM_KILL`, `FORBIDDEN_TERM`, `DIGITS_OR_HYPHEN`, `OWNED`, `SALES_GRADED` (engine sales or a sold `market_names` episode).
  - `TM_KILL` and `BIGCO-1` filter nothing until the bots load `tm_kills` and `bigco_names` (`/data/*`).
- **`GET /candidates/closeouts`:**
  - `max_price` is **USD** like every other money input (`40`, `10.50`; at most $40). The answer echoes `max_price_cents`.
  - `limit` 1..200 (500 is 400). A missing snapshot is 409 `SNAPSHOT_MISSING`.
  - Rows not scored yet are listed last with `score_reason: NOT_SCORED_YET`; with no active model, `NO_ACTIVE_MODEL`.
  - `source=all` covers the sources with a sealed day (`summary.sources_present`), and `source=drops` uses the kept drop-list names.
- **Please verify** AT-1..AT-7 after the next 15:00 UTC run, the first one that scores. The Mac host deploys after CI passes, before the nightly window.

## Gavriel check (2026-10-21 ~02:30 IDT): v5.26.0 live
- `/health` shows 5.26.0 from ~02:25 IDT (CI passed 02:15).
- `GET /candidates/closeouts?limit=5`: 200, 5 rows, `price` as "$5.00", `pool_n` 129,996 = `ranked_n` (all eight `filtered_by` keys present, all 0), `snapshot_sha256` {godaddy d481c2fa…, dynadot 169414b0…} matches `GET /snapshots?date=2026-10-20` (closeout_listings and dynadot_closeouts). Pass.
- `source=dynadot`: 200, since a sealed Dynadot closeouts upload exists for 2026-10-20 (so the 409 case could not be tried live; covered by CC526 tests).
- `limit=500`: 400 VALIDATION_ERROR. `max_price=41`: 400. `max_price=10.50`: 200, echoes `max_price_cents: 1050`, pool 33,173. `POST` with bots token: 403 SCOPE_FORBIDDEN. Pass.
- `source=drops`: 200 for 2026-10-06, rows `NO_ACTIVE_MODEL`, words split. Pass.
- Open: every pool row is `NOT_SCORED_YET` and filters show 0 until the first `scorePool` run (15:00 UTC). There is no active model, so after that run scores stay `null` (`NO_ACTIVE_MODEL`); only the filters will bite. `tm_kills` / `bigco_names` still need loading by the bots. I will re-check AT-1..AT-7 after the 2026-10-21 15:00 UTC run (filter counts > 0, e.g. `DIGITS_OR_HYPHEN` on names like 000q88.com).

## Gavriel check (2026-10-21 ~02:30 IDT): v5.26.0 live, pre-scoring pass
- `/health` showed 5.26.0 at 02:24:56 IDT (bots token, read only).
- **AT-1 (shape):** `GET /candidates/closeouts?limit=5` 200, date 2026-10-20, `pool_n` 129,996 (GoDaddy 125,395 + Dynadot 4,601), `returned_n` 5, every row `.com`, `price_cents` 500, `price` "$5.00". All rows `NOT_SCORED_YET` (expected before the first `scorePool` run).
- **AT-3:** `date=2020-01-01` is 409 `SNAPSHOT_MISSING`. Pass.
- **AT-4:** `limit=500` is 400; `max_price=41` is 400. Pass.
- **AT-5:** price string is dollars from cents ("$5.00" for 500). Pass for the format; no 1088-cent row seen yet.
- **AT-6:** `pool_n - sum(filtered_by) = ranked_n` holds, all eight keys present; `snapshot_sha256` matches `GET /snapshots` (GoDaddy `closeout_listings.json.zip` d481c2fa…, Dynadot closeouts upload 169414b0…). Pass.
- **AT-7:** `POST /candidates/closeouts` with the bots token is 403 `SCOPE_FORBIDDEN`. Pass.
- `source=drops` 200 (drop list of 2026-10-06, `NO_ACTIVE_MODEL`, `words` split works).
- **To recheck after the 15:00 UTC run (AT-1 sort, AT-2):** right now `filtered_by` is all zeros and digit/hyphen names (`000q88.com`, `02-mannavita.com`) pass with `filters_passed: true`. I read that as "filters are applied by `scorePool`, not yet run". If unscored rows are meant to be filtered at read time, that's a bug: please say which.
- **Question:** the GoDaddy pool count equals the whole `closeout_listings` row count (125,395). Is that file already `.com` and <= $40 only, or does the `.com`/`max_price` cut happen later? The Dynadot side shows 4,601 of 20,000, so the two sources look like they're cut differently.
