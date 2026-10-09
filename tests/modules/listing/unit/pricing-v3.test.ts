import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { computePlan, hybridBinMin, type PlanInput } from '../../../../src/modules/listing/pricing/plan.js';
import { pct, roundDollar } from '../../../../src/modules/listing/pricing/round.js';
import { buildSchedule, ladderStep } from '../../../../src/modules/listing/pricing/schedule.js';
import { isV3, ruleFields, type PricingSettings } from '../../../../src/modules/listing/pricing/settings.js';
import { V2, V3 } from '../../../helpers/pricing.js';

const VEC = JSON.parse(readFileSync('tests/fixtures/pricing-vectors.v3.json', 'utf8'));
// The lander gate (P1a: always refused) is a separate rule; the vectors cover the math of every list BIN.
const VMATH: PricingSettings = { ...V3, landerExceptionBinsCents: [] };
const V2VEC = JSON.parse(readFileSync('tests/fixtures/pricing-vectors.v2.json', 'utf8'));

const sched = (v: { input: object; anchor: string; drop_date: string }, settings = VMATH) => {
  const r = computePlan(v.input as PlanInput, settings);
  if (!r.ok) throw new Error(r.code);
  return buildSchedule({ plan: r.plan, anchor: v.anchor, dropDate: v.drop_date, settings }).map((e) => [e.event, e.dueOn, e.binCents, e.floorCents, e.walkawayCents, e.status]);
};
const vec = (bin: number) => VEC.schedules.find((v: { input: { binCents?: number } }) => v.input.binCents === bin);
const geoVec = (grade: string) => VEC.schedules.find((v: { input: { grade?: string } }) => v.input.grade === grade);

