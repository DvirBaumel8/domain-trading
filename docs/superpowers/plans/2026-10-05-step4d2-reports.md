# Step 4d-2: Reports and read endpoints: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give Gavriel and Gizbar every answer from the database alone, which is the last part of build step 4. This step adds:
- **`GET /report`** (JSON and `?format=md`):
  - budget, sales, profit, ROI;
  - the per-domain view (pricing, offers, next event, export state);
  - upcoming events with heads-ups;
  - offers by strategy;
  - pending payouts and the price events applied in the last 7 days;
  - every warning.
- **`GET /report/pricing-review`.**
- **The other reads:** `GET /portfolio`, `GET /portfolio/{domain}` (incl. the last-uploaded values for the lander check, §10.7), `GET /ledger` (JSON and CSV), `GET /deals/{id}`, `GET /audit`.
- **`POST /payouts/{id}/received`** (PO-4; built per the 4d-1 default).
- **The daily registrar check** (`DOMAIN_LEFT_ACCOUNT`, SL-6).

Gate G1 for R-1–R-12, PR-37, PR-38, PR-39, PO-4, PO-5, SL-5, SL-6, S-7, OF-20 (the warning half) and the `/report` wiring of OF-18/OF-19. That closes G0/G1 for build step 4.

**Architecture:**
- **`src/services/report/`**, one file per concern so each stays small and testable:
  - `money.ts`: ledger sums, the single source for every money figure (R-2);
  - `domains.ts`: per-domain rows, shared by `/report` and `/portfolio`;
  - `upcoming.ts`;
  - `warnings.ts`;
  - `markdown.ts`;
  - `pricing-review.ts`.
- **Reuse:** `perDomainOffers`/`offersByStrategy` (offer-stats), `pendingDomains`/`manualDelist` (export-state) and the `sales`/`payouts` tables.
- **Writes:** the registrar check is a job like the drop job. It reads only, and records what it saw in a small table so the warning can say when the name was first seen gone.
- **Every route is READ** except `POST /payouts/{id}/received` (WRITE, idempotent, audited).

**Spec:** `docs/specs/report.md` (all of it); `docs/specs/sold.md` (payout received, PO-4); `docs/specs/listing-strategy.md` §10.4, §10.7, §10.9, §10.11; `docs/specs/test-plan.md` R-*, PR-37–PR-39, PO-4, PO-5, SL-5, SL-6, OF-18–OF-20, S-7; `docs/specs/00-architecture.md` §7; CLAUDE.md (money as cents plus display, IDT output, R-2 traceability).

## Global Constraints

- **Money:** every money field is `*_cents` plus a display string. **Every figure comes from a SQL sum over `ledger_entries`** (R-2), with no estimates. Payouts add no ledger money.
- **Times:** stored in UTC, returned as ISO with the Asia/Jerusalem offset (`toJerusalemIso`). "Days" are IDT calendar days.
- **The walk-away** may appear in READ responses marked "(private)" (internal readers only). It never appears in any export or buyer-facing field.
- **Tests:** deterministic. Every test injects a fixed clock; no assertion depends on the real date.
- **No outbound calls** on any READ path. The registrar check calls `findDomain` only (no writes), and only from the job.

## Decisions (made by Claude Code under Dvir's delegation, 5 Oct 2026; recorded for the spec sync)

