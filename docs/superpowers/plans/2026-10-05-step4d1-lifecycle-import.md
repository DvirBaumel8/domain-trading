# Step 4d-1: Lifecycle and import (/sold, drop job, drop-at-first-expiry, GoDaddy adapter, import-domain): Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Finish a domain's lifecycle so that D-001 can enter the system with its approved plan. This step adds:
- `POST /sold/{domain}`, with ledger rows, commission check, checklist, schedule cancel and offer link;
- the daily **drop job**;
- the admin command **`drop-at-first-expiry`**, which regenerates the final push and delist;
- the **GoDaddy management-only adapter** (NS via v3 with operation polling; never registers or quotes);
- **`npm run admin -- import-domain`**, using the same calculator and rules as `/buy`, with `--manual`, `--legacy-no-comps`, exceptions and `--dry-run`.

Gate G1 for S-1–S-8, PR-25, PR-26, L-12, IM-1–IM-3, IM-5–IM-11, LG-9 and PR-17 (the import part). IM-4 is live at G3.

**Not in this step (4d-2):** `/report` (incl. `pricing-review`), `/portfolio`, `/ledger`, `/deals`, `/audit`, and every report warning.

**Architecture:**
- **`src/services/sold.ts`:** the sale service, under the per-domain lock, in one transaction.
- **`src/jobs/drop.ts`:** `DropJob`, which takes only `db`, `now` and `log` (no adapters). It runs with the price job.
- **`src/admin/drop-date.ts`** and **`src/admin/import-domain.ts`:** admin commands. Both are audited with scope `admin` and both take the lock.
- **`src/registrars/godaddy.ts`:** implements the `RegistrarAdapter` interface with `canRegister: false` and `canQuote: false`. `setNameservers` may report a pending operation.
- **Import** reuses `validateListing`, `validateComps`, `writePlan`, `historyRow`, `domainPlanColumns` and `changedColumns`, so preview, `/buy`, `/list` and import compute the same plan (PR-17).

**Spec:** `docs/specs/sold.md`; `docs/specs/report.md` (§Import, IM-*, §Status lifecycle); `docs/specs/list.md` (GoDaddy NS, L-12); `docs/specs/listing-strategy.md` §10.4 (drop_date change, sold/dropped cancel), §5 (V11 legacy comps, `LEGACY_NO_COMPS`); `docs/specs/test-plan.md` PR-17, PR-25, PR-26; CLAUDE.md founder rules 1, 3, 6, 7, 8 and 12.

## Global Constraints

