# Step 4b-1: Pricing core (settings, calculator, schedule, preview): Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the pure pricing core from pricing rules v2 (Gavriel's spec commit `3488942`, approved by Dvir on 5 Oct 2026):
- the migration: `pricing_settings` (versioned, append-only, v2 seeded), `price_schedule`, `pricing_evidence`, the new `domains` and `listing_history` columns and the `delisted` status, plus the cap raise to $1,500 / 50 confirmed by Dvir;
- the integer-cents calculator (rounding, hybrid floor and walk-away, geo grades, exceptions);
- the drop-schedule generator;
- the `pricing-settings` admin command;
- `GET /pricing/preview`.

Nothing in `/buy`, `/list` or the exports changes in this step; that is 4b-2 and 4b-3. Gate G0/G1 for PR-1–PR-19, PR-30, PR-31, PR-35, PR-40–PR-44, and the cap values in B-11/B-12/B-13/CAP-2.

**Architecture:**
- **`src/pricing/`** is pure and integer-only:
  - `int.ts` holds the only division helpers;
  - `round.ts` has `round5`, `nice95`, `nice99`, `ceil95` and `pct`;
  - `settings.ts` holds the `PricingSettings` type, the DB loader and the zod row schema;
  - `plan.ts` has `computePlan` (geo grade, or hybrid formula or exception, with all V5/V6 price checks and warnings);
  - `schedule.ts` has `buildSchedule` (events, dates, statuses, chained values);
  - `present.ts` has the display strings and `sell_plan_line`.
- **The preview** composes them. **The admin command** writes new settings versions.
- **4b-2 reuses `computePlan` and `buildSchedule` unchanged** inside `/buy`, `/list` and `import-domain`, so the preview, the card and the stored plan can't drift (PR-17).

**Tech Stack:** As before.

**Spec:** `docs/specs/listing-strategy.md` §1, §2, §5 (V2, V5, V6 price rules and warnings), §10.1–§10.4, §10.6, §10.9 (admin command), §10.10; `docs/specs/test-plan.md` PR-*; `docs/specs/00-architecture.md` §4 (new tables and columns); `CLAUDE.md` founder rules 2 and 4 (never hard-code 65/48/20/750/500/100/499/399 in logic; settings change only via the admin command or a migration).

## Global Constraints

- Everything in the earlier steps' Global Constraints still holds: cents, error envelope, idempotency and audit on POSTs, no network in tests (MSW for HTTP, `dgram` blocked), fake keys, ESM `.js` imports, never edit a spec test to make it pass.
- **All pricing math in integer cents.** `src/pricing/*.ts` has no float literal and no `/` operator except in `src/pricing/int.ts` (static test PR-10). Percentages use `pct(c, bps) = floor((c × bps + 5000) / 10000)`.
- **Never hard-code pricing numbers in logic.** Every value comes from a `PricingSettings` object: 6500, 4800, 2000, 75000, 50000, 10000, 49900, 39900, 29900, the 6/12/18 months, and 90/7 days. Constants are allowed only in the migration seed and in tests and vectors.
- **Rounding (normative, §10.2):**
  - `round5(c) = floor((c + 250) / 500) × 500`
  - `nice95(c)`: `n = c + 500`, `lo = floor(n / 10000) × 10000`, `hi = lo + 10000`; take the closer of the two (a tie goes to `lo`) and subtract 500.
  - `nice99` is the same with 100 in place of 500.
  - `ceil95(c)` is the smallest whole-dollar price ending in 95 that is ≥ `c`.
- **Hybrid formula (§10.3):**
  - `floor = min(BIN, max(round5(pct(BIN, floor_bps)), floor_min))`
  - `walkaway = min(floor, max(round5(pct(BIN, walkaway_bps)), walkaway_min))`
  - `min_offer = min(hybrid_min_offer, walkaway)`
  - `hybrid_bin_min = ceil95(floor_min)`
- **Hybrid BIN rules:**
  - The BIN must end in 95 (`bin % 10000 == 9500`), else `BIN_NOT_NICE`. An exception waives this rule.
  - The BIN must be ≥ `hybrid_bin_min`, else `BIN_BELOW_FLOOR_MIN`.
- **An exception** (approved floor and walk-away) must satisfy `walkaway_min ≤ walkaway ≤ floor ≤ bin` and `floor ≥ floor_min`. Violations give `HYBRID_PRICES_INVALID` (order broken), `FLOOR_BELOW_MIN` or `WALKAWAY_BELOW_MIN`.
- **Geo:** the BIN is the grade price; floor = walk-away = min offer = BIN.
- **Schedule (§10.4):**
  - The anchor is the first listing date (IDT `YYYY-MM-DD`). "+N months" keeps the day, clamped to the month's last day.
  - Hybrid gets `drop1_m6`, `drop2_m18`, `final_push` (`drop_date − final_push_days`) and `delist` (`drop_date − delist_days`). Geo strong gets `geo_drop_m12` (499 → 399) plus `delist`; geo weaker gets `delist` only.
  - Values are scaled from the current values, not recomputed from the formula.
  - Statuses: `planned`, `skipped_at_minimum`, `skipped_no_change`, `skipped_disabled`, `superseded_by_final_push`.
- **`pricing_settings` is append-only** (DB trigger) and written only by `npm run admin -- pricing-settings new` (or a migration). No API route writes it.
- **Caps:** `poc_cap_cents` 150000 and `max_domains` 50 (Dvir confirmed 5 Oct 2026). The spec tests B-11/B-12/B-13/CAP-2 move to the new spec values ($1,495 spent, $1,480 race, 50 domains).

## Review Focus

1. **A drop that clamps the BIN at the minimum:** a BIN already at $795 is `skipped_at_minimum`, with floor **and** walk-away unchanged (PR-15). A BIN above $795 that clamps down to $795 still applies, with floor ≥ $750 and walk-away ≥ $500. Tests PR-14, PR-15 and PR-41 in Task 3.
2. **An M-event due on or after the final-push date:** it becomes `superseded_by_final_push`, and the final push is computed from the last *applied-or-planned* values, not from the superseded event's values (PR-19). Test in Task 3.
3. **Month-end anchors:** listed 31 Aug → M6 on 28 Feb (29 Feb in a leap year) (PR-18). Test in Task 3.
4. **A walk-away that would fall below $500 after a drop:** it is lifted to $500 and never exceeds the floor (PR-9 property, PR-41). Property test in Task 3 over every x95 BIN from $795 to $100,000.
5. **A settings change with no version bump:** the vector test fails when the v2 rule fields change while the version stays 2 (PR-44 fingerprint). Test in Task 5.

## Decisions taken in this plan that the spec doesn't spell out (Dvir to confirm)

