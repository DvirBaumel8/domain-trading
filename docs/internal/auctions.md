# Auction bid plans (CR-077, v5.39.0)

Auctions are the main S8 buying line (founder rule 5; at most `settings.s8_max_price_cents` = $250 a name, each with Dvir's approval). This file holds the binding rules and test ids. Code: `src/modules/selection/prebid.ts` (the automatic checks), `src/modules/ops/auctions/plans.ts` (plan logic), `src/modules/ops/api/auctions.ts` (routes), `src/modules/ops/api/portfolio-import.ts` + `ops/admin/import-domain.ts` (the import rule). Tests: `tests/modules/ops/auction-plans.test.ts` (AB539-*), helper `tests/helpers/bid-plans.ts`.

## Flow
prebid (`POST /auctions/prebid`) -> plan (`POST /auctions/plans`, Dvir's line names the maximum) -> bid by hand at the venue -> result (`POST /auctions/plans/{id}/result`) and, for a won name, `POST /portfolio/import`.

## Rules
1. **Prebid checks only registered names**: no availability, price or quote check. Every check is PASS, FLAG, FAIL or SKIP. A check that could not be read is a FLAG (never a pass); only a source switched off by its setting (`sources.surbl`, `sources.popularity`, no Web Risk or Companies House key) is SKIP. Verdict: any FAIL -> `fail`, else any FLAG -> `flag`, else `pass`. The first failing name rule (SPELL-1, BRAND-1, BIGCO-1, TM_KILL) is the FAIL; the later ones are SKIP.
2. **Manual items** (EXACT_STRING_BUSINESS, HIST_WAYBACK) are never automated; the plan must confirm both (`checked: true` + a note). The USPTO trademark search is also manual in the whole service; the prebid covers only the loaded kill terms (TM_KILL).
3. **Prebid is a normal mutating POST** (stores a row): WRITE or bots, Idempotency-Key, audited. `prebid_checks` is append-only.
4. **A plan needs**: an approval validated by `core/approval` (names the domain, <= `settings.approval_max_age_hours`, not future) whose text also names the maximum bid as a dollar amount (`amountsNamed`); a prebid of this name and venue made within the same window with verdict not `fail`; `max_bid` <= the S8 cap (400 `S8_PRICE_CAP`); above $50 `reasons.comparables` or `reasons.other_endings`; kind `closeout` only while `settings.s8_closeouts_allowed` (default false, migration only); an `auction` needs a future `auction_end_at`. One open plan per name (partial unique index + advisory lock `bid_plan:<domain>`). DOM never generates the approval text.
5. **Statuses**: open, won, lost, withdrawn, expired. `expired` is computed in reads for an open plan whose auction ended more than 7 days ago; a new plan for the name stores it (event) so the open-plan rule does not block. Every change is a `bid_plan_events` row (append-only): created, won, lost, withdrawn, expired, imported.
6. **Result**: from open (or computed-expired) only; `won` needs a price and refuses one above the maximum (409 `PRICE_ABOVE_PLAN`, nothing recorded); `lost` may carry the winning price; `withdrawn` takes none. It books nothing.
7. **Import (lane S8, API only)**: needs a plan stored `open` (not computed-expired) or `won`; checked after the S8 price cap and slot checks; price <= `max_bid` (409 `PRICE_ABOVE_PLAN`); no plan 409 `BID_PLAN_REQUIRED`. `approval_ref` may be left out when a plan exists: the plan's approval is used (founder rule 1: Dvir approved this name and price when the bid was committed; an auction may end after the 72 h window); a given `approval_ref` is validated as before, first. In the import transaction an open plan becomes `won` with `final_price = price_paid`; a won plan gets an `imported` event. The ledger note says `bid plan <id>`; the audit row summary names the plan and whether the approval came from it. A dry run reports `would_be_blocked`. The admin `import-domain` command does not enforce plans.
8. Plans and results are WRITE only (`write_only` in `BOTS_ROUTES`); prebid is `allowed` for bots.

## Test ids
| ID | What |
|---|---|
| AB539-1 | clean name: all checks, manual items, endings, cap, stored, audited |
| AB539-2 | brand hit FAIL, later rules SKIP, append-only prebid_checks |
| AB539-3 | RDAP flags, not registered, tm_kills FAIL |
| AB539-4 | Web Risk FAIL with a key |
| AB539-5 | scopes, key required, validation, replay |
| AB539-6 | plan 201, event, audit, GET list and one |
| AB539-7 | approval validation and the amount rule |
| AB539-8 | `amountsNamed` unit |
| AB539-9 | above $50 reasons |
| AB539-10 | `CLOSEOUTS_PAUSED` |
| AB539-11 | prebid requirements (`PREBID_REQUIRED`, `PREBID_FAILED`) |
| AB539-12 | one open plan, expiry |
| AB539-13 | body rules, `S8_PRICE_CAP`, bots 403 |
| AB539-14 | idempotent replay |
| AB539-15..18 | results (won, above max, lost, withdrawn, closed, scope, stale) |
| AB539-19 | `bid_plan_events` append-only |
| AB539-20..24 | import under a plan (required, approval from plan, above plan, won plan, lost/expired plans) |
The S8 import tests S8-1..S8-19 (`tests/modules/buying/s8-import.test.ts`) keep their assertions; their `post` helper creates a plan (not when the body has no `approval_ref`, S8-1).

## Follow-ups
`transfer_pending` at import (RDAP registrar vs buying registrar) and the after-auction transfer check: the safety release. Plan `kind` vs import `source` is not compared.