| # | Decision | Why |
|---|---|---|
| Q1 | **Costs and sale fees.** <ul><li>A `fee` row written by `/sold` (identified by `audit_id` ∈ `sales.audit_id`) and every `payout_fee` row are **sale fees**.</li><li>Every other `registration`/`renewal`/`fee` row is a **cost**.</li><li>`sales.fees` = the sale fees; `net_sales` = gross − commission − sale fees; `total_costs` = the costs; `profit` = net_sales − total_costs; `roi` = profit ÷ total_costs.</li><li>`budget.spent` stays exactly the `/buy` cap figure (`spentCents`: all registration/renewal/fee rows), so the report and the cap never disagree; `budget.remaining` = cap − spent.</li></ul> | R-1 has no sale fees, so both readings agree there. This keeps the cap conservative and stops sale fees being counted twice in profit |
| Q2 | **`committed_forward`** = Σ `renewal_price_cents` for domains with `renewals_used = 0` and status ∉ {sold, dropped}. `complete: false` plus a list when any such domain has a null renewal price | R-3 + the `RENEWAL_PRICE_UNKNOWN` import case |
| Q3 | **Upcoming alert stages.** A first-renewal decision (renewals_used 0) shows when expiry is ≤ 60 days away. `stage` is the smallest of 60/30/7 that is ≥ days left (45 days → 60; 25 → 30; 5 → 7). A final expiry (renewals_used 1) uses stages 60/30 and the text from report.md, with no renew option. Fast Transfer = `buy_date + 60` when within 90 days. Price events: `planned` rows of the current plan due within 90 days, with exact values; `headsup: true` when due within `headsup_days_before` (from the plan's settings) | report.md, R-4–R-6, PR-38 |
| Q4 | **Warning levels:** each warning is `{code, level: 'info'\|'warn'\|'error', domain?, message, details}`. `EXPORT_PENDING` is `warn`, or `error` after 7 days (PR-37). `SALE_UNCONFIRMED` and `PRICING_EXCEPTION` are `info`. Everything else is `warn` unless stated | Gavriel can route by level |
| Q5 | **`OFFER_NEEDS_DVIR`:** an offer with routing `dvir` and outcome `open`/`countered`, whose `created_at` is more than 48 h ago. `created_at` is used, not `received_at`, so an import that backfills old offers doesn't fire it at once | 4c carry |
| Q6 | **Extra warnings promised in 4d-1:** <ul><li>`EXPIRED_NOT_RENEWED`: owned/listed/delisted, renewals_used 0, expiry < today;</li><li>`POST_BUY_INCOMPLETE`: a succeeded purchase whose domain has no `pricing_evidence` row (a reconciler-booked buy);</li><li>`NS_UNVERIFIED`: `lander_ns` is set and `ns_verified_at` is null (covers L-16 pending) or the NS doesn't match.</li></ul> `EXPORT_PENDING` only for `status='listed'` | Carries from 4b-3, 4c and 4d-1 |
| Q7 | **Registrar balance below $15** is reported only when a balance is known. Nothing stores one today, so it is omitted (documented as not available in v1) | No stored account state |
| Q8 | **Registrar check:** a new table `registrar_presence (domain_id PK, status 'present'\|'absent', first_absent_at, last_checked_at)`, updated by the job (no audit row per domain; one audit row per run, scope `job`). `DOMAIN_LEFT_ACCOUNT` = `absent` and no `sales` row for the domain. It runs daily after the drop job, under the per-domain lock only for the presence row (no domain-state writes) | report.md "Daily registrar check" |
| Q9 | **`POST /payouts/{id}/received {received_on, approval_ref?}`** is **bot-only** (no approval needed). Recording that money arrived is neither a buy nor a sell decision (the operating model). `received_on`: a real IDT date, not in the future, not before the sale date. A second attempt with a new key → 409 `PAYOUT_ALREADY_RECEIVED`. Unknown id → 404 `PAYOUT_NOT_FOUND` | PO-4 + Dvir's operating model |
| Q10 | **Pricing review stage:** the sale's stage is the last applied schedule event before `sold_at` (`M0` if none, `M6`/`M12`/`M18`/`final`). `bin_at_sale` = the BIN in force at `sold_at` (the latest `listing_history` row ≤ `sold_at`). `at_floor` = the gross equals the floor in force (± $1). `days_listed` = IDT days from `first_listed_at` | §10.9, PR-39 |
| Q11 | **`?format=md`:** a compact markdown digest with sections Budget, Sales & ROI, Domains (table: domain, status, mode, BIN, floor, next event), Upcoming (table), Pending payouts, Warnings (by level). The walk-away isn't shown in md (it's pasted into chat) | R-9; the md is meant for chat |

---

## File structure

