# Step 4c: Offers log: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Log every offer received as a demand signal (Dvir's decision #2, 5 Oct 2026, 01:03 IDT). The server classifies each offer against the prices in force when it arrived, and routes it: decline automatically, ask Dvir, or accept (Afternic auto-accepts or the plan pre-approved it). It also supports outcomes, an all-or-nothing CSV import, a read endpoint and the offer aggregates for reports.

This step builds:
- `offers` and `offer_imports` (immutable facts);
- `POST /offers`, `POST /offers/{id}/outcome`, `POST /offers/import` (CSV, `dry_run`), `GET /offers`, `GET /report/offers`;
- the aggregates service that `/report` reuses in 4d.

Gate G1 for OF-1–OF-15, OF-17, OF-18 and OF-19 (OF-18/OF-19 through `GET /report/offers` and the service), plus the "zero outbound calls" half of OF-20.

**Not in this step (4d):**
- the `/report` `per_domain[].offers` / `offers_by_strategy` blocks and the `OFFER_NEEDS_DVIR` warning (the other half of OF-20), which will call this step's service;
- `/sold`, which `outcome: sold` must match. For now, `sold` requires the domain's status to be `sold`;
- the lander check in OF-14.

**Architecture:**
- **`src/services/offer-rules.ts`** is pure. `classify(snapshot, amount, source)` returns `{band, routing, outcome, next_step, warnings}`.
- **`src/services/offers.ts`** handles the DB side:
  - the snapshot of prices in force at `received_at` (the latest `listing_history` row with a mode and `at ≤ received_at`);
  - record, dedupe, outcome and import.
- **`src/services/offer-stats.ts`** holds the aggregates.
- **No offer path touches a registrar, a marketplace or a price.** The only exception is an explicit `pricing_hold` with `approval_ref`, which uses the same per-domain lock and history row as `/list`.

**Spec:** `docs/specs/listing-strategy.md` §10.8 (who decides), §10.11 (offers log), §2 (modes); `docs/specs/test-plan.md` OF-1–OF-20; `docs/specs/report.md` (offer endpoints); `docs/specs/00-architecture.md` §4 (`offers`, `offer_imports`).

## Global Constraints

- **Money:** integer cents plus display strings.
- **Errors:** the usual envelope.
- **POSTs:** idempotent and audited.
- **Tests:** no network.
- **No PII:** values containing `@` are refused in `buyer_ref`, `note` and `external_ref` (`NO_PII`).
- **Bands use the prices in force at `received_at`, never the current ones** (OF-7). Bounds are inclusive below: walk-away, floor and BIN each start their band (OF-4).
- **Immutable facts:** `domain_id`, `amount_cents`, `source`, `received_at`, the snapshot columns and `band` can't be updated (DB trigger), and rows can't be deleted. Only `outcome*` changes, through the API, with an audit row.
- **History timestamps use the app clock:** `listing_history.at` must be the service's `now`, not the DB default, so that "prices in force at time T" is consistent with every other app-clock timestamp. Task 1 fixes the writers.

## Decisions taken in this plan that the spec doesn't spell out (Dvir to confirm)

