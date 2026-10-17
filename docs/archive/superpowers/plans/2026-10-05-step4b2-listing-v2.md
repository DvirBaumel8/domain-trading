# Step 4b-2: Listing rules v2 in `/list` and `/buy`: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the v1 listing rules with the v2 rules from `listing-strategy.md` §5, built on the 4b-1 pricing core. Concretely:
- `/list` and `/buy` compute, validate, store and schedule every sell plan, covering:
  - V1–V12, including comps (V11) and the settings version (V12);
  - computed floor and walk-away, exceptions, overrides and lease-to-own;
  - `price_schedule` rows on the first listing, and regeneration on an approved change;
  - holds and replans.
- Close the 4a carry list: a per-domain lock around read → NS → save, ambiguous registrar NS errors, an ASCII-only `display_name`, and the v1 settings columns removed.

Gate G0/G1 for:
- LS-1–LS-20 and LG-1–LG-21;
- LH-1–LH-4;
- L-1–L-9, L-11, L-14 and L-15;
- B-28;
- PR-17 (parity for `/buy` and `/list`).

**Not in this step:** the daily price job and LH-5/PR-20–PR-29 (4b-3); exports v2 and `sedo_hybrid_as = make_offer` (4b-3); offers (4c); `/sold`, `import-domain`, the drop job and drop-date moves (4d).