```
migrations/1760700000000_registrar-presence.sql
src/services/report/money.ts         ledgerTotals(db): spent, costs, sales (gross/commission/fees/net), profit, roi, committed_forward
src/services/report/domains.ts       domainRows(db, now, opts) → per_domain/portfolio rows (incl. offers, next event, export state)
src/services/report/upcoming.ts      upcoming90d(db, now)
src/services/report/warnings.ts      warnings(db, now, ctx)
src/services/report/markdown.ts      toMarkdown(report)
src/services/report/pricing-review.ts pricingReview(db, {from, to})
src/services/report/index.ts         buildReport(db, now, config)
src/api/report.ts                    GET /report, /report/pricing-review
src/api/reads.ts                     GET /portfolio, /portfolio/:domain, /ledger, /deals/:id, /audit
src/api/payouts.ts + src/services/payouts.ts   POST /payouts/:id/received
src/jobs/registrar-check.ts          RegistrarCheckJob
src/main.ts, src/job.ts              (modify) daily runner + `npm run job -- registrar-check`
tests/api/report-*.test.ts, reads.test.ts, payouts-received.test.ts, registrar-check.test.ts, pricing-review.test.ts
```

---

### Task 1: Report core (money, per-domain, upcoming, offers, payouts, applied) + `GET /report` JSON

**Files:** create `src/services/report/{money,domains,upcoming,index}.ts`, `src/api/report.ts`, `tests/api/report-core.test.ts`; modify `src/app.ts`.

**`GET /report`** (READ) → `{ generated_at, budget, sales, profit, roi, per_domain, upcoming_90d, offers_by_strategy, payouts_pending, applied_7d, warnings: [] }`. The warnings stay empty until Task 2.

- **`budget`** (Q1/Q2): `{ poc_cap, spent, remaining, committed_forward: {total, complete, missing: [domains]}, domains: {count, max} }`. `domains.count` = `activeDomainCount`.
- **`sales`:** `{ count, gross, commission, fees, net }`. **`profit`**, **`roi`** (a number such as 79.48, plus `roi_pct` rounded to a whole %; null when there are no costs).
- **`per_domain[]`** for every domain except `pending_purchase`, sorted by domain:
  - `domain`, `status`, `registrar`, `registrar_api`, `category`, `price_grade`, `listing_mode`, `bin`, `floor`, `walkaway` ("(private)"), `min_offer`, `pricing_source`, `pricing_settings_version`;
  - `offers`: from `perDomainOffers`, joined by `domain_id` onto this row set (4c carry);
  - `next_price_event`: `{event, due_on, bin, floor, walkaway}` = the earliest `planned` row of the current plan, else null;
  - `pricing_hold`, `export_pending_since`;
  - `cost`: −Σ registration/renewal rows for the domain; `renewal_price`, `renewals_used`, `expiry_date`, `drop_date`, `lander`, `ns_verified` (bool), `days_held` (IDT days since `buy_date`);
  - `sold_at`, `delisted_at`.
- **`upcoming_90d[]`** (Q3): `{domain, kind: 'first_renewal'|'final_expiry'|'fast_transfer'|'drop_date'|'price_event', date, stage?, headsup?, values?, note}`, sorted by date.
- **`offers_by_strategy`:** `offersByStrategy(db, now)` as is.
- **`payouts_pending[]`:** `payouts` with `received_on` null, joined to sales/domains → `{domain, venue, amount, fee, method, sold_at, days_pending}`.
- **`applied_7d[]`:** `price_schedule` rows `applied` with `applied_at` ≥ now − 7 days → `{domain, event, applied_at, old: {bin, floor, walkaway}, new: {…}, export_pending: bool}`. `old` comes from the history row just before the applied one. `export_pending` = the domain is in `pendingDomains('afternic')`.

**Tests** (fixed clock):
- **R-1:** the exact fixture → spent $21.07, remaining $1,478.93, net sales $1,695.75, profit $1,674.68, roi_pct 7948.
- **R-2:** a fixture with mixed rows (registration, renewal, a non-sale fee, a sale with commission + other fee + payout fee) → every money figure equals an independent SQL sum written in the test. A payout row changes nothing.
- **R-3:** `renewals_used` 0 and 1 and a sold domain → only the first counts. A null renewal price → `complete: false` and that domain is listed.
- **R-4, R-5, R-6:**
  - expiry in 45 days, renewals_used 0 → first_renewal, stage 60;
  - expiry in 25 days, renewals_used 1 → final_expiry, stage 30, note text with no "renew";
  - `buy_date + 60` shown.