| # | Decision | Why |
|---|---|---|
| O1 | **Offer mode** (override): `< min_offer` → `below_min`/`auto_decline`; anything else → `mid_range`/`dvir`. A floor in offer mode → `at_or_above_floor`, with routing as for hybrid. **Non-geo plain `bin`** (override) uses the geo bands (`geo_below_bin`/`at_or_above_bin`). **No prices at all** → band `unpriced`, routing `dvir`, outcome `open` | §2: in offer mode every offer goes to Dvir. The spec only names the geo and hybrid bands |
| O2 | **Routing at or above the BIN:** like at or above the floor: `auto_accept` on afternic/godaddy, `accept_preapproved` elsewhere, `dvir` for email sources | §10.8 table: "≥ BIN … pre-approved by the buy card"; email always goes to Dvir |
| O3 | **Outcome transitions:** `open`/`declined_auto` → any outcome; `countered` → `countered`/`accepted`/`declined`/`expired`/`withdrawn`; `accepted` → `sold`/`withdrawn`. `declined`, `expired`, `withdrawn` and `sold` are final (409 `OUTCOME_FINAL`). An invalid jump → 409 `OUTCOME_TRANSITION_INVALID` | The spec lists the outcomes but not their order |
| O4 | `sold` requires the domain's status to be `sold` (409 `OFFER_SOLD_MISMATCH`), until `/sold` exists in 4d | "sold must match a POST /sold" |
| O5 | The CSV `outcome` column may be empty, `declined`, `expired` or `withdrawn`. `countered`/`accepted`/`sold` need Dvir's approval or `/sold`, so in a CSV they are 422 `OUTCOME_NEEDS_APPROVAL` for that row | A CSV has no `approval_ref` |
| O6 | **Re-importing the same file** (same SHA-256): 200, `{inserted: 0, duplicates: rows}`, and no new `offer_imports` row; the response returns the original `import_id`. **Duplicate rows inside one file**: the second counts as a duplicate | §10.11 "re-importing the same file inserts nothing" |
| O7 | **`POST /offers` may carry `pricing_hold: true`, `pricing_hold_reason` and `approval_ref`.** It then sets the hold exactly as `/list` does (lock, history row, reason required). Without `approval_ref` → 422 `APPROVAL_REQUIRED` | §10.11 "may set pricing_hold only if the request asks for it with approval_ref" |
| O8 | **Aggregates:** <ul><li>`pct_of_bin` = amount ÷ `bin_cents_at`, rounded to 4 decimals (null without a BIN).</li><li>`offers_per_listed_name_per_month` = `offers_90d` ÷ `names_listed` ÷ 3, 2 decimals (0.00 when nothing is listed).</li><li>`names_with_offers` counts listed names with at least one offer in 90 days.</li><li>Median, max and band shares are all-time, and the shares sum to 1.00.</li><li>Strategy labels: geo S2, trend S3, b2b S3/S4, collision S4, regulation S6, buzzword S5, other S7.</li><li>`GET /report/offers` defaults to the last 90 days and `group_by=domain`.</li></ul> | §10.11 lists the fields; the rounding and windows aren't specified |
| O9 | **`recorded_by`** = the token's name. **Received-at window:** ≤ now + 5 min (`RECEIVED_AT_IN_FUTURE`); no lower bound | §10.11 |

---

## File structure

```
migrations/1760300000000_offers.sql   offers, offer_imports, immutability trigger, dedupe indexes
src/services/offer-rules.ts           classify(), nextStep(), OfferSnapshot, Band, Routing
src/services/offers.ts                OfferService: record, outcome, importCsv, list; snapshotAt()
src/services/offer-stats.ts           perDomainOffers(), offersByStrategy(), reportOffers()
src/api/offers.ts                     routes (+ text/csv parser for /offers/import)
src/services/plan-store.ts, src/jobs/price-schedule.ts, src/services/list.ts, src/services/buy.ts  (modify) history at = app clock
src/db/types.ts, src/app.ts           (modify)
tests/unit/offer-rules.test.ts, tests/api/offers.test.ts, tests/api/offers-import.test.ts, tests/api/offer-stats.test.ts
```

---

### Task 1: Schema, history clock, classifier

**Files:**
- Create: `migrations/1760300000000_offers.sql`, `src/services/offer-rules.ts`, `tests/unit/offer-rules.test.ts`
- Modify: `src/db/types.ts`, `src/services/plan-store.ts` (`historyRow` takes and sets `at`), `src/jobs/price-schedule.ts` (history `at: now`), `src/services/list.ts`, `src/services/buy.ts` (pass `now`), `tests/helpers/db.ts` (TABLES), `tests/api/admin-cli.test.ts` (8 migrations), `tests/api/schema.test.ts`