| # | Decision | Why |
|---|---|---|
| P1 | Only **version 2** is seeded. v1 is not recorded because no plan was ever computed with it (D-001's plan is an approved exception, stored under v2). The seed's `approval_text` is the v2 note and `approved_at` is 2026-10-05 09:17 IDT | The v1 numbers aren't fully specified; inventing them would be fake history |
| P2 | The v2 seed lives in an SQL function `seed_pricing_settings_v2()` that the migration calls and the test reset reuses | Tests that create v3 need a clean v2 baseline |
| P3 | **`sedo_hybrid_as` stays `buy_now` in this step**, and the old `settings` columns (`geo_bin_min/max`, `high_value_categories`, `high_value_guard_modes`) stay for now. They change or are dropped in 4b-3 and 4b-2, together with the code that reads them | Changing them now would half-break the v1 exporter and validator |
| P4 | A `delisted` domain counts toward the 50-domain cap (`activeDomainCount`) | It is still held until `drop_date` |
| P5 | `GET /pricing/preview` gets `afternic_row` from `?domain=` (its `display_name`, else the domain), and uses `example.com` when no domain is given | The spec example shows a real name; a preview may have none |
| P6 | Geo M12 due on or after the delist date → `superseded_by_final_push` (geo has no final push; the status name is reused) | Edge case; keeps the status set closed |
| P7 | `sell_plan_line`: planned events are shown as `M6 YYYY-MM-DD $b/$f/$w`; skipped ones as `M6 skipped (minimum)` / `skipped (no change)` / `skipped (disabled)`; superseded ones are omitted. Geo lines start `bin (geo strong) · BIN $499 · no offers` | The spec gives the hybrid line only |
| P8 | Whole-dollar display in previews (`$1,995`, not `$1,995.00`); `net_at_15pct` keeps the cents | Matches the spec example |

---

## File structure

```
migrations/1759900000000_pricing.sql   pricing_settings (+ seed fn, append-only trigger), price_schedule, pricing_evidence,
                                       domains/listing_history columns, delisted status, caps 150000/50
src/pricing/
  int.ts           div, ceilDiv (the only '/' in src/pricing)
  round.ts         pct, round5, nice95, nice99, ceil95
  settings.ts      PricingSettings, PricingSettingsRowSchema, rowToSettings, currentSettings(db, now), settingsByVersion, ruleFields, RULE_KEYS
  plan.ts          computePlan, hybridBinMin, type Plan, type PlanInput
  schedule.ts      buildSchedule, addMonthsClamped, addDays, type ScheduleEvent
  present.ts       wholeUsd, sellPlanLine, previewDisplay
src/admin/pricing-settings.ts          newPricingSettings, showPricingSettings
src/admin.ts                           (modify) pricing-settings new|show
src/api/pricing.ts                     GET /pricing/preview
src/services/budget.ts                 (modify) activeDomainCount counts 'delisted'
src/db/types.ts                        (modify) new tables/columns
src/app.ts                             (modify) register preview
tests/
  unit/pricing-round.test.ts, pricing-plan.test.ts, pricing-schedule.test.ts, pricing-static.test.ts
  api/pricing-settings.test.ts, pricing-preview.test.ts, pricing-vectors.test.ts
  fixtures/pricing-vectors.v2.json
  helpers/db.ts                        (modify) TABLES + re-seed pricing v2 + new settings defaults
  (modify) buy-checks / buy-purchase / cap-property / schema / admin-cli tests for the new cap values and the migration count
```

---

### Task 1: Migration 4 (pricing tables, new columns, delisted, caps) + cap test updates

**Files:**
- Create: `migrations/1759900000000_pricing.sql`
- Modify: `src/db/types.ts`, `src/services/budget.ts`, `tests/helpers/db.ts`, `tests/api/schema.test.ts`, `tests/api/budget.test.ts`, `tests/api/buy-checks.test.ts`, `tests/api/buy-purchase.test.ts`, `tests/api/cap-property.test.ts`, `tests/api/admin-cli.test.ts`

**Interfaces:**
- Produces:
  - Kysely types `PricingSettingsTable`, `PriceScheduleTable`, `PricingEvidenceTable`
  - `DomainsTable` gains `walkaway_cents`, `price_grade: 'strong' | 'weaker' | null`, `pricing_source: 'formula' | 'approved_exception' | null`, `pricing_settings_version: number | null`, `first_listed_at`, `pricing_hold: Generated<boolean>`, `pricing_hold_reason`, `plan_id`, `plan_audit_id`, `export_pending_since`
  - `DomainStatus` gains `'delisted'`
  - `ListingHistoryTable` gains `price_grade`, `walkaway_cents`, `pricing_source`, `pricing_settings_version`, `schedule_event_id: number | null`, `plan_audit_id`; its `source` gains `'schedule'`
  - `activeDomainCount` counts `owned`, `listed`, `delisted` and `pending_purchase`

- [ ] **Step 1: Write the migration**

`migrations/1759900000000_pricing.sql`:
```sql
-- Up Migration

CREATE TABLE pricing_settings (
  version                      integer PRIMARY KEY CHECK (version >= 1),
  effective_at                 timestamptz NOT NULL,
  created_at                   timestamptz NOT NULL DEFAULT now(),
  approval_text                text NOT NULL CHECK (length(trim(approval_text)) > 0),
  approval_at                  timestamptz NOT NULL,
  note                         text,
  geo_bin_strong_cents         integer NOT NULL CHECK (geo_bin_strong_cents > 0),
  geo_bin_weaker_cents         integer NOT NULL CHECK (geo_bin_weaker_cents > 0),
  geo_bin_min_cents            integer NOT NULL CHECK (geo_bin_min_cents > 0),
  geo_bin_max_cents            integer NOT NULL,
  geo_drops_enabled            boolean NOT NULL,
  geo_drops                    jsonb NOT NULL,
  floor_bps                    integer NOT NULL CHECK (floor_bps BETWEEN 1 AND 10000),
  floor_min_cents              integer NOT NULL CHECK (floor_min_cents > 0),
  walkaway_bps                 integer NOT NULL CHECK (walkaway_bps BETWEEN 1 AND 10000),
  walkaway_min_cents           integer NOT NULL CHECK (walkaway_min_cents > 0),
  hybrid_min_offer_cents       integer NOT NULL CHECK (hybrid_min_offer_cents >= 2000),
  drops                        jsonb NOT NULL,
  final_push_days_before_drop  integer NOT NULL CHECK (final_push_days_before_drop > 0),
  final_push_mode              text NOT NULL CHECK (final_push_mode IN ('bin_to_floor_ceil95')),
  delist_days_before_drop      integer NOT NULL CHECK (delist_days_before_drop > 0),
  headsup_days_before          integer NOT NULL CHECK (headsup_days_before >= 0),
  comps_min                    integer NOT NULL CHECK (comps_min >= 1),
  comps_max                    integer NOT NULL,
  public_lto                   boolean NOT NULL,
  CHECK (geo_bin_min_cents <= geo_bin_weaker_cents AND geo_bin_weaker_cents <= geo_bin_strong_cents AND geo_bin_strong_cents <= geo_bin_max_cents),
  CHECK (walkaway_bps <= floor_bps),
  CHECK (walkaway_min_cents <= floor_min_cents),
  CHECK (comps_min <= comps_max),
  CHECK (final_push_days_before_drop > delist_days_before_drop)
);
CREATE TRIGGER pricing_settings_append_only BEFORE UPDATE OR DELETE ON pricing_settings
  FOR EACH ROW EXECUTE FUNCTION reject_mutation();
CREATE TRIGGER pricing_settings_no_truncate BEFORE TRUNCATE ON pricing_settings
  FOR EACH STATEMENT EXECUTE FUNCTION reject_mutation();

-- v2 = Dvir, 5 Oct 2026, 09:17 IDT (listing-strategy.md §10.1). Reused by the test reset (plan P2).
CREATE FUNCTION seed_pricing_settings_v2() RETURNS void LANGUAGE sql AS $$
  INSERT INTO pricing_settings (
    version, effective_at, approval_text, approval_at, note,
    geo_bin_strong_cents, geo_bin_weaker_cents, geo_bin_min_cents, geo_bin_max_cents,
    geo_drops_enabled, geo_drops, floor_bps, floor_min_cents, walkaway_bps, walkaway_min_cents,
    hybrid_min_offer_cents, drops, final_push_days_before_drop, final_push_mode,
    delist_days_before_drop, headsup_days_before, comps_min, comps_max, public_lto
  ) VALUES (
    2, '2026-10-05T09:17:00+03:00',
    'v2: $500 walk-away floor, one geo drop, Sedo make-offer, final push to floor', '2026-10-05T09:17:00+03:00',
    'pricing rules v2 (Gavriel spec commit 3488942, approved by Dvir)',
    49900, 39900, 29900, 49900,
    true, '[{"after_months":12,"from_cents":49900,"to_cents":39900}]'::jsonb,
    6500, 75000, 4800, 50000,
    10000, '[{"after_months":6,"pct_bps":2000},{"after_months":18,"pct_bps":2000}]'::jsonb, 90, 'bin_to_floor_ceil95',
    7, 7, 2, 3, false
  );
$$;
SELECT seed_pricing_settings_v2();

-- Domains: v2 pricing columns + delisted status (listing-strategy.md §10.10)
ALTER TABLE domains DROP CONSTRAINT domains_status_check;
ALTER TABLE domains ADD CONSTRAINT domains_status_check
  CHECK (status IN ('pending_purchase', 'owned', 'listed', 'delisted', 'sold', 'dropped'));
ALTER TABLE domains
  ADD COLUMN walkaway_cents integer CHECK (walkaway_cents > 0),
  ADD COLUMN price_grade text CHECK (price_grade IN ('strong', 'weaker')),
  ADD COLUMN pricing_source text CHECK (pricing_source IN ('formula', 'approved_exception')),
  ADD COLUMN pricing_settings_version integer REFERENCES pricing_settings (version),
  ADD COLUMN first_listed_at timestamptz,
  ADD COLUMN pricing_hold boolean NOT NULL DEFAULT false,
  ADD COLUMN pricing_hold_reason text,
  ADD COLUMN plan_id text,
  ADD COLUMN plan_audit_id text,
  ADD COLUMN export_pending_since timestamptz,
  ADD CONSTRAINT domains_price_order CHECK (
    (floor_cents IS NULL OR bin_cents IS NULL OR floor_cents <= bin_cents)
    AND (walkaway_cents IS NULL OR (floor_cents IS NOT NULL AND walkaway_cents <= floor_cents))
  );

-- Listing history: v2 fields + scheduled changes
ALTER TABLE listing_history DROP CONSTRAINT listing_history_source_check;
ALTER TABLE listing_history ADD CONSTRAINT listing_history_source_check
  CHECK (source IN ('buy', 'import', 'list', 'schedule'));
ALTER TABLE listing_history
  ADD COLUMN price_grade text CHECK (price_grade IN ('strong', 'weaker')),
  ADD COLUMN walkaway_cents integer CHECK (walkaway_cents > 0),
  ADD COLUMN pricing_source text CHECK (pricing_source IN ('formula', 'approved_exception')),
  ADD COLUMN pricing_settings_version integer REFERENCES pricing_settings (version),
  ADD COLUMN schedule_event_id bigint,
  ADD COLUMN plan_audit_id text;

CREATE TABLE price_schedule (
  id                  bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  domain_id           bigint NOT NULL REFERENCES domains (id),
  plan_id             text NOT NULL,
  event               text NOT NULL CHECK (event IN ('drop1_m6', 'drop2_m18', 'geo_drop_m12', 'final_push', 'delist')),
  due_on              date NOT NULL,
  bin_cents           integer CHECK (bin_cents > 0),
  floor_cents         integer CHECK (floor_cents > 0),
  walkaway_cents      integer CHECK (walkaway_cents > 0),
  settings_version    integer NOT NULL REFERENCES pricing_settings (version),
  status              text NOT NULL CHECK (status IN ('planned', 'applied', 'skipped_at_minimum', 'skipped_no_change',
                        'skipped_disabled', 'superseded', 'superseded_by_final_push', 'cancelled', 'failed')),
  applied_at          timestamptz,
  listing_history_id  bigint REFERENCES listing_history (id),
  note                text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (domain_id, event, plan_id)
);
CREATE INDEX price_schedule_due ON price_schedule (status, due_on);

CREATE TABLE pricing_evidence (
  id                      bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  domain_id               bigint NOT NULL REFERENCES domains (id),
  comps                   jsonb,
  rationale               text,
  legacy_no_comps_reason  text,
  audit_id                text,
  created_at              timestamptz NOT NULL DEFAULT now(),
  CHECK (comps IS NOT NULL OR legacy_no_comps_reason IS NOT NULL)
);

-- Caps raised (Dvir, 5 Oct 2026, 01:04 IDT; confirmed in chat with Claude Code)
ALTER TABLE settings ALTER COLUMN poc_cap_cents SET DEFAULT 150000;
ALTER TABLE settings ALTER COLUMN max_domains SET DEFAULT 50;
UPDATE settings SET poc_cap_cents = 150000, max_domains = 50, updated_at = now();

-- Down Migration

UPDATE settings SET poc_cap_cents = 50000, max_domains = 10, updated_at = now();
ALTER TABLE settings ALTER COLUMN max_domains SET DEFAULT 10;
ALTER TABLE settings ALTER COLUMN poc_cap_cents SET DEFAULT 50000;
DROP TABLE pricing_evidence;
DROP TABLE price_schedule;
ALTER TABLE listing_history DROP COLUMN plan_audit_id, DROP COLUMN schedule_event_id, DROP COLUMN pricing_settings_version,
  DROP COLUMN pricing_source, DROP COLUMN walkaway_cents, DROP COLUMN price_grade;
ALTER TABLE listing_history DROP CONSTRAINT listing_history_source_check;
ALTER TABLE listing_history ADD CONSTRAINT listing_history_source_check CHECK (source IN ('buy', 'import', 'list'));
ALTER TABLE domains DROP CONSTRAINT domains_price_order;
ALTER TABLE domains DROP COLUMN export_pending_since, DROP COLUMN plan_audit_id, DROP COLUMN plan_id,
  DROP COLUMN pricing_hold_reason, DROP COLUMN pricing_hold, DROP COLUMN first_listed_at,
  DROP COLUMN pricing_settings_version, DROP COLUMN pricing_source, DROP COLUMN price_grade, DROP COLUMN walkaway_cents;
ALTER TABLE domains DROP CONSTRAINT domains_status_check;
ALTER TABLE domains ADD CONSTRAINT domains_status_check
  CHECK (status IN ('pending_purchase', 'owned', 'listed', 'sold', 'dropped'));
DROP FUNCTION seed_pricing_settings_v2();
DROP TABLE pricing_settings;
```
**Check before writing:** confirm the existing CHECK constraint names in the DB (`\d domains`, `\d listing_history`). Postgres auto-names them `domains_status_check` and `listing_history_source_check`; if they differ, use the real names.

- [ ] **Step 2: Types, budget, test reset**

- `src/db/types.ts`: add the three tables and the new columns exactly as listed in **Interfaces** (use `Json` for jsonb, `Timestamp`/`TimestampDefault` for times, `DateString` for `due_on`, `Generated<…>` for defaults).
- `src/services/budget.ts` `activeDomainCount`: `.where('status', 'in', ['owned', 'listed', 'delisted', 'pending_purchase'])`.
- `tests/helpers/db.ts`: add `price_schedule`, `pricing_evidence` and `pricing_settings` to `TABLES`. They must be truncated before `domains` and `listing_history`; `TRUNCATE … CASCADE` handles the foreign keys. After the truncate, while still in replica mode, run `SELECT seed_pricing_settings_v2()`. The existing `INSERT INTO settings DEFAULT VALUES` now produces the new defaults automatically.

- [ ] **Step 3: Update tests that encode the old caps and the migration count**

These spec values changed in the approved spec (buy.md B-11/B-12/B-13, test-plan CAP-2). Update exactly these:
- `tests/api/buy-checks.test.ts`:
  - B-11: `seedSpent(49500)` → `seedSpent(149500)`. The expected remaining `$5.00` / 500 is unchanged.
  - B-13 / CAP-2: `seedOwnedDomains(10)` → `seedOwnedDomains(50)`.
  - DR-2: `seedSpent(49500)` → `seedSpent(149500)`.
  - B-16/DR-1: `poc_remaining_after: '$488.92'` → `'$1,488.92'`.
- `tests/api/buy-purchase.test.ts`:
  - B-21: `poc_remaining: '$488.92'` → `'$1,488.92'`.
  - B-12/CAP-1: `seedSpent(48000)` → `seedSpent(148000)`.
  - CAP-2 (unknown purchase counts): `seedOwnedDomains(9)` → `seedOwnedDomains(49)`.
  - Any other `seedOwnedDomains(9)` (the ambiguous-dry-run cap test) → `49`.
- `tests/api/cap-property.test.ts`: `rnd(50001)` → `rnd(150001)` (start spend up to the new cap).
- `tests/api/schema.test.ts` settings defaults: `poc_cap_cents: 150000`, `max_domains: 50`. Add schema tests:
  - `UPDATE pricing_settings` raises and `DELETE pricing_settings` raises (**PR-30**);
  - exactly one `pricing_settings` row, version 2, with `floor_bps` 6500 and `walkaway_min_cents` 50000;
  - `price_schedule` rejects a duplicate `(domain_id, event, plan_id)`;
  - `domains_price_order` rejects `walkaway_cents > floor_cents` and `floor_cents > bin_cents`;
  - status `delisted` is accepted for an owned-shaped row.
- `tests/api/budget.test.ts`: add a `delisted` domain to the active-domains test; the expected count goes up by 1.
- `tests/api/admin-cli.test.ts`: `/migrations: 3 applied/` → `/migrations: 4 applied/`.
- Before finishing, search `tests/` for any remaining `49500`, `48000`, `488.92`, `seedOwnedDomains(10)` or `seedOwnedDomains(9)` that refers to the caps, and list them in the report.

- [ ] **Step 4: Run, migrate dev DB, commit**

Run: `npx vitest run && npx tsc --noEmit && npm run migrate up`
Expected: all PASS, and the dev DB is migrated.
```bash
git add migrations/ src/ tests/
git commit -m "feat: migration 4 (pricing_settings v2 + append-only, price_schedule, pricing_evidence, v2 domain/history columns, delisted); caps to \$1,500/50"
```

---

### Task 2: Integer rounding, settings loader, plan calculator

**Files:**
- Create: `src/pricing/int.ts`, `src/pricing/round.ts`, `src/pricing/settings.ts`, `src/pricing/plan.ts`, `tests/unit/pricing-round.test.ts`, `tests/unit/pricing-plan.test.ts`, `tests/unit/pricing-static.test.ts`

**Interfaces:**
- Produces:
```ts
// int.ts
export type Cents = number; // always an integer number of US cents
export function div(a: number, b: number): number;      // floor division of integers
export function ceilDiv(a: number, b: number): number;  // ceiling division of integers
// round.ts
export function pct(c: Cents, bps: number): Cents;      // floor((c*bps + 5000)/10000)
export function round5(c: Cents): Cents;
export function nice95(c: Cents): Cents;
export function nice99(c: Cents): Cents;
export function ceil95(c: Cents): Cents;
// settings.ts
export interface PricingSettings {
  version: number; effectiveAt: Date;
  geoBinStrongCents: Cents; geoBinWeakerCents: Cents; geoBinMinCents: Cents; geoBinMaxCents: Cents;
  geoDropsEnabled: boolean; geoDrops: { afterMonths: number; fromCents: Cents; toCents: Cents }[];
  floorBps: number; floorMinCents: Cents; walkawayBps: number; walkawayMinCents: Cents; hybridMinOfferCents: Cents;
  drops: { afterMonths: number; pctBps: number }[];
  finalPushDaysBeforeDrop: number; finalPushMode: 'bin_to_floor_ceil95'; delistDaysBeforeDrop: number; headsupDaysBefore: number;
  compsMin: number; compsMax: number; publicLto: boolean;
}
export const RULE_KEYS: readonly (keyof PricingSettings)[];  // every field except version, effectiveAt
export function ruleFields(s: PricingSettings): Record<string, unknown>;
export function rowToSettings(row: Selectable<PricingSettingsTable>): PricingSettings;  // validates jsonb with zod
export function currentSettings(db: Kysely<Database>, now: Date): Promise<PricingSettings>; // highest version with effective_at <= now
export function settingsByVersion(db: Kysely<Database>, version: number): Promise<PricingSettings | null>;
// plan.ts
export type PlanCategory = 'geo' | 'trend' | 'b2b' | 'collision' | 'regulation' | 'buzzword' | 'other';
export interface PlanInput {
  category: PlanCategory; grade?: 'strong' | 'weaker' | null; binCents?: Cents | null;
  floorCents?: Cents | null; walkawayCents?: Cents | null; exception?: boolean;
}
export interface Plan {
  mode: 'bin' | 'hybrid'; category: PlanCategory; grade: 'strong' | 'weaker' | null;
  binCents: Cents; floorCents: Cents; walkawayCents: Cents; minOfferCents: Cents;
  pricingSource: 'formula' | 'approved_exception'; settingsVersion: number; warnings: string[];
  formula: { floorCents: Cents; walkawayCents: Cents } | null; // hybrid only: what the formula gives (for PRICING_EXCEPTION)
}
export type PlanResult = { ok: true; plan: Plan } | { ok: false; code: string; message: string; details?: Record<string, unknown> };
export function hybridBinMin(s: PricingSettings): Cents; // ceil95(floorMinCents)
export function computePlan(input: PlanInput, s: PricingSettings): PlanResult;
```

- [ ] **Step 1: Write the failing tests**

`tests/unit/pricing-round.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { ceilDiv, div } from '../../src/pricing/int.js';
import { ceil95, nice95, nice99, pct, round5 } from '../../src/pricing/round.js';

describe('integer helpers', () => {
  it('div floors, ceilDiv ceils (positive and negative)', () => {
    expect([div(7, 2), div(-7, 2), ceilDiv(7, 2), ceilDiv(-7, 2), div(8, 2)]).toEqual([3, -4, 4, -3, 4]);
  });
  it('rejects non-integers and division by zero', () => {
    expect(() => div(7.5, 2)).toThrow();
    expect(() => div(7, 0)).toThrow();
  });
});

describe('PR-7: rounding vectors (cents → cents)', () => {
  it.each([[159600, 159500], [127600, 129500], [154500, 149500], [95600, 99500]])('nice95(%i) = %i', (c, r) => expect(nice95(c)).toBe(r));
  it.each([[39920, 39900], [31920, 29900]])('nice99(%i) = %i', (c, r) => expect(nice99(c)).toBe(r));
  it.each([[83000, 89500], [75000, 79500], [103500, 109500], [129500, 129500]])('ceil95(%i) = %i', (c, r) => expect(ceil95(c)).toBe(r));
  it.each([[129675, 129500], [95760, 96000], [95750, 96000], [82800, 83000]])('round5(%i) = %i', (c, r) => expect(round5(c)).toBe(r));
  it('pct is half-up to the cent', () => {
    expect(pct(199500, 6500)).toBe(129675); // 129675.5 → floor of (x+0.5) as integer math
    expect(pct(199500, 4800)).toBe(95760);
    expect(pct(199500, 8500)).toBe(169575);
  });
});
```
`tests/unit/pricing-plan.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { computePlan, hybridBinMin } from '../../src/pricing/plan.js';
import type { PricingSettings } from '../../src/pricing/settings.js';

export const V2: PricingSettings = {
  version: 2, effectiveAt: new Date('2026-10-05T06:17:00Z'),
  geoBinStrongCents: 49900, geoBinWeakerCents: 39900, geoBinMinCents: 29900, geoBinMaxCents: 49900,
  geoDropsEnabled: true, geoDrops: [{ afterMonths: 12, fromCents: 49900, toCents: 39900 }],
  floorBps: 6500, floorMinCents: 75000, walkawayBps: 4800, walkawayMinCents: 50000, hybridMinOfferCents: 10000,
  drops: [{ afterMonths: 6, pctBps: 2000 }, { afterMonths: 18, pctBps: 2000 }],
  finalPushDaysBeforeDrop: 90, finalPushMode: 'bin_to_floor_ceil95', delistDaysBeforeDrop: 7, headsupDaysBefore: 7,
  compsMin: 2, compsMax: 3, publicLto: false,
};
const hy = (bin: number, extra: object = {}) => computePlan({ category: 'trend', binCents: bin, ...extra }, V2);
const ok = (r: ReturnType<typeof computePlan>) => {
  if (!r.ok) throw new Error(`${r.code}: ${r.message}`);
  return r.plan;
};
const code = (r: ReturnType<typeof computePlan>) => (r.ok ? 'OK' : r.code);

describe('computePlan: hybrid formula (PR-1–PR-5, PR-40)', () => {
  it.each([
    [199500, 129500, 96000], // PR-1
    [249500, 162000, 120000], // PR-2
    [499500, 324500, 240000], // PR-3
    [119500, 77500, 57500], // PR-4
    [79500, 75000, 50000], // PR-5
    [99500, 75000, 50000], // PR-40
    [109500, 75000, 52500], // PR-40
    [149500, 97000, 72000], // PR-40
  ])('BIN %i → floor %i, walk-away %i, min offer 10000, formula', (bin, floor, walk) => {
    const p = ok(hy(bin));
    expect(p).toMatchObject({ mode: 'hybrid', binCents: bin, floorCents: floor, walkawayCents: walk, minOfferCents: 10000, pricingSource: 'formula', settingsVersion: 2 });
    expect(p.formula).toEqual({ floorCents: floor, walkawayCents: walk });
  });
  it('PR-5: BIN 795 → FLOOR_RAISED_TO_MIN, no WALKAWAY_BELOW_500 (retired)', () => {
    const p = ok(hy(79500));
    expect(p.warnings).toContain('FLOOR_RAISED_TO_MIN');
    expect(p.warnings).not.toContain('WALKAWAY_BELOW_500');
  });
  it('FLOOR_AUTO_ACCEPT whenever floor < BIN; BIN_OVER_FAST_TRANSFER_MAX at ≥ $100,000; CATEGORY_OTHER', () => {
    expect(ok(hy(199500)).warnings).toContain('FLOOR_AUTO_ACCEPT');
    expect(ok(hy(10_000_000 - 500)).warnings).not.toContain('BIN_OVER_FAST_TRANSFER_MAX');
    expect(ok(hy(10_009_500)).warnings).toContain('BIN_OVER_FAST_TRANSFER_MAX');
    expect(ok(computePlan({ category: 'other', binCents: 199500 }, V2)).warnings).toContain('CATEGORY_OTHER');
  });
});

describe('computePlan: BIN validation (PR-8, LS-16, PR-35)', () => {
  it.each([[199000, 'BIN_NOT_NICE'], [69500, 'BIN_BELOW_FLOOR_MIN'], [79500, 'OK'], [199500, 'OK']])('BIN %i → %s', (bin, c) => {
    expect(code(hy(bin))).toBe(c);
  });
  it('missing BIN → HYBRID_FIELDS_REQUIRED (LS-10)', () => expect(code(computePlan({ category: 'trend' }, V2))).toBe('HYBRID_FIELDS_REQUIRED'));
  it('hybrid_bin_min is derived from floor_min (795 under v2; 995 with floor_min 900)', () => {
    expect(hybridBinMin(V2)).toBe(79500);
    expect(hybridBinMin({ ...V2, floorMinCents: 90000 })).toBe(99500);
    expect(code(computePlan({ category: 'trend', binCents: 79500 }, { ...V2, floorMinCents: 90000, walkawayMinCents: 50000 }))).toBe('BIN_BELOW_FLOOR_MIN');
  });
});

describe('computePlan: sent floor/walk-away (LS-17–LS-20, LS-11)', () => {
  it('LS-17: floor sent without exception and ≠ formula → PRICING_FORMULA_MISMATCH with computed values', () => {
    const r = hy(199500, { floorCents: 120000 });
    expect(r.ok).toBe(false);
    expect(!r.ok && r).toMatchObject({ code: 'PRICING_FORMULA_MISMATCH', details: { floor_cents: 129500, walkaway_cents: 96000 } });
  });
  it('sent values equal to the formula without exception → OK (formula)', () => {
    expect(ok(hy(199500, { floorCents: 129500, walkawayCents: 96000 })).pricingSource).toBe('formula');
  });
  it('LS-18: D-001 exception 1995/1295/950 → approved_exception + PRICING_EXCEPTION, formula 960 kept for display', () => {
    const p = ok(hy(199500, { floorCents: 129500, walkawayCents: 95000, exception: true }));
    expect(p).toMatchObject({ floorCents: 129500, walkawayCents: 95000, minOfferCents: 10000, pricingSource: 'approved_exception', formula: { floorCents: 129500, walkawayCents: 96000 } });
    expect(p.warnings).toEqual(expect.arrayContaining(['PRICING_EXCEPTION', 'FLOOR_AUTO_ACCEPT']));
  });
  it('LS-11: exception floor > BIN, or walk-away > floor → HYBRID_PRICES_INVALID', () => {
    expect(code(hy(199500, { floorCents: 210000, walkawayCents: 95000, exception: true }))).toBe('HYBRID_PRICES_INVALID');
    expect(code(hy(199500, { floorCents: 95000, walkawayCents: 100000, exception: true }))).toBe('HYBRID_PRICES_INVALID');
  });
  it('LS-19: exception floor 700 → FLOOR_BELOW_MIN', () => expect(code(hy(199500, { floorCents: 70000, walkawayCents: 60000, exception: true }))).toBe('FLOOR_BELOW_MIN'));
  it('LS-20/PR-40: exception walk-away 450 → WALKAWAY_BELOW_MIN', () => expect(code(hy(199500, { floorCents: 129500, walkawayCents: 45000, exception: true }))).toBe('WALKAWAY_BELOW_MIN'));
  it('an exception may waive "ends in 95"', () => expect(code(hy(200000, { floorCents: 130000, walkawayCents: 96000, exception: true }))).toBe('OK'));
  it('exception without both floor and walk-away → HYBRID_FIELDS_REQUIRED', () => expect(code(hy(199500, { floorCents: 129500, exception: true }))).toBe('HYBRID_FIELDS_REQUIRED'));
});

describe('computePlan: geo (PR-6, LG-18/19)', () => {
  it('strong 499 / weaker 399: bin = floor = walk-away = min offer', () => {
    expect(ok(computePlan({ category: 'geo', grade: 'strong' }, V2))).toMatchObject({ mode: 'bin', binCents: 49900, floorCents: 49900, walkawayCents: 49900, minOfferCents: 49900, grade: 'strong', formula: null });
    expect(ok(computePlan({ category: 'geo', grade: 'weaker' }, V2))).toMatchObject({ binCents: 39900, floorCents: 39900, walkawayCents: 39900, minOfferCents: 39900 });
  });
  it('geo without grade → GEO_GRADE_REQUIRED; strong with bin 399 → GEO_BIN_NOT_GRADE_PRICE; matching bin → OK', () => {
    expect(code(computePlan({ category: 'geo' }, V2))).toBe('GEO_GRADE_REQUIRED');
    expect(code(computePlan({ category: 'geo', grade: 'strong', binCents: 39900 }, V2))).toBe('GEO_BIN_NOT_GRADE_PRICE');
    expect(code(computePlan({ category: 'geo', grade: 'strong', binCents: 49900 }, V2))).toBe('OK');
  });
  it('geo with floor/walk-away sent different from BIN → BIN_MODE_NO_NEGOTIATION', () => {
    expect(code(computePlan({ category: 'geo', grade: 'weaker', floorCents: 35000 }, V2))).toBe('BIN_MODE_NO_NEGOTIATION');
  });
});

describe('computePlan: settings-driven, no hard-coded numbers', () => {
  it('a v3 with floor_bps 6000 changes the floor (PR-32: 1995 → 1195 when floor_bps 6000 and nice inputs)', () => {
    const p = ok(computePlan({ category: 'trend', binCents: 199500 }, { ...V2, version: 3, floorBps: 6000 }));
    expect(p.floorCents).toBe(119500);
    expect(p.settingsVersion).toBe(3);
  });
  it('hybrid_min_offer 150 in settings → min offer 150 (OF-16)', () => {
    expect(ok(computePlan({ category: 'trend', binCents: 199500 }, { ...V2, hybridMinOfferCents: 15000 })).minOfferCents).toBe(15000);
  });
});
```
`tests/unit/pricing-static.test.ts`:
```ts
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/** Remove comments and string/template literals so '/' in imports or comments doesn't count. */
function code(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/gm, '')
    .replace(/`(?:\\.|[^`\\])*`/g, '``')
    .replace(/'(?:\\.|[^'\\])*'/g, "''")
    .replace(/"(?:\\.|[^"\\])*"/g, '""');
}