- **R-10:** `sold_at` comes back with +03:00 in summer and +02:00 in winter.
- **PR-38:** an event due in 5 days → `upcoming` with exact values and `headsup: true`; one applied 2 days ago → `applied_7d` with old → new.
- **S-7 / SL-5 (money part):** after a sale (one confirmed, one unconfirmed), `sales`, `profit` and `roi` count both.
- **PO-5 (list part):** a pending payout 10 days old and one 31 days old → both listed with `days_pending` 10 and 31; profit unchanged.
- **OF-18/OF-19 wiring:** `per_domain[].offers` and `offers_by_strategy` equal the service outputs for the 4c fixtures.
- **Auth:** a READ token → 200; none → 401.

**Commit:** `feat: GET /report core (budget, sales, profit/ROI from ledger sums, per-domain, upcoming with heads-ups, offers by strategy, pending payouts, applied events) (R-1–R-6, R-10, PR-38, S-7)`

---

### Task 2: Warnings + `?format=md`

**Files:** create `src/services/report/{warnings,markdown}.ts`, `tests/api/report-warnings.test.ts`; modify `src/services/report/index.ts`, `src/api/report.ts`.

**Warnings** (Q4–Q7), each with a test (fixture → exactly that warning; a clean fixture → none of them):

| Code | Rule | Level |
|---|---|---|
| `SALE_UNCONFIRMED` | each `sales.confirmed=false`: domain, venue, ref, evidence, recorded_by, sold_at | info |
| `DOMAIN_LEFT_ACCOUNT` | `registrar_presence.status='absent'` and no sale (Task 3 writes the table; the Task 2 test inserts the row directly) | error |
| `PAYOUT_OVERDUE` | a pending payout with days_pending > 30 | warn |
| `NS_UNVERIFIED` | `lander_ns` set, `ns_verified_at` null, status owned/listed (R-7 fixture: NS ≠ lander) | warn |
| `CATEGORY_MISSING` | listed without a category | warn |
| `RENEWAL_PRICE_UNKNOWN` | renewals_used 0, renewal price null, status ∉ {sold, dropped} | warn |
| `FLOOR_AUTO_ACCEPT` | a listed hybrid/offer with floor < BIN (reminder) | info |
| `BIN_MISSING` | listed bin/hybrid with a null BIN | warn |
| `EXPORT_STALE` | no confirmed Afternic upload in the last 7 days while `pendingDomains('afternic')` is non-empty | warn |
| `PURCHASE_UNKNOWN` | purchases in `unknown` | error |
| `PAST_DROP_DATE` | status owned/listed/delisted and drop_date < today (the drop job hasn't run) | warn |
| `RECEIPT_MISSING` | a succeeded purchase with no receipts row | warn |
| `EXPORT_PENDING` | listed and in `pendingDomains('afternic')`, with days since `export_pending_since`; error after 7 days (PR-37) | warn/error |
| `PRICE_EVENT_FAILED` | `price_schedule` rows `failed` for a domain that isn't sold/dropped | error |
| `HOLD_STALE` | pricing_hold true and the latest hold history row is older than 30 days | warn |
| `PRICING_EXCEPTION` | pricing_source approved_exception (shows the formula values vs the stored ones) | info |
| `OFFER_NEEDS_DVIR` | Q5 | warn |
| `EXPIRED_NOT_RENEWED` | Q6 | error |
| `POST_BUY_INCOMPLETE` | Q6 | warn |

**`?format=md`** (Q11, R-9): `text/markdown; charset=utf-8`, valid tables (every row has the same column count as its header), amounts as `$` strings. `format` must be `json` or `md`, else 400.

**Tests:**
- every row in the table above;
- PR-37: pending 3 days → warn, 8 days → error;
- OF-20 (warning half): a mid-range offer open for 49 h → `OFFER_NEEDS_DVIR`; 47 h → none; an imported old offer created 1 h ago → none;
- SL-5: `SALE_UNCONFIRMED` lists only the unconfirmed sale;
- PO-5: `PAYOUT_OVERDUE` only for the 31-day payout;
- R-9: md parses (header and separator present, consistent column counts), contains "$1,995", and doesn't contain the walk-away.

**Commit:** `feat: /report warnings (sales, payouts, NS, export pending, price events, offers, expiry, post-buy) and ?format=md (R-7, R-9, PR-37, SL-5, PO-5, OF-20)`

---

### Task 3: Registrar check job + `POST /payouts/{id}/received`

**Files:** create `migrations/1760700000000_registrar-presence.sql`, `src/jobs/registrar-check.ts`, `src/services/payouts.ts`, `src/api/payouts.ts`, `tests/api/registrar-check.test.ts`, `tests/api/payouts-received.test.ts`; modify `src/main.ts` (daily runner: price → drop → registrar check), `src/job.ts` (`registrar-check` subcommand), `src/app.ts`, TABLES, the migration count (12).

**Migration:** `registrar_presence (domain_id bigint PK REFERENCES domains, status text CHECK IN ('present','absent'), first_absent_at timestamptz, last_checked_at timestamptz NOT NULL)`.

**`RegistrarCheckJob.runOnce({ dryRun? })`** (deps: `db`, `adapters`, `now`, `log`):
- **Scope:** domains with status owned/listed/delisted, `registrar_api` ∈ {full, manage}, and an enabled adapter for their registrar.
- **For each:**
  - `findDomain` returns null (definite) → upsert `absent`, keeping `first_absent_at` if it's already absent;
  - info returned → upsert `present` and clear `first_absent_at`;
  - a `RegistrarError` or other error → no change (retry tomorrow), counted in `errors`.
- **Writes:** one audit row per run (scope `job`, path `registrar-check`, summary counts). No domain-state writes and no registrar writes.
- **Scheduling:** the daily runner runs it after the drop job, each caught. `npm run job -- registrar-check [--dry-run]`.

**`POST /payouts/:id/received`** (Q9) `{ received_on: 'YYYY-MM-DD', approval_ref? }`:
- In one transaction under the domain lock: `UPDATE payouts SET received_on = $d WHERE id = $id AND received_on IS NULL`. Zero rows → 409 `PAYOUT_ALREADY_RECEIVED` if it exists, else 404.
- The response is the payout view (status `received`).

**Tests:**
- **SL-6:**
  - a listed domain → null and no sale → absent, and `/report` shows `DOMAIN_LEFT_ACCOUNT`;
  - a sold domain → never checked;
  - a registrar timeout → no change;
  - `registrar_api=none` (D-001) → skipped;
  - absent then present → cleared;
  - zero registrar writes (the FakeAdapter calls contain only `findDomain`);
  - status unchanged.
- **PO-4:**
  - received → status `received` in `/portfolio/{domain}` (Task 4 builds that route; in Task 3, assert via the DB and the response);
  - same-key replay → same response;
  - a new key → 409 `PAYOUT_ALREADY_RECEIVED`;
  - a future date → 422;
  - before the sale date → 422;
  - unknown id → 404;
  - a READ token → 403.

**Commit:** `feat: daily registrar check (DOMAIN_LEFT_ACCOUNT; read-only) and POST /payouts/{id}/received (SL-6, PO-4)`

---

### Task 4: `/portfolio`, `/ledger`, `/deals`, `/audit`, `/report/pricing-review`

**Files:** create `src/api/reads.ts`, `src/services/report/pricing-review.ts`, `tests/api/reads.test.ts`, `tests/api/pricing-review.test.ts`; modify `src/api/report.ts`, `src/app.ts`.

- **`GET /portfolio?status=`:** the `domainRows` of Task 1, filtered (`status` must be a valid status, else 400).
- **`GET /portfolio/:domain`** (404 `DOMAIN_NOT_FOUND`): the row plus:
  - `ledger` (the domain's rows);
  - `purchases` (state, registrar, cost, created_at, no request bodies);
  - `quotes` (from the latest check of this domain);
  - `listing_history` (all rows, newest first; walk-away "(private)");
  - `schedule` (rows of the current plan);
  - `sale` (the sales row view) and `payout` (`{amount, fee, method, received_on, status}` or null);
  - `export: {afternic: {pending, last_confirmed_upload_at, last_uploaded: {bin, floor, min_offer} | null}, sedo: {…}}`. `last_uploaded` = the values in force at the newest confirmed file containing the domain (the latest `listing_history` row ≤ that file's `at`). **Never the walk-away.** This is the weekly lander check from §10.7.
  - `offers` (the latest 50, newest first).
- **`GET /ledger?type=&domain=&from=&to=&format=json|csv`:** filters validated (400 on bad input).
  - CSV header exactly `date,type,domain,deal_id,amount_usd,counterparty,receipt_ref,note` (R-12); `amount_usd` signed with 2 decimals (`-11.08`); RFC 4180 quoting with the existing `toCsv`; CRLF.
- **`GET /deals/:id`:** `{id, domain, strategy, status_note, created_at, approvals: [audit rows whose approval_text is not null and whose request references this deal_id or its domain]}`; 404 if unknown.
- **`GET /audit?since=&limit=`:** newest first; limit 1–500 (default 100); `since` ISO. Returns `request` as stored. Bodies never contain secrets; assert that with the existing AU-8 grep helper if available.
- **`GET /report/pricing-review?from=&to=`** (Q10, PR-39): `{from, to, sales: [{domain, venue, gross, bin_at_sale, ratio, stage, days_listed, at_floor}], offers: {count, by_band, median_pct_of_bin}, skipped_events, held_events, settings_versions_in_use: [n], insufficient_data: sales.length < 3}`.

**Tests:**
- **R-8:** READ, WRITE (WRITE ⊇ READ), none → 401, revoked → 401, on each GET.
- **R-11:** `/health` with no auth and no business data (already covered; assert again that it has no domain/ledger keys).
- **R-12:** the CSV header is byte-exact and amounts are signed.
- **IM-4 shape (mock):** an import with D-001's flags, then `/portfolio/promptinjectionaudit.com` shows registrar godaddy, cost $13.73, expiry 2027-10-04, drop 2028-10-04, trend hybrid 1995/1295/950 (private)/100, approved_exception, and 4 schedule rows.
- **Export block:** after a confirmed upload and a later drop, `last_uploaded` shows the uploaded values (not the current ones) and `pending: true`. 950 doesn't appear anywhere in the `export` block.
- **PR-39:**
  - sales at 1995 (M0), 1295 (at the floor) and 1595 (after M6, BIN 1595) → ratios 1.00 / 0.65 / 1.00, stages M0 / M0 / M6, `at_floor` false/true/false;
  - with 2 sales → `insufficient_data: true`.
- **Deals:** a buy with `deal_id` → `/deals/D-002` lists its approval.
- **Audit:** limit and since filters; bad input → 400.

**Commit:** `feat: GET /portfolio (+ lander-check export block), /ledger (json/csv), /deals, /audit, /report/pricing-review (R-8, R-11, R-12, PR-39)`

---

### Task 5 (Opus): Gate report for build step 4

- [ ] Full suite, typecheck and build.
- [ ] Map every step-4 test ID in the test-plan G1 row to a test, or to a deferral that was accepted.
- [ ] Final review, then a fix wave.
- [ ] Spec-sync note for Gavriel (Q1–Q11).
- [ ] Push.
- [ ] Report to Dvir: step 4 complete. Next are build step 5 (G2 contract tests) and step 6 (Render, which needs his OK on the cost).

## Review Focus
1. **The ledger is the only money source.** No report figure is computed from `domains` or `sales` amounts (R-2). A test recomputes every figure independently.
2. **Clock boundaries:** IDT midnight for days held, stages, 7-day windows and 48 h; summer/winter offsets (R-10).
3. **The walk-away** shows up only as "(private)" in JSON reads, never in md, the export block or any CSV.
4. **The registrar check never writes to a registrar and never changes domain state.**
5. **Payout received is set once,** under a race (two concurrent posts): exactly one succeeds.
