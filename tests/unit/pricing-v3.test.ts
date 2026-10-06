import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { computePlan, hybridBinMin, type PlanInput } from '../../src/pricing/plan.js';
import { roundDollar } from '../../src/pricing/round.js';
import { buildSchedule, ladderStep } from '../../src/pricing/schedule.js';
import { isV3, ruleFields } from '../../src/pricing/settings.js';
import { V2, V3 } from '../helpers/pricing.js';

const VEC = JSON.parse(readFileSync('tests/fixtures/pricing-vectors.v3.json', 'utf8'));
// The lander gate (P1a: always refused) is a separate rule; the vectors cover the math of every list BIN.
const VMATH = { ...V3, landerExceptionBinsCents: [] };
const V2VEC = JSON.parse(readFileSync('tests/fixtures/pricing-vectors.v2.json', 'utf8'));

describe('pricing v3 (§10.13)', () => {
  it('PR3-1: roundDollar and isV3', () => {
    expect([roundDollar(96720), roundDollar(96750), roundDollar(96749)]).toEqual([96700, 96800, 96700]);
    expect([isV3(V3), isV3(V2)]).toEqual([true, false]);
    expect([hybridBinMin(V3), hybridBinMin(V2)]).toEqual([78800, 79500]);
  });

  it('PR3-2: plan vectors', () => {
    for (const v of VEC.plans) {
      const r = computePlan({ category: 'trend', binCents: v.bin }, VMATH);
      if (!r.ok) throw new Error(`${v.bin} → ${r.code}`);
      expect([r.plan.floorCents, r.plan.walkawayCents, r.plan.settingsVersion]).toEqual([v.floor, v.walkaway, 3]);
    }
  });

  it('PR3-3: schedule vectors', () => {
    for (const v of VEC.schedules) {
      const r = computePlan(v.input as PlanInput, VMATH);
      if (!r.ok) throw new Error(r.code);
      const ev = buildSchedule({ plan: r.plan, anchor: v.anchor, dropDate: v.drop_date, settings: VMATH });
      expect(ev.map((e) => [e.event, e.dueOn, e.binCents, e.floorCents, e.walkawayCents, e.status])).toEqual(v.events);
    }
  });

  it('PR3-4: a BIN off the list is refused, also with an exception', () => {
    for (const bin of [149500, 99900, 199900]) {
      const r = computePlan({ category: 'trend', binCents: bin }, V3);
      expect(r).toMatchObject({ ok: false, code: 'BIN_NOT_IN_PRICE_LIST' });
      const e = computePlan({ category: 'trend', binCents: bin, floorCents: 90000, walkawayCents: 60000, exception: true }, V3);
      expect(e).toMatchObject({ ok: false, code: 'BIN_NOT_IN_PRICE_LIST' });
    }
    expect(computePlan({ category: 'trend', binCents: 29900 }, V3)).toMatchObject({ ok: false, code: 'BIN_NOT_IN_PRICE_LIST' }); // on the list, below the non-geo minimum
  });

  it('PR3-5: lander-exception BINs are refused until the screening pack exists (P1b)', () => {
    for (const bin of [198800, 248800]) {
      expect(computePlan({ category: 'trend', binCents: bin }, V3)).toMatchObject({
        ok: false, code: 'LANDER_EXCEPTION_REQUIRED', details: { needs: 'screening_pack (CR-001 P1b)' },
      });
    }
  });

  it('PR3-6: carried (stored) plans skip the price list', () => {
    expect(computePlan({ category: 'trend', binCents: 199500, floorCents: 129500, walkawayCents: 95000, exception: true, carried: true }, V3)).toMatchObject({ ok: true });
  });

  it('PR3-7: ladderStep', () => {
    expect([ladderStep(148800, 1, 'nongeo', V3), ladderStep(78800, 1, 'nongeo', V3), ladderStep(148800, 2, 'nongeo', V3), ladderStep(148800, 9, 'nongeo', V3)]).toEqual([108800, null, 78800, 78800]);
    expect([ladderStep(49900, 1, 'geo', V3), ladderStep(39900, 1, 'geo', V3), ladderStep(29900, 1, 'geo', V3)]).toEqual([39900, 29900, null]);
  });

  it('PR3-8: an exception does not carry through drops (floor/walk-away recomputed from the new BIN)', () => {
    const r = computePlan({ category: 'trend', binCents: 148800, floorCents: 120000, walkawayCents: 90000, exception: true }, V3);
    if (!r.ok) throw new Error(r.code);
    const ev = buildSchedule({ plan: r.plan, anchor: '2026-10-12', dropDate: '2028-10-04', settings: V3 });
    expect([ev[0]!.binCents, ev[0]!.floorCents, ev[0]!.walkawayCents]).toEqual([108800, 75000, 52000]);
  });

  it('PR3-9: v2 settings still produce the v2 vectors', () => {
    for (const v of V2VEC.plans) {
      const r = computePlan(v.input as PlanInput, V2);
      if (!r.ok) throw new Error(r.code);
      expect([r.plan.floorCents, r.plan.walkawayCents]).toEqual([v.floor, v.walkaway]);
    }
    for (const v of V2VEC.schedules) {
      const r = computePlan(v.input as PlanInput, V2);
      if (!r.ok) throw new Error(r.code);
      const ev = buildSchedule({ plan: r.plan, anchor: v.anchor, dropDate: v.drop_date, settings: V2 });
      expect(ev.map((e) => [e.event, e.dueOn, e.binCents, e.floorCents, e.walkawayCents, e.status])).toEqual(v.events);
    }
    expect(Object.keys(ruleFields(V2))).not.toContain('dropMode');
    expect(Object.keys(ruleFields(V3))).toContain('dropMode');
  });
});