describe('pricing v3 (§10.13, test-plan PR3-*)', () => {
  it('PR3-1: hybrid plan vectors; min offer 100; FLOOR_RAISED_TO_MIN at 1088', () => {
    for (const v of VEC.plans) {
      const r = computePlan({ category: 'trend', binCents: v.bin }, VMATH);
      if (!r.ok) throw new Error(`${v.bin} → ${r.code}`);
      expect([r.plan.floorCents, r.plan.walkawayCents, r.plan.minOfferCents, r.plan.settingsVersion]).toEqual([v.floor, v.walkaway, 10000, 3]);
      expect(r.plan.warnings.includes('FLOOR_RAISED_TO_MIN')).toBe(v.bin === 108800 || v.bin === 78800);
    }
  });

  it('PR3-2: off-list BINs refused (also with an exception); list BINs ok; lander-exception BINs refused until the pack exists', () => {
    for (const bin of [149500, 99500, 199900, 95000, 69900, 199000]) {
      expect(computePlan({ category: 'trend', binCents: bin }, V3)).toMatchObject({ ok: false, code: 'BIN_NOT_IN_PRICE_LIST' });
      expect(computePlan({ category: 'trend', binCents: bin, floorCents: 90000, walkawayCents: 60000, exception: true }, V3)).toMatchObject({ ok: false, code: 'BIN_NOT_IN_PRICE_LIST' });
    }
    expect(computePlan({ category: 'trend', binCents: 29900 }, V3)).toMatchObject({ ok: false, code: 'BIN_NOT_IN_PRICE_LIST' }); // on the list, below the non-geo minimum
    for (const bin of [78800, 108800, 148800]) expect(computePlan({ category: 'trend', binCents: bin }, V3).ok).toBe(true);
    for (const bin of [198800, 248800]) {
      expect(computePlan({ category: 'trend', binCents: bin }, V3)).toMatchObject({ ok: false, code: 'LANDER_EXCEPTION_REQUIRED', details: { needs: 'screening_pack (CR-001 P1b)' } });
      expect(computePlan({ category: 'trend', binCents: bin }, VMATH).ok).toBe(true); // "with LANDER-1": the gate off
    }
  });

  it('PR3-3: formula 1488 schedule (not 1190/952)', () => expect(sched(vec(148800))).toEqual(vec(148800).events));
  it('PR3-4: 2488 and 1988 schedules', () => {
    expect(sched(vec(248800))).toEqual(vec(248800).events);
    expect(sched(vec(198800))).toEqual(vec(198800).events);
  });
  it('PR3-5: 1088 and 788 schedules', () => {
    expect(sched(vec(108800))).toEqual(vec(108800).events);
    expect(sched(vec(78800))).toEqual(vec(78800).events);
  });
  it('PR3-6: geo strong 499 → 399, weaker 399 → 299, delist only otherwise', () => {
    expect(sched(geoVec('strong'))).toEqual(geoVec('strong').events);
    expect(sched(geoVec('weaker'))).toEqual(geoVec('weaker').events);
  });

  it('PR3-7 (property): every v3 plan: scheduled BINs on the list; 500 <= walk-away <= floor <= BIN; floor = recomputed 65% (whole dollar) unless raised', () => {
    const list = V3.allowedBinsCents!;
    const plans: PlanInput[] = [
      ...list.filter((b) => b >= V3.nongeoBinMinCents!).map((b) => ({ category: 'trend' as const, binCents: b })),
      { category: 'geo' as const, grade: 'strong' as const }, { category: 'geo' as const, grade: 'weaker' as const },
    ];
    for (const input of plans) {
      const r = computePlan(input, VMATH);
      if (!r.ok) throw new Error(r.code);
      for (const e of buildSchedule({ plan: r.plan, anchor: '2026-10-12', dropDate: '2028-10-04', settings: VMATH })) {
        if (e.binCents === null) continue;
        const [b, f, w] = [e.binCents, e.floorCents!, e.walkawayCents!];
        expect(list).toContain(b);
        expect(w <= f && f <= b).toBe(true);
        if (input.category !== 'geo') {
          expect(w).toBeGreaterThanOrEqual(50000);
          expect(f).toBeGreaterThanOrEqual(75000);
          if (e.event !== 'final_push') expect(f).toBe(Math.min(b, Math.max(roundDollar(pct(b, 6500)), 75000)));
        }
      }
    }
  });

  it('PR3-8: the v2 exception fixture 1995/1295/950 keeps PR-11 under v2 settings; under v3 a drop recomputes from the new BIN (no exception carry)', () => {
    const v2 = sched({ input: { category: 'trend', binCents: 199500, floorCents: 129500, walkawayCents: 95000, exception: true }, anchor: '2026-10-12', drop_date: '2028-10-04' }, V2);
    expect(v2).toEqual([
      ['drop1_m6', '2027-04-12', 159500, 103500, 76000, 'planned'], ['drop2_m18', '2028-04-12', 129500, 83000, 61000, 'planned'],
      ['final_push', '2028-07-06', 89500, 83000, 61000, 'planned'], ['delist', '2028-09-27', null, null, null, 'planned'],
    ]);
    const stored = computePlan({ category: 'trend', binCents: 199500, floorCents: 129500, walkawayCents: 95000, exception: true, carried: true }, V3);
    if (!stored.ok) throw new Error(stored.code);
    const ev = buildSchedule({ plan: stored.plan, anchor: '2026-10-12', dropDate: '2028-10-04', settings: V3 });
    expect(ev.slice(0, 3).map((e) => [e.event, e.binCents, e.floorCents, e.walkawayCents, e.status])).toEqual([
      // 1995 is off the list: one rung = the next list value below it (1988), recomputed, not 1995's exception prices
      ['drop1_m6', 198800, 129200, 95500, 'planned'], ['drop2_m18', 148800, 96700, 71500, 'planned'], ['final_push', 108800, 96700, 71500, 'planned'],
    ]);
  });

  it('v3-a: roundDollar, isV3, hybridBinMin', () => {
    expect([roundDollar(96720), roundDollar(96750), roundDollar(96749)]).toEqual([96700, 96800, 96700]);
    expect([isV3(V3), isV3(V2)]).toEqual([true, false]);
    expect([hybridBinMin(V3), hybridBinMin(V2)]).toEqual([78800, 79500]);
  });

  it('v3-b: carried (stored) plans skip the price list', () => {
    expect(computePlan({ category: 'trend', binCents: 199500, floorCents: 129500, walkawayCents: 95000, exception: true, carried: true }, V3)).toMatchObject({ ok: true });
  });

  it('v3-c: ladderStep', () => {
    expect([ladderStep(148800, 1, 'nongeo', V3), ladderStep(78800, 1, 'nongeo', V3), ladderStep(148800, 2, 'nongeo', V3), ladderStep(148800, 9, 'nongeo', V3)]).toEqual([108800, null, 78800, 78800]);
    expect([ladderStep(49900, 1, 'geo', V3), ladderStep(39900, 1, 'geo', V3), ladderStep(29900, 1, 'geo', V3)]).toEqual([39900, 29900, null]);
  });

  it('v3-d: v2 settings still produce the v2 vectors; the v2 fingerprint has no v3 keys', () => {
    for (const v of V2VEC.plans) {
      const r = computePlan(v.input as PlanInput, V2);
      if (!r.ok) throw new Error(r.code);
      expect([r.plan.floorCents, r.plan.walkawayCents]).toEqual([v.floor, v.walkaway]);
    }
    for (const v of V2VEC.schedules) expect(sched(v, V2)).toEqual(v.events);
    expect(Object.keys(ruleFields(V2))).not.toContain('dropMode');
    expect(Object.keys(ruleFields(V3))).toContain('dropMode');
  });
});