**Migration:**
```sql
-- Up Migration
CREATE TABLE offer_imports (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  file_sha256  text NOT NULL UNIQUE CHECK (file_sha256 ~ '^[0-9a-f]{64}$'),
  rows         integer NOT NULL CHECK (rows >= 0),
  inserted     integer NOT NULL CHECK (inserted >= 0),
  duplicates   integer NOT NULL CHECK (duplicates >= 0),
  recorded_by  text NOT NULL,
  audit_id     text,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER offer_imports_append_only BEFORE UPDATE OR DELETE ON offer_imports FOR EACH ROW EXECUTE FUNCTION reject_mutation();
CREATE TRIGGER offer_imports_no_truncate BEFORE TRUNCATE ON offer_imports FOR EACH STATEMENT EXECUTE FUNCTION reject_mutation();

CREATE TABLE offers (
  id                     bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  domain_id              bigint NOT NULL REFERENCES domains (id),
  amount_cents           integer NOT NULL CHECK (amount_cents > 0),
  source                 text NOT NULL CHECK (source IN ('afternic','godaddy','sedo','domainagents','email_inbound','outbound_reply','other')),
  received_at            timestamptz NOT NULL,
  buyer_type             text NOT NULL DEFAULT 'unknown' CHECK (buyer_type IN ('end_user','investor','broker','unknown')),
  buyer_ref              text CHECK (buyer_ref IS NULL OR position('@' in buyer_ref) = 0),
  external_ref           text CHECK (external_ref IS NULL OR position('@' in external_ref) = 0),
  bin_cents_at           integer, floor_cents_at integer, walkaway_cents_at integer, min_offer_cents_at integer,
  listing_history_id     bigint REFERENCES listing_history (id),
  band                   text NOT NULL CHECK (band IN ('below_min','below_walkaway','mid_range','at_or_above_floor','at_or_above_bin','geo_below_bin','unpriced')),
  routing                text NOT NULL CHECK (routing IN ('auto_decline','dvir','auto_accept','accept_preapproved')),
  outcome                text NOT NULL CHECK (outcome IN ('declined_auto','open','declined','countered','accepted','expired','withdrawn','sold')),
  outcome_at             timestamptz,
  outcome_note           text CHECK (outcome_note IS NULL OR position('@' in outcome_note) = 0),
  outcome_approval_text  text,
  note                   text CHECK (note IS NULL OR position('@' in note) = 0),
  recorded_by            text NOT NULL,
  import_id              bigint REFERENCES offer_imports (id),
  audit_id               text,
  created_at             timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX offers_source_external_ref ON offers (source, external_ref) WHERE external_ref IS NOT NULL;
CREATE UNIQUE INDEX offers_natural_key ON offers (domain_id, amount_cents, source, received_at) WHERE external_ref IS NULL;
CREATE INDEX offers_domain_received ON offers (domain_id, received_at DESC);

CREATE FUNCTION offers_facts_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'offers: DELETE is not allowed'; END IF;
  IF (NEW.domain_id, NEW.amount_cents, NEW.source, NEW.received_at, NEW.buyer_type, NEW.buyer_ref, NEW.external_ref,
      NEW.bin_cents_at, NEW.floor_cents_at, NEW.walkaway_cents_at, NEW.min_offer_cents_at, NEW.listing_history_id,
      NEW.band, NEW.routing, NEW.note, NEW.recorded_by, NEW.import_id, NEW.audit_id, NEW.created_at)
     IS DISTINCT FROM
     (OLD.domain_id, OLD.amount_cents, OLD.source, OLD.received_at, OLD.buyer_type, OLD.buyer_ref, OLD.external_ref,
      OLD.bin_cents_at, OLD.floor_cents_at, OLD.walkaway_cents_at, OLD.min_offer_cents_at, OLD.listing_history_id,
      OLD.band, OLD.routing, OLD.note, OLD.recorded_by, OLD.import_id, OLD.audit_id, OLD.created_at) THEN
    RAISE EXCEPTION 'offers: facts are immutable; only outcome fields may change';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER offers_immutable BEFORE UPDATE OR DELETE ON offers FOR EACH ROW EXECUTE FUNCTION offers_facts_immutable();
CREATE TRIGGER offers_no_truncate BEFORE TRUNCATE ON offers FOR EACH STATEMENT EXECUTE FUNCTION reject_mutation();

-- Down Migration
DROP TABLE offers;
DROP FUNCTION offers_facts_immutable();
DROP TABLE offer_imports;
```

**`src/services/offer-rules.ts`:**
```ts
export type OfferSource = 'afternic' | 'godaddy' | 'sedo' | 'domainagents' | 'email_inbound' | 'outbound_reply' | 'other';
export const OFFER_SOURCES: readonly OfferSource[];
export type BuyerType = 'end_user' | 'investor' | 'broker' | 'unknown';
export const BUYER_TYPES: readonly BuyerType[];
export type Band = 'below_min' | 'below_walkaway' | 'mid_range' | 'at_or_above_floor' | 'at_or_above_bin' | 'geo_below_bin' | 'unpriced';
export type Routing = 'auto_decline' | 'dvir' | 'auto_accept' | 'accept_preapproved';
export interface OfferSnapshot {
  mode: 'bin' | 'hybrid' | 'offer' | null; binCents: number | null; floorCents: number | null;
  walkawayCents: number | null; minOfferCents: number | null; listingHistoryId: number | null; listedAtReceipt: boolean;
}
export function classify(s: OfferSnapshot, amountCents: number, source: OfferSource): {
  band: Band; routing: Routing; outcome: 'declined_auto' | 'open'; nextStep: string; warnings: string[];
};
```

