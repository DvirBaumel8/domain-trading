import { describe, expect, it } from 'vitest';
import { computePlan } from '../../src/modules/listing/pricing/plan.js';
import { addDays, addMonthsClamped } from '../../src/core/dates.js';
import { buildSchedule, type ScheduleEvent, type SchedulePlan } from '../../src/modules/listing/pricing/schedule.js';
import type { Plan } from '../../src/modules/listing/pricing/plan.js';
import { V2 } from '../helpers/pricing.js';

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
  it('impossible dates throw', () => {
    expect(() => addDays('2026-13-40', 1)).toThrow(/Not a date/);
    expect(() => addMonthsClamped('2026-02-30', 1)).toThrow(/Not a date/);
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
  it('geo drop due on/after the delist → superseded_by_final_push, then delist planned', () => {
    expect(rows(S(geo('strong'), '2027-10-20', '2028-10-04'))).toEqual([
      ['geo_drop_m12', '2028-10-20', null, null, null, 'superseded_by_final_push'],
      ['delist', '2028-09-27', null, null, null, 'planned'],
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
        expect(p.minOfferCents === V2.hybridMinOfferCents && 50000 <= w && w <= f && f <= b && f >= 75000, `bin ${bin}: ${b}/${f}/${w}`).toBe(true);
      };
      check(p.binCents, p.floorCents, p.walkawayCents);
      if (p.floorCents > 75000) expect(Math.abs(p.floorCents * 10000 - bin * 6500)).toBeLessThanOrEqual(250 * 10000);
      if (p.walkawayCents > 50000 && p.walkawayCents < p.floorCents) expect(Math.abs(p.walkawayCents * 10000 - bin * 4800)).toBeLessThanOrEqual(250 * 10000);
      for (const e of S(p)) if (e.binCents !== null) check(e.binCents, e.floorCents!, e.walkawayCents!);
    }
  });
});

describe('SchedulePlan paths and startAfter (4b-2)', () => {
  const sp = (o: Partial<SchedulePlan>): SchedulePlan => ({ category: 'trend', mode: 'hybrid', grade: null, binCents: 199500, floorCents: 129500, walkawayCents: 96000, ...o });
  it('Q1: non-geo bin override, offer, and geo hybrid override → delist only', () => {
    for (const p of [sp({ mode: 'bin', floorCents: 99900, walkawayCents: 99900, binCents: 99900 }), sp({ mode: 'offer', binCents: null, floorCents: null, walkawayCents: null }), sp({ category: 'geo', grade: 'strong' }), sp({ category: 'geo', mode: 'offer', grade: 'strong', binCents: null, floorCents: null, walkawayCents: null })]) {
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
it('startAfter after the final push and delist dates → only the delist row (never lost)', () => {
  expect(buildSchedule({ plan: sp({}), anchor: '2026-10-12', dropDate: '2028-10-04', settings: V2, startAfter: '2028-09-30' }).map((e) => [e.event, e.dueOn, e.binCents, e.floorCents, e.walkawayCents, e.status])).toEqual([['delist', '2028-09-27', null, null, null, 'planned']]);
});
});
