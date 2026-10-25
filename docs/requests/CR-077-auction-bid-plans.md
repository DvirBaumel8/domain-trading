> Status: DOM: accepted (own request, built in release v5.39.0)

# CR-077: auction bid plans (pre-bid check, approved maximum bid, real result, import enforcement)
| Field | Value |
|---|---|
| CR id | CR-077 |
| From | DOM (own request) |
| Requested by | Dvir, 25 Oct 2026 ("build") |
| Date | 2026-10-25 |
| Approved by Dvir | 25 Oct 2026, "build" (auctions are the main buying line; cap $250 a name since v5.36.0) |
| Priority | P1 |

## 1. Business need
Auctions (GoDaddy and Dynadot public expired-name auctions, lane S8, at most `settings.s8_max_price_cents` = $250 a name) are the main buying line. Today the server sees an auction name only after it is bought (`POST /portfolio/import`). No safety or demand check runs before money is bid, nothing enforces the maximum bid, and what an auction name really cost is not recorded as a learning signal. Background: `docs/research/funnel-names-safety-2026-10.md` §5-6, `docs/research/auctions-playbook.md` §2 and §5.

## 2. Rules
- R-1 **Pre-bid check.** `POST /auctions/prebid {domain, venue}` runs the existing automatic safety checks that make sense for an already registered .com (name rules SPELL-1, BRAND-1, BIGCO-1, TM_KILL; TYPO-1; SURBL-1; Google Web Risk when a key exists; the name's own RDAP status flags; the same name on .net .org .co .io .ai; UK company names), never availability, price or a quote. A source that cannot be read is a FLAG, never a pass. The answer carries `verdict` (pass, flag, fail), the checks, the endings, `manual_required` (EXACT_STRING_BUSINESS, HIST_WAYBACK) and the S8 cap. Every answer is stored (`prebid_checks`, append-only) and returned with `prebid_id`.
- R-2 **Bid plan.** `POST /auctions/plans` (WRITE only) records Dvir's approval of one name at one maximum price: `approval_ref` validated by the shared validator and its text must name the maximum bid amount; `prebid_id` of this name and venue, made within the approval window, verdict not `fail`; both manual checks confirmed with a note; reasons (`buyers` always; above $50 `comparables` or `other_endings` too); `kind: closeout` refused while `settings.s8_closeouts_allowed` is false; one open plan per name.
- R-3 **Result.** `POST /auctions/plans/{id}/result` (WRITE only): won (with price), lost (price optional), withdrawn. A won price above the maximum bid is refused and nothing is recorded. An open plan whose auction ended more than 7 days ago reads as `expired` (computed).
- R-4 **Import enforces the plan.** `POST /portfolio/import` for lane S8 needs an open or won plan for the name and a paid price at or under its maximum bid. When a plan exists `approval_ref` may be left out (the plan carries the approval, because an auction can end after the 72 h window).
- R-5 Every status change is an append-only `bid_plan_events` row.

## 3. Acceptance criteria
Test ids AB539-1..24 in `tests/modules/ops/auction-plans.test.ts`; rules in `docs/internal/auctions.md`.
- AC-1 A clean registered name: prebid 201, verdict pass or flag, all checks present, the row stored. (AB539-1)
- AC-2 A brand-list hit or a tm_kills term: FAIL and verdict fail; a failed check gets no plan (409 `PREBID_FAILED`). (AB539-2, 3, 11)
- AC-3 RDAP holds and not-registered are FLAG; Web Risk listed is FAIL. (AB539-3, 4)
- AC-4 Plan: approval missing, wrong name, old, future or not naming the maximum bid: 422 `APPROVAL_INVALID` / `APPROVAL_EXPIRED`. (AB539-7, 8)
- AC-5 Above $50 without reasons: 422; closeout: 409 `CLOSEOUTS_PAUSED`; old, other-name or missing prebid: 409 `PREBID_REQUIRED`; second open plan: 409 `BID_PLAN_EXISTS`. (AB539-9..12)
- AC-6 Result: won above the maximum: 409 `PRICE_ABOVE_PLAN`, nothing recorded; closed plan: 409 `BID_PLAN_CLOSED`. (AB539-15..18)
- AC-7 Import: no plan 409 `BID_PLAN_REQUIRED`; price over the maximum 409 `PRICE_ABOVE_PLAN`; with a plan and no `approval_ref` it succeeds and the plan becomes won with the paid price. (AB539-20..24)
- AC-8 Existing S8 import tests S8-1..S8-19 keep every assertion; only their setup creates a plan.

## 4. Open questions for DOM
None at request time. Answered in the response below.

<!-- DOM writes below this line -->
## DOM response (2026-10-25)
Accepted and built in v5.39.0 (contract MINOR). Decisions and deviations from the request text:
1. **Prebid is a normal mutating POST** (Idempotency-Key, audit row, WRITE or bots), not a read-only POST like `POST /score`: it stores its answer, and `READ_ONLY_POSTS` routes must write nothing the caller owns. A READ token is therefore 403 on it. Bots may call it (`allowed` in `BOTS_ROUTES`: no money, price or listing).
2. **Plans and results are `write_only`** in `BOTS_ROUTES` (Gavriel holds WRITE; a bots token is 403 even with `dry_run: true`).
3. **Storage:** `bid_plans` keeps the current status (mutable), `bid_plan_events` is the append-only history of every change, `prebid_checks` is append-only. All three are in the backup.
4. **Check ids** are rule names (SPELL-1, BRAND-1, BIGCO-1, TM_KILL, TYPO-1, SURBL-1, WEB-RISK-1) plus RDAP_STATUS, SAME_NAME_ENDINGS, UK_COMPANY. The lookalike hyphen/prefix variants are not run (only the five endings). The USPTO search stays manual and is not a separate `manual_required` item (the request names two; TM_KILL is the loaded kill-term list only).
5. **Expired stale plan:** `expired` is computed in reads; when a new plan is created for a name whose open plan is more than 7 days past its end, that plan is stored as `expired` (event row) so the one-open-plan rule does not block. A computed-expired plan does not allow an import and does not block a new plan; its result can still be recorded.
6. **Import:** the plan check runs after the S8 price cap and slot checks (so `S8_PRICE_CAP` and `S8_SLOTS_FULL` keep their order), a dry run reports `would_be_blocked: "BID_PLAN_REQUIRED" | "PRICE_ABOVE_PLAN"`. The admin `import-domain` command is not affected. The plan `kind` is not compared with the import `source`.
7. **Closeouts:** an already bought closeout cannot be imported while `s8_closeouts_allowed` is false (no plan can be made). Intended (Dvir: no money on closeouts until the pick-proof edge).
8. **Not built (follow-up):** `transfer_pending` from RDAP at import time, planned with the after-auction transfer check in the safety release.