**Rules:**
- **Band:**
  - `hybrid`: `< min` → `below_min`; `< walk` → `below_walkaway`; `< floor` → `mid_range`; `< bin` → `at_or_above_floor`; else `at_or_above_bin`.
  - `bin` (geo or override): `< bin` → `geo_below_bin`; else `at_or_above_bin`.
  - `offer`: `< min` → `below_min`; a floor and `≥ floor` → `at_or_above_floor`; else `mid_range` (O1).
  - No mode, or the needed price is null → `unpriced`.
- **Routing:**
  - `below_min`, `below_walkaway` and `geo_below_bin` → `auto_decline` (for every source, OF-5).
  - `email_inbound`/`outbound_reply` with any other band → `dvir`.
  - `mid_range` and `unpriced` → `dvir`.
  - `at_or_above_floor` and `at_or_above_bin` → `auto_accept` on afternic/godaddy, `accept_preapproved` elsewhere (O2).
- **Outcome:** `declined_auto` iff the routing is `auto_decline`, else `open`.
- **Warnings:**
  - `OFFER_ON_UNLISTED` when `!listedAtReceipt`;
  - `OFFER_AT_OR_ABOVE_FLOOR` when the band is `at_or_above_floor` and the source is afternic/godaddy.
- **`nextStep`** (plain text, one per routing and source family):
  - `auto_decline` + afternic/godaddy: "Below the walk-away: decline in the Afternic dashboard (or let it expire); no Gate D."
  - `auto_decline` + sedo/domainagents/other: "Below the walk-away: Sochen's standard decline template; no Gate D."
  - `auto_decline` + email: "Below the walk-away: Sochen's standard decline template; Dvir sends it (pre-approved text, no Gate D)."
  - `geo_below_bin`: "Geo price is fixed: reply 'The price is $X, fixed'." ($X = the BIN in whole dollars)
  - `dvir` + `mid_range`: "Mid-range: Sochen drafts; needs Dvir's Gate D line."
  - `dvir` + email at or above the walk-away: "Email offer: Sochen drafts; Dvir decides and sends."
  - `dvir` + `unpriced`: "No prices in force: ask Dvir."
  - `auto_accept`: "At or above the floor: Afternic may already have closed this; check the dashboard."
  - `accept_preapproved`: "At or above the floor: accept (pre-approved by the buy card)."

**History clock:** `historyRow` gains a required `at: Date`. `/list`, `/buy` saveListing and the price job pass their `now`. The job passes `new Date(this.deps.now())`.

- [ ] **Step 1: Failing tests:**
  - **`offer-rules.test.ts`** with the D-001 snapshot (hybrid 199500/129500/95000/10000):
    - OF-1: 45000 afternic → `below_walkaway`/`auto_decline`/`declined_auto`, `nextStep` mentions "no Gate D".
    - OF-2: 100000 → `mid_range`/`dvir`/`open`.
    - OF-3: 129500 → `at_or_above_floor` + `auto_accept` + `OFFER_AT_OR_ABOVE_FLOOR`; 199500 → `at_or_above_bin`.
    - OF-4 boundaries: 9900 `below_min`; 10000 `below_walkaway`; 94900 `below_walkaway`; 95000 `mid_range`; 129400 `mid_range`.
    - OF-5: 120000 `email_inbound` → `dvir`; 60000 `email_inbound` → `auto_decline`.
    - OF-6: geo 39900 snapshot, 35000 → `geo_below_bin`/`auto_decline`, `nextStep` includes "$399"; 39900 → `at_or_above_bin`.
    - O1/O2 rows: offer mode min 50000 → 40000 `below_min`, 60000 `mid_range`; non-geo plain bin 99900 → `geo_below_bin` below; no mode → `unpriced`/`dvir`/`open`; sedo at or above the floor → `accept_preapproved`; email at or above the BIN → `dvir`.
    - `listedAtReceipt` false → `OFFER_ON_UNLISTED`.
  - **Schema:**
    - OF-11: raw `UPDATE offers SET amount_cents=…`, `band`, `received_at` → error; `UPDATE offers SET outcome='declined'` → OK; `DELETE` → error.
    - `offer_imports` UPDATE → error.
    - The two dedupe indexes reject duplicates.
    - The `buyer_ref` CHECK rejects `a@b.com`.
  - **History clock:** after a `/list` with a fixed app clock of 2026-10-12, `listing_history.at` equals that clock. After a price-job run with `now` = 2027-04-12T00:30Z, the history `at` equals it.
