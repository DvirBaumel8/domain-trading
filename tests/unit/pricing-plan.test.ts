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