- Everything from earlier steps still holds: cents and display strings, the error envelope, idempotency and audit on POSTs, no network in tests (MSW for GoDaddy), fake keys only (`GODADDY_PAT=fake_…`), ESM `.js` imports.
- **`drop_date` is never moved later.** The only change allowed is earlier, to the expiry date (`drop-at-first-expiry`). `renewals_used` stays 0..1.
- **The GoDaddy adapter never registers, never quotes and never calls a top-up or billing endpoint** (static test, IM-11). A GoDaddy key is never logged, returned or stored.
- **Every write to a domain row** (`/sold`, the drop job, the drop-date command, import) runs under `withDomainLock`, using only `conn` inside it.
- **A sold, dropped or delisted transition** sets `delisted_at` (if it's null) and `listing_changed_at`, but never `export_pending_since`. The 4b-3 manual-delist rules depend on this. Open `price_schedule` rows → `cancelled`.

## Decisions taken in this plan that the spec doesn't spell out (Dvir to confirm)

| # | Decision | Why |
|---|---|---|
| D1 | **`/sold` accepts `owned`, `listed` and `delisted`.** A `delisted` name is still held until `drop_date`, and a buyer can complete during the last week. Everything else → 409 `NOT_SELLABLE_STATE` | sold.md predates the `delisted` status |
| D2 | `/sold` sets `status=sold`, `sold_at`, `delisted_at = coalesce(delisted_at, sold_at)` and `listing_changed_at = now`. It cancels open schedule rows (PR-26). Profit = sale − commission − other fees − payout fee − all of the domain's costs (Σ registration/renewal/fee rows) | sold.md + §10.4 + 4b-3's delist rule |
| D3 | `/sold` may carry an optional `offer_id`. That offer must belong to the domain and be `open`, `countered` or `accepted`; it is set to `sold`, and the offer's outcome rule (O4) is then satisfied. An unknown id or a wrong domain → 422 `OFFER_MISMATCH` | 4c carry: "/sold should link the offer" |
| D4 | **Drop job:** domains with status `owned`, `listed` or `delisted` and `drop_date < today` (IDT) → `dropped`, `delisted_at` set if null, open rows → `cancelled`, audit (scope `job`). It runs after the price job (startup + daily 00:30 UTC). An expired-but-unrenewed domain (`renewals_used=0`, `expiry_date < today`) is **not** auto-dropped, because the registrar's grace period applies; `/report` warns about it in 4d-2 | report.md lifecycle; renewing goes through the registrar, and there's no `/renew` in v1 |
| D5 | `npm run admin -- drop-at-first-expiry --domain d --approval-text "…" --approval-at <ISO>`. It needs `renewals_used=0` and status `owned`/`listed`/`delisted`. It sets `drop_date = expiry_date` (a migration relaxes the DB CHECK to allow `expiry` or `expiry + 1y`). It then regenerates the schedule from the current values: same anchor, `startAfter` = today, and M-rows on or after the new final push → `superseded_by_final_push` (PR-25). It writes an admin audit row with the approval | Gate F, "drop at first expiry", PR-25 |
| D6 | **GoDaddy `setNameservers`:**<ul><li>`PUT /v3/domains/domain-names/{domain}/nameservers` → 202 + operation id;</li><li>poll the operation every 5 s (sleep injected) for up to 5 min;</li><li>DONE → `{ pending: false }`; still running → `{ pending: true }`; FAILED → a definite `RegistrarError` with the operation's code.</li></ul>`/list` maps `pending` to `ns_status: "pending"` and saves the listing without a read-back compare. **Unverified paths** (domain details, operation status) are constants marked `UNVERIFIED`, checked at G2/G3 contract tests | list.md step 4 + report.md §GoDaddy (paths partly unverified) |
| D7 | **import-domain** never checks the POC cap or the domain cap, because it records a past purchase. If either is exceeded after the import, it prints a warning (`POC_CAP_EXCEEDED_BY_IMPORT` / `DOMAIN_CAP_EXCEEDED_BY_IMPORT`) | IM-10: the import counts toward the caps; it can't undo a real purchase |
| D8 | `--legacy-no-comps <reason>` is allowed only when `--buy-date` < 2026-10-05; otherwise → `COMPS_REQUIRED`. Comps come from `--comps-file <json>` (same shape as `/buy` `pricing_evidence`) | §5 V11: "only for names bought before 5 Oct 2026" |
| D9 | **Import validation uses the `buy` phase** (a geo BIN must be the grade price), `expected_settings_version` is optional, and the approval is `--approval-text`/`--approval-at` (needed whenever a listing or an exception is given; it doesn't need to name the domain, since it's an admin command run by Dvir) | report.md §Import: "validated with the same rules" |

---

## File structure

```
migrations/1760400000000_lifecycle.sql   drop_date CHECK relaxed (expiry or expiry+1y); price_schedule note column already exists
src/services/sold.ts                     SoldService.sell(domain, body, ctx)
src/api/sold.ts                          POST /sold/:domain
src/jobs/drop.ts                         DropJob.runOnce({ today?, dryRun? })
src/admin/drop-date.ts                   dropAtFirstExpiry(db, opts)
src/registrars/godaddy.ts                GoDaddyAdapter (manage only)
src/registrars/types.ts                  (modify) setNameservers returns Promise<void | { pending: boolean }>
src/registrars/registry.ts               (modify) godaddy entry
src/services/list.ts                     (modify) ns_status 'pending'
src/admin/import-domain.ts               importDomain(db, adapters, opts)
src/admin.ts                             (modify) import-domain, drop-at-first-expiry
src/main.ts, src/job.ts                  (modify) drop job after the price job; `npm run job -- drop`
tests/api/sold.test.ts, drop-job.test.ts, drop-date.test.ts, godaddy.test.ts, import-domain.test.ts, tests/unit/godaddy-static.test.ts
```

---

### Task 1: Migration 9 + `POST /sold/{domain}`

**Files:** Create `migrations/1760400000000_lifecycle.sql`, `src/services/sold.ts`, `src/api/sold.ts`, `tests/api/sold.test.ts`. Modify `src/app.ts`, `src/db/types.ts` (if needed), `tests/api/admin-cli.test.ts` (9 migrations), `tests/api/schema.test.ts`.

**Migration:**
```sql
-- Up Migration
-- drop_date may be expiry + 1 y (default) or the expiry itself (Gate F: drop at first expiry); never later
ALTER TABLE domains DROP CONSTRAINT domains_drop_date_rule;
ALTER TABLE domains ADD CONSTRAINT domains_drop_date_rule CHECK (
  renewals_used = 1 OR drop_date IS NULL OR drop_date = (expiry_date + interval '1 year')::date OR drop_date = expiry_date);
-- Down Migration
ALTER TABLE domains DROP CONSTRAINT domains_drop_date_rule;
ALTER TABLE domains ADD CONSTRAINT domains_drop_date_rule CHECK (
  renewals_used = 1 OR drop_date IS NULL OR drop_date = (expiry_date + interval '1 year')::date);
```
Before writing it, check the real constraint text with `\d domains`.

**`POST /sold/:domain`** (WRITE). The body (zod, strict) matches sold.md:
```
{ venue: 'afternic'|'sedo'|'afternic_checkout'|'escrow'|'other', sale_price: number, commission: number, other_fees?: number,
  sold_at: ISO-with-offset, payout?: { amount: number, method: string, fee?: number, received_on?: YYYY-MM-DD|null },
  transaction_ref?: string, approval_ref: { text, approved_at }, offer_id?: number }
```

**Validation:**
- **Money:** amounts are USD numbers with ≤ 2 decimals. `sale_price` must be > 0; `commission`, `other_fees` and `payout.fee` must be ≥ 0. Anything else → 422 `VALIDATION_ERROR`.
- **`sold_at`:** not more than 5 min in the future → else 422 `SOLD_AT_IN_FUTURE`.
- **Approval:** `approval_ref` is required → else 422 `APPROVAL_REQUIRED` (S-4). It must pass `checkApproval` (it names the domain, ≤ 72 h old).
- **PII:** `transaction_ref` containing `@` → 422 `NO_PII`.

**Behaviour:**
1. Under `withDomainLock`, in one transaction, re-read the row `FOR UPDATE`. Its status must be `owned`, `listed` or `delisted` (D1), else 409 `NOT_SELLABLE_STATE` (S-3 when already sold).
2. Write the ledger rows. All have `occurred_on` = the `sold_at` IDT date, `domain_id`, `deal_id`, `counterparty = venue`, `receipt_ref = transaction_ref`, `audit_id`:
   - `sale` with +sale;
   - `commission` with −commission, if > 0;
   - `fee` with −other_fees, if > 0;
   - `payout_fee` with −payout.fee, if > 0.
3. Update the domain: `status 'sold'`, `sold_at`, `delisted_at = coalesce(delisted_at, sold_at)`, `listing_changed_at = now`, `updated_at`.
4. Open `price_schedule` rows (status `planned`) → `cancelled`, with note `sold` (PR-26).
5. **D3:** if `offer_id` is given and valid, set that offer's `outcome = 'sold'`, `outcome_at = now`, `outcome_note = 'via /sold'`.
6. **Commission check** (a warning, never a block). The expected rate:
   - Afternic: 15% if the domain's `lander` was `afternic` at `sold_at`, else 25%, with a $15 minimum. Use the current `lander` and `lander_set_at ≤ sold_at`.
   - Sedo: one of 10%, 15% or 20% (warn only when none matches within $1).
   - `afternic_checkout`: 5%.
   - `escrow`/`other`: no check.

   Warn `COMMISSION_UNEXPECTED: expected 15% ($299.25), got $199.50` when it's off by more than $1.
7. **Response 200:**
   - `{ domain, status: 'sold', sale, commission, fees, net_proceeds, total_costs, profit }`, each as cents + display;
   - `checklist`: the 3 sold.md lines plus, when the domain was in any confirmed upload, "Remove the listing at Afternic/Sedo (see X-Manual-Delist)";
   - `warnings`.

- [ ] **Step 1: Failing tests:**
  - **S-1:** a listed domain with a `registration` −1108 ledger row, sold at Afternic for 1995.00 with commission 299.25 → the domain's ledger has 3 rows with the right signs (`registration` −1108, `sale` +199500, `commission` −29925); status `sold`; `profit` $1,684.67.
  - **S-2:** commission 199.50 on an Afternic-NS domain → 200 with a warning containing "expected 15%".
  - **S-3:** a second `/sold` → 409 `NOT_SELLABLE_STATE`, with no new ledger rows.
  - **S-4:** no `approval_ref` → 422 `APPROVAL_REQUIRED`.
  - **S-5:** the same key twice → one set of rows (replayed).
  - **S-6:** READ → 403.
  - **S-8:** the checklist contains "Remove the listing on the *other* marketplace".
  - **PR-26:**
    1. a domain listed via `/list` (fixed clock) with 4 planned rows;
    2. `/sold` → all 4 are `cancelled`;
    3. running the price job on the M6 date then changes nothing (no history, prices unchanged).
  - **D1:** a `delisted` domain can be sold; a `dropped` one → 409.
  - **D2:** `delisted_at` = `sold_at` (when it was null); `export_pending_since` is unchanged.
  - **D3:** `offer_id` of an open offer on the domain → that offer's outcome is `sold`; an offer on another domain → 422 `OFFER_MISMATCH`, with nothing written.
  - **Lock:** hold `withDomainLock` on the domain in the test and start `/sold`; it completes only after the release.
  - **Ledger is append-only:** rows are never updated.
  - **Schema:** the new CHECK accepts `drop_date = expiry_date` and still rejects `drop_date = expiry + 2 y`.
- [ ] **Step 2–4:** Implement, then `npx vitest run && npx tsc --noEmit`, then `npm run migrate up` on the dev DB, then down/up.
- [ ] **Step 5: Commit** `feat: POST /sold (ledger rows, commission check, checklist, cancels schedule, links the offer) + drop_date CHECK allows drop at first expiry (S-1–S-8, PR-26)`

---

### Task 2: Drop job + `drop-at-first-expiry` (PR-25)

**Files:** Create `src/jobs/drop.ts`, `src/admin/drop-date.ts`, `tests/api/drop-job.test.ts`, `tests/api/drop-date.test.ts`. Modify `src/app.ts` (`app.dropJob`), `src/main.ts` (run after the price job at startup and daily), `src/job.ts` (`npm run job -- drop [--dry-run] [--today]`), `src/admin.ts`.

**`DropJob.runOnce({ today?, dryRun? })`** (deps: `db`, `now`, `log`, `lockTimeoutMs?`):
- **Candidates:** status `owned`, `listed` or `delisted`, with `drop_date < today` (IDT).
- **For each candidate,** under the lock, re-read `FOR UPDATE`:
  - status → `dropped`;
  - `delisted_at = coalesce(delisted_at, now)`, `listing_changed_at = now`;
  - planned rows → `cancelled` (note `dropped`);
  - audit row with scope `job`, path `drop`.
- **Errors:** per-domain error isolation and best-effort error audit, as in the price job.
- **Result:** `{ today, dryRun, dropped: string[], failed: [...] }`.
- **`main.ts`:** `runDaily = async () => { await priceJob.runOnce(); await dropJob.runOnce(); }`, both caught. Use the same startup call and the same `scheduleDailyUtc(…, 0, 30)`; replace the separate price-job scheduling with this combined runner.
- **`job.ts`:** subcommand `drop`, with the same flags and the same future `--today` guard.

**`dropAtFirstExpiry(db, { domain, approvalText, approvalAt, now })`:**
- **Approval:** strict ISO, not in the future, non-empty text.
- **Lock:** under it, re-read the row:
  - `renewals_used` must be 0, else `MAX_ONE_RENEWAL_USED`;
  - the status must be `owned`, `listed` or `delisted`, else refused;
  - `expiry_date` must not be null;
  - if `drop_date` already equals `expiry_date`, refuse with `NO_CHANGE`.
- **Update:** `drop_date = expiry_date`, `updated_at`.
- **Schedule:** if the domain has a plan (`plan_id` and `first_listed_at`), regenerate it with `writePlan`:
  - `plan` = the current values as a `ListingPlan` (use `currentPlan` from plan-store);
  - anchor = the IDT date of `first_listed_at`;
  - `dropDate` = the new date;
  - `startAfter` = today (IDT);
  - `settings` = `settingsByVersion(row.pricing_settings_version)`;
  - `planAuditId` = this command's audit id.

  `buildSchedule` already marks M-events on or after the final push as `superseded_by_final_push`.
- **Audit:** an admin audit row (`path 'drop-at-first-expiry'`) with the approval text and time, and `request {domain, from, to}`.
- **CLI:** `npm run admin -- drop-at-first-expiry --domain d --approval-text "…" --approval-at <ISO>`. It prints the new `drop_date` and the new schedule.

- [ ] **Step 1: Failing tests:**
  - **Drop job:**
    - a listed domain with `drop_date` 2028-10-04 and `today` 2028-10-05 → `dropped`, `delisted_at` set, planned rows cancelled, an audit row;
    - `today` 2028-10-04 → no change (strictly after);
    - an `owned` domain past `drop_date` → dropped;
    - a `sold` domain → untouched;
    - a dry run changes nothing;
    - two concurrent runs → one transition;
    - the CLI `drop --dry-run --today 2028-10-05` → exit 0.
  - **PR-25:**
    1. D-001-like: listed via `/list` on 2026-10-12, hybrid 1995 with exception 1295/950, expiry 2027-10-04, drop 2028-10-04;
    2. run `drop-at-first-expiry` with the clock at 2026-10-20;
    3. expect `drop_date` 2027-10-04 and the new rows: M6 2027-04-12 planned 1595/1035/760 (kept, PR-25); M18 2028-04-12 `superseded_by_final_push` (it is after the new final push); `final_push` 2027-07-06 planned 1095/1035/760 (§10.4 v2 from the M6 values: BIN = `min(1595, max(ceil95(1035), 795))` = 1095); delist 2027-09-27 planned;
    4. the old plan's rows are `superseded`;
    5. an admin audit row.

    Assert these exact values.
  - **Refusals:** `renewals_used = 1` → refused; a sold domain → refused; a second run → `NO_CHANGE`; `--approval-at` in the future → refused (exit 2 via CLI).
  - The CHECK accepts the new `drop_date`.
- [ ] **Step 2–4:** Implement, then `npx vitest run && npx tsc --noEmit && npm run build`.
- [ ] **Step 5: Commit** `feat: drop job (past drop_date → dropped, schedule cancelled) and admin drop-at-first-expiry (regenerates final push/delist) (PR-25)`

---

### Task 3: GoDaddy management-only adapter (L-12, IM-11)

**Files:** Create `src/registrars/godaddy.ts`, `tests/api/godaddy.test.ts`, `tests/unit/godaddy-static.test.ts`, `tests/helpers/godaddy-msw.ts`. Modify `src/registrars/types.ts`, `src/registrars/registry.ts`, `src/config.ts` (`GODADDY_BASE_URL`, https outside tests), `src/services/list.ts`, `.env.example`, `tests/helpers/fake-adapter.ts` (`setNs` may return pending).

**Interface change:** `setNameservers(domain, ns): Promise<void | { pending: boolean }>`. Porkbun returns `void` (unchanged).

**`list.ts`:** if the result is `{ pending: true }` → `ns_status: 'pending'`, skip the read-back compare, save the listing (the NS target is recorded), and add the warning `NS_PENDING: GoDaddy is still applying the change; the daily DNS check will confirm it`. `{ pending: false }` or `void` → the current read-back behaviour.

**`GoDaddyAdapter`:**
- **Name and auth:** `name 'godaddy'`; `capabilities { canQuote: false, canRegister: false, canManageNs: true, ... }` (match the `Capabilities` type). Auth header `Authorization: Bearer <PAT>`, never logged.
- **`findDomain(domain)`:** `GET {base}/v3/domains/domain-names/{domain}` (**UNVERIFIED path**, constant).
  - Map it to `DomainInfo` (expiry, NS, privacy, auto-renew where present).
  - 404 → `null`.
  - 403 with body `code` (e.g. `ACCOUNT_NOT_ELIGIBLE`) → a definite `RegistrarError('godaddy', code)`.
  - 5xx, timeout or network → ambiguous.
- **`getNameservers(domain)`:** from `findDomain`.
- **`setNameservers(domain, ns)`:** as in D6 (`PUT` → 202 with an operation id in the body or a `Location` header; poll `GET {base}/v3/domains/operations/{id}` (**UNVERIFIED**) until `status` is one of `SUCCESS`/`DONE`, `FAILED`, or the time runs out).
- **Every other method** (`quote`, `register`, account state, `setAutoRenew`, `findRegistration`, …) throws `RegistrarError('godaddy', 'NOT_SUPPORTED', …)` definite, and has **no HTTP call**.
- **Registry:** add `godaddy` (needs `GODADDY_PAT`).
- **`/check`:** exclude GoDaddy with `exclusionReason: 'NO_AVAILABILITY_ACCESS'` (inspect how `/check` builds quotes per adapter; use `canQuote` false, or add the reason where adapters can't quote).

- [ ] **Step 1: Failing tests** (MSW handlers in `tests/helpers/godaddy-msw.ts` with fake PAT values):
  - **L-12:** `/list` on a `registrar 'godaddy'`, `registrar_api 'manage'` domain with the adapter enabled:
    - PUT → 202 with operation id `op1`;
    - the polls return `PENDING` once, then `SUCCESS`;
    - expect `ns_status 'set'`, the right body sent (the afternic pair), and polling seen (2 GETs).
    - **Variant:** always `PENDING` with a short timeout (inject `pollTimeoutMs` / `sleep`) → `ns_status 'pending'` + `NS_PENDING`, and the listing is saved.
    - **Variant:** `FAILED` → 409 `REGISTRAR_REJECTED`, with nothing saved.
  - **IM-11 (static):**
    - `src/registrars/godaddy.ts` contains no `register` HTTP call or path (grep for `/purchase`, `/register`, `availab`, `topup`, `top-up`, `billing`);
    - `register()` throws `NOT_SUPPORTED` without any HTTP request (MSW would error on one);
    - `GET /check` with GoDaddy enabled lists godaddy with `NO_AVAILABILITY_ACCESS` and is never the winner.
  - **`findDomain`:** 200 → mapped info; 404 → null; 403 `ACCOUNT_NOT_ELIGIBLE` → `RegistrarError` with that code, `ambiguous` false.
  - **The PAT** never appears in logs or error messages (reuse the AU-8 grep helper if one exists, or assert on the error message).
  - **Config:** `GODADDY_BASE_URL` must be https outside tests.
- [ ] **Step 2–4:** Implement, then `npx vitest run && npx tsc --noEmit`.
- [ ] **Step 5: Commit** `feat: GoDaddy management-only adapter (v3 NS with operation polling; never registers or quotes) + /list ns_status pending (L-12, IM-11)`

---

### Task 4: `import-domain` (IM-1–IM-3, IM-5–IM-10, LG-9, PR-17)

**Files:** Create `src/admin/import-domain.ts`, `tests/api/import-domain.test.ts`. Modify `src/admin.ts`.

**CLI** (exact flags from report.md §Import, plus these):
```
npm run admin -- import-domain --domain D --registrar porkbun|godaddy|other --buy-date YYYY-MM-DD --cost 13.73 [--cost-note "…"]
  [--order <id>|none] [--deal D-NNN] --category C [--grade strong|weaker]
  [--listing-mode bin|hybrid|offer --bin N [--floor N --walkaway N --pricing-exception "<reason>"] [--min-offer N] [--override --override-reason "…"]]
  [--comps-file comps.json | --legacy-no-comps "<reason>"]
  [--approval-text "…" --approval-at ISO] [--manual --expiry YYYY-MM-DD] [--renewal-price N] [--dry-run]
```

**Flow:**
1. **Parse and check the arguments:**
   - the money flags must be USD ≤ 2 decimals;
   - `--category` is required (IM-9 → `CATEGORY_REQUIRED`);
   - geo needs `--grade`;
   - a listing needs approval text and time (D9);
   - an exception needs a reason;
   - comps (D8): one of `--comps-file` / `--legacy-no-comps`; legacy only if buy date < 2026-10-05;
   - `--manual` needs `--expiry` (IM-7).
2. **Already in `domains`** (any status) → refused, `ALREADY_IN_PORTFOLIO` (IM-2).
3. **Registrar data:**
   - **`--manual`:** `registrar_api = 'none'`; expiry from the flag.
   - **Otherwise:** the adapter for `--registrar` must be enabled. Call `findDomain`:
     - null → refused, `NOT_IN_ACCOUNT` (IM-3);
     - `RegistrarError` with code `ACCOUNT_NOT_ELIGIBLE` → refused with the hint "use --manual with --expiry YYYY-MM-DD" (IM-6);
     - otherwise the expiry (and NS) come from the adapter; `registrar_api` = `registrarApiOf(adapter.capabilities)` (`manage` for GoDaddy, IM-5).
4. **Settings and plan:**
   - `s = currentSettings(db, now)`;
   - if a listing is given: `validateListing(req, { category, grade, phase: 'buy', settings: s, highValueMinBinCents, override, overrideReason, approvalValid: true, today, dropDate: addOneYear(expiry) })` → a plan, or a refusal with the guard code (IM-9);
   - `validateComps` unless legacy (warning `LEGACY_NO_COMPS`).
5. **`--dry-run`:** print JSON `{ dry_run: true, domain, registrar_api, expiry_date, drop_date, listing: planView(plan, buildSchedule({ plan, anchor: today, dropDate, settings: s })), warnings }`, write nothing, and exit 0.
6. **Write**, in one transaction under `withDomainLock` (the same rows as a `/buy` success, IM-1):
   - **domains row:** status `listed` if there's a listing, else `owned`; `registrar`, `registrar_api`, `buy_date`, `cost_cents`, `expiry_date`, `renewal_price_cents` (null if unknown), `renewals_used 0`, `drop_date = addOneYear(expiry)`, `category`, `price_grade`, `deal_id`; plus, when listed, `domainPlanColumns(plan)`, `first_listed_at = now` and `changedColumns`;
   - **ledger:** `registration` −cost, `occurred_on` = buy date, `counterparty` = registrar, `receipt_ref` = `registrar:order` (`order 'none'` → `registrar:none`), note `"import; <cost-note>; approval <audit_id>"`;
   - **`pricing_evidence`:** comps + rationale, or `legacy_no_comps_reason`;
   - **listing:** a history row `source 'import'` (`historyRow`, `at` = now, approval text/time) and `writePlan` (anchor = today IDT, `dropDate`, `settings: s`, `planAuditId` = the audit id);
   - **`deals`:** upsert when `--deal`;
   - **audit:** an admin audit row (`path 'import-domain'`) with the approval text/time and a `request` holding the flags. **No secrets**; the cost note is free text, so refuse `@` in it (`NO_PII`).
7. **Warnings:**
   - `RENEWAL_PRICE_UNKNOWN` when there's no renewal price (IM-8);
   - `LEGACY_NO_COMPS`;
   - the plan warnings (`FLOOR_AUTO_ACCEPT`, `PRICING_EXCEPTION`);
   - the cap warnings (D7).
8. **Output:** JSON `{ domain, status, registrar_api, expiry_date, drop_date, listing, warnings }`, exit 0. Refusals → exit 2 (usage) or 1 (with the code in the message).

- [ ] **Step 1: Failing tests** (call `importDomain(...)` directly for most, plus a few CLI runs):
  - **IM-1:** a Porkbun mock (FakeAdapter whose `findDomain` returns expiry 2027-10-04) imports a geo weaker name. The rows have the same shape as a `/buy` success: every domains column that `/buy` fills is non-null, and there is a ledger `registration` row and a `pricing_evidence` row. The ledger sum includes it.
  - **IM-2:** a second import → refused, no new rows.
  - **IM-3:** `findDomain` → null → refused.
  - **IM-5:** a GoDaddy MSW `findDomain` OK → `registrar_api 'manage'`, expiry from the mock.
  - **IM-6:** GoDaddy 403 `ACCOUNT_NOT_ELIGIBLE` → refused with the `--manual` hint, no rows.
  - **IM-7:** `--manual` without `--expiry` → refused.
  - **IM-8:** `--manual --expiry 2027-10-04`, with no renewal price → imported, `registrar_api 'none'`, `drop_date` 2028-10-04, warning `RENEWAL_PRICE_UNKNOWN`.
  - **IM-9:** no category → `CATEGORY_REQUIRED`; a trend `--listing-mode bin --bin 999` without override → `MODE_NOT_ALLOWED_FOR_CATEGORY`, nothing written.
  - **IM-10:**
    - after the import, `spentAndPending` includes it;
    - a `/buy` whose quote exceeds the remaining cap → `POC_CAP_EXCEEDED`;
    - with 50 domains already, the import succeeds with `DOMAIN_CAP_EXCEEDED_BY_IMPORT`, and a following `/buy` → `DOMAIN_CAP_REACHED`.
  - **LG-9 / D-001 (the spec's exact command, with a fixed clock of 2026-10-06):**
    - `--registrar godaddy --buy-date 2026-10-04 --cost 13.73 --cost-note "42 ILS @0.3269" --order none --deal D-001 --category trend --listing-mode hybrid --bin 1995 --floor 1295 --walkaway 950 --pricing-exception "Dvir approved 2026-10-05 00:39 IDT" --legacy-no-comps "bought before the comps rule; card found no comps" --approval-text "Approve the prices, but wait for the software to list it" --approval-at 2026-10-05T00:39:00+03:00 --manual --expiry 2027-10-04`;
    - expect status `listed`, 1995/1295/950/100, `approved_exception`, warnings ⊇ {`FLOOR_AUTO_ACCEPT`, `PRICING_EXCEPTION`, `LEGACY_NO_COMPS`, `RENEWAL_PRICE_UNKNOWN`};
    - ledger −1373, `receipt_ref 'godaddy:none'`;
    - 4 schedule rows = PR-11 values anchored 2026-10-06 (M6 2027-04-06, M18 2028-04-06, final push 2028-07-06, delist 2028-09-27);
    - a history row with `source 'import'`;
  - **D8:** `--legacy-no-comps` with buy date 2026-10-06 → `COMPS_REQUIRED`.
  - **PR-17:** the same inputs (trend hybrid 1995, today 2026-10-12, drop 2028-10-04 via expiry 2027-10-04) through `import-domain --dry-run`, `GET /pricing/preview?...&listed_on=2026-10-12&drop_date=2028-10-04`, a `/list` dry run and a `/buy` dry run (drop date there is today + 24 months, so compare the plan fields and the schedule only where the inputs agree) → identical `bin_cents`, `floor_cents`, `walkaway_cents`, `min_offer_cents`, `sell_plan_line`, `schedule` for preview, list and import.
  - **CLI:** one test that runs the D-001 command as a subprocess with `--dry-run` (env from `testEnv()`) → exit 0 and JSON; the output has no `pk1_`/`sk1_`/PAT value.
- [ ] **Step 2–4:** Implement, then `npx vitest run && npx tsc --noEmit && npm run build`.
- [ ] **Step 5: Commit** `feat: admin import-domain (registrar or --manual, same calculator and rules, legacy comps, exceptions, schedule from the import date, dry run) (IM-1–IM-3, IM-5–IM-10, LG-9, PR-17)`

---

### Task 5 (Opus): Gate report

- [ ] Full suite, typecheck and build.
- [ ] Map the IDs: S-1–S-8, PR-25, PR-26, L-12, IM-1–IM-3, IM-5–IM-11, LG-9, PR-17.
- [ ] Final review, then a fix wave.
- [ ] Spec sync after Dvir confirms D1–D9.
- [ ] Push.

## Review Focus
1. **A sale racing the price job on the same domain:** the lock serialises them. If the sale wins, the job finds no planned rows; if the job wins, the sale then cancels whatever is left. Test in Task 1.
2. **`drop-at-first-expiry` after M6 was applied:** M6 isn't recreated, the final push and delist move, and M18 is superseded (PR-25 with M6 applied). Test in Task 2.
3. **A GoDaddy operation that never finishes:** `/list` returns `pending` and saves, with no hang beyond the poll timeout. Test in Task 3.
4. **An import of a name whose expiry is already past** (an old manual buy): it imports as `owned`; `drop_date` = expiry + 1 y, which may already be past, so the next drop job drops it. Document and test in Task 4.
5. **A sale on an `owned` (never listed) domain with no lander:** the Afternic commission expectation is 25% (no Afternic NS). Test in Task 1.

## Self-review notes
- **sold.md** → Task 1. **report.md §Import** → Tasks 3 and 4. **list.md GoDaddy NS** → Task 3. **§10.4 drop_date change and cancels** → Tasks 1 and 2.
- **Not here (4d-2):** `RENEWAL_PRICE_UNKNOWN` in `/report`, `committed_forward` incomplete, expired-not-renewed warnings, and the post-buy-incomplete flag.