- [ ] **Step 2:** Run → fail.
- [ ] **Step 3:** Implement. `npm run migrate up` on the dev DB, then `down` and `up`.
- [ ] **Step 4:** `npx vitest run && npx tsc --noEmit`.
- [ ] **Step 5: Commit** `feat: offers schema (immutable facts, dedupe keys, imports), offer classifier (bands, routing, next step), history timestamps on the app clock (OF-1–OF-6, OF-11)`

---

### Task 2: `POST /offers`, `GET /offers`, `POST /offers/{id}/outcome`

**Files:**
- Create: `src/services/offers.ts`, `src/api/offers.ts`, `tests/api/offers.test.ts`
- Modify: `src/app.ts`

**`snapshotAt(db, domainId, receivedAt)`:**
- Take the latest `listing_history` row of the domain with `mode IS NOT NULL` and `at ≤ receivedAt`.
- If there is none, use the latest such row at all ("the plan's prices", OF-10). If there is still none, use the domain's current prices. If they are null too, the snapshot has a null mode.
- **`listedAtReceipt`:** true iff the domain's status was `listed` at `receivedAt`. Approximate it as: the domain is now `listed` or `delisted`/`sold`, AND `first_listed_at ≤ receivedAt`, AND (`delisted_at` is null or `delisted_at > receivedAt`).

**`POST /offers`** (WRITE). Body (zod, strict):
```
{ domain, amount_usd: string, source, received_at, buyer_type?, buyer_ref?, external_ref?, note?,
  pricing_hold?: boolean, pricing_hold_reason?: string, approval_ref? }
```