describe('PR-10: no floats in the pricing module', () => {
  const dir = 'src/pricing';
  const files = readdirSync(dir).filter((f) => f.endsWith('.ts'));
  it('has files', () => expect(files.length).toBeGreaterThan(3));
  it.each(files)('%s has no float literal', (f) => {
    expect(code(readFileSync(join(dir, f), 'utf8'))).not.toMatch(/\b\d+\.\d+\b/);
  });
  it.each(files.filter((f) => f !== 'int.ts'))('%s has no division operator (only int.ts may divide)', (f) => {
    expect(code(readFileSync(join(dir, f), 'utf8'))).not.toMatch(/\//);
  });
  it.each(files)('%s hard-codes no pricing rule numbers (6500, 4800, 2000, 75000, 50000, 10000, 49900, 39900, 29900)', (f) => {
    expect(code(readFileSync(join(dir, f), 'utf8'))).not.toMatch(/\b(6500|4800|2000|75000|50000|49900|39900|29900)\b/);
  });
});
```
Note: the last check deliberately leaves out `10000` and `500`/`100` because the rounding math uses them (the bps denominator, `nice95` steps and `round5`). Those are part of the normative rounding rules, not pricing settings.

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/unit/pricing-round.test.ts tests/unit/pricing-plan.test.ts tests/unit/pricing-static.test.ts`
Expected: FAIL (modules missing).

- [ ] **Step 3: Implement**

`src/pricing/int.ts`:
```ts
/** Money is always an integer number of US cents. */
export type Cents = number;

function assertInts(a: number, b: number): void {
  if (!Number.isSafeInteger(a) || !Number.isSafeInteger(b)) throw new Error(`integer division needs integers, got ${a}, ${b}`);
  if (b === 0) throw new Error('division by zero');
}

/** Floor division of integers. The only place in src/pricing that divides. */
export function div(a: number, b: number): number {
  assertInts(a, b);
  return Math.floor(a / b);
}

export function ceilDiv(a: number, b: number): number {
  assertInts(a, b);
  return Math.ceil(a / b);
}
```
`src/pricing/round.ts`:
```ts
import { div, type Cents } from './int.js';

const BPS = 10000;
const HALF_BPS = 5000;
const DOLLAR = 100;
const HUNDRED_DOLLARS = 10000;

/** c × bps / 10000, half-up to the cent. */
export function pct(c: Cents, bps: number): Cents {
  return div(c * bps + HALF_BPS, BPS);
}

/** Nearest $5, ties up. */
export function round5(c: Cents): Cents {
  return div(c + 250, 500) * 500;
}

function niceEnding(c: Cents, ending: Cents): Cents {
  const n = c + ending;
  const lo = div(n, HUNDRED_DOLLARS) * HUNDRED_DOLLARS;
  const hi = lo + HUNDRED_DOLLARS;
  return (n - lo <= hi - n ? lo : hi) - ending;
}

/** Nearest whole-dollar price ending in 95; ties go down. */
export function nice95(c: Cents): Cents {
  return niceEnding(c, 5 * DOLLAR);
}

/** Nearest price ending in 99; ties go down. */
export function nice99(c: Cents): Cents {
  return niceEnding(c, DOLLAR);
}

/** Smallest whole-dollar price ending in 95 that is ≥ c. */
export function ceil95(c: Cents): Cents {
  const step = HUNDRED_DOLLARS;
  const offset = step - 5 * DOLLAR; // 9500: the "…95" position inside each $100 band
  const k = Math.max(0, div(c - offset + step - 1, step));
  return k * step + offset;
}
```

`src/pricing/settings.ts`:
```ts
import type { Kysely, Selectable } from 'kysely';
import { z } from 'zod';
import type { Database, PricingSettingsTable } from '../db/types.js';
import type { Cents } from './int.js';

export interface PricingSettings {
  version: number; effectiveAt: Date;
  geoBinStrongCents: Cents; geoBinWeakerCents: Cents; geoBinMinCents: Cents; geoBinMaxCents: Cents;
  geoDropsEnabled: boolean; geoDrops: { afterMonths: number; fromCents: Cents; toCents: Cents }[];
  floorBps: number; floorMinCents: Cents; walkawayBps: number; walkawayMinCents: Cents; hybridMinOfferCents: Cents;
  drops: { afterMonths: number; pctBps: number }[];
  finalPushDaysBeforeDrop: number; finalPushMode: 'bin_to_floor_ceil95'; delistDaysBeforeDrop: number; headsupDaysBefore: number;
  compsMin: number; compsMax: number; publicLto: boolean;
}

export const RULE_KEYS = [
  'geoBinStrongCents', 'geoBinWeakerCents', 'geoBinMinCents', 'geoBinMaxCents', 'geoDropsEnabled', 'geoDrops',
  'floorBps', 'floorMinCents', 'walkawayBps', 'walkawayMinCents', 'hybridMinOfferCents', 'drops',
  'finalPushDaysBeforeDrop', 'finalPushMode', 'delistDaysBeforeDrop', 'headsupDaysBefore', 'compsMin', 'compsMax', 'publicLto',
] as const satisfies readonly (keyof PricingSettings)[];

export function ruleFields(s: PricingSettings): Record<string, unknown> {
  return Object.fromEntries(RULE_KEYS.map((k) => [k, s[k]]));
}

const Int = z.number().int().nonnegative();
// jsonb keys are snake_case in the DB (listing-strategy.md §10.1); the TS object is camelCase.
const GeoDrops = z.array(z.object({ after_months: Int.positive(), from_cents: Int.positive(), to_cents: Int.positive() }).strict())
  .transform((a) => a.map((d) => ({ afterMonths: d.after_months, fromCents: d.from_cents, toCents: d.to_cents })));
const Drops = z.array(z.object({ after_months: Int.positive(), pct_bps: Int.min(1).max(9999) }).strict())
  .transform((a) => a.map((d) => ({ afterMonths: d.after_months, pctBps: d.pct_bps })));

export function rowToSettings(r: Selectable<PricingSettingsTable>): PricingSettings {
  return {
    version: r.version, effectiveAt: r.effective_at,
    geoBinStrongCents: r.geo_bin_strong_cents, geoBinWeakerCents: r.geo_bin_weaker_cents,
    geoBinMinCents: r.geo_bin_min_cents, geoBinMaxCents: r.geo_bin_max_cents,
    geoDropsEnabled: r.geo_drops_enabled, geoDrops: GeoDrops.parse(r.geo_drops),
    floorBps: r.floor_bps, floorMinCents: r.floor_min_cents, walkawayBps: r.walkaway_bps, walkawayMinCents: r.walkaway_min_cents,
    hybridMinOfferCents: r.hybrid_min_offer_cents, drops: Drops.parse(r.drops),
    finalPushDaysBeforeDrop: r.final_push_days_before_drop, finalPushMode: r.final_push_mode,
    delistDaysBeforeDrop: r.delist_days_before_drop, headsupDaysBefore: r.headsup_days_before,
    compsMin: r.comps_min, compsMax: r.comps_max, publicLto: r.public_lto,
  };
}

export async function currentSettings(db: Kysely<Database>, now: Date): Promise<PricingSettings> {
  const r = await db.selectFrom('pricing_settings').selectAll().where('effective_at', '<=', now).orderBy('version', 'desc').executeTakeFirst();
  if (!r) throw new Error('No pricing_settings version is in effect');
  return rowToSettings(r);
}

export async function settingsByVersion(db: Kysely<Database>, version: number): Promise<PricingSettings | null> {
  const r = await db.selectFrom('pricing_settings').selectAll().where('version', '=', version).executeTakeFirst();
  return r ? rowToSettings(r) : null;
}
```
(The `PricingSettingsTable` type must declare `final_push_mode: 'bin_to_floor_ceil95'`, `geo_drops`/`drops` as `Json`, and `effective_at` as `Timestamp`.)

`src/pricing/plan.ts`:
```ts
import { ceil95, pct, round5 } from './round.js';
import type { Cents } from './int.js';
import type { PricingSettings } from './settings.js';

export type PlanCategory = 'geo' | 'trend' | 'b2b' | 'collision' | 'regulation' | 'buzzword' | 'other';
export interface PlanInput {
  category: PlanCategory; grade?: 'strong' | 'weaker' | null; binCents?: Cents | null;
  floorCents?: Cents | null; walkawayCents?: Cents | null; exception?: boolean;
}
export interface Plan {
  mode: 'bin' | 'hybrid'; category: PlanCategory; grade: 'strong' | 'weaker' | null;
  binCents: Cents; floorCents: Cents; walkawayCents: Cents; minOfferCents: Cents;
  pricingSource: 'formula' | 'approved_exception'; settingsVersion: number; warnings: string[];
  formula: { floorCents: Cents; walkawayCents: Cents } | null;
}
export type PlanResult = { ok: true; plan: Plan } | { ok: false; code: string; message: string; details?: Record<string, unknown> };

const FAST_TRANSFER_MAX_CENTS = 10_000_000; // Afternic Premium network limit ($100,000); an Afternic rule, not a pricing setting
const BAND = 10000;
const ENDING_95 = 9500;

const fail = (code: string, message: string, details?: Record<string, unknown>): PlanResult => ({ ok: false, code, message, details });

export function hybridBinMin(s: PricingSettings): Cents {
  return ceil95(s.floorMinCents);
}

function formula(bin: Cents, s: PricingSettings): { floorCents: Cents; walkawayCents: Cents; raised: boolean } {
  const rawFloor = round5(pct(bin, s.floorBps));
  const floorCents = Math.min(bin, Math.max(rawFloor, s.floorMinCents));
  const walkawayCents = Math.min(floorCents, Math.max(round5(pct(bin, s.walkawayBps)), s.walkawayMinCents));
  return { floorCents, walkawayCents, raised: rawFloor < s.floorMinCents };
}

export function computePlan(input: PlanInput, s: PricingSettings): PlanResult {
  const warnings: string[] = [];
  if (input.category === 'other') warnings.push('CATEGORY_OTHER');

  if (input.category === 'geo') {
    if (input.grade !== 'strong' && input.grade !== 'weaker') return fail('GEO_GRADE_REQUIRED', 'Geo names need price_grade strong or weaker');
    const bin = input.grade === 'strong' ? s.geoBinStrongCents : s.geoBinWeakerCents;
    if (input.binCents != null && input.binCents !== bin) {
      return fail('GEO_BIN_NOT_GRADE_PRICE', 'A geo BIN must be the grade price', { grade: input.grade, bin_cents: bin });
    }
    if ((input.floorCents != null && input.floorCents !== bin) || (input.walkawayCents != null && input.walkawayCents !== bin)) {
      return fail('BIN_MODE_NO_NEGOTIATION', 'Geo names are strict Buy It Now: floor and walk-away equal the BIN');
    }
    return { ok: true, plan: {
      mode: 'bin', category: 'geo', grade: input.grade, binCents: bin, floorCents: bin, walkawayCents: bin, minOfferCents: bin,
      pricingSource: 'formula', settingsVersion: s.version, warnings, formula: null,
    } };
  }

  const bin = input.binCents;
  if (bin == null) return fail('HYBRID_FIELDS_REQUIRED', 'hybrid needs bin');
  const exception = input.exception === true;
  if (!exception && bin % BAND !== ENDING_95) return fail('BIN_NOT_NICE', 'A non-geo BIN must be a whole-dollar price ending in 95');
  if (bin < hybridBinMin(s)) return fail('BIN_BELOW_FLOOR_MIN', 'BIN is below the minimum hybrid BIN', { min_bin_cents: hybridBinMin(s) });

  const f = formula(bin, s);
  let floorCents = f.floorCents;
  let walkawayCents = f.walkawayCents;
  let pricingSource: Plan['pricingSource'] = 'formula';

  if (exception) {
    if (input.floorCents == null || input.walkawayCents == null) return fail('HYBRID_FIELDS_REQUIRED', 'An exception needs both floor and walkaway');
    floorCents = input.floorCents;
    walkawayCents = input.walkawayCents;
    if (!(walkawayCents <= floorCents && floorCents <= bin)) return fail('HYBRID_PRICES_INVALID', 'Need walkaway ≤ floor ≤ bin');
    if (floorCents < s.floorMinCents) return fail('FLOOR_BELOW_MIN', 'Floor is below the minimum', { floor_min_cents: s.floorMinCents });
    if (walkawayCents < s.walkawayMinCents) return fail('WALKAWAY_BELOW_MIN', 'Walk-away is below the minimum', { walkaway_min_cents: s.walkawayMinCents });
    if (floorCents !== f.floorCents || walkawayCents !== f.walkawayCents) {
      pricingSource = 'approved_exception';
      warnings.push('PRICING_EXCEPTION');
    }
  } else if (
    (input.floorCents != null && input.floorCents !== f.floorCents) ||
    (input.walkawayCents != null && input.walkawayCents !== f.walkawayCents)
  ) {
    return fail('PRICING_FORMULA_MISMATCH', 'floor/walkaway differ from the formula; send pricing_exception with approval_ref, or omit them', {
      floor_cents: f.floorCents, walkaway_cents: f.walkawayCents,
    });
  }

  if (f.raised && pricingSource === 'formula') warnings.push('FLOOR_RAISED_TO_MIN');
  if (floorCents < bin) warnings.push('FLOOR_AUTO_ACCEPT');
  if (bin >= FAST_TRANSFER_MAX_CENTS) warnings.push('BIN_OVER_FAST_TRANSFER_MAX');

  return { ok: true, plan: {
    mode: 'hybrid', category: input.category, grade: null, binCents: bin, floorCents, walkawayCents,
    minOfferCents: Math.min(s.hybridMinOfferCents, walkawayCents),
    pricingSource, settingsVersion: s.version, warnings, formula: { floorCents: f.floorCents, walkawayCents: f.walkawayCents },
  } };
}
```
The static "no hard-coded pricing numbers" test doesn't forbid `10_000_000`, `9500` or `10000`. Those are an Afternic rule and normative rounding positions, not pricing settings.

- [ ] **Step 4: Run tests**

Run: `npx vitest run && npx tsc --noEmit`
Expected: all PASS. If a PR vector fails, recheck the formula against listing-strategy §10.2–§10.3. **Never change a vector.**

- [ ] **Step 5: Commit**
```bash
git add src/pricing/ tests/unit/
git commit -m "feat: integer pricing core: rounding (round5/nice95/nice99/ceil95), settings loader, hybrid/geo plan calculator with exceptions (PR-1–PR-8, PR-10, PR-40)"
```

---

### Task 3: Drop-schedule generator

**Files:**
- Create: `src/pricing/schedule.ts`, `tests/unit/pricing-schedule.test.ts`

**Interfaces:**
- Consumes: `Plan`, `PricingSettings`, `pct`, `round5`, `nice95`, `ceil95`, `hybridBinMin`.
- Produces:
```ts
export type ScheduleEventName = 'drop1_m6' | 'drop2_m18' | 'geo_drop_m12' | 'final_push' | 'delist';
export type ScheduleStatus = 'planned' | 'skipped_at_minimum' | 'skipped_no_change' | 'skipped_disabled' | 'superseded_by_final_push';
export interface ScheduleEvent {
  event: ScheduleEventName; dueOn: string; // YYYY-MM-DD
  binCents: Cents | null; floorCents: Cents | null; walkawayCents: Cents | null; status: ScheduleStatus;
}
export function addMonthsClamped(date: string, months: number): string;
export function addDays(date: string, days: number): string;
export function buildSchedule(input: {
  plan: Pick<Plan, 'mode' | 'grade' | 'binCents' | 'floorCents' | 'walkawayCents'>; anchor: string; dropDate: string; settings: PricingSettings;
}): ScheduleEvent[];
```
  Hybrid order: `drop1_m6`, `drop2_m18`, `final_push`, `delist`. Geo order: `geo_drop_m12` (strong only, or `skipped_disabled`), `delist`. Drop events come from `settings.drops` in order, named `drop1_m{afterMonths}` and `drop2_m{afterMonths}` for the v2 names. **Event names are fixed by the DB CHECK:** the first drop is `drop1_m6`, the second `drop2_m18`. If settings ever define other months, the names stay `drop1_m6`/`drop2_m18` (positional) and the date follows the settings.

- [ ] **Step 1: Write the failing tests**

`tests/unit/pricing-schedule.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { computePlan } from '../../src/pricing/plan.js';
import { addDays, addMonthsClamped, buildSchedule, type ScheduleEvent } from '../../src/pricing/schedule.js';
import type { Plan } from '../../src/pricing/plan.js';
import { V2 } from './pricing-plan.test.js';

const plan = (bin: number, extra: object = {}): Plan => {
  const r = computePlan({ category: 'trend', binCents: bin, ...extra }, V2);
  if (!r.ok) throw new Error(r.code);
  return r.plan;
};
const geo = (grade: 'strong' | 'weaker'): Plan => {
  const r = computePlan({ category: 'geo', grade }, V2);
  if (!r.ok) throw new Error(r.code);
  return r.plan;
};
const rows = (ev: ScheduleEvent[]) => ev.map((e) => [e.event, e.dueOn, e.binCents, e.floorCents, e.walkawayCents, e.status]);
const S = (p: Plan, anchor = '2026-10-12', dropDate = '2028-10-04', settings = V2) => buildSchedule({ plan: p, anchor, dropDate, settings });

describe('dates', () => {
  it('PR-18: month ends clamp, leap years respected', () => {
    expect(addMonthsClamped('2026-08-31', 6)).toBe('2027-02-28');
    expect(addMonthsClamped('2026-08-31', 18)).toBe('2028-02-29');
    expect(addMonthsClamped('2027-08-31', 6)).toBe('2028-02-29');
    expect(addMonthsClamped('2026-10-12', 6)).toBe('2027-04-12');
  });
  it('addDays crosses months and years', () => {
    expect(addDays('2028-10-04', -90)).toBe('2028-07-06');
    expect(addDays('2028-10-04', -7)).toBe('2028-09-27');
    expect(addDays('2026-12-30', 3)).toBe('2027-01-02');
  });
});

describe('hybrid schedules (PR-11–PR-15, PR-41, PR-42)', () => {
  it('PR-11: D-001 exception 1995/1295/950', () => {
    expect(rows(S(plan(199500, { floorCents: 129500, walkawayCents: 95000, exception: true })))).toEqual([
      ['drop1_m6', '2027-04-12', 159500, 103500, 76000, 'planned'],
      ['drop2_m18', '2028-04-12', 129500, 83000, 61000, 'planned'],
      ['final_push', '2028-07-06', 89500, 83000, 61000, 'planned'],
      ['delist', '2028-09-27', null, null, null, 'planned'],
    ]);
  });
  it('PR-12: formula 1995', () => {
    expect(rows(S(plan(199500)))).toEqual([
      ['drop1_m6', '2027-04-12', 159500, 103500, 77000, 'planned'],
      ['drop2_m18', '2028-04-12', 129500, 83000, 61500, 'planned'],
      ['final_push', '2028-07-06', 89500, 83000, 61500, 'planned'],
      ['delist', '2028-09-27', null, null, null, 'planned'],
    ]);
  });
  it('PR-13: formula 2495', () => {
    expect(rows(S(plan(249500))).slice(0, 3)).toEqual([
      ['drop1_m6', '2027-04-12', 199500, 129500, 96000, 'planned'],
      ['drop2_m18', '2028-04-12', 159500, 103500, 77000, 'planned'],
      ['final_push', '2028-07-06', 109500, 103500, 77000, 'planned'],
    ]);
  });
  it('PR-14: formula 1195 (walk-away lifted to 500; final push no change)', () => {
    expect(rows(S(plan(119500))).slice(0, 3)).toEqual([
      ['drop1_m6', '2027-04-12', 99500, 75000, 50000, 'planned'],
      ['drop2_m18', '2028-04-12', 79500, 75000, 50000, 'planned'],
      ['final_push', '2028-07-06', 79500, 75000, 50000, 'skipped_no_change'],
    ]);
  });
  it('PR-15 / Review Focus 1: formula 795 → both drops skipped_at_minimum with values unchanged; final push no change', () => {
    expect(rows(S(plan(79500))).slice(0, 3)).toEqual([
      ['drop1_m6', '2027-04-12', 79500, 75000, 50000, 'skipped_at_minimum'],
      ['drop2_m18', '2028-04-12', 79500, 75000, 50000, 'skipped_at_minimum'],
      ['final_push', '2028-07-06', 79500, 75000, 50000, 'skipped_no_change'],
    ]);
  });
  it('PR-41: walk-away floor after drops (1495)', () => {
    expect(rows(S(plan(149500))).slice(0, 3)).toEqual([
      ['drop1_m6', '2027-04-12', 119500, 77500, 57500, 'planned'],
      ['drop2_m18', '2028-04-12', 99500, 75000, 50000, 'planned'],
      ['final_push', '2028-07-06', 79500, 75000, 50000, 'planned'],
    ]);
  });
  it('a BIN above 795 that clamps down to 795 still applies (e.g. 895)', () => {
    const p: Plan = { ...plan(89500) };
    const [m6] = S(p);
    expect(m6).toMatchObject({ binCents: 79500, status: 'planned' });
    expect(m6!.floorCents!).toBeGreaterThanOrEqual(75000);
    expect(m6!.walkawayCents!).toBeGreaterThanOrEqual(50000);
  });
  it('PR-19 / Review Focus 2: M18 after the final push → superseded_by_final_push; final push from M6 values', () => {
    expect(rows(S(plan(199500), '2027-06-01', '2028-10-04'))).toEqual([
      ['drop1_m6', '2027-12-01', 159500, 103500, 77000, 'planned'],
      ['drop2_m18', '2028-12-01', null, null, null, 'superseded_by_final_push'],
      ['final_push', '2028-07-06', 109500, 103500, 77000, 'planned'],
      ['delist', '2028-09-27', null, null, null, 'planned'],
    ]);
  });
});

describe('geo schedules (PR-16, PR-43)', () => {
  it('PR-16: strong → one geo_drop_m12 499→399 + delist; no M6/M18/final push', () => {
    expect(rows(S(geo('strong'), '2026-11-01', '2028-11-01'))).toEqual([
      ['geo_drop_m12', '2027-11-01', 39900, 39900, 39900, 'planned'],
      ['delist', '2028-10-25', null, null, null, 'planned'],
    ]);
  });
  it('PR-16: weaker → only delist', () => {
    expect(rows(S(geo('weaker'), '2026-11-01', '2028-11-01'))).toEqual([['delist', '2028-10-25', null, null, null, 'planned']]);
  });
  it('PR-16: geo drops disabled → geo_drop_m12 skipped_disabled', () => {
    expect(rows(S(geo('strong'), '2026-11-01', '2028-11-01', { ...V2, geoDropsEnabled: false }))[0]).toEqual(
      ['geo_drop_m12', '2027-11-01', null, null, null, 'skipped_disabled']);
  });
  it('PR-43: no geo plan ever schedules a BIN other than 499 or 399, at most one geo price row', () => {
    for (const g of ['strong', 'weaker'] as const) {
      for (let m = 0; m < 24; m++) {
        const anchor = addMonthsClamped('2026-10-31', m);
        const ev = S(geo(g), anchor, addMonthsClamped(anchor, 24));
        const priced = ev.filter((e) => e.binCents !== null && e.status === 'planned');
        expect(priced.length).toBeLessThanOrEqual(1);
        for (const e of priced) expect([49900, 39900]).toContain(e.binCents);
      }
    }
  });
});

describe('PR-9: property — every x95 BIN from $795 to $100,000', () => {
  it('invariants hold at listing and after every scheduled event', () => {
    for (let bin = 79500; bin <= 10_000_000; bin += 10000) {
      const p = plan(bin);
      const check = (b: number, f: number, w: number) => {
        expect(2000 <= p.minOfferCents && p.minOfferCents <= 50000 && 50000 <= w && w <= f && f <= b && f >= 75000, `bin ${bin}: ${b}/${f}/${w}`).toBe(true);
      };
      check(p.binCents, p.floorCents, p.walkawayCents);
      if (p.floorCents > 75000) expect(Math.abs(p.floorCents * 10000 - bin * 6500)).toBeLessThanOrEqual(250 * 10000);
      if (p.walkawayCents > 50000 && p.walkawayCents < p.floorCents) expect(Math.abs(p.walkawayCents * 10000 - bin * 4800)).toBeLessThanOrEqual(250 * 10000);
      for (const e of S(p)) if (e.binCents !== null) check(e.binCents, e.floorCents!, e.walkawayCents!);
    }
  });
});
```
(`tests/unit/pricing-plan.test.ts` exports `V2`. Vitest allows importing a test file's export; if it complains, move `V2` into `tests/helpers/pricing.ts` and import it from both files.)

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/unit/pricing-schedule.test.ts`
Expected: FAIL (module missing).

- [ ] **Step 3: Implement**

`src/pricing/schedule.ts`:
```ts
import { ceil95, nice95, pct, round5 } from './round.js';
import type { Cents } from './int.js';
import { hybridBinMin, type Plan } from './plan.js';
import type { PricingSettings } from './settings.js';

export type ScheduleEventName = 'drop1_m6' | 'drop2_m18' | 'geo_drop_m12' | 'final_push' | 'delist';
export type ScheduleStatus = 'planned' | 'skipped_at_minimum' | 'skipped_no_change' | 'skipped_disabled' | 'superseded_by_final_push';
export interface ScheduleEvent {
  event: ScheduleEventName; dueOn: string;
  binCents: Cents | null; floorCents: Cents | null; walkawayCents: Cents | null; status: ScheduleStatus;
}

const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const BPS = 10000;
const DROP_NAMES: readonly ScheduleEventName[] = ['drop1_m6', 'drop2_m18'];

function parse(date: string): [number, number, number] {
  const m = DATE.exec(date);
  if (!m) throw new Error(`Not a date: ${date}`);
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}
const fmt = (d: Date) => d.toISOString().slice(0, 10);

/** Same day N months later; clamps to the last day of a shorter month. */
export function addMonthsClamped(date: string, months: number): string {
  const [y, mo, d] = parse(date);
  const target = new Date(Date.UTC(y, mo - 1 + months, 1));
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  return fmt(new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth(), Math.min(d, lastDay))));
}

