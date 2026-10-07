# CR-005: Bugs from the v2.0.2 acceptance run, testability through the API, and the .com price rise

**From:** Gavriel (requester, on Dvir's behalf)
**Status:** OPEN, approved by Dvir on 2026-10-07 10:33 IDT
**Contract base:** v2.0.2

## 1. Business need
On 2026-10-07 (09:16 to 09:41 IDT) Gavriel ran a full acceptance test of the live API (`https://domain-trading-api.onrender.com`, `GET /health` version 2.0.2) against every contract file. All 48 routes exist and behave to contract wherever they could be reached. The run found one major problem (the scheduled jobs are not running), five small behaviour bugs and three documentation gaps (§4).

It also showed that about half of the documented behaviour can't be checked from outside today. 151 of 280 route error codes were produced; the rest need an owned domain, money, a real buy, the job token, months of elapsed time, or state changes that would stick forever. **Dvir wants everything in the software to be testable by Gavriel through the API alone**, without a real purchase and without waiting months. §5 lists what that needs.

Last, .com prices go up on 2026-11-01, and today's contract has no way to know about a dated price change (§6).

Sources: our acceptance report `qa/acceptance-v2.0.2-full.md` and its request log `qa/acceptance-v2.0.2-full.json`; a read-only recheck of `GET /audit`, `GET /tranches`, `GET /health` and the bad-URL request on 2026-10-07 at 09:44 IDT; DOM's contract files and release notes at commit `2c91250`; our `system/registrar-setup.md` §5 and `research.md` for the price rise.

## 2. Scope
In scope: the bugs and docs gaps in §4; the testability needs in §5; the dated price change in §6.
Out of scope: any purchase; any change to caps, approval rules or founder rules; the Sedo template and D-001 (both in CR-004); Dynadot (CR-003, dropped).
How DOM builds anything here is DOM's choice. Where today's contract already does what we need, "already supported, here is how" is the best answer. DOM's `docs/requests/README.md` asks for one BUG file per bug; they are bundled here so Dvir approves one document. DOM may split them (Q-3).

## 3. Safety rules for everything in this CR
These apply to every bug fix, every testability need and the price item.
1. **S-1** Nothing here may cause a real purchase, real money movement, or a real change at a registrar or marketplace (registration, renewal, nameservers, privacy, auto-renew, listing, top-up).
2. **S-2** No test mode, test token or test switch may weaken a production rule: the $1,500 and 50-domain caps, the `approval_ref` rules, the screening pack and tranche gates, and the append-only guarantees stay exactly as they are for real calls.
3. **S-3** Test data never mixes with real data. Anything made in a test mode or test environment never appears in the real `/portfolio`, `/ledger`, `/report`, exports or caps, and every test response says plainly that it is a test (for example a `test: true` field).
4. **S-4** A test credential can never reach a real registrar or marketplace, and a real credential can never switch a test fault on.
5. **S-5** Every test call is audited like any other call.
6. **S-6** Nothing here may add a paid service. If DOM finds that a need can't be met at $0, mark it **DVIR** in the reply and say what it would cost.

## 4. Bugs and docs gaps
Every reproduction below is a `GET` or a request the service refuses. None creates anything. Use a timeout of at least 60 s (cold start). Times are IDT (UTC+3).

### BUG-1 (MAJOR, URGENT): scheduled jobs are not running
- **Contract:** `jobs.md` §`POST /jobs/run` ("Audit: one `audit_log` row with scope `job`" per run, for example `tick: ok`), §Schedules (`tick` hourly at :05 UTC; `daily` at 00:05 UTC), §What bots can rely on ("a stuck purchase resolves within about 90 minutes"; "`/report` warnings reflect the last daily run"). DOM commit `1a47357` (2026-10-07 00:43 IDT) set one cron, hourly at :05 and daily at 00:05 UTC.
- **Steps:**
  1. `GET /audit?limit=200` with Gavriel's token.
  2. Look at rows with `scope: "job"`.
- **Expected:** one `tick` row about every hour at :05 (01:05, 02:05 ... 09:05 IDT, so 9 rows by 09:39), and one `daily` row at about 03:05 IDT (00:05 UTC) on 2026-10-07.
- **Actual (rechecked 2026-10-07 09:44 IDT):** 190 rows, oldest `2026-10-07T00:08:40+03:00` (`token create`, when the database was created), newest `09:39:22+03:00`. `limit=500` returns the same 190 rows. There are exactly two job rows, and neither is from the schedule:
  - `01:01:26` method `JOB`, path `registrar-check`, `checked 0; present 0; absent 0; errors 0`
  - `01:01:28` `POST /jobs/run`, scope `job`, `daily: ok`, idempotency key `manual-daily-1791324086` (a manual run; the scheduler's keys are `<job>-<scheduled time in ms>`).
  There are **zero** `tick` rows (so no `reconciler`, `nsVerifier` or `screeningResume` run is recorded) and no scheduled `daily` row. The job token is configured: a WRITE token on `/jobs/run` gets 401, not 503 `JOBS_DISABLED`.
- **Why it matters:** either the scheduler isn't calling, or ticks run but aren't audited. Both break the contract. With no purchases or holdings yet, nothing has been lost so far, but once the first real buy is made an unknown purchase would never settle, price drops and drops would never apply, and the nameserver and ownership checks would never run.
- **Acceptance tests:** BG-1, BG-2. N-1 and N-2 (§5) are there so this can't go unseen again.

### BUG-2 (minor): some responses use UTC `Z` timestamps instead of the Asia/Jerusalem offset
- **Contract:** `README.md` §Conventions › Time: responses use the Asia/Jerusalem offset (`+03:00` IDT / `+02:00` IST). The only UTC exceptions are `uploaded_at` on `/export/{venue}/uploaded` and `started_at` / `finished_at` on `/jobs/run`.
- **Steps:** `GET /tranches` (rechecked 09:44 IDT). The same is seen in `GET /report` `tranches[]`, `GET /screening/runs/{id}`, `GET /screening/packs/{id}`, `POST /screening/runs/{id}/manual` and `POST /quotes/manual` responses.
- **Expected:** `opened_at: "2026-10-07T00:15:42+03:00"`.
- **Actual:** `opened_at: "2026-10-06T21:15:42.359Z"`. Also `Z`: screening run `created_at`, `finished_at`, `results[].checked_at`; pack `issued_at`, `content.screened_at`, `gates[].checked_at`; manual result `checked_at`, `data_as_of`; manual quote `valid_until` (`2026-11-06T06:22:24.000Z`). `/audit`, `/check` and `/selection/settings` are correct. First seen in the v2.0.0 run, still present.
- **Acceptance test:** BG-3.

### BUG-3 (minor): a `text/plain` body gets 422 instead of 415
- **Contract:** `README.md` §Errors: `INVALID_BODY` 400/413/415 (unparseable JSON, body over 64 KB, **wrong content type**).
- **Steps:** `POST /buy` with `Content-Type: text/plain`, body `hello`, a fresh `Idempotency-Key`, WRITE token.
- **Expected:** 415 `INVALID_BODY`.
- **Actual:** 422 `VALIDATION_ERROR`, `details.issues[0]`: `{path: "", message: "Invalid input: expected object, received string"}`. With `Content-Type: application/xml` the answer is the correct 415 `INVALID_BODY`, so only `text/plain` gets through. Bad JSON (400) and an oversize body (413) are correct.
- **Acceptance test:** BG-4.

### BUG-4 (minor): `/offers/{id}/outcome` checks the id before the body
- **Contract:** `endpoints.md` §`POST /offers/{id}/outcome`: "`id` = the offer id (digits; anything else gives 404 `OFFER_NOT_FOUND`, **but an invalid body is checked first and gives 422**)".
- **Steps:** `POST /offers/abc/outcome` with body `{"outcome":"maybe"}`, a fresh key.
- **Expected:** 422 `VALIDATION_ERROR`.
- **Actual:** 404 `OFFER_NOT_FOUND` (`"Offer not found"`).
- **Acceptance test:** BG-5.

### BUG-5 (minor): replacing a locked parent setting gives `SETTINGS_INVALID`, not `SETTINGS_KEY_LOCKED`
- **Contract:** `endpoints.md` §`POST /selection/settings`: 422 `SETTINGS_KEY_LOCKED` for `tier.p_passive`, `lead.p_lead` and `priors_v91`, "whether by a leaf path **or by replacing a parent**", with `details.path`.
- **Steps:** `POST /selection/settings` with `{"label":"v1","set":{"tier.p_passive":0.1}}` (label `v1` already exists, so nothing can be created).
- **Expected:** 422 `SETTINGS_KEY_LOCKED`, `details.path: "tier.p_passive"`.
- **Actual:** 422 `SETTINGS_INVALID`, `details.issues: [{path: "tier.p_passive", message: "Invalid input: expected record, received number"}]`. Leaf paths are refused correctly: `tier.p_passive.A` and `priors_v91.p_passive.S3` give `SETTINGS_KEY_LOCKED`. Only replacing the parent is wrong.
- **Acceptance test:** BG-6.

### BUG-6 (minor): a malformed percent-encoding in the path gives a Cloudflare 520
- **Contract:** `README.md` §Who may call and §Errors: framework rejections such as bad URL encoding are answered with `INVALID_REQUEST` (4xx) in the error shape.
- **Steps:** `GET /portfolio/%E0%A4%A` with a valid token (rechecked 09:44 IDT).
- **Expected:** a 4xx `INVALID_REQUEST` in the shape `{error: {code, message, details}}`.
- **Actual:** HTTP 520 from Cloudflare ("The origin web server sent a response that Cloudflare could not parse"), no service error body.
- **Acceptance test:** BG-7.

### DOCS-1: the route table in `endpoints.md` is incomplete and labelled v1.0.0
- **Contract:** the table at the top of `endpoints.md`, which says a test fails if a registered route is missing from it.
- **Found:** the table lists 35 of the 48 documented routes. Missing (all live and documented further down the same file): `POST /screening/runs`, `GET /screening/runs/{id}`, `POST /screening/runs/{id}/manual`, `POST /screening/runs/{id}/verdicts`, `GET /screening/evidence/{id}`, `POST /quotes/manual`, `POST /screening/packs`, `GET /screening/packs`, `GET /screening/packs/{id}`, `GET /tranches`, `POST /tranches`, `POST /tranches/{id}/members`, `POST /tranches/{id}/close`. The header says "contract v1.0.0" (so does `jobs.md`) while `README.md` says 2.0.2.
- **Acceptance test:** BG-8.

### DOCS-2: the code index is incomplete
- **Contract:** `README.md` §Errors: "The code index at the end of `endpoints.md` lists every code the service emits."
- **Found:** route error codes missing from the index: `MANUAL_REQUIRED` (409 on `POST /tranches/{id}/members`), `RUN_RUNNING` (409 on `POST /screening/packs`), `PACK_NOT_FOUND` (404 on `GET /screening/packs/{id}`), `JUDGED_AT_INVALID` (on `POST /screening/packs`). While drafting this CR we also found `SCREENING_PACK_REQUIRED` and `NO_TRANCHE` (409 on `POST /buy`, since v2.0.0) missing from "Buying errors". Listed in the index but documented on no route: `LABELLED_NAME_CONFLICT`.
- **Acceptance test:** BG-9.

### DOCS-3: when `SUITE_UNKNOWN` is given on `/selection/replays` is not defined
- **Contract:** `endpoints.md` §`POST /selection/replays` lists both 422 `SUITE_NOT_DEFINED` and 422 `SUITE_UNKNOWN` but defines only the first.
- **Steps:** `POST /selection/replays` with `{"suite":"QA-XYZ","mode":"holdout",...}` (a suite that isn't in `holdout.required_suites`).
- **Found:** 422 `SUITE_NOT_DEFINED`. On `/selection/holdout-suites` the same kind of name gives `SUITE_UNKNOWN` (`details.required_suites`). Either answer may be right; the contract has to say which, and when the other one is given.
- **Acceptance test:** BG-10.

## 5. Testability needs (N-1 to N-11)
The goal: Gavriel can test every documented behaviour through the API, safely (§3), without a real purchase and without waiting for real time to pass. Today's gaps, from §7 and §8 of our report, are below. For each need we give inputs, outputs and rules; field and route names are suggestions, and DOM chooses the final names. Several needs depend on a **test environment** (N-3); Q-4 asks DOM how to provide one at $0.

### N-1 Job runs read
- **Need:** see every job run and every step's result. Today `/audit` shows only a one-line summary, and only the scheduler sees the step summaries.
- **Input:** READ token; filters `job?` (`tick` | `daily`), `since?` (ISO with offset), `limit?` (1 to 500).
- **Output, per run, newest first:** `job`, `trigger` (`scheduled` | `manual` | `test`), `scheduled_for` (the slot it was meant for, or null), `started_at`, `finished_at`, `skipped`, `steps: {<step>: {ok, skipped?, error?, summary}}`, using the step names and summary fields already in `jobs.md`. Plus, per job: `last_run_at`, `last_ok_at`, and `next_due_at`.
- **Rules:** read-only. Secrets, repo URLs and tokens never appear. A failed or skipped run is listed like any other.
- **Errors:** 400 `VALIDATION_ERROR` for a bad filter.
- **Tests:** TS-1, TS-2.

### N-2 Missed-schedule warning
- **Need:** BUG-1 was found only by counting audit rows by hand. The service should say so itself when the schedule stops.
- **Output:** a `/report` warning (suggested `JOB_OVERDUE`, level `error`) when no `tick` has finished in the last 2 hours or no `daily` in the last 26 hours, with `details: {job, last_run_at, expected_every}`. `GET /health` may also show it.
- **Rules:** thresholds as settings with these defaults. A manual run counts as a run, but N-1 shows which runs were scheduled.
- **Tests:** TS-3.

### N-3 Test environment with a test registrar and test data
- **Need:** most untested codes need an owned domain, registrar money, or a registrar answer we can't cause: the real-buy gates and outcomes (`BUY_HOLD`, `SCREENING_PACK_REQUIRED` with each `details.reason`, `NO_TRANCHE`, `TRANCHE_SPEND_CAP`, 201, 202 `PURCHASE_STATE_UNKNOWN`, `POC_CAP_EXCEEDED`, `DOMAIN_CAP_REACHED`, `REGISTRAR_DRY_RUN_FAILED` / `_AMBIGUOUS`, `REGISTRAR_STATE_UNKNOWN`, `REGISTRAR_AUTO_TOPUP_ON`, `REGISTRAR_REJECTED`, `PURCHASE_ABANDONED` / `_FAILED`, `post_buy` warnings), about 40 `/list` rule codes, the offer and sale rules, `DOMAIN_LEFT_ACCOUNT`, `NS_UNVERIFIED`, a FLAG result for verdicts, and every `/report` warning.
- **Input:** a test environment (a separate instance or a test mode, DOM's choice, Q-4) where Gavriel, with a **test token**, can:
  1. set the test registrar's answers: balance, auto-recharge on or off, and the outcome of the next dry run and register (`ok` | `ambiguous` | `rejected` | `insufficient_funds` | `state_unknown`), and the outcome a later reconciler read finds (`registered` | `absent`);
  2. set which names the test registrar account holds (for the daily ownership check) and which nameservers public DNS shows for a test name (for the nameserver check);
  3. load fixture data: owned and listed test domains with a chosen category, buy date, expiry, drop date and listing; logged offers; a screening run with a FLAG result; a second settings version; a tranche with members.
- **Output:** the same routes and response shapes as production, each response marked as a test (S-3). Test registrar purchases book ledger rows in the test environment only.
- **Rules:** S-1 to S-6. The test registrar never calls a real registrar. Caps, approvals and gates work exactly as in production. Gavriel can reset the test environment to empty.
- **Errors:** a test-only call with a real token is refused (suggested 403 `TEST_ONLY`); a production-only call that would touch a real registrar with a test token is refused.
- **Tests:** TS-4, TS-5, TS-6, TS-7.

### N-4 Job dry run with a simulated date
- **Need:** `priceJob` drops happen at month 6 and later, `dropJob` after about two years, and report thresholds after 7 to 30 days. We can't wait, and Gavriel may not hold the job token. `jobs.md` already shows `today` and `dryRun` in the `priceJob`, `dropJob` and `registrarCheck` summaries.
- **Input:** WRITE token (or a scoped test token), `{job: "tick" | "daily", dry_run: true, today?: "YYYY-MM-DD"}` (`today` defaults to the real IDT date; it may be up to 3 years ahead).
- **Output:** the normal job response plus, per step, what would happen: `would_apply[]`, `would_supersede[]`, `held[]`, `would_delist[]`, `would_drop[]`, `would_book[]`, `would_fail[]`, `newly_absent[]`, and the `/report` warnings that would appear.
- **Rules:** writes nothing but the audit row (scope `job`, trigger `test`); never calls a registrar or marketplace to change anything; a dry run never counts as a run for N-2. In production it runs on real data. In the test environment (N-3) it may also run for real (`dry_run: false`) on test data.
- **Errors:** 422 `VALIDATION_ERROR` (bad job, bad date, date out of range).
- **Tests:** TS-8, TS-9.

### N-5 Reference data and backup status
- **Need:** `referenceRefresh` keeps the previous snapshot when a sub-step fails, but no route shows which snapshot is in use. `backupExport` is visible only to the scheduler. Dvir dropped the backup drill on 2026-10-07 (DOM's `docs/internal/gaps.md` G-79), so we expect `skipped`; we only want to see that.
- **Input:** READ token.
- **Output:** `{popularity: {list_id, list_date, rows, refreshed_at}, iana: {refreshed_at}, namebio: {enabled, cache_date}, last_error?: {step, at, message}, backup: {configured, last_status, last_ok_at | null, reason}}`.
- **Rules:** read-only; no repo URL, key or secret.
- **Tests:** TS-10.

### N-6 Validate-only mode for state-changing routes
- **Need:** settings drafts, activation, list versions, holdout-suite freezes, tranche create, add and close, and export confirmations change state for good (a version can be activated once; a failed holdout replay sticks). So their refusals (`SETTINGS_ALREADY_ACTIVE`, `SETTINGS_ALREADY_ACTIVATED`, `HOLDOUT_NOT_PASSED`, `SUITE_OVERLAP`, `TRANCHE_FULL`, `GEO_CAP`, `TRANCHE_BELOW_TARGET`, `MAIN_LANE_QUOTA`, `EXPORT_ALREADY_CONFIRMED` and others) can't be tested in production.
- **Input:** `dry_run: true` in the body of `POST /selection/settings`, `/selection/settings/{label}/activate`, `/selection/lists/{name}`, `/selection/holdout-suites`, `/tranches`, `/tranches/{id}/members`, `/tranches/{id}/close` and `/export/{venue}/uploaded`.
- **Output:** the success body the real call would return, with `dry_run: true`, or the exact error the real call would give.
- **Rules:** writes nothing but the audit row. All checks run, including `approval_ref`. A dry-run activation reads existing holdout replays only; it never scores a test slice and never records a replay, so it can't contaminate a holdout (Q-10).
- **Tests:** TS-11, TS-12.

### N-7 Strict dry run for the real-buy gates
- **Need:** a dry-run `/buy` reports the real-buy gates only in `would_be_blocked` and then stops at `REGISTRAR_FUNDS` (Porkbun stays at $0 by policy). The gate codes themselves are never produced.
- **Input:** `POST /buy` with `dry_run: "strict"` (or another flag DOM prefers).
- **Output:** the first refusal a real buy would get, as the error: `BUY_HOLD`, `SCREENING_PACK_REQUIRED` (with `details.reason` and `details.pack_id`), `NO_TRANCHE`, `TRANCHE_SPEND_CAP` (with its details), in the contract's check order; else the same result as today's dry run.
- **Rules:** exactly the same as `dry_run: true` for side effects (§Guarantees 3). Never registers or charges.
- **Tests:** TS-13.

### N-8 Rate-limit visibility and test credentials
- **Need:** testing the per-token limits (60 GET / 10 POST per minute) or the failed-auth limiter (20 failures in 10 minutes) would lock out Gavriel's only token. No response carries rate-limit headers today (checked on `GET /tranches`, 09:44 IDT). There is also no READ token, so 403 `SCOPE_FORBIDDEN` can't be tested.
- **Input:** (a) every response carries the limit, the remaining count and the reset time for the caller's token and scope (suggested `RateLimit-Limit`, `RateLimit-Remaining`, `RateLimit-Reset`); (b) a test token with low limits (for example 3 GET and 2 POST per minute) that works only in the test environment (N-3); (c) a READ token for Gavriel.
- **Rules:** a 429 never claims an `Idempotency-Key` (as today). The failed-auth limiter is testable in the test environment only, from its own address, so Gavriel's real token is never locked out.
- **Tests:** TS-14, TS-15.

### N-9 Fault switch (test environment only)
- **Need:** fault paths can't be caused safely from outside: a 5xx releases the key, `AUDIT_WRITE_FAILED`, `IDEMPOTENCY_KEY_IN_USE`, `DOMAIN_BUSY`, `/health` 503, `PRICING_SETTINGS_MISSING`, `SELECTION_SETTINGS_MISSING` / `_INVALID`, `RUN_RUNNING`, `VERDICT_RESULT_STALE`, and a stalled screening run (`screeningResume`, partial with `TIMEOUT`).
- **Input:** test token; `{fault, scope?, duration_seconds?}` where `fault` is one of `db_down`, `audit_write_fails`, `internal_error`, `slow_request` (holds a request so a second one with the same key gets `IDEMPOTENCY_KEY_IN_USE`), `domain_lock_held`, `pricing_settings_missing`, `selection_settings_missing`, `selection_settings_invalid`, `screening_stall`. A read shows which faults are on; a call clears them.
- **Output:** each documented route then gives its documented error.
- **Rules:** test environment only (S-4); faults expire by themselves (at most 15 minutes). If DOM prefers, it may instead give test evidence for each fault path in the release note (Q-9), but a switch is what Dvir asked for.
- **Tests:** TS-16, TS-17.

### N-10 `/report` as of a date
- **Need:** report warnings depend on days passing (`EXPIRED_NOT_RENEWED`, `HOLD_STALE` after 30 days, `OFFER_NEEDS_DVIR` after 48 hours, `EXPORT_STALE` after 7 days, `EXPORT_PENDING` becoming an error after 7 days, `PAST_DROP_DATE`, `upcoming_90d` items).
- **Input:** `GET /report?as_of=YYYY-MM-DD` (today up to 3 years ahead). The same for `GET /portfolio/{domain}` if DOM agrees.
- **Output:** the report as it would read on that day with no further calls or job runs, with `as_of` and `simulated: true` at the top.
- **Rules:** read-only. A past date is refused unless DOM can rebuild history exactly (Q-11).
- **Errors:** 400 `VALIDATION_ERROR` (bad or out-of-range date).
- **Tests:** TS-18.

### N-11 Attestations for the negative guarantees
- **Need:** the guarantees "append-only" (ledger, audit, listing history, pricing settings, sale facts), "no secrets in responses", "no outbound contact except the listed sources", "no LLM calls" and "no top-up" can't be proved from outside.
- **Input / output:** (a) a READ route listing the outside hosts the service contacted in the last 24 hours, with a count per host and per job or route, and no request contents; (b) in the next release note, DOM's list of every append-only record type and the automated test that proves each one refuses a change or delete.
- **Rules:** read-only; no secrets.
- **Tests:** TS-19.

## 6. Dated registrar price changes (PR-1)
- **Facts:** Verisign raises the .com wholesale price from **$10.26 to $10.97 (+$0.71) on 2026-11-01 at 04:00 UTC (07:00 IDT)** (ICANN correspondence, Verisign to ICANN, 23 Apr 2026: `itp.cdn.icann.org/en/files/correspondence/stewart-to-lindqvist-23-04-2026-en.pdf`). Porkbun's own page says its .com price will reach about $11.81 (our research; not checked by DOM). More rises of up to 7% a year are possible to 2029.
- **Why it matters:** every name bought today renews after 2026-11-01. But `/check` `two_year` (and so the winner, `max_two_year_price` on `/buy`, and the selection `lifetime_cost`, EV and ratio) uses today's renewal quote. `committed_forward` in `/report` uses each name's stored renewal price, and the replay profit report uses `profit.cost_per_name_year_cents` 1108 ($11.08). None of these knows that a price changes on a date, so each understates costs by at least $0.71 per name-year after the change.
- **Need:** the software accepts a **dated price change** for a registrar and extension and uses the price in force on the date money will actually move.
- **Input:** `{registrar, tld: "com", kind: "first_year" | "renewal" | "both", new_price_usd or change_usd, effective_at (ISO with offset), source_note, source_url?}`. Who may enter it (Gavriel with WRITE, or DOM's admin step on Dvir's word) is for DOM to propose (Q-12).
- **Output:** a read listing the known price changes; every forecast that uses a future price says which price it used (`price_basis: "quote" | "scheduled_change"`, `effective_at`).
- **Rules:**
  1. A live quote taken on or after `effective_at` always wins over a scheduled change.
  2. A forecast for a date on or after `effective_at` (a renewal on expiry, `committed_forward`, the second year in `two_year`) uses the changed price when no newer live quote covers that date.
  3. Past ledger rows never change: they record money that already moved.
  4. Price changes are append-only; a wrong one is corrected by a new entry, not an edit.
  5. Changing a cap or `max_price` behaviour is out of scope; if this changes how `max_two_year_price` is checked, DOM says so and marks it **DVIR**.
- **Errors:** 422 `VALIDATION_ERROR`; 422 `REGISTRAR_UNKNOWN`; an `effective_at` without an offset is refused as today.
- **Tests:** PR-1 to PR-4.
- **Existing data:** please tell us how this affects stored renewal prices, `committed_forward`, stored screening results and packs, stored replay profit reports, and the `profit.cost_per_name_year_cents` setting (Q-13). Today the portfolio and ledger are empty, so 2026-11-01 is the cheapest moment to settle it.

## 7. Errors
No new public codes unless DOM needs one (suggested above: `JOB_OVERDUE` as a warning, `TEST_ONLY`). Any new code goes in the code index with its HTTP status and `details`.

## 8. Acceptance tests (Gavriel runs them through the API)

### Bugs
| ID | Test | Pass when |
|---|---|---|
| BG-1 | After the fix, wait 3 full hours; `GET /audit?since=<fix time>` | at least one scope `job` row per hour for `tick`, each within 10 minutes after :05 UTC, from the scheduler (not a `manual-` key); with N-1, each run shows `trigger: scheduled` and all three tick steps |
| BG-2 | The next 24 hours after the fix | at least 23 `tick` rows and exactly one scheduled `daily` row at about 00:05 UTC (03:05 IDT, or 02:05 IST in winter) with all five daily steps |
| BG-3 | `GET /tranches`, `GET /report`, `GET /screening/runs/{id}`, `GET /screening/packs/{id}`, a new `POST /screening/runs/{id}/manual` and a new `POST /quotes/manual` (in the test environment, or on QA-labelled data as in our run) | every timestamp ends in `+03:00` (`+02:00` in winter); `Z` appears only in the two documented exceptions |
| BG-4 | `POST /buy`, `Content-Type: text/plain`, body `hello` | 415 `INVALID_BODY` in the error shape |
| BG-5 | `POST /offers/abc/outcome` with `{"outcome":"maybe"}`; then with a valid outcome body | first 422 `VALIDATION_ERROR`; then 404 `OFFER_NOT_FOUND` |
| BG-6 | `POST /selection/settings` label `v1` with `set` `{"tier.p_passive":0.1}`; again with `{"lead.p_lead":0.1}` and `{"priors_v91":{}}` | each 422 `SETTINGS_KEY_LOCKED` with `details.path` naming the locked key; no version created |
| BG-7 | `GET /portfolio/%E0%A4%A` with a token | a 4xx `INVALID_REQUEST` in the error shape; never a 5xx or 520 |
| BG-8 | Read `endpoints.md` and `jobs.md` | the table lists all 48 routes; every contract file header shows the current contract version |
| BG-9 | Compare every route error code in `endpoints.md` with the index | no route code missing from the index; no index code without a route or a stated meaning |
| BG-10 | Read `POST /selection/replays`; then `POST /selection/replays` holdout with a suite outside `holdout.required_suites`, and with a required suite that has no frozen definition | the contract says when each code is given, and the two calls get those codes |

### Testability
| ID | Need | Test | Pass when |
|---|---|---|---|
| TS-1 | N-1 | Job runs read after BG-1 | the scheduled ticks are listed with `trigger`, `scheduled_for`, all step summaries, `last_ok_at`, `next_due_at`; no secret anywhere |
| TS-2 | N-1 | Filter `job=daily`, `since`, `limit=1`; then a bad filter | only daily runs, newest first, one row; then 400 `VALIDATION_ERROR` |
| TS-3 | N-2 | In the test environment, stop scheduled runs for 2 hours (or use N-10 `as_of`) | `/report` shows `JOB_OVERDUE` at error level with `last_run_at`; it clears after the next run |
| TS-4 | N-3 | Test environment, test registrar balance $0, real-buy `POST /buy` for a screened, packed, tranche-admitted test name | 409 `REGISTRAR_FUNDS` with `shortfall`; nothing booked |
| TS-5 | N-3 | Same, with balance set high and outcome `ok`; then with outcome `ambiguous` and a later reconciler read `registered` | first 201 with `post_buy`; second 202 `PURCHASE_STATE_UNKNOWN`, then after a test tick the purchase is booked; the test ledger has the rows, the production ledger and `/report` do not |
| TS-6 | N-3 | Test name removed from the test registrar account; run the daily job | test `/report` shows `DOMAIN_LEFT_ACCOUNT` with `registrar`, `first_absent_at`, `last_checked_at` |
| TS-7 | N-3 | A test token on a production route that would contact a real registrar; a real token on a test-only call | both refused; audited; no registrar call |
| TS-8 | N-4 | Daily dry run with `today` = a listed test name's first listing date + 6 months + 1 day | `would_apply` holds its M6 row with the new prices; nothing written but the audit row (`/portfolio` and `/audit` before and after prove it) |
| TS-9 | N-4 | Daily dry run with `today` after a test name's `drop_date`; then a date 4 years ahead | `would_drop` holds the name; then 422 `VALIDATION_ERROR` |
| TS-10 | N-5 | Reference status read | popularity `list_date` and `rows` match the latest `referenceRefresh` summary in N-1; backup shows `configured: false` and `skipped` |
| TS-11 | N-6 | Dry-run activation of a draft that clears the buy hold with no holdout replay, with a valid `approval_ref` | 409 `HOLDOUT_NOT_PASSED` with `details.suites`; no replay recorded; `GET /selection/buy-hold` unchanged |
| TS-12 | N-6 | Dry-run tranche add of a geo name to a test tranche already at its geo cap; dry-run close of a tranche below target | 409 `GEO_CAP`; 409 `TRANCHE_BELOW_TARGET`; tranche unchanged |
| TS-13 | N-7 | Strict dry-run `/buy` for an unscreened free name with a valid approval | 409 `SCREENING_PACK_REQUIRED` with `details.reason: "NO_PACK"` and `pack_id: null`; nothing bought |
| TS-14 | N-8 | Any `GET` and any `POST` with the production token | every response has the limit, remaining and reset values; remaining goes down by one per call |
| TS-15 | N-8 | Low-limit test token: 4 GETs in a minute; a READ token on a POST | 4th call 429 `RATE_LIMITED` with `Retry-After`, key not claimed; READ on POST 403 `SCOPE_FORBIDDEN` |
| TS-16 | N-9 | Fault `db_down`, then `GET /health`; fault `audit_write_fails`, then a POST, then the same POST and key with the fault off | 503 `degraded`; then 500 `AUDIT_WRITE_FAILED`; then the stored result replayed |
| TS-17 | N-9 | Fault `slow_request` and two POSTs with the same key; fault `screening_stall` on a test run, then a pack request and a tick after the deadline | second POST 409 `IDEMPOTENCY_KEY_IN_USE`; pack 409 `RUN_RUNNING`; after the tick the run is `partial` with `TIMEOUT` and N-1 lists it in `finalized` |
| TS-18 | N-10 | Test name with a pricing hold; `/report?as_of=` today + 31 days; then a past date | `HOLD_STALE` appears with `simulated: true`; then 400 `VALIDATION_ERROR` |
| TS-19 | N-11 | Outbound-hosts read after a daily run | only hosts from the documented sources and the registrar; no LLM host; counts match the run |

### Price
| ID | Test | Pass when |
|---|---|---|
| PR-1 | Enter the .com renewal change for Porkbun, `effective_at` 2026-11-01T07:00+03:00; read the price changes | 201; the read lists it with its source; the same call with the same `Idempotency-Key` is replayed, not stored twice |
| PR-2 | `GET /check` on a free name before 2026-11-01 | the renewal part of `two_year` uses the changed price (the renewal falls after the change), with `price_basis` saying so |
| PR-3 | After 2026-11-01, a live quote shows the new price; `GET /check` again | the live quote is used (`price_basis: "quote"`) |
| PR-4 | Test environment: a held test name with expiry after the change; `GET /report` | `committed_forward` uses the changed renewal price; past ledger rows are unchanged |

## 9. Questions for DOM (please answer in the reply)
**BUG-1**
1. **Q-1** What is the cause: is the scheduler not calling, or are ticks running without being audited? Was the scheduler deployed after commit `1a47357`, and does DOM have its own record of the calls?
2. **Q-2** Did anything that should have run since 00:08 IDT need to run again (the missed `daily` at 03:05 IDT, reference data)? Does the next run catch up by itself?

**Form**
3. **Q-3** Do you want the bugs split into BUG-### files, or is one CR fine?

**Test environment and modes**
4. **Q-4** Can a test environment (N-3) run at $0 on today's hosting, as a separate instance or as a test mode in production? Which do you recommend, and how do you guarantee S-3 (test data never in real reports, ledger or caps)?
5. **Q-5** Which needs in §5 are MINOR contract changes and which are larger? If DOM thinks a need isn't worth it, please say why and what evidence you would give instead.
6. **Q-6** Can Gavriel get a READ token now (N-8), without waiting for the rest?
7. **Q-7** For the job dry run (N-4): may it run in production on real data, and with which token?
8. **Q-8** Do Render or Cloudflare add their own rate limits in front of the service that Gavriel should know about?
9. **Q-9** For fault paths (N-9): if you prefer test evidence to a switch, what exactly would the release note show?
10. **Q-10** Can a validate-only activation (N-6) be built without ever scoring a holdout test slice?
11. **Q-11** Can `/report?as_of=` (N-10) work for past dates, or only for today and later?

**Price**
12. **Q-12** Who should enter a dated price change (Gavriel with WRITE, or your admin step on Dvir's word)?
13. **Q-13** How does a dated change affect existing data: stored renewal prices on held names, `committed_forward`, screening results and packs made before the change, stored replay profit reports, and `profit.cost_per_name_year_cents` (does it need a new settings version and Dvir's approval)?

## 10. What Dvir is approving by approving this CR
- Gavriel sends this CR to DOM.
- DOM fixes BUG-1 first, then the other bugs and docs gaps.
- DOM replies on N-1 to N-11 and PR-1 (verdict, release plan, anything marked **DVIR**).
- Nothing in this CR spends money, changes a cap or an approval rule, or allows a real purchase or registrar change.