Checks, in this order:
1. Unknown domain, or a domain in `pending_purchase` → 404 `DOMAIN_NOT_FOUND`.
2. `amount_usd` must match `^\d+(\.\d{1,2})?$`, be > 0, and pass `usdStringToCents` → else 422 `AMOUNT_INVALID`.
3. `source` → else 422 `SOURCE_INVALID`.
4. `buyer_type` → else 422 `BUYER_TYPE_INVALID`.
5. `received_at` must be ISO with an offset → else 422 `VALIDATION_ERROR`; more than 5 min in the future → 422 `RECEIVED_AT_IN_FUTURE`.
6. `@` in `buyer_ref`, `external_ref` or `note` → 422 `NO_PII`.
7. `pricing_hold: true` without a valid `approval_ref` naming the domain → 422 `APPROVAL_REQUIRED` (or the approval's own code); without a reason → 422 `HOLD_REASON_REQUIRED`.

Then:
- **Dedupe:** `(source, external_ref)` when an `external_ref` is given, else `(domain_id, amount_cents, source, received_at)`. A match → **200** with the existing row and `"duplicate": true`; nothing written, and the hold is not applied.
- **Otherwise:** classify, then insert. `recorded_by` = `req.auth.name`, `audit_id` = `req.auditId`. Map a 23505 race to the duplicate path.
- **If a hold is requested:** under `withDomainLock`, run the same update and history row as `/list`'s hold (reuse a small exported helper from `list.ts` or plan-store, e.g. `applyHold(trx, cur, {hold, reason, approvalText, approvalAt, auditId, now})`).
- **Response 201:**
  - the row view: `id`, `domain`, `amount_cents` + `amount` display, `source`, `received_at` (ISO with offset), `buyer_type`, `external_ref`, `band`, `routing`, `outcome`, `snapshot {bin, floor, walkaway (private), min_offer}` as cents + display, `listing_history_id`;
  - plus `next_step` and `warnings`.

**`GET /offers?domain=&from=&to=&band=&source=`** (READ):
- newest first by `received_at`, then `id`;
- `from`/`to` are dates (IDT days, inclusive) or ISO times;
- invalid filters → 400 `VALIDATION_ERROR`;
- limit 500.

**`POST /offers/:id/outcome`** (WRITE) `{ outcome, note?, approval_ref? }`:
- Unknown id → 404 `OFFER_NOT_FOUND`.
- Transitions per O3 (409 `OUTCOME_FINAL` / `OUTCOME_TRANSITION_INVALID`).
- `countered`/`accepted` when the band is `mid_range` OR the source is `email_inbound`/`outbound_reply` → needs a valid `approval_ref` naming the offer's domain (else 422 `APPROVAL_REQUIRED`). Store its text in `outcome_approval_text`.
- `sold` → domain status must be `sold` (O4).
- `@` in `note` → `NO_PII`.
- Update only `outcome`, `outcome_at` (= now), `outcome_note` and `outcome_approval_text`. Audited by the middleware.
- 200 with the row view.

- [ ] **Step 1: Failing tests** (`tests/api/offers.test.ts`, fixed app clock). Set up D-001-like data:
  - an owned trend domain listed via `/list` hybrid 1995 with the exception 1295/950 + approval on 2026-10-12;
  - a geo weaker domain listed at 399.

  Cases:
  - **OF-1:** $450 afternic, received 2026-12-01 → 201; band, routing and outcome per Task 1; snapshot 199500/129500/95000/10000 with display strings; walk-away display "(private)"; `next_step`.
  - **OF-2 / OF-3:** via the API (bands, routing, warning).
  - **OF-7:**
    1. Run `PriceScheduleJob({ db, now: 2027-04-12T00:30Z })` with `today 2027-04-12`, which applies M6 (floor 103500).
    2. An offer of $1,100 received 2027-04-11T12:00+03:00 → `mid_range`.
    3. One received 2027-04-13T12:00+03:00 → `at_or_above_floor`.
  - **OF-8:**
    - the same source + `external_ref` twice → the second is 200 with `duplicate: true` and the same id, one row;
    - without `external_ref`, the same domain/amount/source/`received_at` twice → also a duplicate.
  - **OF-9:**
    - a READ token → 403;
    - an unknown domain → 404 `DOMAIN_NOT_FOUND`;
    - `"0"` and `"12.345"` → `AMOUNT_INVALID`;
    - `ebay` → `SOURCE_INVALID`;
    - `received_at` 1 h ahead → `RECEIVED_AT_IN_FUTURE`;
    - `buyer_ref` `a@b.com` → `NO_PII`;
    - `buyer_type` `whale` → `BUYER_TYPE_INVALID`.
  - **OF-10:** an owned domain that was never listed → 201, `OFFER_ON_UNLISTED`, band `unpriced`. For a domain that was listed after the offer's `received_at`: band against the plan's prices, plus `OFFER_ON_UNLISTED`.
  - **OF-12:**
    - `countered` on the mid-range offer without approval → 422 `APPROVAL_REQUIRED`; with approval → 200 and `outcome_approval_text` stored;
    - `declined` on an `auto_decline` offer without approval → 200;
    - each successful change writes one `audit_log` row (count before and after);
    - `declined` then `accepted` → 409 `OUTCOME_FINAL`;
    - `sold` on a domain that isn't sold → 409 `OFFER_SOLD_MISMATCH`.
  - **O7:** `pricing_hold: true` + reason + approval → domain `pricing_hold` true and one history row. Without approval → 422 and nothing written.
  - **OF-20 (half):**
    - with the FakeAdapter, snapshot its `calls` before and after `POST /offers`, `/outcome` and `GET /offers`: no new calls;
    - the domain's prices and `pricing_hold` are unchanged after an offer without a hold;
    - MSW would error on any HTTP call.
  - **`GET /offers`:** newest first; filters by `domain`, `band`, `source` and `from`/`to`; a bad `band` → 400.
- [ ] **Step 2–4:** Implement, then `npx vitest run && npx tsc --noEmit`.
- [ ] **Step 5: Commit** `feat: POST /offers (snapshot at receipt, bands, routing, dedupe, optional hold), GET /offers, POST /offers/{id}/outcome (Gate D approvals, transitions) (OF-1–OF-3, OF-7–OF-10, OF-12, OF-20 part)`

---

### Task 3: CSV import

**Files:**
- Modify: `src/services/offers.ts`, `src/api/offers.ts`
- Create: `tests/api/offers-import.test.ts`

**`POST /offers/import?dry_run=true|false`** (WRITE, `Content-Type: text/csv`):
- **Parser and size:** add a scoped content-type parser for `text/csv` on this route (as a string, limit 1 MB → 413 `INVALID_BODY` via the existing error mapping). Parse RFC 4180 (quotes, CRLF/LF, BOM stripped). Reuse a small parser if one exists in the repo (`tests/helpers/csv.ts` is test-only, so write `src/csv-parse.ts`).
- **Header:** must be exactly `domain,amount_usd,source,received_at,buyer_type,external_ref,outcome,note`, else 422 `CSV_HEADER_INVALID`. The column count per row must be 8, else a row error `COLUMN_COUNT`.
- **Validation:** validate every row with the same checks as `POST /offers` (empty `buyer_type` = `unknown`; empty `external_ref`/`outcome`/`note` = null; outcome per O5).
  - Collect `{row: n (1-based data row), field, code}` for every problem.
  - Unknown domain → `DOMAIN_NOT_FOUND`.
  - Any problem → **422** `IMPORT_INVALID` with `details.errors`, and nothing written.
- **Dedupe:** against the DB and within the file (O6).
- **The same file again** (its SHA-256 is already in `offer_imports`) → 200 `{import_id: <existing>, rows, inserted: 0, duplicates: rows, by_band}`, with nothing written.
- **Write:** in one transaction, insert `offer_imports` and then the new offers, each with `import_id`, `recorded_by`, `audit_id`. An outcome from the CSV sets `outcome`/`outcome_at` (now) on insert.
- **`dry_run`:** no writes. Response `{dry_run: true, rows, would_insert, duplicates, by_band}`.
- **Response:** `{import_id, rows, inserted, duplicates, by_band: {band: count}}`. `by_band` counts the new (would-be) offers only.

- [ ] **Step 1: Failing tests:**
  - **OF-13:** a dry run with 5 valid rows → 200 `{rows: 5, would_insert: 5, duplicates: 0, by_band}`; the offers table is unchanged.
  - **OF-15:**
    1. 5 valid rows + 1 row with an unknown domain → 422 with `details.errors` containing `{row: 6, field: 'domain', code: 'DOMAIN_NOT_FOUND'}`; nothing written.
    2. Then the 5 valid rows → `inserted 5`.
    3. Then the same file again → `inserted 0, duplicates 5` and the same `import_id`.
  - **Other cases:**
    - a wrong header → 422 `CSV_HEADER_INVALID`;
    - a row with 7 columns → its row error;
    - a quoted note containing a comma parses;
    - `countered` in the CSV → 422 `OUTCOME_NEEDS_APPROVAL` row error;
    - a duplicate row within the file → counted once as a duplicate;
    - `@` in a note → `NO_PII` row error;
    - a READ token → 403;
    - a missing `Idempotency-Key` → 400.
- [ ] **Step 2–4:** Implement, then `npx vitest run && npx tsc --noEmit`.
- [ ] **Step 5: Commit** `feat: offers CSV import (exact header, all-or-nothing validation, dedupe in DB and file, same-file no-op, dry run) (OF-13, OF-15)`

---

### Task 4: Offer aggregates + `GET /report/offers` + OF-14/OF-17 checks

**Files:**
- Create: `src/services/offer-stats.ts`, `tests/api/offer-stats.test.ts`
- Modify: `src/api/offers.ts` (route `GET /report/offers`)

**`src/services/offer-stats.ts`:**
```ts
export interface PerDomainOffers { count_30d: number; highest_30d: Money | null; count_90d: number; highest_90d: Money | null;
  count_all: number; highest_all: Money | null; highest_all_pct_of_bin: number | null; last_offer_at: string | null; open_for_dvir: number }
// Money = { cents: number; display: string }
export async function perDomainOffers(db, now: Date): Promise<Map<number /* domain_id */, PerDomainOffers>>;
export async function offersByStrategy(db, now: Date): Promise<StrategyRow[]>;
export async function reportOffers(db, o: { from: Date; to: Date; groupBy: 'domain' | 'category' | 'source' | 'month' }): Promise<GroupRow[]>;
```

**Definitions:**
- **Windows:** periods are counted back from `now` in IDT days: 30d = `received_at ≥` IDT midnight of (today − 29); 90d likewise (today − 89). `last_offer_at` is ISO with offset.
- **`open_for_dvir`:** offers with `routing = 'dvir'` and `outcome IN ('open', 'countered')`.
- **`highest_all_pct_of_bin`:** the highest offer's amount ÷ its `bin_cents_at` (4 decimals).
- **`StrategyRow`:** `{ category, strategy, names_listed, names_with_offers, offers_90d, offers_per_listed_name_per_month, median_offer_pct_of_bin, max_offer_pct_of_bin, band_shares: Record<Band, number> }`, per O8. Only categories with at least one listed name or at least one offer appear; sort by category.
- **`GroupRow`:** `{ key, count, highest: Money|null, median_pct_of_bin, max_pct_of_bin, band_shares }`.
- **`GET /report/offers?from&to&group_by`** (READ): `from`/`to` are dates, default the last 90 IDT days; a bad parameter → 400. Response `{ from, to, group_by, rows }`.

- [ ] **Step 1: Failing tests:**
  - **OF-18** (service + route): D-001-like domain offers at −5 d ($450), −40 d ($1,000) and −200 d ($1,500) relative to a fixed `now`. Insert the offers through `POST /offers` with those `received_at` values.
    - `count_30d 1`, `highest_30d $450`;
    - `count_90d 2`, `highest_90d $1,000`;
    - `count_all 3`, `highest_all $1,500`, `highest_all_pct_of_bin` = round4(150000 / 199500) = 0.7519;
    - a listed domain without offers → zeros and nulls, keys present.
  - **OF-19:**
    - two trend names (3 and 0 offers within 90 d) and one geo name (1 offer);
    - trend: `names_listed 2`, `names_with_offers 1`, `offers_90d 3`, `offers_per_listed_name_per_month 0.50`, the median and max pct, and band shares that sum to 1.00 (±0.0001);
    - geo row separate;
    - `GET /report/offers?group_by=source` totals equal the same counts.
  - **OF-14:**
    - for the D-001 setup, `GET /export/afternic.csv` contains `PromptInjectionAudit.com,1995,1295,100,N,,Custom Lander,Y,N,Y,N` (set `display_name` via `/list`);
    - the Sedo row (test template) has minimum 100;
    - `GET /pricing/preview?...&domain=` gives an `afternic_row` without 950;
    - no export body or header contains `950`.
  - **OF-17:**
    - run the price job over D-001's M6, M18 and final-push dates; each time, `domains.min_offer_cents`, the new history row and the export row keep 100;
    - a geo strong M12 sets min offer = the new BIN (39900).
- [ ] **Step 2–4:** Implement, then `npx vitest run && npx tsc --noEmit && npm run build`.
- [ ] **Step 5: Commit** `feat: offer aggregates (per domain, per strategy, GET /report/offers) + walk-away and min-offer guards across exports and the job (OF-14, OF-17–OF-19)`

---

### Task 5 (Opus): Gate report + spec sync
- [ ] Full suite, typecheck and build.
- [ ] Map OF-1–OF-20 (OF-20's warning half and the `/report` blocks go to 4d).
- [ ] Final whole-change review, then a fix wave.
- [ ] Spec sync after Dvir confirms O1–O9 (and the open 4b-3 R1–R10). Push.

## Review Focus
1. **An offer received exactly when a drop applied** (at = the history time): `at ≤ received_at` puts it in the new prices' band. Test in Task 2 (OF-7 variant at the exact instant).
2. **Two `POST /offers` racing with the same `external_ref`:** one row, the other a duplicate (unique index + 23505 mapping). Test in Task 2.
3. **The CSV has a BOM, CRLF and a trailing newline:** it parses, with no phantom row. Test in Task 3.
4. **An offer on a delisted or sold domain:** recorded with the snapshot at receipt and `OFFER_ON_UNLISTED` only if `received_at` is after `delisted_at`. Test in Task 2.
5. **The aggregates on an IDT day boundary:** an offer at 23:30 IDT on day −30 is outside the 30 d window, and one at 00:10 IDT on day −29 is inside. Test in Task 4.

## Self-review notes
- **§10.11 coverage:**
  - table → Task 1;
  - `POST`/`GET`/outcome → Task 2;
  - import → Task 3;
  - `/report` aggregates → Task 4 (the service), with 4d wiring them into `/report` and the `OFFER_NEEDS_DVIR` warning;
  - the CLI (`dt offers import`) is part of the optional thin CLI, not here.
- **Types:** `OfferSnapshot`/`classify` (Task 1) are used by Tasks 2 and 3. `perDomainOffers`/`offersByStrategy` (Task 4) are for the 4d `/report`.