export function addDays(date: string, days: number): string {
  const [y, mo, d] = parse(date);
  return fmt(new Date(Date.UTC(y, mo - 1, d + days)));
}

interface Values { bin: Cents; floor: Cents; walk: Cents }

function applyDrop(v: Values, pctBps: number, s: PricingSettings): Values | null {
  const keep = BPS - pctBps;
  const bin = Math.max(nice95(pct(v.bin, keep)), hybridBinMin(s));
  if (bin >= v.bin) return null; // can't lower the BIN: skipped_at_minimum, nothing changes
  const floor = Math.min(bin, Math.max(round5(pct(v.floor, keep)), s.floorMinCents));
  const walk = Math.min(floor, Math.max(round5(pct(v.walk, keep)), s.walkawayMinCents));
  return { bin, floor, walk };
}

export function buildSchedule(input: {
  plan: Pick<Plan, 'mode' | 'grade' | 'binCents' | 'floorCents' | 'walkawayCents'>; anchor: string; dropDate: string; settings: PricingSettings;
}): ScheduleEvent[] {
  const { plan, anchor, dropDate, settings: s } = input;
  const out: ScheduleEvent[] = [];
  const delistOn = addDays(dropDate, -s.delistDaysBeforeDrop);
  const ev = (event: ScheduleEventName, dueOn: string, v: Values | null, status: ScheduleStatus): ScheduleEvent => ({
    event, dueOn, binCents: v?.bin ?? null, floorCents: v?.floor ?? null, walkawayCents: v?.walk ?? null, status,
  });

  if (plan.mode === 'bin') {
    const rule = s.geoDrops[0];
    if (plan.grade === 'strong' && rule && plan.binCents === rule.fromCents) {
      const due = addMonthsClamped(anchor, rule.afterMonths);
      const v = { bin: rule.toCents, floor: rule.toCents, walk: rule.toCents };
      if (!s.geoDropsEnabled) out.push(ev('geo_drop_m12', due, null, 'skipped_disabled'));
      else if (due >= delistOn) out.push(ev('geo_drop_m12', due, null, 'superseded_by_final_push'));
      else out.push(ev('geo_drop_m12', due, v, 'planned'));
    }
    out.push(ev('delist', delistOn, null, 'planned'));
    return out;
  }

  const finalOn = addDays(dropDate, -s.finalPushDaysBeforeDrop);
  let cur: Values = { bin: plan.binCents, floor: plan.floorCents, walk: plan.walkawayCents };
  s.drops.forEach((d, i) => {
    const name = DROP_NAMES[i];
    if (!name) return;
    const due = addMonthsClamped(anchor, d.afterMonths);
    if (due >= finalOn) {
      out.push(ev(name, due, null, 'superseded_by_final_push'));
      return;
    }
    const next = applyDrop(cur, d.pctBps, s);
    if (!next) out.push(ev(name, due, cur, 'skipped_at_minimum'));
    else {
      cur = next;
      out.push(ev(name, due, cur, 'planned'));
    }
  });

  const pushedBin = Math.min(cur.bin, Math.max(ceil95(cur.floor), hybridBinMin(s)));
  out.push(pushedBin === cur.bin ? ev('final_push', finalOn, cur, 'skipped_no_change') : ev('final_push', finalOn, { ...cur, bin: pushedBin }, 'planned'));
  out.push(ev('delist', delistOn, null, 'planned'));
  return out;
}
```
This uses no `/` operator: `addMonthsClamped` and `addDays` use `Date.UTC` arithmetic. Keep it that way for PR-10.

- [ ] **Step 4: Run tests**

Run: `npx vitest run && npx tsc --noEmit`
Expected: all PASS. If a vector differs, trace the chain by hand against listing-strategy §10.4 and report it. **Do not edit the expected values.**

- [ ] **Step 5: Commit**
```bash
git add src/pricing/schedule.ts tests/unit/
git commit -m "feat: drop-schedule generator (hybrid M6/M18/final push/delist, geo M12, clamps, supersede) (PR-9, PR-11–PR-16, PR-18, PR-19, PR-41–PR-43)"
```

---

### Task 4: `pricing-settings` admin command

**Files:**
- Create: `src/admin/pricing-settings.ts`, `tests/api/pricing-settings.test.ts`
- Modify: `src/admin.ts` (subcommands `pricing-settings new|show`), `tests/api/auth.test.ts` (AU-7: no `pricing` route writes settings)

**Interfaces:**
- Consumes: `currentSettings`, `rowToSettings`, `RULE_KEYS`, `newAuditId`.
- Produces:
  - `newPricingSettings(db, opts: { set: Record<string, string>; approvalText: string; approvalAt: string; note?: string; effectiveAt?: Date; now: Date }): Promise<{ version: number }>` (reads the current version, applies `set` (snake_case column names, JSON for `geo_drops`/`drops`, `true`/`false` for booleans, integers otherwise), inserts version + 1 in a transaction, and writes an `admin` audit row `pricing-settings new`)
  - `showPricingSettings(db, version?: number): Promise<object>`
  - CLI:
    - `npm run admin -- pricing-settings new --from-current --set floor_bps=6000 [--set …] --approval-text "<Dvir's words>" --approval-at <ISO> [--note …]`
    - `npm run admin -- pricing-settings show [--version N]`

- [ ] **Step 1: Write the failing tests**

`tests/api/pricing-settings.test.ts`:
```ts
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { newPricingSettings } from '../../src/admin/pricing-settings.js';
import { currentSettings } from '../../src/pricing/settings.js';
import { testDb as db } from '../helpers/db.js';
import { testEnv } from '../helpers/env.js';
import { makeApp } from '../helpers/app.js';