**Architecture:**
- **`src/services/listing-v2.ts`** is the pure rules engine. It takes a request plus a context (category, grade, phase, settings, override, approval, dates) and returns a `ListingPlan` or a coded failure, in the exact §5 order. Hybrid and geo price math goes through `computePlan` (4b-1), so the preview, `/list` and `/buy` can't drift. `validateComps` (V11) and `checkSettingsVersion` (V12) sit beside it.
- **`src/services/plan-store.ts`** owns:
  - `withDomainLock` (a session advisory lock on one pooled connection, the same key space as `/buy`'s `pg_advisory_xact_lock(hashtext(domain))`);
  - `writePlan` (supersede the open rows, `buildSchedule`, insert `price_schedule`, stamp `plan_id`/`plan_audit_id`);
  - `historyRow` (the v2 `listing_history` shape).
- **`src/services/plan-view.ts`** renders plans and schedules for responses, with cents plus display strings. The preview reuses its schedule view.
- **`/list` and `/buy`** call the engine, then the store. The v1 `listing-rules.ts` and the v1 `settings` columns are deleted at the end.

**Tech Stack:** As before.

**Spec:**
- `docs/specs/listing-strategy.md` §1, §2, §4, §5 (V1–V12, warnings, history), §7, §10.3, §10.4 (schedule rules, regeneration, hold);
- `docs/specs/list.md` (behaviour 1–6, L-*);
- `docs/specs/buy.md` (request, check 3b, step 7.3, B-28);
- `docs/specs/test-plan.md` PR-17;
- CLAUDE.md founder rules 1, 2, 4 and 8.

## Global Constraints

- Everything in the earlier steps' Global Constraints still holds:
  - cents and display strings;
  - the error envelope;
  - idempotency and audit on POSTs;
  - no network in tests;
  - fake keys only;
  - ESM `.js` imports;
  - never edit a spec test to make it pass.
- **Pricing math only through `src/pricing/*`** (`computePlan`, `buildSchedule`). The engine and services never re-implement a formula or hard-code 65/48/20/750/500/100/499/399. Geo range and grade prices come from `PricingSettings`; `high_value_min_bin_cents` comes from `settings`.
- **§5 order, first failure wins:** V1 → V2 → V3/V4/V5 (mode rules; never overridable) → V6/V7 guards (overridable only under V8) → V8 → V9/V10 approval → V11 comps → V12 version.
  - **Statuses:** 422 for every rule failure, except 409 `SETTINGS_VERSION_CHANGED`.
  - **Overridable under V8:** the V6 and V7 guards and the LTO switch. V1–V5 (except LTO), V11 and V12 are never overridable.
- **Approval:** `approval_ref` is required for any change to mode, price, category, grade, exception, hold or replan (V10). An NS-only re-point needs none (LG-14). An override needs `override: true`, a non-empty `override_reason` **and** a valid `approval_ref` (V8). On `/buy`, the call's own `approval_ref` is the approval (already validated in check 3).
- **Hybrid:** the client never sends `min_offer`, unless it equals `min(hybrid_min_offer, walkaway)`; otherwise 422 `MIN_OFFER_FIXED`. `floor`/`walkaway` are computed unless `pricing_exception: true` comes with a non-empty `pricing_exception_reason` and approval.
- **The walk-away is never exported.** It's stored in `domains.walkaway_cents` and `listing_history.walkaway_cents` only. Responses may show it as `"$960 (private)"`.
- **Schedule rows** (§10.4):
  - **When created:** on the **first** accepted listing of a domain (`first_listed_at` was null). Anchor = the IDT date of now. All events.
  - **When regenerated:** on an accepted change to mode, price, category, grade or replan of an already-listed domain. Open (`planned`) rows → `superseded`, and new rows are computed from the **new** values with the **same anchor** (`first_listed_at` as an IDT date). Events due on or before today are not recreated (the `startAfter` rule).
  - **A hold change never regenerates.**
- **Settings version for a change** (decision Q2):
  - first listing, `replan: true`, or a domain with no `pricing_settings_version` → the **current** version;
  - any other manual change → the **plan's own** version (`domains.pricing_settings_version`). Existing plans keep their version (§10.1).
- **One per-domain lock** (`hashtext(domain)`, the same key `/buy` uses) is held across read → validate → set NS → save in `/list`, and across the listing save in `/buy` post-buy.

## Decisions taken in this plan that the spec doesn't spell out (Dvir to confirm)

| # | Decision | Why |
|---|---|---|
| Q1 | **Override plans** (non-geo plain `bin`, `offer`, or geo off the grade price) get **only a `delist` row**: no drops and no final push | Drops are pre-approved for the standard plan only. An override is already off-plan; scaling an offer-only listing has no BIN to drop. (This answers the open question from the 4b-1 report) |
| Q2 | A manual change keeps the plan's settings version; only `replan: true` (or a first listing) uses the current version | §10.1 "existing plans keep their version until a re-plan" |
| Q3 | On `/buy`, `pricing_exception` and `pricing_exception_reason` go **inside** `proposed_listing` (with `walkaway`) | buy.md's request has no top-level exception fields; the proposed listing is where the card's numbers live |
| Q4 | Regeneration doesn't recreate events already due (due on ≤ today). The new values are the approved current values, and future events chain from them | Otherwise the job would immediately re-apply a past M6 on top of the new price |
| Q5 | New error codes: `EXCEPTION_REASON_REQUIRED` (exception without a reason), `WALKAWAY_NOT_ALLOWED` (walk-away sent in `bin` (≠ BIN) or `offer` mode), `HOLD_REASON_REQUIRED`, `GRADE_NOT_GEO`, `REPLAN_NOTHING_LISTED`, and **503 `REGISTRAR_UNAVAILABLE`** (an ambiguous NS answer that the read-back can't confirm) | The spec lists none for these cases |
| Q6 | `pricing_evidence` is stored on **every** successful buy (not only with `auto_list`), in post-buy. A failure there is a warning; it never undoes the purchase | The comps belong to the buy approval, not to the listing |
| Q7 | `/list` accepts `price_grade` (geo only; a change needs `approval_ref`) | §4/V10 name grade changes; list.md's body didn't have the field |
| Q8 | `pricing_hold: true` needs a non-empty `pricing_hold_reason`; a hold change appends a `listing_history` row with the unchanged prices | LH-1 counts a hold as an accepted change |
| Q9 | A `delisted` domain can't be re-listed through `/list` (404 `NOT_IN_PORTFOLIO`, as today for sold/dropped) | list.md behaviour 1 allows only owned/listed; the delist is tied to `drop_date` |
| Q10 | `replan: true` re-computes from the stored BIN with the current settings. For hybrid it drops any earlier exception (the formula applies), unless the same call sends `pricing_exception` values | A replan is an explicit, approved recompute |

**Spec defects found while planning** (fixed in this step's tests; flagged for the spec sync):
- **B-28** sends `expected_settings_version: 1`, but the current version is 2, so V12 would refuse it. The test uses 2.
- **LS-12** "with override and bin 495 → ok": under v2 a hybrid BIN below $795 is `BIN_BELOW_FLOOR_MIN`. The test uses BIN 1995 for the OK case, plus `lto_max_months: 61` and a lease past `drop_date` for `LTO_INVALID`.
- **LG-1** "geo bin 299": the range check is allowed on manual changes (V6), so it's kept as written.

## Review Focus

1. **A price change on a listed domain after M6 was already applied:** the old open rows are superseded; the new rows start after today; there's no new M6; M18 chains from the new values (Q4). Test in Task 3.
2. **Hold then unhold:** no schedule rows change, and two history rows are written. Holding without a reason → 422; holding without approval → 422 `APPROVAL_REQUIRED` (L-15). Test in Task 3.
3. **Concurrency:** two concurrent `/list` calls on one domain with different BINs. The lock serialises them: both succeed in order, the final state equals the second call, and there are exactly two plans, with the first plan's rows superseded. Test in Task 4.
4. **An ambiguous NS error whose read-back shows the new set** → 200 `ns_status: "set"` + warning `NS_SET_AFTER_AMBIGUOUS`. With a read-back mismatch → 503 `REGISTRAR_UNAVAILABLE`, and the idempotency key is released (a retry with the same key runs again). Test in Task 4.
5. **`/buy` with a proposed listing that equals the card but would fail after the charge:** everything that could fail (V1–V12) is checked before the registrar is called (LG-16, 0 `register` calls). The post-buy save can't fail on validation, only on infrastructure (warning). Test in Task 5.

---

## File structure

```
src/pricing/plan.ts          (modify) PlanInput.mode?: 'hybrid' forces the hybrid path (geo override to hybrid)
src/pricing/schedule.ts      (modify) SchedulePlan input (category, mode, nullable prices); non-standard plans → delist only; startAfter
src/services/listing-v2.ts   validateListing (V1–V8), validateComps (V11), checkSettingsVersion (V12), CATEGORIES/isCategory
src/services/plan-store.ts   withDomainLock, writePlan, historyRow, newPlanId
src/services/plan-view.ts    planView, scheduleView (cents + display; walk-away marked private)
src/api/pricing.ts           (modify) schedule view from plan-view
src/services/list.ts         (rewrite) v2 flow under the lock; NS ambiguity; per-registrar API_ACCESS_DISABLED
src/api/list.ts              (modify) v2 body schema
src/services/buy.ts          (modify) 3b v2 checks; price_grade on the pending row; post-buy evidence + plan save under the lock
src/api/buy.ts               (modify) v2 body schema
src/services/export.ts       (modify) display_name re-checked (ASCII + case-only) at export
src/services/listing-rules.ts (delete, Task 6)
migrations/1760000000000_drop-v1-listing-settings.sql (Task 6)
tests/unit/listing-v2.test.ts, tests/unit/pricing-schedule.test.ts (extend), tests/api/plan-store.test.ts,
tests/api/list.test.ts (rewrite), tests/api/list-concurrency.test.ts, tests/api/buy-listing.test.ts,
tests/helpers/{buy,db,listing}.ts (modify), tests/unit/listing-rules.test.ts (delete, Task 6)
```

---

### Task 1: Rules engine v2 (pure) + calculator/schedule hooks

**Files:**
- Modify: `src/pricing/plan.ts`, `src/pricing/schedule.ts`, `tests/unit/pricing-schedule.test.ts`, `tests/unit/pricing-plan.test.ts`
- Create: `src/services/listing-v2.ts`, `tests/unit/listing-v2.test.ts`

**Interfaces:**
- Consumes: `computePlan`, `PlanInput`, `buildSchedule`, `addMonthsClamped`, `PricingSettings`, `dollarsToCents`, `Category`, `ListingMode`.
- Produces:
```ts
// src/pricing/plan.ts
export interface PlanInput { /* existing fields */ mode?: 'hybrid' }   // 'hybrid' on a geo category → hybrid math (geo override)

// src/pricing/schedule.ts
export interface SchedulePlan {
  category: Category; mode: ListingMode; grade: 'strong' | 'weaker' | null;
  binCents: Cents | null; floorCents: Cents | null; walkawayCents: Cents | null;
}
export function buildSchedule(input: { plan: SchedulePlan; anchor: string; dropDate: string; settings: PricingSettings; startAfter?: string }): ScheduleEvent[];
//   Each new path, and its test name in Step 1:
//   - geo, mode 'bin' → as before (geo_drop_m12 only when bin === geo_drops[0].from_cents)
//   - non-geo 'hybrid' → as before
//   - anything else (non-geo 'bin'/'offer', geo 'hybrid'/'offer') → [delist] only (Q1)
//   - startAfter: events with dueOn <= startAfter are omitted, not emitted and not applied to the chained values

// src/services/listing-v2.ts
export const CATEGORIES: readonly Category[];
export const isCategory: (v: unknown) => v is Category;
export interface ListingRequest {
  mode?: unknown; bin?: number | null; floor?: number | null; walkaway?: number | null; min_offer?: number | null;
  lto_max_months?: number | null; pricing_exception?: boolean | null; pricing_exception_reason?: string | null;
}
export interface ListingContext {
  category: Category | null; grade: 'strong' | 'weaker' | null;
  phase: 'buy' | 'change';            // buy/import: geo bin must be the grade price; change: geo_bin_min ≤ bin ≤ geo_bin_max
  settings: PricingSettings; highValueMinBinCents: number;
  override: boolean; overrideReason: string | null; approvalValid: boolean;
  today: string; dropDate: string | null;   // LTO must end before dropDate
}
export interface ListingPlan {
  mode: ListingMode; category: Category; grade: 'strong' | 'weaker' | null;
  binCents: number | null; floorCents: number | null; walkawayCents: number | null; minOfferCents: number;
  ltoMaxMonths: number | null; pricingSource: 'formula' | 'approved_exception'; settingsVersion: number;
  overrideUsed: boolean; warnings: string[];
  formula: { floorCents: number; walkawayCents: number } | null;   // hybrid: what the formula gives
}
export type Fail = { ok: false; status: 422 | 409; code: string; message: string; details?: Record<string, unknown> };
export type ListingResult = { ok: true; plan: ListingPlan } | Fail;
export function validateListing(req: ListingRequest, ctx: ListingContext): ListingResult;
export interface Comp { domain: string; price_usd: number; sold_on: string; venue: string; source_url: string }
export interface Evidence { comps?: unknown; rationale?: unknown }
export function validateComps(e: Evidence | null | undefined, s: PricingSettings, today: string):
  { ok: true; comps: Comp[]; rationale: string | null } | Fail;
export function checkSettingsVersion(expected: number | null | undefined, s: PricingSettings): Fail | null;
```

- [ ] **Step 1: Write the failing tests**

`tests/unit/pricing-schedule.test.ts`: add a `describe('SchedulePlan paths and startAfter (4b-2)')` with these cases:
```ts
const sp = (o: Partial<SchedulePlan>): SchedulePlan => ({ category: 'trend', mode: 'hybrid', grade: null, binCents: 199500, floorCents: 129500, walkawayCents: 96000, ...o });
it('Q1: non-geo bin override, offer, and geo hybrid override → delist only', () => {
  for (const p of [sp({ mode: 'bin', floorCents: 99900, walkawayCents: 99900, binCents: 99900 }), sp({ mode: 'offer', binCents: null, floorCents: null, walkawayCents: null }), sp({ category: 'geo', grade: 'strong' })]) {
    expect(buildSchedule({ plan: p, anchor: '2026-10-12', dropDate: '2028-10-04', settings: V2 }).map((e) => e.event)).toEqual(['delist']);
  }
});
it('geo bin off the grade price (manual 450) → delist only', () => {
  expect(buildSchedule({ plan: sp({ category: 'geo', mode: 'bin', grade: 'strong', binCents: 45000, floorCents: 45000, walkawayCents: 45000 }), anchor: '2026-10-12', dropDate: '2028-10-04', settings: V2 }).map((e) => e.event)).toEqual(['delist']);
});
it('Review Focus 1 / Q4: startAfter omits due events and chains future ones from the given values', () => {
  // new values 1795/1165/865 approved on 2027-05-01 (after M6 2027-04-12): M18 = one drop from the new values
  const ev = buildSchedule({ plan: sp({ binCents: 179500, floorCents: 116500, walkawayCents: 86500 }), anchor: '2026-10-12', dropDate: '2028-10-04', settings: V2, startAfter: '2027-05-01' });
  expect(ev.map((e) => [e.event, e.dueOn, e.binCents, e.floorCents, e.walkawayCents, e.status])).toEqual([
    ['drop2_m18', '2028-04-12', 139500, 93000, 69000, 'planned'],
    ['final_push', '2028-07-06', 99500, 93000, 69000, 'planned'],
    ['delist', '2028-09-27', null, null, null, 'planned'],
  ]);
});
it('startAfter after the final push and delist dates → empty list', () => {
  expect(buildSchedule({ plan: sp({}), anchor: '2026-10-12', dropDate: '2028-10-04', settings: V2, startAfter: '2028-09-30' })).toEqual([]);
});
```
The startAfter vector, worked out by hand from §10.2/§10.4 (a `/list` of formula 1795 gives walk-away 860, which yields the same 690 at M18, so Task 3 reuses this vector):
- M18 from 1795: `nice95(pct(179500, 8000)) = nice95(143600) = 139500`.
- Floor: `round5(pct(116500, 8000)) = round5(93200) = 93000`, which is ≥ 75000 and ≤ 139500.
- Walk-away: `round5(pct(86500, 8000)) = round5(69200) = 69000`, which is ≥ 50000 and ≤ 93000.
- Final push: `min(139500, max(ceil95(93000), 79500)) = min(139500, 99500) = 99500`.

`tests/unit/pricing-plan.test.ts`: add `it('mode hybrid on a geo category uses the hybrid formula (geo override path)', …)`. Input: `computePlan({ category: 'geo', mode: 'hybrid', binCents: 199500 }, V2)` → `{ mode: 'hybrid', floorCents: 129500, walkawayCents: 96000, grade: null }`.

`tests/unit/listing-v2.test.ts` (pure; uses `V2` from `tests/helpers/pricing.ts`):
```ts
import { describe, expect, it } from 'vitest';
import { checkSettingsVersion, validateComps, validateListing, type ListingContext, type ListingRequest } from '../../src/services/listing-v2.js';
import { V2 } from '../helpers/pricing.js';

const ctx = (o: Partial<ListingContext> = {}): ListingContext => ({
  category: 'trend', grade: null, phase: 'change', settings: V2, highValueMinBinCents: 250000,
  override: false, overrideReason: null, approvalValid: true, today: '2026-10-12', dropDate: '2028-10-04', ...o,
});
const v = (req: ListingRequest, o: Partial<ListingContext> = {}) => validateListing(req, ctx(o));
const code = (r: ReturnType<typeof validateListing>) => (r.ok ? 'OK' : r.code);
const plan = (r: ReturnType<typeof validateListing>) => { if (!r.ok) throw new Error(`${r.code}: ${r.message}`); return r.plan; };
const OV = { override: true, overrideReason: 'Dvir asked', approvalValid: true };
const geo = (grade: 'strong' | 'weaker' = 'weaker', o: Partial<ListingContext> = {}) => ({ category: 'geo' as const, grade, ...o });

describe('V1–V5 (never overridable)', () => {
  it('LS-1 mode auction → MODE_INVALID', () => expect(code(v({ mode: 'auction' }))).toBe('MODE_INVALID'));
  it('V2: no category → CATEGORY_REQUIRED; geo without grade → GEO_GRADE_REQUIRED', () => {
    expect(code(v({ mode: 'hybrid', bin: 1995 }, { category: null }))).toBe('CATEGORY_REQUIRED');
    expect(code(v({ mode: 'bin', bin: 399 }, { category: 'geo', grade: null }))).toBe('GEO_GRADE_REQUIRED');
  });
  it('LS-2 bin mode without bin → BIN_REQUIRED', () => expect(code(v({ mode: 'bin' }, geo()))).toBe('BIN_REQUIRED'));
  it('LS-3 geo bin 399 + floor 350 → BIN_MODE_NO_NEGOTIATION', () => expect(code(v({ mode: 'bin', bin: 399, floor: 350 }, geo()))).toBe('BIN_MODE_NO_NEGOTIATION'));
  it('LS-4 geo bin 399 → floor = min_offer = walkaway = 399', () => {
    expect(plan(v({ mode: 'bin', bin: 399 }, geo()))).toMatchObject({ mode: 'bin', binCents: 39900, floorCents: 39900, minOfferCents: 39900, walkawayCents: 39900, grade: 'weaker', pricingSource: 'formula', settingsVersion: 2 });
  });
  it('LS-5 bin + lto → LTO_NOT_ALLOWED', () => expect(code(v({ mode: 'bin', bin: 399, lto_max_months: 12 }, geo()))).toBe('LTO_NOT_ALLOWED'));
  it('LS-6–LS-9 offer mode (with override)', () => {
    expect(code(v({ mode: 'offer', bin: 2000, min_offer: 500 }, OV))).toBe('OFFER_MODE_HAS_BIN');
    expect(code(v({ mode: 'offer' }, OV))).toBe('MIN_OFFER_REQUIRED');
    expect(code(v({ mode: 'offer', min_offer: 10 }, OV))).toBe('MIN_OFFER_TOO_LOW');
    expect(code(v({ mode: 'offer', min_offer: 500, floor: 400 }, OV))).toBe('FLOOR_BELOW_MIN_OFFER');
    const p = plan(v({ mode: 'offer', min_offer: 500 }, OV));
    expect(p).toMatchObject({ mode: 'offer', binCents: null, floorCents: null, walkawayCents: null, minOfferCents: 50000, overrideUsed: true });
    expect(p.warnings).toContain('NO_BIN_LESS_EXPOSURE');
  });
  it('offer mode with walkaway → WALKAWAY_NOT_ALLOWED', () => expect(code(v({ mode: 'offer', min_offer: 500, walkaway: 450 }, OV))).toBe('WALKAWAY_NOT_ALLOWED'));
  it('LS-10 hybrid without bin → HYBRID_FIELDS_REQUIRED', () => expect(code(v({ mode: 'hybrid' }))).toBe('HYBRID_FIELDS_REQUIRED'));
  it('LS-11 exception floor 2100 / walkaway 1000 with floor 950 → HYBRID_PRICES_INVALID', () => {
    const ex = { pricing_exception: true, pricing_exception_reason: 'Dvir' };
    expect(code(v({ mode: 'hybrid', bin: 1995, floor: 2100, walkaway: 950, ...ex }))).toBe('HYBRID_PRICES_INVALID');
    expect(code(v({ mode: 'hybrid', bin: 1995, floor: 950, walkaway: 1000, ...ex }))).toBe('HYBRID_PRICES_INVALID');
  });
  it('LS-12 (v2-corrected): LTO without override → LTO_NOT_ALLOWED; with override 1995/12 → OK; 61 months or past drop_date → LTO_INVALID', () => {
    expect(code(v({ mode: 'hybrid', bin: 1995, lto_max_months: 12 }))).toBe('LTO_NOT_ALLOWED');
    expect(plan(v({ mode: 'hybrid', bin: 1995, lto_max_months: 12 }, OV))).toMatchObject({ ltoMaxMonths: 12, overrideUsed: true });
    expect(code(v({ mode: 'hybrid', bin: 1995, lto_max_months: 61 }, OV))).toBe('LTO_INVALID');
    expect(code(v({ mode: 'hybrid', bin: 1995, lto_max_months: 24 }, { ...OV, today: '2026-10-12', dropDate: '2028-10-04' }))).toBe('LTO_INVALID');
  });
  it('LS-13 hybrid 4995 → 3245 / 2400 / 100 + FLOOR_AUTO_ACCEPT', () => {
    const p = plan(v({ mode: 'hybrid', bin: 4995 }));
    expect(p).toMatchObject({ binCents: 499500, floorCents: 324500, walkawayCents: 240000, minOfferCents: 10000 });
    expect(p.warnings).toContain('FLOOR_AUTO_ACCEPT');
  });
  it('LS-15 min_offer 800 / 960 → MIN_OFFER_FIXED; 100 → OK', () => {
    expect(code(v({ mode: 'hybrid', bin: 1995, min_offer: 800 }))).toBe('MIN_OFFER_FIXED');
    expect(code(v({ mode: 'hybrid', bin: 1995, min_offer: 960 }))).toBe('MIN_OFFER_FIXED');
    expect(code(v({ mode: 'hybrid', bin: 1995, min_offer: 100 }))).toBe('OK');
  });
  it('LS-16 bin 1990 / 695 → BIN_NOT_NICE / BIN_BELOW_FLOOR_MIN', () => {
    expect(code(v({ mode: 'hybrid', bin: 1990 }))).toBe('BIN_NOT_NICE');
    expect(code(v({ mode: 'hybrid', bin: 695 }))).toBe('BIN_BELOW_FLOOR_MIN');
  });
  it('LS-17 floor 1200 without exception → PRICING_FORMULA_MISMATCH with computed cents', () => {
    const r = v({ mode: 'hybrid', bin: 1995, floor: 1200 });
    expect(r).toMatchObject({ ok: false, status: 422, code: 'PRICING_FORMULA_MISMATCH', details: { floor_cents: 129500, walkaway_cents: 96000, floor: '$1,295', walkaway: '$960' } });
  });
  it('LS-18 exception 1295/950 with reason + approval → approved_exception + PRICING_EXCEPTION, formula 960', () => {
    const p = plan(v({ mode: 'hybrid', bin: 1995, floor: 1295, walkaway: 950, pricing_exception: true, pricing_exception_reason: 'Dvir 00:39' }));
    expect(p).toMatchObject({ walkawayCents: 95000, pricingSource: 'approved_exception', formula: { floorCents: 129500, walkawayCents: 96000 } });
    expect(p.warnings).toEqual(expect.arrayContaining(['PRICING_EXCEPTION', 'FLOOR_AUTO_ACCEPT']));
  });
  it('exception without reason → EXCEPTION_REASON_REQUIRED; without valid approval → APPROVAL_REQUIRED', () => {
    expect(code(v({ mode: 'hybrid', bin: 1995, floor: 1295, walkaway: 950, pricing_exception: true }))).toBe('EXCEPTION_REASON_REQUIRED');
    expect(code(v({ mode: 'hybrid', bin: 1995, floor: 1295, walkaway: 950, pricing_exception: true, pricing_exception_reason: 'x' }, { approvalValid: false }))).toBe('APPROVAL_REQUIRED');
  });
  it('LS-19 / LS-20: exception floor 700 → FLOOR_BELOW_MIN; walkaway 450 (even with override) → WALKAWAY_BELOW_MIN', () => {
    const ex = { pricing_exception: true, pricing_exception_reason: 'x' };
    expect(code(v({ mode: 'hybrid', bin: 1995, floor: 700, walkaway: 600, ...ex }))).toBe('FLOOR_BELOW_MIN');
    expect(code(v({ mode: 'hybrid', bin: 1995, floor: 1295, walkaway: 450, ...ex }, OV))).toBe('WALKAWAY_BELOW_MIN');
  });
  it('LG-15: an override never bypasses V5 (floor > bin) → HYBRID_PRICES_INVALID', () => {
    expect(code(v({ mode: 'hybrid', bin: 1995, floor: 2100, walkaway: 950, pricing_exception: true, pricing_exception_reason: 'x' }, OV))).toBe('HYBRID_PRICES_INVALID');
  });
});

describe('V6/V7 guards + V8 override', () => {
  it('LG-1 / LG-2 geo manual change: 299 and 499 OK; 298 / 500 → GEO_BIN_OUT_OF_RANGE', () => {
    expect(code(v({ mode: 'bin', bin: 299 }, geo()))).toBe('OK');
    expect(code(v({ mode: 'bin', bin: 499 }, geo()))).toBe('OK');
    expect(code(v({ mode: 'bin', bin: 298 }, geo()))).toBe('GEO_BIN_OUT_OF_RANGE');
    expect(code(v({ mode: 'bin', bin: 500 }, geo()))).toBe('GEO_BIN_OUT_OF_RANGE');
  });
  it('geo at buy: bin must equal the grade price → GEO_BIN_NOT_GRADE_PRICE (LG-19); grade price OK', () => {
    expect(code(v({ mode: 'bin', bin: 399 }, geo('strong', { phase: 'buy' })))).toBe('GEO_BIN_NOT_GRADE_PRICE');
    expect(plan(v({ mode: 'bin', bin: 499 }, geo('strong', { phase: 'buy' })))).toMatchObject({ binCents: 49900, grade: 'strong' });
  });
  it('LG-3 geo offer / hybrid → GEO_MODE_NOT_ALLOWED', () => {
    expect(code(v({ mode: 'offer', min_offer: 300 }, geo()))).toBe('GEO_MODE_NOT_ALLOWED');
    expect(code(v({ mode: 'hybrid', bin: 1995 }, geo()))).toBe('GEO_MODE_NOT_ALLOWED');
  });
  it('LG-4 geo 650 with override → OK, overrideUsed; LG-5 override without reason / approval → OVERRIDE_NEEDS_APPROVAL', () => {
    expect(plan(v({ mode: 'bin', bin: 650 }, geo('weaker', OV)))).toMatchObject({ binCents: 65000, overrideUsed: true });
    expect(code(v({ mode: 'bin', bin: 650 }, geo('weaker', { override: true, overrideReason: null })))).toBe('OVERRIDE_NEEDS_APPROVAL');
    expect(code(v({ mode: 'bin', bin: 650 }, geo('weaker', { override: true, overrideReason: 'x', approvalValid: false })))).toBe('OVERRIDE_NEEDS_APPROVAL');
  });
  it('LG-6 / LG-7 trend bin 999 or 2500 without override → MODE_NOT_ALLOWED_FOR_CATEGORY', () => {
    expect(code(v({ mode: 'bin', bin: 999 }))).toBe('MODE_NOT_ALLOWED_FOR_CATEGORY');
    expect(code(v({ mode: 'bin', bin: 2500 }))).toBe('MODE_NOT_ALLOWED_FOR_CATEGORY');
  });
  it('LG-8 trend bin 999 with override → OK, HIGH_VALUE_LOW_BIN warning; 2500 → no such warning', () => {
    expect(plan(v({ mode: 'bin', bin: 999 }, OV)).warnings).toContain('HIGH_VALUE_LOW_BIN');
    expect(plan(v({ mode: 'bin', bin: 2500 }, OV)).warnings).not.toContain('HIGH_VALUE_LOW_BIN');
  });
  it('LG-10 trend hybrid 1995 → 1995/1295/960, formula, version 2', () => {
    expect(plan(v({ mode: 'hybrid', bin: 1995 }))).toMatchObject({ binCents: 199500, floorCents: 129500, walkawayCents: 96000, minOfferCents: 10000, pricingSource: 'formula', settingsVersion: 2, overrideUsed: false });
  });
  it('geo hybrid with override → hybrid math', () => {
    expect(plan(v({ mode: 'hybrid', bin: 1995 }, geo('strong', OV)))).toMatchObject({ mode: 'hybrid', floorCents: 129500, grade: 'strong', overrideUsed: true });
  });
  it('CATEGORY_OTHER and BIN_OVER_FAST_TRANSFER_MAX pass through', () => {
    expect(plan(v({ mode: 'hybrid', bin: 1995 }, { category: 'other' })).warnings).toContain('CATEGORY_OTHER');
    expect(plan(v({ mode: 'hybrid', bin: 100095 })).warnings).toContain('BIN_OVER_FAST_TRANSFER_MAX');
  });
  it('non-integer cents / bad amounts → LISTING_PRICE_INVALID', () => {
    expect(code(v({ mode: 'hybrid', bin: 1995.555 }))).toBe('LISTING_PRICE_INVALID');
    expect(code(v({ mode: 'hybrid', bin: -5 }))).toBe('LISTING_PRICE_INVALID');
  });
});

describe('V11 comps / V12 version', () => {
  const c = (o: object = {}) => ({ domain: 'compa.com', price_usd: 1500, sold_on: '2026-09-01', venue: 'NameBio', source_url: 'https://namebio.com/compa.com', ...o });
  const vc = (e: unknown) => validateComps(e as never, V2, '2026-10-12');
  it('LG-20: 0/1 comp → COMPS_REQUIRED; 4 → COMPS_INVALID; missing source_url / http / future sold_on / price 0 → COMPS_INVALID', () => {
    expect(vc(null)).toMatchObject({ ok: false, code: 'COMPS_REQUIRED' });
    expect(vc({ comps: [c()] })).toMatchObject({ ok: false, code: 'COMPS_REQUIRED' });
    expect(vc({ comps: [c(), c(), c(), c()] })).toMatchObject({ ok: false, code: 'COMPS_INVALID' });
    expect(vc({ comps: [c(), c({ source_url: undefined })] })).toMatchObject({ ok: false, code: 'COMPS_INVALID' });
    expect(vc({ comps: [c(), c({ source_url: 'http://x.com' })] })).toMatchObject({ ok: false, code: 'COMPS_INVALID' });
    expect(vc({ comps: [c(), c({ sold_on: '2026-10-13' })] })).toMatchObject({ ok: false, code: 'COMPS_INVALID' });
    expect(vc({ comps: [c(), c({ price_usd: 0 })] })).toMatchObject({ ok: false, code: 'COMPS_INVALID' });
    expect(vc({ comps: [c(), c({ sold_on: '2026-02-30' })] })).toMatchObject({ ok: false, code: 'COMPS_INVALID' });
  });
  it('2 or 3 valid comps → ok, rationale kept; extra keys rejected', () => {
    expect(vc({ comps: [c(), c()], rationale: 'two trend comps' })).toMatchObject({ ok: true, rationale: 'two trend comps' });
    expect(vc({ comps: [c(), c(), c()] })).toMatchObject({ ok: true, rationale: null });
    expect(vc({ comps: [c(), c({ extra: 1 })] })).toMatchObject({ ok: false, code: 'COMPS_INVALID' });
  });
  it('LG-21: expected version current − 1 → 409 SETTINGS_VERSION_CHANGED; equal or absent → null', () => {
    expect(checkSettingsVersion(1, V2)).toMatchObject({ ok: false, status: 409, code: 'SETTINGS_VERSION_CHANGED', details: { current_version: 2 } });
    expect(checkSettingsVersion(2, V2)).toBeNull();
    expect(checkSettingsVersion(undefined, V2)).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/unit/listing-v2.test.ts tests/unit/pricing-schedule.test.ts tests/unit/pricing-plan.test.ts`
Expected: FAIL (the module is missing; the new schedule and plan cases fail).

- [ ] **Step 3: Implement**

`src/pricing/plan.ts`: add `mode?: 'hybrid'` to `PlanInput`. In `computePlan`, take the geo branch only when `input.category === 'geo' && input.mode !== 'hybrid'`. On the hybrid path, set the result's `grade` to `input.category === 'geo' ? (input.grade ?? null) : null`, so a geo name overridden to hybrid keeps its grade.

`src/pricing/schedule.ts`:
- Replace the input type with `SchedulePlan` (import `Category` and `ListingMode` as types from `../db/types.js`).
- Add `startAfter?: string`.
- Branching:
```ts
  const standardGeo = plan.category === 'geo' && plan.mode === 'bin';
  const standardHybrid = plan.category !== 'geo' && plan.mode === 'hybrid';
  if (!standardGeo && !standardHybrid) return keep([ev('delist', delistOn, null, 'planned')]);
```
  where `keep = (list) => startAfter ? list.filter((e) => e.dueOn > startAfter) : list`.
- In the hybrid loop, skip (`return` without applying) a drop whose `due <= startAfter`.
- In the geo branch, omit the M12 row if `due <= startAfter`.
- Omit `final_push` and `delist` when they are `<= startAfter`.
- The hybrid branch needs non-null prices: `binCents!` etc. are safe because a standard hybrid always has them. Assert with `if (plan.binCents === null || …) throw new Error('hybrid plan without prices')`.
- No `/` and no regex literals (PR-10).

`src/services/listing-v2.ts`:
```ts
import type { Category, ListingMode } from '../db/types.js';
import { dollarsToCents, formatUsd } from '../money.js';
import { computePlan } from '../pricing/plan.js';
import { addMonthsClamped } from '../pricing/schedule.js';
import type { PricingSettings } from '../pricing/settings.js';

export const CATEGORIES: readonly Category[] = ['geo', 'trend', 'b2b', 'collision', 'regulation', 'buzzword', 'other'];
export const isCategory = (v: unknown): v is Category => typeof v === 'string' && (CATEGORIES as readonly string[]).includes(v);
const MODES: readonly ListingMode[] = ['bin', 'offer', 'hybrid'];
const MIN_OFFER_FLOOR = 2000;          // $20: Afternic's minimum (A3), not a pricing setting
const LTO_BIN_MIN = 49_500;            // $495: Afternic LTO rule
const LTO_BIN_MAX = 500_000_000;       // $5,000,000: Afternic LTO rule
const DATE = /^\d{4}-\d{2}-\d{2}$/;

// …interfaces exactly as in **Interfaces** above…

const fail = (code: string, message: string, details?: Record<string, unknown>, status: 422 | 409 = 422): Fail =>
  ({ ok: false, status, code, message, ...(details ? { details } : {}) });

export function validateListing(req: ListingRequest, ctx: ListingContext): ListingResult {
  // V1
  if (typeof req.mode !== 'string' || !(MODES as readonly string[]).includes(req.mode)) return fail('MODE_INVALID', 'mode must be bin, offer or hybrid');
  const mode = req.mode as ListingMode;
  // V2
  if (!ctx.category) return fail('CATEGORY_REQUIRED', 'The domain needs a category');
  if (ctx.category === 'geo' && ctx.grade !== 'strong' && ctx.grade !== 'weaker') return fail('GEO_GRADE_REQUIRED', 'Geo names need price_grade strong or weaker');

  let bin: number | null, floor: number | null, walk: number | null, min: number | null;
  try {
    const c = (x: number | null | undefined) => (x === null || x === undefined ? null : dollarsToCents(x));
    [bin, floor, walk, min] = [c(req.bin), c(req.floor), c(req.walkaway), c(req.min_offer)];
  } catch {
    return fail('LISTING_PRICE_INVALID', 'Prices must be positive USD amounts with at most 2 decimals');
  }
  const lto = req.lto_max_months ?? null;
  const exception = req.pricing_exception === true;
  const s = ctx.settings;
  const warnings: string[] = [];
  const guards: { code: string; message: string }[] = [];
  let out: Omit<ListingPlan, 'overrideUsed' | 'warnings'>;

  if (mode === 'bin') {
    // V3
    if (bin === null) return fail('BIN_REQUIRED', 'bin mode needs a bin price');
    if ((floor !== null && floor !== bin) || (min !== null && min !== bin) || exception) {
      return fail('BIN_MODE_NO_NEGOTIATION', 'bin mode: floor, walkaway and min_offer must be empty or equal to bin');
    }
    if (walk !== null && walk !== bin) return fail('WALKAWAY_NOT_ALLOWED', 'bin mode: walkaway must be empty or equal to bin');
    if (lto !== null) return fail('LTO_NOT_ALLOWED', 'Lease-to-own is only allowed in hybrid mode');
    if (bin < MIN_OFFER_FLOOR) return fail('MIN_OFFER_TOO_LOW', 'bin mode needs a BIN of at least $20');
    out = { mode, category: ctx.category, grade: ctx.category === 'geo' ? ctx.grade : null, binCents: bin, floorCents: bin, walkawayCents: bin,
      minOfferCents: bin, ltoMaxMonths: null, pricingSource: 'formula', settingsVersion: s.version, formula: null };
    // V6 / V7
    if (ctx.category === 'geo') {
      if (ctx.phase === 'buy') {
        const gradePrice = ctx.grade === 'strong' ? s.geoBinStrongCents : s.geoBinWeakerCents;
        if (bin !== gradePrice) guards.push({ code: 'GEO_BIN_NOT_GRADE_PRICE', message: 'At buy, a geo BIN must be the grade price' });
      } else if (bin < s.geoBinMinCents || bin > s.geoBinMaxCents) {
        guards.push({ code: 'GEO_BIN_OUT_OF_RANGE', message: 'A geo BIN must be within the configured range' });
      }
    } else {
      guards.push({ code: 'MODE_NOT_ALLOWED_FOR_CATEGORY', message: 'Non-geo names are hybrid; plain bin needs an override' });
      if (bin < ctx.highValueMinBinCents) warnings.push('HIGH_VALUE_LOW_BIN');
    }
  } else if (mode === 'offer') {
    // V4
    if (bin !== null) return fail('OFFER_MODE_HAS_BIN', 'offer mode has no bin price');
    if (min === null) return fail('MIN_OFFER_REQUIRED', 'offer mode needs min_offer');
    if (min < MIN_OFFER_FLOOR) return fail('MIN_OFFER_TOO_LOW', 'min_offer must be at least $20');
    if (floor !== null && floor < min) return fail('FLOOR_BELOW_MIN_OFFER', 'floor must be ≥ min_offer');
    if (walk !== null || exception) return fail('WALKAWAY_NOT_ALLOWED', 'offer mode has no walk-away or pricing exception');
    if (lto !== null) return fail('LTO_NOT_ALLOWED', 'Lease-to-own is only allowed in hybrid mode');
    warnings.push('NO_BIN_LESS_EXPOSURE');
    if (floor !== null) warnings.push('FLOOR_AUTO_ACCEPT');
    out = { mode, category: ctx.category, grade: ctx.category === 'geo' ? ctx.grade : null, binCents: null, floorCents: floor, walkawayCents: null,
      minOfferCents: min, ltoMaxMonths: null, pricingSource: 'formula', settingsVersion: s.version, formula: null };
    guards.push(ctx.category === 'geo'
      ? { code: 'GEO_MODE_NOT_ALLOWED', message: 'Geo names are strict Buy It Now' }
      : { code: 'MODE_NOT_ALLOWED_FOR_CATEGORY', message: 'offer mode needs an override' });
  } else {
    // V5
    if (exception && !req.pricing_exception_reason?.trim()) return fail('EXCEPTION_REASON_REQUIRED', 'A pricing exception needs pricing_exception_reason');
    if (exception && !ctx.approvalValid) return fail('APPROVAL_REQUIRED', "A pricing exception needs a valid approval_ref (Dvir's words)");
    const r = computePlan({ category: ctx.category, mode: 'hybrid', grade: ctx.grade, binCents: bin, floorCents: floor, walkawayCents: walk, exception }, s);
    if (!r.ok) {
      const d = r.details ?? {};
      const display = Object.fromEntries(Object.entries(d).filter(([k]) => k.endsWith('_cents') && typeof d[k] === 'number')
        .map(([k, val]) => [k.slice(0, -'_cents'.length), wholeDollars(val as number)]));
      return fail(r.code, r.message, { ...d, ...display });
    }
    const p = r.plan;
    if (min !== null && min !== p.minOfferCents) return fail('MIN_OFFER_FIXED', 'min_offer is set by the server', { min_offer_cents: p.minOfferCents, min_offer: wholeDollars(p.minOfferCents) });
    if (lto !== null) {
      if (!Number.isInteger(lto) || lto < 2 || lto > 60 || p.binCents < LTO_BIN_MIN || p.binCents > LTO_BIN_MAX
        || (ctx.dropDate !== null && addMonthsClamped(ctx.today, lto) >= ctx.dropDate)) {
        return fail('LTO_INVALID', 'Lease-to-own needs 2–60 months, a BIN of $495–$5,000,000, and must end before drop_date');
      }
      if (!s.publicLto) guards.push({ code: 'LTO_NOT_ALLOWED', message: 'Public lease-to-own is off; it needs an override' });
    }
    warnings.push(...p.warnings);
    out = { mode, category: ctx.category, grade: p.grade, binCents: p.binCents, floorCents: p.floorCents, walkawayCents: p.walkawayCents,
      minOfferCents: p.minOfferCents, ltoMaxMonths: lto, pricingSource: p.pricingSource, settingsVersion: p.settingsVersion, formula: p.formula };
    if (ctx.category === 'geo') guards.unshift({ code: 'GEO_MODE_NOT_ALLOWED', message: 'Geo names are strict Buy It Now' });
  }

  // V8
  let overrideUsed = false;
  if (guards.length > 0) {
    if (!ctx.override) return fail(guards[0]!.code, guards[0]!.message);
    if (!ctx.overrideReason?.trim() || !ctx.approvalValid) {
      return fail('OVERRIDE_NEEDS_APPROVAL', 'An override needs a reason and a valid approval_ref that names the domain');
    }
    overrideUsed = true;
  }
  if (!overrideUsed) {
    const i = warnings.indexOf('HIGH_VALUE_LOW_BIN');
    if (i >= 0) warnings.splice(i, 1);
  }
  if (ctx.category === 'other' && !warnings.includes('CATEGORY_OTHER')) warnings.push('CATEGORY_OTHER');
  return { ok: true, plan: { ...out, overrideUsed, warnings } };
}

function wholeDollars(c: number): string {
  const s = formatUsd(c);
  return s.endsWith('.00') ? s.slice(0, -3) : s;
}
```
Write `validateComps` with zod (`import { z } from 'zod'`):
```ts
const Comp = z.object({
  domain: z.string().trim().min(3).max(253),
  price_usd: z.number().positive().refine((n) => Number.isFinite(n) && Math.round(n * 100) === n * 100, 'at most 2 decimals'),
  sold_on: z.string().regex(DATE),
  venue: z.string().trim().min(1).max(100),
  source_url: z.string().url().refine((u) => u.startsWith('https://'), 'https only'),
}).strict();

export function validateComps(e: Evidence | null | undefined, s: PricingSettings, today: string) {
  const list = e && Array.isArray(e.comps) ? e.comps : [];
  if (list.length < s.compsMin) return fail('COMPS_REQUIRED', `Every buy needs ${s.compsMin}–${s.compsMax} comparable sales`, { comps_min: s.compsMin, comps_max: s.compsMax });
  if (list.length > s.compsMax) return fail('COMPS_INVALID', `At most ${s.compsMax} comparable sales`, { comps_max: s.compsMax });
  const comps: Comp[] = [];
  for (const [i, raw] of list.entries()) {
    const r = Comp.safeParse(raw);
    if (!r.success) return fail('COMPS_INVALID', `comps[${i}] is invalid`, { index: i, issues: r.error.issues.map((x) => x.message) });
    const t = new Date(`${r.data.sold_on}T00:00:00Z`);
    if (Number.isNaN(t.getTime()) || t.toISOString().slice(0, 10) !== r.data.sold_on) return fail('COMPS_INVALID', `comps[${i}].sold_on is not a real date`, { index: i });
    if (r.data.sold_on > today) return fail('COMPS_INVALID', `comps[${i}].sold_on is in the future`, { index: i });
    comps.push(r.data);
  }
  const rationale = e && typeof e.rationale === 'string' && e.rationale.trim() ? e.rationale.trim() : null;
  if (e && e.rationale !== undefined && e.rationale !== null && typeof e.rationale !== 'string') return fail('COMPS_INVALID', 'rationale must be text');
  return { ok: true as const, comps, rationale };
}

export function checkSettingsVersion(expected: number | null | undefined, s: PricingSettings): Fail | null {
  if (expected === undefined || expected === null || expected === s.version) return null;
  return fail('SETTINGS_VERSION_CHANGED', 'Pricing settings changed since the preview; re-run GET /pricing/preview and re-ask Dvir',
    { expected_version: expected, current_version: s.version }, 409);
}
```
The `fail` helper's return type is `Fail`; `validateComps` returns `{ ok: true; comps; rationale } | Fail`.

**Order note (§5):** inside one mode the checks above follow the V3/V4/V5 code lists. Guards come after. Only one guard (the first) is reported when no override is given.

- [ ] **Step 4: Run tests**

Run: `npx vitest run && npx tsc --noEmit`
Expected: all PASS. The old `listing-rules.ts` is untouched and still used by `/list` and `/buy`.

- [ ] **Step 5: Commit**
```bash
git add src/ tests/
git commit -m "feat: listing rules v2 engine (V1–V8 on computePlan, V11 comps, V12 version); schedule paths for override plans + startAfter"
```

---

### Task 2: Plan store, lock, views (DB-backed)

**Files:**
- Create: `src/services/plan-store.ts`, `src/services/plan-view.ts`, `tests/api/plan-store.test.ts`
- Modify: `src/api/pricing.ts` (use `scheduleView`), `tests/helpers/db.ts` (`insertOwnedDomain` default `price_grade: 'weaker'`, so geo fixtures are v2-valid)

**Interfaces:**
- Consumes: `ListingPlan`, `buildSchedule`, `ScheduleEvent`, `PricingSettings`, `jerusalemDate`, `formatUsd`, `sellPlanLine`, `wholeUsd`.
- Produces:
```ts
// plan-store.ts
export function newPlanId(): string;                                    // 'pl_' + randomUUID()
export async function withDomainLock<T>(db: Kysely<Database>, domain: string, fn: (conn: Kysely<Database>) => Promise<T>): Promise<T>;
export async function writePlan(trx: Transaction<Database> | Kysely<Database>, o: {
  domainId: number; plan: ListingPlan; anchor: string; dropDate: string; settings: PricingSettings;
  planAuditId: string; startAfter?: string; now: Date;
}): Promise<{ planId: string; events: ScheduleEvent[] }>;
export function historyRow(o: {
  domainId: number; source: 'buy' | 'list'; plan: ListingPlan | null; category: Category | null; grade: 'strong' | 'weaker' | null;
  lander: string | null; override: boolean; overrideReason: string | null;
  approvalText: string | null; approvalAt: Date | null; auditId: string; planAuditId: string | null;
}): Insertable<ListingHistoryTable>;
export function domainPlanColumns(plan: ListingPlan): Updateable<DomainsTable>;   // mode, prices, lto, grade, source, version
// plan-view.ts
export function scheduleView(events: { event: string; dueOn: string; binCents: number | null; floorCents: number | null; walkawayCents: number | null; status: string }[]): object[];
export function planView(plan: ListingPlan, events?: ScheduleEvent[]): object;
```

`writePlan` behaviour:
1. `UPDATE price_schedule SET status='superseded', updated_at=now WHERE domain_id=? AND status='planned'`.
2. `events = buildSchedule({ plan, anchor, dropDate, settings, startAfter })`.
3. Insert one row per event: `plan_id`, `event`, `due_on`, prices, `settings_version = plan.settingsVersion`, `status = event.status`.
4. `UPDATE domains SET plan_id, plan_audit_id = planAuditId`.
5. Return `{ planId, events }`.

`settings` must be the version the plan was computed with; the caller passes it.

`withDomainLock`: `db.connection().execute(async (conn) => { await sql\`select pg_advisory_lock(hashtext(${domain}))\`.execute(conn); try { return await fn(conn); } finally { await sql\`select pg_advisory_unlock(hashtext(${domain}))\`.execute(conn); } })`.
- Kysely 0.29 allows `conn.transaction()` on a connection-scoped instance. **Verify this in a test** (below).
- Same key as `/buy`'s `pg_advisory_xact_lock(hashtext(domain))`, so a `/list` and a `/buy` reservation on one name exclude each other.

`planView(plan, events)` returns:
```json
{ "mode":"hybrid", "category":"trend", "price_grade":null,
  "bin_cents":199500, "bin":"$1,995", "floor_cents":129500, "floor":"$1,295",
  "walkaway_cents":96000, "walkaway":"$960 (private)", "min_offer_cents":10000, "min_offer":"$100",
  "lto_max_months":null, "pricing_source":"formula", "settings_version":2, "override":false,
  "schedule":[ …scheduleView… ], "sell_plan_line":"…" }
```
- Null prices show as `null` in both the `_cents` and the display key.
- `sell_plan_line` is present only for standard plans: geo `bin`, or non-geo `hybrid`. It comes from `sellPlanLine`, which needs a `Plan`; build one from the `ListingPlan` fields. Otherwise it is `null`.
- `scheduleView` is exactly the preview's current mapping:
  - priced events: `{event, due_on, bin, floor, walkaway, status}` with whole-dollar strings;
  - delist, superseded or null prices: `{event, due_on, status}`.

The preview switches to it with no change in output (its tests must still pass unchanged).

- [ ] **Step 1: Write the failing tests** — `tests/api/plan-store.test.ts`:
  - **writePlan on an owned domain** (insert with `insertOwnedDomain`; build the plan with `validateListing({mode:'hybrid', bin:1995}, …)` using `currentSettings`): anchor `2026-10-12`, dropDate `2028-10-04` → 4 rows equal to PR-12 (event, due_on, cents, status `planned`, `settings_version` 2). `domains.plan_id` = the returned id and starts with `pl_`. `plan_audit_id` is set.
  - **writePlan a second time** with new values and `startAfter: '2027-05-01'`: the first plan's 4 rows → `superseded`; the new rows are exactly the Task 1 startAfter vector; `domains.plan_id` changed.
  - **Non-planned rows are not superseded:** set one first-plan row to `applied` by hand before the second write; it stays `applied`.
  - **withDomainLock serialises:** start two `withDomainLock(db, 'x.com', …)` calls. The first sleeps 200 ms (`await new Promise((r) => setTimeout(r, 200))`) and records `start1`/`end1`; the second records `start2`. Assert `start2 >= end1`.
  - **withDomainLock + a transaction inside it** commits.
  - **A different domain isn't blocked:** `start2 < end1` for `'y.com'`.
  - **A lock held via `withDomainLock` blocks a `pg_advisory_xact_lock(hashtext('x.com'))` in another transaction** until release (proves the same key as `/buy`).
  - **historyRow** gives a row the DB accepts (insert it) with `walkaway_cents`, `pricing_source`, `pricing_settings_version`, `price_grade`, `plan_audit_id`.
  - **planView** for hybrid 1995: matches the JSON above (with schedule from PR-12). For offer mode (min 500): `bin` null and `sell_plan_line` null.
- [ ] **Step 2: Run to verify failure.**
- [ ] **Step 3: Implement** as specified. Update `src/api/pricing.ts` to use `scheduleView`. Make the `insertOwnedDomain` default change.
- [ ] **Step 4: Run** `npx vitest run && npx tsc --noEmit`. Expected: all PASS (preview tests unchanged).
- [ ] **Step 5: Commit** `feat: plan store (writePlan with supersede, per-domain session lock, v2 history row) and plan/schedule views`

---

### Task 3: `/list` pricing v2 (validation, save, schedule, hold, replan, dry run)

**Files:**
- Modify: `src/services/list.ts`, `src/api/list.ts`, `tests/api/list.test.ts` (rewrite the pricing tests; keep the L-1–L-4, L-6–L-9, L-11 and L-13 tests, with assertions updated to the new `listing` view shape)
- Modify: `tests/helpers/listing.ts` (`listedDomain` default: hybrid trend 1995/1295/960/100, `price_grade` null, `pricing_source` 'formula', `pricing_settings_version` 2, `first_listed_at` '2026-10-12T09:00:00Z')

**Interfaces:**
- Consumes: `validateListing`, `isCategory`, `currentSettings`, `settingsByVersion`, `writePlan`, `historyRow`, `domainPlanColumns`, `planView`, `buildSchedule`, `jerusalemDate`, `checkApproval`.
- `ListBody` (API schema, `.strict()`) adds:
  - `walkaway: number | null`
  - `pricing_exception: boolean | null`, `pricing_exception_reason: string | null`
  - `replan: boolean`
  - `pricing_hold: boolean | null`, `pricing_hold_reason: string | null`
  - `price_grade: 'strong' | 'weaker' | null`
  
  The existing fields stay. Unknown fields → 400 VALIDATION_ERROR (as now; LS-14, LG-12).

**Behaviour** (replaces the price/category part of `ListService.list`; the lander/NS part stays for Task 4 to harden):
1. Load the row. Status must be `owned` or `listed`, else 404 (Q9: `delisted` → 404).
2. **Classify the request:**
   - `priceChange` = any of `mode`, `bin`, `floor`, `walkaway`, `min_offer`, `lto_max_months` or `pricing_exception` is non-null;
   - `categoryChange` = `category` non-null and ≠ `row.category`;
   - `gradeChange` = `price_grade` non-null and ≠ `row.price_grade`;
   - `holdChange` = `pricing_hold` non-null and ≠ `row.pricing_hold`;
   - `replan` = `body.replan === true`;
   - `listingChange = priceChange || categoryChange || gradeChange || replan`;
   - `changing = listingChange || holdChange`.
3. **Field checks:**
   - `price_grade` on a non-geo category (the resulting category) → 422 `GRADE_NOT_GEO`.
   - `pricing_hold: true` without a reason → 422 `HOLD_REASON_REQUIRED`.
   - `replan` on a domain with no `listing_mode` and no `priceChange` → 422 `REPLAN_NOTHING_LISTED`.
   - Unknown category → 422 `CATEGORY_REQUIRED`.
4. **Settings:** `useCurrent = replan || row.pricing_settings_version === null || row.first_listed_at === null`. Then `s = useCurrent ? currentSettings(db, now) : settingsByVersion(db, row.pricing_settings_version)`, falling back to current if that is null.
5. **The request fed to the engine:**
   - `priceChange` → the body's price fields.
   - Else, if `listingChange` and the row has a mode → the current values re-validated:
     - hybrid: `{mode, bin}` plus, when the row's `pricing_source` is `approved_exception` and **not** `replan`, `{floor, walkaway, pricing_exception: true, pricing_exception_reason: 'carried from the approved plan'}`;
     - bin: `{mode, bin}`;
     - offer: `{mode, min_offer, floor}`.
   - Otherwise there is no engine call.
   - **Context:**
     - `category` = new or current; `grade` = new or current;
     - `phase: 'change'`, `settings: s`, `highValueMinBinCents` from `settings`;
     - `override`, `overrideReason`, `approvalValid` (from `checkApproval`);
     - `today = jerusalemDate(now)`, `dropDate = row.drop_date`.
6. **Relabel guard (kept from 4a):** any non-geo → `geo` change needs override + reason + valid approval, else `OVERRIDE_NEEDS_APPROVAL`. The engine's guards then apply too.
7. **V9/V10:** an invalid `approval_ref` → its code. `changing` without `approval_ref` → 422 `APPROVAL_REQUIRED`. An NS-only call needs none.
8. **`display_name`:** unchanged here; Task 4 hardens it.
9. **Dry run:** return `{ dry_run: true, valid: true, domain, category, listing: planView(plan, previewEvents), lander, ns, preview: { afternic, sedo }, warnings }`.
   - `previewEvents = buildSchedule(...)` with the same anchor/startAfter rules as step 11.
   - No writes beyond the audit row (LH-4).
10. **NS:** as today (Task 4 replaces it).
11. **Save** (one transaction, existing FOR UPDATE re-check kept):
    - `listingChange` with a plan → `UPDATE domains SET ...domainPlanColumns(plan)`, plus:
      - `status='listed'`;
      - `category`, and `price_grade` (geo only; null for non-geo);
      - `export_pending_since = coalesce(export_pending_since, now)`;
      - `first_listed_at = coalesce(first_listed_at, now)`.
    - Then `writePlan`:
      - **first listing** (`row.first_listed_at === null`): `anchor = jerusalemDate(now)`, no `startAfter`;
      - **otherwise:** `anchor = jerusalemDate(row.first_listed_at)`, `startAfter = jerusalemDate(now)`.
      - Pass `planAuditId = ctx.auditId` and `dropDate = row.drop_date`.
    - `holdChange` → `pricing_hold`, and `pricing_hold_reason` (null when false). No `writePlan`.
    - `display_name` change → `export_pending_since = coalesce(export_pending_since, now)`.
    - **One `listing_history` row** per accepted call where `changing || lander changed` (as 4a).
      - Use `historyRow` with `source 'list'` and the plan (or the current values for a hold- or lander-only call).
      - `plan_audit_id` = this call's audit id when a plan was written, else `row.plan_audit_id`.
12. **Response** gains:
    - `listing: planView(plan or current values, current planned+applied rows of the current plan_id)`;
    - `pricing_hold`;
    - `warnings` (engine warnings + `FLOOR_AUTO_ACCEPT` etc.).

    The `presentListing` import is removed from `list.ts`.

- [ ] **Step 1: Write the failing tests** (`tests/api/list.test.ts`). Each test is one `it`, with fakes and helpers as in the current file. The setup inserts a trend owned domain with `insertOwnedDomain(db, { domain: D, category: 'trend', price_grade: null })` unless the test says geo.
  - **L-14:** first `/list` hybrid 1995 + approval on an owned trend domain, `now` fixed at `2026-10-12T09:00:00Z` via `makeApp({ now })`. Expect:
    - 200, with `listing` = 1995/1295/960/100, formula, v2;
    - DB: `first_listed_at` = now and `export_pending_since` set;
    - 4 `price_schedule` rows equal to PR-12 (dates from 2026-10-12, drop 2028-10-04);
    - `domains.plan_audit_id` = the audit id of the call (read it from `audit_log`).
  - **LS-18 via /list:** exception 1295/950 with reason + approval → `pricing_source` `approved_exception`; DB `walkaway_cents` 95000; schedule rows = PR-11; `afternic` export unaffected (950 nowhere in `GET /export/afternic.csv`).
  - **LG-13:** a price change without `approval_ref` → 422 `APPROVAL_REQUIRED`, 0 history rows, 0 schedule rows, 1 audit row.
  - **LG-14:** an NS-only call without approval → 200.
  - **LG-11:** trend → geo relabel without override → 422 `OVERRIDE_NEEDS_APPROVAL`.
  - **LG-12:** `floor_bps` in the body → 400 (strict schema); the settings are unchanged.
  - **L-15 / Review Focus 2:** `pricing_hold: true` without approval → 422 `APPROVAL_REQUIRED`. Without a reason → 422 `HOLD_REASON_REQUIRED`. With both → 200, `pricing_hold` true, 1 new history row with unchanged prices, the schedule rows unchanged (same ids and status `planned`). Then `pricing_hold: false` + approval → 200, another history row, the schedule still unchanged.
  - **Review Focus 1:**
    1. List at 2026-10-12 (fixed `now`).
    2. Set the M6 row to `applied` by hand.
    3. With `now` at `2027-05-01T09:00:00Z` (a second app instance on the same DB), `/list` hybrid 1795 + approval.
    4. Expect: the old planned rows → `superseded`; the applied M6 untouched; new rows = Task 1's startAfter vector; `first_listed_at` unchanged; `domains.plan_id` changed.
  - **replan:** with a v3 created through `newPricingSettings` (`floor_bps` 6000), a listed 1995 domain (v2) with `replan: true` + approval → floor = `min(1995, max(round5(1995 × 60%), 750)) = $1,195`, `settings_version` 3, the schedule regenerated. Without `replan`, a manual BIN change to 2495 keeps v2 (floor 1620).
  - **replan of an exception plan** drops the exception (Q10): the stored `pricing_source` becomes `formula` and the walk-away 960.
  - **Category change trend → b2b** (approval): history row, plan regenerated, prices unchanged.
  - **Geo grade:** `price_grade: 'strong'` on a trend name → 422 `GRADE_NOT_GEO`.
  - **Geo manual change** (owned geo domain, grade weaker, listed bin 399): `{mode:'bin', bin: 299}` + approval → 200, and the schedule is delist only (bin ≠ the strong price). `{mode:'bin', bin: 650}` without override → 422 `GEO_BIN_OUT_OF_RANGE`; with override + reason + approval → 200, `override: true` in history.
  - **Offer override** (trend): `{mode:'offer', min_offer: 500, override: true, override_reason: 'x'}` + approval → 200, `NO_BIN_LESS_EXPOSURE`, schedule delist only (Q1).
  - **LH-1:** 3 accepted changes (hybrid 1995 → hybrid 2495 → hold) → 3 history rows in order, each with `audit_id`.
  - **LH-2:** a rejected change → 0 history rows, 1 audit row.
  - **LH-4:** `dry_run: true` hybrid 1995 + approval → 200, `dry_run: true`, `listing.schedule` has 4 events, `preview.afternic` = `examplecityroofing.com,1995,1295,100,N,,Custom Lander,Y,N,Y,N` (or the display name). 0 history, 0 schedule rows, `first_listed_at` still null.
  - **Delisted:** `status: 'delisted'` → 404 `NOT_IN_PORTFOLIO`.
  - **PR-17 parity:** the `listing` block for `/list` hybrid 1995 at `now` 2026-10-12 equals the preview's fields (`bin_cents`, `floor_cents`, `walkaway_cents`, `min_offer_cents`, `schedule`, `sell_plan_line`) for `GET /pricing/preview?category=trend&bin=1995&listed_on=2026-10-12&domain=<D>`.
- [ ] **Step 2: Run to verify failure.**
- [ ] **Step 3: Implement** as specified.
- [ ] **Step 4: Run** `npx vitest run && npx tsc --noEmit`. Expected: all PASS. The old `listing-rules.ts` may still be imported by `buy.ts`; leave it.
- [ ] **Step 5: Commit** `feat: /list pricing v2 (computed plans, exceptions, overrides, hold, replan, schedule on first listing and regeneration, dry-run schedule) (L-14, L-15, LS/LG/LH)`

---

### Task 4: `/list` concurrency and NS hardening (4a carry list)

**Files:**
- Modify: `src/services/list.ts`, `src/services/export.ts`, `tests/api/list.test.ts`, `tests/unit/export-rows.test.ts`
- Create: `tests/api/list-concurrency.test.ts`

**Behaviour:**
1. **Lock:** everything after the dry-run return runs inside `withDomainLock(db, domain, async (conn) => …)`, using `conn` for every query:
   - re-read the row;
   - re-run the classification and validation against the locked row (move steps 1–8 of Task 3 into a function that takes `(dbOrConn, row)`);
   - set NS;
   - save.

   The dry run stays outside the lock. The 4a `LISTING_CHANGED_CONCURRENTLY` re-check inside the save transaction stays as a belt-and-braces check. It now also compares `lander`, `lander_ns`, `walkaway_cents`, `pricing_hold`, `plan_id` and `status`.
2. **Ambiguous NS** (`setNameservers` throws a `RegistrarError` with `ambiguous === true`):
   - call `getNameservers`;
   - if it matches as a set → continue with `ns_status: 'set'` and push the warning `NS_SET_AFTER_AMBIGUOUS`;
   - otherwise, or if the read-back throws → throw `AppError(503, 'REGISTRAR_UNAVAILABLE', 'The registrar did not confirm the nameserver change; retry later', { registrar, registrar_code })`.

   A 5xx releases the idempotency key (existing middleware), so a same-key retry runs again. Non-ambiguous `RegistrarError` → 409 `REGISTRAR_REJECTED` as now.
3. **`API_ACCESS_DISABLED`:** the message depends on the registrar:
   - `porkbun` → the current Opt-In text;
   - any other → `The registrar refused: API access is off for this domain at <registrar>. Enable API access for it, then call /list again.`
4. **`display_name`:** must match `^[A-Za-z0-9.-]+$` **and** lowercase to the domain, else 422 `DISPLAY_NAME_MISMATCH`. This closes the Kelvin-sign bypass: `'K'.toLowerCase()` is `'k'`.
5. **Export re-check:** in `afternicRow` and `sedoRow`, if `display_name` fails the same check, use the lowercase domain and add the warning `DISPLAY_NAME_IGNORED:<domain>`.
   - Put `isValidDisplayName(domain, name)` in `src/domain-name.ts` and use it in both places.
   - Unit test in `export-rows.test.ts`: a row with display name `'Kelvin.com'` for domain `kelvin.com` → cell `kelvin.com` + warning.

- [ ] **Step 1: Write the failing tests:**
  - **Review Focus 3** (`list-concurrency.test.ts`):
    - `FakeAdapter` with `onSetNs: () => new Promise((r) => setTimeout(r, 150))`;
    - two concurrent `/list` calls on one listed trend domain: hybrid 2495 and hybrid 2995, different keys, both with approval;
    - `await Promise.all`: both 200;
    - the final `domains.bin_cents` equals whichever finished second (read the history order);
    - 2 history rows with distinct `plan_audit_id`s;
    - exactly one `plan_id` has `planned` rows, and all rows of the other plan are `superseded`.
  - **Lock shared with `/buy`:** hold `withDomainLock` on the domain in the test for 200 ms while a `/list` runs; `/list` finishes after the release (time it).
  - **Review Focus 4a:** `setNs: new RegistrarError('porkbun', 'REGISTRAR_TIMEOUT', 't')`, and `getNs` returns the afternic pair → 200, `ns_status` `set`, warning `NS_SET_AFTER_AMBIGUOUS`.
  - **Review Focus 4b:** the same with `getNs: ['ns1.old.com', 'ns2.old.com']` → 503 `REGISTRAR_UNAVAILABLE`, nothing saved (no history, `lander` unchanged). Then a retry with the **same** `Idempotency-Key` and a working adapter → 200 (not a replay; the key was released).
  - **Review Focus 4c:** `getNsError` after an ambiguous `setNs` → 503.
  - **L-6:** porkbun `API_ACCESS_DISABLED` → 409 with "Opt In All Domains". For a domain at registrar `godaddy` (`registrar_api: 'manage'`, a FakeAdapter named `godaddy` with `canManageNs`) → the message contains `godaddy` and not `porkbun`.
  - **`display_name`:** `'KELVIN.com'` for `kelvin.com` → 422 `DISPLAY_NAME_MISMATCH`; `'KelVin.com'` → 200.
- [ ] **Step 2: Run to verify failure.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npx vitest run && npx tsc --noEmit`.
- [ ] **Step 5: Commit** `fix: /list under the per-domain lock; ambiguous NS → read back or 503; per-registrar API-access message; ASCII display_name (list + export)`

---

### Task 5: `/buy` v2 (category + grade, comps, version, plan, post-buy save, B-28)

**Files:**
- Modify: `src/api/buy.ts`, `src/services/buy.ts`, `tests/helpers/buy.ts`, `tests/api/buy-checks.test.ts`, `tests/api/buy-purchase.test.ts`
- Create: `tests/api/buy-listing.test.ts`

**Request** (zod, `.strict()`) adds:
- `price_grade: 'strong' | 'weaker' | null`;
- `pricing_evidence: { comps: unknown[]; rationale?: string | null }`, required: missing → V11 `COMPS_REQUIRED`, not a zod 400; so make it `z.unknown().optional()` and let `validateComps` decide;
- `expected_settings_version: number().int() | null`;
- `proposed_listing` gains `walkaway`, `pricing_exception` and `pricing_exception_reason` (Q3).

**Check 3b** (after the approval check, before check 4; any failure → no registrar call). Every failure is an `AppError(f.status, f.code, f.message, f.details)`.
1. `CATEGORY_REQUIRED` if the category is missing or invalid.
2. Geo without `price_grade` → `GEO_GRADE_REQUIRED`. A non-geo with `price_grade` → `GRADE_NOT_GEO`.
3. `s = currentSettings(db, now)`.
4. If `proposed_listing`: `validateListing(proposed, { category, grade, phase: 'buy', settings: s, highValueMinBinCents: settings.high_value_min_bin_cents, override, overrideReason, approvalValid: true, today, dropDate: null })`.
   - For an LTO check at buy, the drop date is unknown; use `addOneYear(addOneYear(today))`, since registration is today + 1 y and the drop is + 1 y more.
5. `validateComps(input.pricingEvidence, s, today)`.
6. `checkSettingsVersion(input.expectedSettingsVersion, s)`.

Keep `plan`, `comps`, `rationale` and `s` on the `Approved` object.

**Reservation:** the pending `domains` row also gets `price_grade` (geo) on both insert paths (the normal reservation and the ambiguous dry run).

**Dry run response:**
- `proposed_listing: plan ? planView(plan) : null`, with no schedule, since `drop_date` isn't known before the registrar answers;
- `warnings` includes the plan warnings;
- `settings_version: s.version`.

**Post-buy** (after privacy and auto-renew; a failure in each part → a warning, never undoing the purchase):
1. **Evidence (Q6):** insert `pricing_evidence { domain_id, comps: JSON.stringify(comps), rationale, audit_id }`.
   - On failure: warning `EVIDENCE_SAVE_FAILED: …`.
2. **`auto_list` NS:** as today.
3. **`auto_list && plan`:** `withDomainLock(db, domain, conn => conn.transaction()…)`, in one transaction:
   - re-read the row (it must be `owned`);
   - `UPDATE domains SET ...domainPlanColumns(plan), status 'listed', category, price_grade, first_listed_at = now, export_pending_since = now`;
   - `INSERT listing_history` via `historyRow` with `source 'buy'`, `planAuditId = auditId`, and approval text/time from the call;
   - `writePlan({ anchor: jerusalemDate(now), dropDate: row.drop_date, settings: s, planAuditId: auditId })`.
   - `post.listing = planView(plan, events)`.
   - On failure: `LISTING_SAVE_FAILED` as now.

   The plan was fully validated in 3b, so this save can only fail on infrastructure (Review Focus 5).
4. `presentListing` and `validateListing` from `listing-rules.ts` are no longer imported by `buy.ts`.

**Test helper** (`tests/helpers/buy.ts`). This edit is required by the approved v2 spec, where every buy needs a grade for geo and comps:
```ts
export const COMPS = [
  { domain: 'compa.com', price_usd: 1500, sold_on: '2026-09-01', venue: 'NameBio', source_url: 'https://namebio.com/compa.com' },
  { domain: 'compb.com', price_usd: 2200, sold_on: '2026-08-15', venue: 'NameBio', source_url: 'https://namebio.com/compb.com' },
];
export function buyBody(over: Record<string, unknown> = {}) {
  const domain = (over.domain as string | undefined) ?? DOMAIN;
  return { domain, max_price: 11.5, approval_ref: approvalNow(domain), category: 'geo', price_grade: 'weaker',
    pricing_evidence: { comps: COMPS, rationale: 'fixture' }, ...over };
}
```
Existing buy tests that send `proposed_listing: { mode: 'bin', bin: 650 }` (LG-16) still expect a 422. Update the expected code to `GEO_BIN_NOT_GRADE_PRICE` (phase buy), with 0 register calls. Tests asserting the old `presentListing` shape (`{ mode, bin: 399, floor: 399, min_offer: 399, lto_max_months: null }`) switch to the `planView` shape.

- [ ] **Step 1: Write the failing tests** (`tests/api/buy-listing.test.ts`; FakeAdapter purchase flow as in `buy-purchase.test.ts`):
  - **B-28:**
    - trend, `price_grade` absent, `proposed_listing {mode:'hybrid', bin:1995}`, 2 comps, `expected_settings_version: 2` (spec defect: B-28 says 1);
    - fixed `now` 2026-10-04T10:00:00Z;
    - FakeAdapter expiry `2027-10-04` → `drop_date` 2028-10-04.
    
    Expect:
    - 201;
    - domain: status `listed`, 1995/1295/960/100, formula, v2, `first_listed_at` = now;
    - one `pricing_evidence` row with 2 comps and `audit_id` = the call's audit id;
    - 4 schedule rows = PR-12 shifted to anchor 2026-10-04: M6 2027-04-04, M18 2028-04-04, final push 2028-07-06, delist 2028-09-27, with PR-12's values;
    - `plan_audit_id` = the audit id;
    - history `source 'buy'`;
    - the response `post_buy.listing.schedule` has 4 events.
  - **Geo weaker buy** with `proposed_listing {mode:'bin', bin:399}` → listed at 399, schedule delist only. **Geo strong** at 499 → `geo_drop_m12` + delist.
  - **LG-16 / Review Focus 5** (each → 422/409 and **0** `register` calls in `adapter.calls`):
    - hybrid 1990 (`BIN_NOT_NICE`);
    - floor 1200 without exception (`PRICING_FORMULA_MISMATCH`);
    - trend `{mode:'bin', bin: 999}` without override (`MODE_NOT_ALLOWED_FOR_CATEGORY`);
    - 1 comp (`COMPS_REQUIRED`);
    - version 1 (409 `SETTINGS_VERSION_CHANGED`).
  - **LG-17 / LG-18 / LG-19:** no category; geo without grade; geo strong with bin 399 → codes as the spec says, 0 register calls.
  - **LG-20 via /buy:** a comp with `http://` → `COMPS_INVALID`, 0 register calls.
  - **Exception via /buy (Q3):** `proposed_listing {mode:'hybrid', bin:1995, floor:1295, walkaway:950, pricing_exception:true, pricing_exception_reason:'Dvir 00:39'}` → 201; stored walk-away 95000, `approved_exception`.
  - **`auto_list: false`:** 201; evidence row present; no listing, no schedule; status `owned`; `price_grade` stored for geo.
  - **Dry run:** `proposed_listing` view with cents and display strings, `settings_version` 2; 0 rows in `pricing_evidence` and `price_schedule`.
  - (The evidence-save failure path isn't tested: it mirrors the already-tested `LISTING_SAVE_FAILED` path, and forcing an insert failure would need schema tampering.)
- [ ] **Step 2: Run to verify failure.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npx vitest run && npx tsc --noEmit`. Every existing buy test must pass after the helper change. Any test whose expected value changes beyond the shape updates listed above → report it; don't change it silently.
- [ ] **Step 5: Commit** `feat: /buy v2 (grade, comps V11, settings version V12, computed plan validated before any registrar call; post-buy evidence + plan + schedule under the domain lock) (B-28, LG-16–LG-21)`

---

### Task 6: Remove v1 listing rules and settings columns

**Files:**
- Delete: `src/services/listing-rules.ts`, `tests/unit/listing-rules.test.ts`
- Create: `migrations/1760000000000_drop-v1-listing-settings.sql`
- Modify: `src/db/types.ts` (`SettingsTable` loses 4 columns), `src/services/list.ts` and `src/api/pricing.ts` and any other importer of `isCategory` → import from `listing-v2.ts`, `tests/api/schema.test.ts` (settings defaults), `tests/api/admin-cli.test.ts` (5 migrations)

```sql
-- Up Migration
-- v1 listing settings moved to pricing_settings (geo range) or retired (high-value guard) on 5 Oct 2026 (listing-strategy.md §5 Settings)
ALTER TABLE settings
  DROP COLUMN geo_bin_min_cents,
  DROP COLUMN geo_bin_max_cents,
  DROP COLUMN high_value_categories,
  DROP COLUMN high_value_guard_modes;

-- Down Migration
ALTER TABLE settings
  ADD COLUMN geo_bin_min_cents integer NOT NULL DEFAULT 29900,
  ADD COLUMN geo_bin_max_cents integer NOT NULL DEFAULT 49900,
  ADD COLUMN high_value_categories text[] NOT NULL DEFAULT '{trend,b2b,collision,regulation,buzzword}',
  ADD COLUMN high_value_guard_modes text[] NOT NULL DEFAULT '{bin}',
  ADD CHECK (geo_bin_min_cents > 0 AND geo_bin_min_cents <= geo_bin_max_cents),
  ADD CHECK (high_value_guard_modes <@ ARRAY['bin', 'offer', 'hybrid']),
  ADD CHECK (high_value_categories <@ ARRAY['geo', 'trend', 'b2b', 'collision', 'regulation', 'buzzword', 'other']);
```
- [ ] **Step 1:** `grep -rn "listing-rules\|high_value_categories\|high_value_guard_modes\|SEDO_NO_FLOOR\|HYBRID_BIN_BELOW_HIGH_VALUE_MIN" src tests`. Each hit is removed or redirected. `geo_bin_min_cents` and `geo_bin_max_cents` stay in **`pricing_settings`**; only the `settings` columns go.
- [ ] **Step 2:** Write the migration, update the types and fix the importers. Schema test: the `settings` row has no `geo_bin_min_cents` key. `npm run migrate up` on the dev DB, and `npm run migrate down` then `up` once to prove the reversal.
- [ ] **Step 3:** `npx vitest run && npx tsc --noEmit && npm run build`. All PASS.
- [ ] **Step 4: Commit** `refactor: remove v1 listing rules and settings columns (geo range now in pricing_settings; high-value guard retired)`

---

### Task 7 (Opus): Gate report and spec sync

- [ ] Full suite, typecheck and build; record the counts.
- [ ] Map the spec IDs to tests: LS-1–LS-20, LG-1–LG-21, LH-1–LH-4, L-1–L-9, L-11, L-14, L-15, B-28, PR-17 (`/list` and `/buy`). Every one needs a named test or a reason.
- [ ] Final whole-change review, then the fix wave if needed.
- [ ] **Spec sync, after Dvir confirms Q1–Q10 and the open 4b-1 decisions.** Small "Decided" notes only; Gavriel's text is not rewritten.
  - listing-strategy §5: the new codes (Q5) and the Q1, Q2, Q4, Q8 and Q10 notes.
  - buy.md: the Q3 and Q6 notes; B-28 version 2.
  - list.md: the `price_grade` field (Q7), Q9, 503 `REGISTRAR_UNAVAILABLE`, `NS_SET_AFTER_AMBIGUOUS`, `DISPLAY_NAME_MISMATCH` (ASCII).
  - LS-12 v2 correction.
  - The 4a decisions L2–L7, `LISTING_CHANGED_CONCURRENTLY` (retry with a new key), and "an empty DNS answer = mismatch".
  - 00-architecture §4 notes: `walkaway_cents` is no longer "= min_offer", and `geo_drop_m12` in the event list.
- [ ] Report; push to `main` (check `origin/main` first).

---

## Self-review notes

- **Spec coverage:**
  - §5 V1–V8 → Task 1; V9/V10 → Task 3; V11/V12 → Tasks 1 and 5.
  - The warnings list → Task 1. `SEDO_NO_FLOOR` and `HYBRID_BIN_BELOW_HIGH_VALUE_MIN` are retired in Task 6. `LEGACY_NO_COMPS` → 4d import.
  - The §5 history-row fields → Task 2 `historyRow` (`schedule_event_id` stays null until the 4b-3 job).
  - §7 one approval (plan stored at buy, `plan_audit_id`) → Task 5.
  - §10.4: the first-listing rows and the regeneration on a manual change, replan or category change → Tasks 2 and 3. The hold flag → Task 3; the job's hold behaviour → 4b-3. `drop_date` moves and sold/delist/drop cancellation → 4b-3/4d.
  - list.md behaviour 1–6 → Tasks 3 and 4 (the checklist text is unchanged; the `POST /export/{venue}/uploaded` line comes with 4b-3).
  - buy.md 3b and 7.3 → Task 5.
- **Placeholder scan:** none. The startAfter vector is computed by hand in Task 1.
- **Type consistency:**
  - `ListingPlan` (Task 1) is consumed by `writePlan`, `historyRow`, `domainPlanColumns` and `planView` (Task 2), and by `/list` and `/buy` (Tasks 3 and 5).
  - `SchedulePlan` (Task 1) is satisfied structurally by `ListingPlan` (same field names).
  - `Fail.status` (422/409) feeds `AppError` in Tasks 3 and 5.