const run = promisify(execFile);
const now = new Date('2026-10-06T08:00:00Z');
const approval = { approvalText: 'Dvir: set floor to 60%', approvalAt: '2026-10-06T10:00:00+03:00' };

describe('pricing-settings admin (PR-31, PR-32)', () => {
  it('creates version 3 from current with --set, keeps v2 intact, records approval and an admin audit row', async () => {
    const { version } = await newPricingSettings(db, { set: { floor_bps: '6000' }, ...approval, now });
    expect(version).toBe(3);
    const rows = await db.selectFrom('pricing_settings').select(['version', 'floor_bps', 'walkaway_bps', 'approval_text']).orderBy('version').execute();
    expect(rows).toEqual([
      { version: 2, floor_bps: 6500, walkaway_bps: 4800, approval_text: expect.stringContaining('v2') },
      { version: 3, floor_bps: 6000, walkaway_bps: 4800, approval_text: 'Dvir: set floor to 60%' },
    ]);
    expect((await currentSettings(db, new Date())).version).toBe(3);
    const audit = await db.selectFrom('audit_log').selectAll().where('path', '=', 'pricing-settings new').execute();
    expect(audit).toHaveLength(1);
  });

  it('refuses without approval text, with an unknown key, or with values that break an invariant', async () => {
    await expect(newPricingSettings(db, { set: { floor_bps: '6000' }, approvalText: '  ', approvalAt: approval.approvalAt, now })).rejects.toThrow(/approval/i);
    await expect(newPricingSettings(db, { set: { nope: '1' }, ...approval, now })).rejects.toThrow(/unknown/i);
    await expect(newPricingSettings(db, { set: { walkaway_bps: '7000' }, ...approval, now })).rejects.toThrow();
    expect(await db.selectFrom('pricing_settings').select('version').execute()).toHaveLength(1);
  });

  it('jsonb and boolean values parse (drops, geo_drops_enabled)', async () => {
    await newPricingSettings(db, { set: { drops: '[{"after_months":4,"pct_bps":2000},{"after_months":18,"pct_bps":2000}]', geo_drops_enabled: 'false' }, ...approval, now });
    const s = await currentSettings(db, new Date());
    expect(s.drops[0]).toEqual({ afterMonths: 4, pctBps: 2000 });
    expect(s.geoDropsEnabled).toBe(false);
  });

  it('CLI: new + show work; missing --approval-text exits non-zero; output has no secret', async () => {
    const env = { ...process.env, ...testEnv() };
    await expect(run('npx', ['tsx', 'src/admin.ts', 'pricing-settings', 'new', '--from-current', '--set', 'floor_bps=6000'], { env })).rejects.toMatchObject({ code: 2 });
    const ok = await run('npx', ['tsx', 'src/admin.ts', 'pricing-settings', 'new', '--from-current', '--set', 'floor_bps=6000',
      '--approval-text', 'Dvir: 60%', '--approval-at', '2026-10-06T10:00:00+03:00'], { env });
    expect(ok.stdout).toMatch(/version 3/);
    const show = await run('npx', ['tsx', 'src/admin.ts', 'pricing-settings', 'show'], { env });
    expect(show.stdout).toMatch(/"floor_bps": 6000/);
    expect(show.stdout).not.toMatch(/pk1_|sk1_/);
  });

  it('PR-31: no API route writes pricing_settings (route table)', async () => {
    const app = await makeApp({ testRoutes: false });
    for (const r of app.routeTable) {
      if (r.method !== 'GET' && r.method !== 'HEAD') expect(r.url).not.toMatch(/pricing|settings/i);
    }
    await app.close();
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/api/pricing-settings.test.ts`
Expected: FAIL (module missing).

- [ ] **Step 3: Implement**

`src/admin/pricing-settings.ts`:
```ts
import type { Kysely } from 'kysely';
import type { Database } from '../db/types.js';
import { newAuditId } from '../http/audit.js';
import { rowToSettings } from '../pricing/settings.js';

const INT_KEYS = [
  'geo_bin_strong_cents', 'geo_bin_weaker_cents', 'geo_bin_min_cents', 'geo_bin_max_cents', 'floor_bps', 'floor_min_cents',
  'walkaway_bps', 'walkaway_min_cents', 'hybrid_min_offer_cents', 'final_push_days_before_drop', 'delist_days_before_drop',
  'headsup_days_before', 'comps_min', 'comps_max',
] as const;
const BOOL_KEYS = ['geo_drops_enabled', 'public_lto'] as const;
const JSON_KEYS = ['geo_drops', 'drops'] as const;
const TEXT_KEYS = ['final_push_mode'] as const;

function parseValue(key: string, raw: string): unknown {
  if ((INT_KEYS as readonly string[]).includes(key)) {
    if (!/^\d+$/.test(raw)) throw new Error(`${key} must be a non-negative integer`);
    return Number(raw);
  }
  if ((BOOL_KEYS as readonly string[]).includes(key)) {
    if (raw !== 'true' && raw !== 'false') throw new Error(`${key} must be true or false`);
    return raw === 'true';
  }
  if ((JSON_KEYS as readonly string[]).includes(key)) return JSON.stringify(JSON.parse(raw));
  if ((TEXT_KEYS as readonly string[]).includes(key)) return raw;
  throw new Error(`unknown pricing setting: ${key}`);
}

export async function newPricingSettings(
  db: Kysely<Database>,
  o: { set: Record<string, string>; approvalText: string; approvalAt: string; note?: string; effectiveAt?: Date; now: Date },
): Promise<{ version: number }> {
  if (!o.approvalText.trim()) throw new Error('approval text (Dvir\'s words) is required');
  const approvalAt = new Date(o.approvalAt);
  if (Number.isNaN(approvalAt.getTime())) throw new Error('approval-at must be an ISO 8601 time');
  const changes = Object.fromEntries(Object.entries(o.set).map(([k, v]) => [k, parseValue(k, v)]));
  return db.transaction().execute(async (trx) => {
    const cur = await trx.selectFrom('pricing_settings').selectAll().orderBy('version', 'desc').forUpdate().executeTakeFirstOrThrow();
    const { version, created_at: _c, ...rest } = cur;
    const row = {
      ...rest,
      geo_drops: JSON.stringify(cur.geo_drops),
      drops: JSON.stringify(cur.drops),
      ...changes,
      version: version + 1,
      effective_at: o.effectiveAt ?? o.now,
      approval_text: o.approvalText,
      approval_at: approvalAt,
      note: o.note ?? null,
    };
    const inserted = await trx.insertInto('pricing_settings').values(row as never).returningAll().executeTakeFirstOrThrow();
    rowToSettings(inserted); // validates the jsonb shapes; throws (and rolls back) on a bad value
    await trx.insertInto('audit_log').values({
      id: newAuditId(), scope: 'admin', method: 'ADMIN', path: 'pricing-settings new',
      request: JSON.stringify({ set: o.set, note: o.note ?? null }), approval_text: o.approvalText, approval_at: approvalAt,
      status_code: 200, result_summary: `created pricing_settings version ${inserted.version}`,
    }).execute();
    return { version: inserted.version };
  });
}

export async function showPricingSettings(db: Kysely<Database>, version?: number): Promise<object> {
  let q = db.selectFrom('pricing_settings').selectAll();
  q = version ? q.where('version', '=', version) : q.orderBy('version', 'desc');
  const r = await q.executeTakeFirst();
  if (!r) throw new Error('no such pricing_settings version');
  return r;
}
```
The DB CHECK constraints enforce the invariants: `walkaway_bps ≤ floor_bps`, `comps_min ≤ comps_max`, `hybrid_min_offer ≥ 2000` and the rest. An invalid `--set` makes the insert fail and nothing is written.

`src/admin.ts`: add the `pricing-settings` command. `parseArgs` gets the options `set` (`type: 'string', multiple: true`), `'from-current'` (boolean), `'approval-text'`, `'approval-at'`, `note` and `version`. `new` without `--from-current` or `--approval-text` → `UsageError` (exit 2). `--set` values are split on the first `=`. On success print `Created pricing_settings version N`. `show` prints `JSON.stringify(row, null, 2)`.

In `tests/api/auth.test.ts` (AU-7), extend the existing route-table test so no route URL matches `/settings/i` for any method. It already checks `settings`; just make sure the new `/pricing/preview` GET doesn't violate it (it doesn't contain "settings").

- [ ] **Step 4: Run tests**

Run: `npx vitest run && npx tsc --noEmit`
Expected: all PASS.

- [ ] **Step 5: Commit**
```bash
git add src/admin/ src/admin.ts tests/
git commit -m "feat: pricing-settings admin command (new version from current with approval; show) (PR-30, PR-31)"
```

---

### Task 5: `GET /pricing/preview`, presentation, PR-44 vectors

**Files:**
- Create: `src/pricing/present.ts`, `src/api/pricing.ts`, `tests/api/pricing-preview.test.ts`, `tests/api/pricing-vectors.test.ts`, `tests/fixtures/pricing-vectors.v2.json`
- Modify: `src/app.ts`

**Interfaces:**
- Consumes: everything above, `afternicRow` (`src/services/export.ts`), `jerusalemDate`, `formatUsd`, `canonicalJson`, `dollarsToCents`.
- Produces:
  - `wholeUsd(c: Cents): string` (`$1,995` when whole dollars, else `formatUsd`)
  - `eventLabel(e: ScheduleEventName): string` (`drop1_m6` → `M6`, `drop2_m18` → `M18`, `geo_drop_m12` → `M12`, `final_push` → `final push`, `delist` → `delist`)
  - `sellPlanLine(plan: Plan, schedule: ScheduleEvent[]): string`
  - `registerPricing(app, deps: { db; now: () => number }): void`, which adds `GET /pricing/preview`

- [ ] **Step 1: Write the vector file and the failing tests**

`tests/fixtures/pricing-vectors.v2.json` (PR-44: keyed by settings version; `settings_sha256` = SHA-256 of `canonicalJson(ruleFields(v2))`):
```json
{
  "settings_version": 2,
  "settings_sha256": "a0636bbd9daf7cf5b50b41efda54cc027c66b4d7e66ccfb338d24e5b26c4a0e4",
  "plans": [
    { "input": { "category": "trend", "binCents": 199500 }, "floor": 129500, "walkaway": 96000, "min_offer": 10000 },
    { "input": { "category": "trend", "binCents": 249500 }, "floor": 162000, "walkaway": 120000, "min_offer": 10000 },
    { "input": { "category": "trend", "binCents": 499500 }, "floor": 324500, "walkaway": 240000, "min_offer": 10000 },
    { "input": { "category": "trend", "binCents": 119500 }, "floor": 77500, "walkaway": 57500, "min_offer": 10000 },
    { "input": { "category": "trend", "binCents": 79500 }, "floor": 75000, "walkaway": 50000, "min_offer": 10000 },
    { "input": { "category": "trend", "binCents": 99500 }, "floor": 75000, "walkaway": 50000, "min_offer": 10000 },
    { "input": { "category": "trend", "binCents": 109500 }, "floor": 75000, "walkaway": 52500, "min_offer": 10000 },
    { "input": { "category": "trend", "binCents": 149500 }, "floor": 97000, "walkaway": 72000, "min_offer": 10000 },
    { "input": { "category": "geo", "grade": "strong" }, "floor": 49900, "walkaway": 49900, "min_offer": 49900 },
    { "input": { "category": "geo", "grade": "weaker" }, "floor": 39900, "walkaway": 39900, "min_offer": 39900 }
  ],
  "schedules": [
    { "input": { "category": "trend", "binCents": 199500, "floorCents": 129500, "walkawayCents": 95000, "exception": true }, "anchor": "2026-10-12", "drop_date": "2028-10-04",
      "events": [["drop1_m6","2027-04-12",159500,103500,76000,"planned"],["drop2_m18","2028-04-12",129500,83000,61000,"planned"],["final_push","2028-07-06",89500,83000,61000,"planned"],["delist","2028-09-27",null,null,null,"planned"]] },
    { "input": { "category": "trend", "binCents": 199500 }, "anchor": "2026-10-12", "drop_date": "2028-10-04",
      "events": [["drop1_m6","2027-04-12",159500,103500,77000,"planned"],["drop2_m18","2028-04-12",129500,83000,61500,"planned"],["final_push","2028-07-06",89500,83000,61500,"planned"],["delist","2028-09-27",null,null,null,"planned"]] },
    { "input": { "category": "trend", "binCents": 79500 }, "anchor": "2026-10-12", "drop_date": "2028-10-04",
      "events": [["drop1_m6","2027-04-12",79500,75000,50000,"skipped_at_minimum"],["drop2_m18","2028-04-12",79500,75000,50000,"skipped_at_minimum"],["final_push","2028-07-06",79500,75000,50000,"skipped_no_change"],["delist","2028-09-27",null,null,null,"planned"]] },
    { "input": { "category": "geo", "grade": "strong" }, "anchor": "2026-11-01", "drop_date": "2028-11-01",
      "events": [["geo_drop_m12","2027-11-01",39900,39900,39900,"planned"],["delist","2028-10-25",null,null,null,"planned"]] }
  ]
}
```
`tests/api/pricing-vectors.test.ts`:
```ts
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { canonicalJson } from '../../src/http/canonical-json.js';
import { computePlan, type PlanInput } from '../../src/pricing/plan.js';
import { buildSchedule } from '../../src/pricing/schedule.js';
import { currentSettings, ruleFields } from '../../src/pricing/settings.js';
import { testDb as db } from '../helpers/db.js';

const V = JSON.parse(readFileSync('tests/fixtures/pricing-vectors.v2.json', 'utf8'));

describe('PR-44: vectors are keyed by the settings version', () => {
  it('Review Focus 5: the current version and its rule fingerprint match the vector file', async () => {
    const s = await currentSettings(db, new Date());
    const sha = createHash('sha256').update(canonicalJson(ruleFields(s))).digest('hex');
    expect({ version: s.version, sha }).toEqual({ version: V.settings_version, sha: V.settings_sha256 });
  });
  it('every plan and schedule vector reproduces exactly', async () => {
    const s = await currentSettings(db, new Date());
    for (const v of V.plans) {
      const r = computePlan(v.input as PlanInput, s);
      if (!r.ok) throw new Error(`${JSON.stringify(v.input)} → ${r.code}`);
      expect([r.plan.floorCents, r.plan.walkawayCents, r.plan.minOfferCents, r.plan.settingsVersion]).toEqual([v.floor, v.walkaway, v.min_offer, 2]);
    }
    for (const v of V.schedules) {
      const r = computePlan(v.input as PlanInput, s);
      if (!r.ok) throw new Error(r.code);
      const ev = buildSchedule({ plan: r.plan, anchor: v.anchor, dropDate: v.drop_date, settings: s });
      expect(ev.map((e) => [e.event, e.dueOn, e.binCents, e.floorCents, e.walkawayCents, e.status])).toEqual(v.events);
    }
  });
});
```
`tests/api/pricing-preview.test.ts`:
```ts
import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { makeApp } from '../helpers/app.js';
import { insertOwnedDomain, testDb as db } from '../helpers/db.js';
import { issueToken } from '../helpers/tokens.js';

let app: FastifyInstance;
afterEach(async () => app?.close());
const get = async (qs: string, auth: Record<string, string>) => app.inject({ method: 'GET', url: `/pricing/preview?${qs}`, headers: auth });

describe('GET /pricing/preview (§10.6)', () => {
  it('matches the spec example: trend 1995, listed 2026-10-12, drop 2028-10-04', async () => {
    app = await makeApp();
    const { auth } = await issueToken('read');
    const res = await get('category=trend&bin=1995&listed_on=2026-10-12&drop_date=2028-10-04', auth);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      settings_version: 2, category: 'trend', mode: 'hybrid', pricing_source: 'formula', grade: null,
      bin_cents: 199500, floor_cents: 129500, walkaway_cents: 96000, min_offer_cents: 10000,
      display: { bin: '$1,995', floor: '$1,295', walkaway: '$960 (private)', min_offer: '$100' },
      net_at_15pct: { bin: '$1,695.75', floor: '$1,100.75', walkaway: '$816.00' },
      schedule: [
        { event: 'drop1_m6', due_on: '2027-04-12', bin: '$1,595', floor: '$1,035', walkaway: '$770', status: 'planned' },
        { event: 'drop2_m18', due_on: '2028-04-12', bin: '$1,295', floor: '$830', walkaway: '$615', status: 'planned' },
        { event: 'final_push', due_on: '2028-07-06', bin: '$895', floor: '$830', walkaway: '$615', status: 'planned' },
        { event: 'delist', due_on: '2028-09-27', status: 'planned' },
      ],
      afternic_row: 'example.com,1995,1295,100,N,,Custom Lander,Y,N,Y,N',
      sell_plan_line: 'hybrid · BIN $1,995 · floor (auto-accept) $1,295 · walk-away (private) $960 · min offer $100 · LTO off · M6 2027-04-12 $1,595/$1,035/$770 · M18 2028-04-12 $1,295/$830/$615 · final push 2028-07-06 $895/$830/$615 · delist 2028-09-27 · settings v2',
      warnings: ['FLOOR_AUTO_ACCEPT'],
    });
  });

  it('D-001 exception via domain: afternic_row uses display_name; 950 never in afternic_row (OF-14 part)', async () => {
    app = await makeApp();
    const { auth } = await issueToken('read');
    await insertOwnedDomain(db, { domain: 'promptinjectionaudit.com', display_name: 'PromptInjectionAudit.com', category: 'trend', expiry_date: '2027-10-04', drop_date: '2028-10-04' });
    const b = (await get('category=trend&bin=1995&floor=1295&walkaway=950&listed_on=2026-10-12&domain=promptinjectionaudit.com', auth)).json();
    expect(b).toMatchObject({ pricing_source: 'approved_exception', walkaway_cents: 95000, afternic_row: 'PromptInjectionAudit.com,1995,1295,100,N,,Custom Lander,Y,N,Y,N' });
    expect(b.afternic_row).not.toContain('950');
    expect(b.warnings).toEqual(expect.arrayContaining(['PRICING_EXCEPTION', 'FLOOR_AUTO_ACCEPT']));
    expect(b.schedule[2]).toMatchObject({ event: 'final_push', due_on: '2028-07-06', bin: '$895', floor: '$830', walkaway: '$610' });
  });

  it('geo strong preview: bin row, M12 + delist, sell_plan_line starts with the geo prefix', async () => {
    app = await makeApp();
    const { auth } = await issueToken('read');
    const b = (await get('category=geo&grade=strong&listed_on=2026-11-01&drop_date=2028-11-01', auth)).json();
    expect(b).toMatchObject({ mode: 'bin', grade: 'strong', bin_cents: 49900, min_offer_cents: 49900, afternic_row: 'example.com,499,499,499,N,,Buy It Now,Y,N,N,N' });
    expect(b.schedule.map((e: { event: string }) => e.event)).toEqual(['geo_drop_m12', 'delist']);
    expect(b.sell_plan_line).toMatch(/^bin \(geo strong\) · BIN \$499 · no offers · M12 2027-11-01 \$399 · delist 2028-10-25 · settings v2$/);
  });

  it('errors use the V2/V5/V6 codes (422) and the preview has no side effects', async () => {
    app = await makeApp();
    const { auth } = await issueToken('read');
    expect((await get('category=trend&bin=1990', auth)).json().error.code).toBe('BIN_NOT_NICE');
    expect((await get('category=trend&bin=695', auth)).json().error.code).toBe('BIN_BELOW_FLOOR_MIN');
    expect((await get('category=geo', auth)).json().error.code).toBe('GEO_GRADE_REQUIRED');
    expect((await get('category=trend&bin=1995&floor=1295&walkaway=450', auth)).json().error.code).toBe('WALKAWAY_BELOW_MIN');
    expect((await get('category=nope&bin=1995', auth)).json().error.code).toBe('CATEGORY_REQUIRED');
    expect((await get('bin=1995', auth)).json().error.code).toBe('CATEGORY_REQUIRED');
    expect((await get('category=trend&bin=1995&listed_on=2026-13-01', auth)).statusCode).toBe(422);
    expect(await db.selectFrom('audit_log').selectAll().where('method', '<>', 'ADMIN').execute()).toHaveLength(0);
  });

  it('default dates: listed today (IDT), drop_date = listed + 2 years; skipped events shown in the line', async () => {
    app = await makeApp();
    const { auth } = await issueToken('read');
    const b = (await get('category=trend&bin=795', auth)).json();
    expect(b.schedule[0]).toMatchObject({ event: 'drop1_m6', status: 'skipped_at_minimum' });
    expect(b.sell_plan_line).toMatch(/M6 skipped \(minimum\)/);
    expect(b.warnings).toContain('FLOOR_RAISED_TO_MIN');
  });

  it('READ token 200; no token 401', async () => {
    app = await makeApp();
    expect((await app.inject({ method: 'GET', url: '/pricing/preview?category=trend&bin=1995' })).statusCode).toBe(401);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/api/pricing-preview.test.ts tests/api/pricing-vectors.test.ts`
Expected: preview FAILS (no route); the vector test should already PASS. It guards the core; keep it.

- [ ] **Step 3: Implement**

`src/pricing/present.ts`:
```ts
import { formatUsd } from '../money.js';
import type { Cents } from './int.js';
import type { Plan } from './plan.js';
import type { ScheduleEvent, ScheduleEventName } from './schedule.js';

const CENTS_PER_DOLLAR = 100;

export function wholeUsd(c: Cents): string {
  const s = formatUsd(c);
  return c % CENTS_PER_DOLLAR === 0 && s.endsWith('.00') ? s.slice(0, -3) : s;
}

const LABELS: Record<ScheduleEventName, string> = {
  drop1_m6: 'M6', drop2_m18: 'M18', geo_drop_m12: 'M12', final_push: 'final push', delist: 'delist',
};
export const eventLabel = (e: ScheduleEventName) => LABELS[e];

const SKIP_TEXT: Partial<Record<ScheduleEvent['status'], string>> = {
  skipped_at_minimum: 'skipped (minimum)', skipped_no_change: 'skipped (no change)', skipped_disabled: 'skipped (disabled)',
};

function eventText(plan: Plan, e: ScheduleEvent): string | null {
  if (e.status === 'superseded_by_final_push') return null;
  const skip = SKIP_TEXT[e.status];
  if (skip) return `${eventLabel(e.event)} ${skip}`;
  if (e.event === 'delist') return `delist ${e.dueOn}`;
  if (plan.mode === 'bin') return `${eventLabel(e.event)} ${e.dueOn} ${wholeUsd(e.binCents!)}`;
  return `${eventLabel(e.event)} ${e.dueOn} ${wholeUsd(e.binCents!)}/${wholeUsd(e.floorCents!)}/${wholeUsd(e.walkawayCents!)}`;
}

export function sellPlanLine(plan: Plan, schedule: ScheduleEvent[]): string {
  const head = plan.mode === 'bin'
    ? [`bin (geo ${plan.grade}) · BIN ${wholeUsd(plan.binCents)} · no offers`]
    : [`hybrid · BIN ${wholeUsd(plan.binCents)} · floor (auto-accept) ${wholeUsd(plan.floorCents)} · walk-away (private) ${wholeUsd(plan.walkawayCents)} · min offer ${wholeUsd(plan.minOfferCents)} · LTO off`];
  const events = schedule.map((e) => eventText(plan, e)).filter((t): t is string => t !== null);
  return [...head, ...events, `settings v${plan.settingsVersion}`].join(' · ');
}
```
(`present.ts` must pass PR-10: no regex literals, because the static test doesn't strip them and their `/` would count as division.)

`src/api/pricing.ts`:
```ts
import type { FastifyInstance } from 'fastify';
import type { Kysely } from 'kysely';
import { z } from 'zod';
import { jerusalemDate } from '../dates.js';
import type { Database } from '../db/types.js';
import { AppError } from '../http/errors.js';
import { dollarsToCents, formatUsd } from '../money.js';
import { computePlan, type PlanCategory } from '../pricing/plan.js';
import { sellPlanLine, wholeUsd } from '../pricing/present.js';
import { pct } from '../pricing/round.js';
import { addMonthsClamped, buildSchedule } from '../pricing/schedule.js';
import { currentSettings } from '../pricing/settings.js';
import { afternicRow } from '../services/export.js';
import { isCategory } from '../services/listing-rules.js';

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const NET_BPS = 8500; // display only: net after Afternic's 15% Basic commission

const Query = z.object({
  category: z.string().optional(),
  bin: z.coerce.number().optional(),
  grade: z.enum(['strong', 'weaker']).optional(),
  floor: z.coerce.number().optional(),
  walkaway: z.coerce.number().optional(),
  listed_on: z.string().regex(DATE).optional(),
  drop_date: z.string().regex(DATE).optional(),
  domain: z.string().optional(),
}).strict();

const cents = (n: number | undefined, f: string) => {
  if (n === undefined) return undefined;
  try {
    return dollarsToCents(n);
  } catch {
    throw new AppError(422, 'VALIDATION_ERROR', `${f} must be a positive USD amount with at most 2 decimals`);
  }
};

function validDate(d: string, f: string): string {
  const t = new Date(`${d}T00:00:00Z`);
  if (Number.isNaN(t.getTime()) || t.toISOString().slice(0, 10) !== d) throw new AppError(422, 'VALIDATION_ERROR', `${f} is not a real date`);
  return d;
}

export function registerPricing(app: FastifyInstance, deps: { db: Kysely<Database>; now: () => number }): void {
  app.get('/pricing/preview', async (req) => {
    const parsed = Query.safeParse(req.query);
    if (!parsed.success) throw new AppError(422, 'VALIDATION_ERROR', 'Invalid preview query', { issues: parsed.error.issues.map((i) => i.message) });
    const q = parsed.data;
    if (!isCategory(q.category)) throw new AppError(422, 'CATEGORY_REQUIRED', 'category is required (geo, trend, b2b, collision, regulation, buzzword, other)');
    const now = new Date(deps.now());
    const s = await currentSettings(deps.db, now);

    const exception = q.floor !== undefined || q.walkaway !== undefined;
    const r = computePlan({
      category: q.category as PlanCategory, grade: q.grade ?? null, binCents: cents(q.bin, 'bin'),
      floorCents: cents(q.floor, 'floor'), walkawayCents: cents(q.walkaway, 'walkaway'), exception,
    }, s);
    if (!r.ok) throw new AppError(422, r.code, r.message, r.details ?? {});
    const plan = r.plan;

    let name = 'example.com';
    let dropDate = q.drop_date ? validDate(q.drop_date, 'drop_date') : undefined;
    if (q.domain) {
      const row = await deps.db.selectFrom('domains').select(['domain', 'display_name', 'drop_date']).where('domain', '=', q.domain.toLowerCase()).executeTakeFirst();
      if (row) {
        name = row.display_name ?? row.domain;
        dropDate = dropDate ?? row.drop_date ?? undefined;
      }
    }
    const listedOn = q.listed_on ? validDate(q.listed_on, 'listed_on') : jerusalemDate(now);
    dropDate = dropDate ?? addMonthsClamped(listedOn, 24);
    const schedule = buildSchedule({ plan, anchor: listedOn, dropDate, settings: s });

    const a = afternicRow({
      domain: name.toLowerCase(), display_name: name, listing_mode: plan.mode, bin_cents: plan.binCents,
      floor_cents: plan.floorCents, min_offer_cents: plan.minOfferCents, lto_max_months: null,
    });

    return {
      settings_version: plan.settingsVersion, category: plan.category, mode: plan.mode, pricing_source: plan.pricingSource, grade: plan.grade,
      bin_cents: plan.binCents, floor_cents: plan.floorCents, walkaway_cents: plan.walkawayCents, min_offer_cents: plan.minOfferCents,
      display: { bin: wholeUsd(plan.binCents), floor: wholeUsd(plan.floorCents), walkaway: `${wholeUsd(plan.walkawayCents)} (private)`, min_offer: wholeUsd(plan.minOfferCents) },
      net_at_15pct: { bin: formatUsd(pct(plan.binCents, NET_BPS)), floor: formatUsd(pct(plan.floorCents, NET_BPS)), walkaway: formatUsd(pct(plan.walkawayCents, NET_BPS)) },
      schedule: schedule.map((e) => (e.event === 'delist' || e.binCents === null
        ? { event: e.event, due_on: e.dueOn, status: e.status }
        : { event: e.event, due_on: e.dueOn, bin: wholeUsd(e.binCents), floor: wholeUsd(e.floorCents!), walkaway: wholeUsd(e.walkawayCents!), status: e.status })),
      afternic_row: 'cells' in a.row ? a.row.cells.join(',') : null,
      sell_plan_line: sellPlanLine(plan, schedule),
      warnings: plan.warnings,
    };
  });
}
```

Note on the spec example: the preview response in §10.6 has no `grade` key. This plan adds `"grade": null` for hybrid (`strong`/`weaker` for geo) so callers needn't infer it. The test above asserts it.

`src/app.ts`: `registerPricing(app, { db: deps.db, now: deps.now ?? Date.now });`

- [ ] **Step 4: Run tests**

Run: `npx vitest run && npx tsc --noEmit && npm run build`
Expected: all PASS.

- [ ] **Step 5: Commit**
```bash
git add src/ tests/
git commit -m "feat: GET /pricing/preview (plan, schedule, display, net, afternic_row, sell_plan_line) + PR-44 version-keyed vectors"
```

---

### Task 6 (Opus, not Sonnet): Gate report

- [ ] Full suite, typecheck and build; record the counts.
- [ ] Map spec IDs to tests: PR-1–PR-19, PR-30, PR-31, PR-35, PR-40–PR-44, plus the B-11/B-12/B-13/CAP-2 value updates.
- [ ] Final whole-change review; fix wave if needed.
- [ ] Spec sync after Dvir confirms P1–P8 (only where the spec is silent; listing-strategy §10 is Gavriel's text, so add small "Decided" notes, don't rewrite it).
- [ ] Report; push to `main` (check `origin/main` for new Gavriel commits first).

---

## Self-review notes

- **Spec coverage (§10):**
  - §10.1 settings → Tasks 1, 2, 4.
  - §10.2 rounding → Task 2.
  - §10.3 formula and minimums → Task 2.
  - §10.4 schedule rules → Task 3. Regeneration on a manual change, a hold, a sale or a `drop_date` move is **4b-2/4b-3**, because it needs DB plans.
  - §10.6 preview → Task 5.
  - §10.9 admin command → Task 4.
  - §10.10 data model → Task 1.
- **Deliberately not here:**
  - storing plans and schedules in the DB (4b-2);
  - V7/V8/V11/V12 request validation (4b-2);
  - exports, `changed_only`, uploads and the Sedo default (4b-3);
  - the price job (4b-3);
  - offers (4c);
  - PR-17's `/buy`/`/list`/import parity (4b-2/4d);
  - PR-20–PR-29 and PR-32–PR-34, PR-36–PR-39 (4b-2/4b-3/4d).
