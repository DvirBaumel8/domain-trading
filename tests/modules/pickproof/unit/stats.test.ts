// CR-073 (v5.28.0): the pure pick-proof statistics. Expected values are exact: the Fisher p-values are rational numbers from the hypergeometric
// distribution computed with integer binomials (17/70 is the classic tea-tasting table, scipy.stats.fisher_exact([[3,1],[1,3]], alternative='greater') = 0.2429);
// the CMH numbers were computed by hand from the textbook formulas (E = n1 m1 / n, V = n1 n2 m1 m2 / (n^2 (n-1)), z = (sum a - sum E) / sqrt(sum V)).
import { describe, expect, it } from 'vitest';
import { MT19937 } from '../../../../src/core/mt19937.js';
import { cmh, fisherGreater, holm, normalSf, permutationTest } from '../../../../src/modules/pickproof/stats.js';

describe('PP528 stats', () => {
  it('PP528-1 Fisher exact one-sided matches exact hypergeometric values', () => {
    expect(fisherGreater({ a: 3, b: 1, c: 1, d: 3 })).toBeCloseTo(17 / 70, 12);
    expect(fisherGreater({ a: 8, b: 2, c: 1, d: 5 })).toBeCloseTo(7 / 286, 12);
    expect(fisherGreater({ a: 10, b: 0, c: 2, d: 8 })).toBeCloseTo(3 / 8398, 12);
    expect(fisherGreater({ a: 5, b: 15, c: 5, d: 15 })).toBeCloseTo(210533 / 328042, 12);
    expect(fisherGreater({ a: 12, b: 88, c: 3, d: 97 })).toBeCloseTo(0.01433565748658855, 12);
    // an empty arm or no events at all cannot show a difference
    expect(fisherGreater({ a: 0, b: 0, c: 3, d: 4 })).toBe(1);
    expect(fisherGreater({ a: 0, b: 5, c: 0, d: 5 })).toBe(1);
  });

  it('PP528-2 the normal tail used by CMH', () => {
    expect(normalSf(0)).toBeCloseTo(0.5, 6);
    expect(normalSf(1.6448536)).toBeCloseTo(0.05, 6);
    expect(normalSf(-1.6448536)).toBeCloseTo(0.95, 6);
    expect(normalSf(1.8973666)).toBeCloseTo(0.02888978556, 6);
  });

  it('PP528-3 Cochran-Mantel-Haenszel over strata (z, chi2, one-sided p, MH odds ratio)', () => {
    const two = cmh([{ a: 5, b: 5, c: 2, d: 8 }, { a: 6, b: 4, c: 3, d: 7 }]);
    expect(two.z).toBeCloseTo(1.8973665961, 8);
    expect(two.chi2).toBeCloseTo(3.6, 8);
    expect(two.p_value).toBeCloseTo(0.02888978556, 6);
    expect(two.odds_ratio).toBeCloseTo(3.7272727, 6);
    const three = cmh([{ a: 8, b: 12, c: 2, d: 18 }, { a: 4, b: 6, c: 1, d: 9 }, { a: 2, b: 8, c: 0, d: 10 }]);
    expect(three.z).toBeCloseTo(2.9900122904, 8);
    expect(three.p_value).toBeCloseTo(0.00139483111, 6);
    expect(three.odds_ratio).toBeCloseTo(7.1111111, 6);
    expect(three.used_strata_n).toBe(3);
    // strata without variance (no events, or one arm empty) add nothing; no usable stratum gives null
    expect(cmh([{ a: 0, b: 5, c: 0, d: 5 }, { a: 3, b: 0, c: 0, d: 0 }]).p_value).toBeNull();
  });

  it('PP528-4 Holm adjustment keeps the input order and is monotone', () => {
    expect(holm([0.01, 0.04])).toEqual([0.02, 0.04]);
    expect(holm([0.04, 0.01])).toEqual([0.04, 0.02]);
    expect(holm([0.03, 0.04])).toEqual([0.06, 0.06]);
    expect(holm([0.6, 0.9])).toEqual([1, 1]);
    expect(holm([0.5])).toEqual([0.5]);
    expect(holm([])).toEqual([]);
  });

  it('PP528-5 the permutation test is reproducible for a seed, differs for another, and finds an obvious difference', () => {
    const days = [0, 1, 2, 3].map(() => ({ outcomes: [...Array<number>(10).fill(1), ...Array<number>(10).fill(0), ...Array<number>(2).fill(1), ...Array<number>(18).fill(0)], n1: 20 }));
    const a = permutationTest(days, 12345, 2000);
    expect(permutationTest(days, 12345, 2000)).toEqual(a);
    expect(a.observed).toBe(40);
    expect(a.shuffles).toBe(2000);
    expect(a.p_value).toBeLessThan(0.01);
    expect(permutationTest(days, 999, 2000).p_value).toBeLessThan(0.01);
    // no difference: p is large
    const flat = [0, 1, 2].map(() => ({ outcomes: [...Array<number>(5).fill(1), ...Array<number>(15).fill(0), ...Array<number>(5).fill(1), ...Array<number>(15).fill(0)], n1: 20 }));
    expect(permutationTest(flat, 7, 2000).p_value).toBeGreaterThan(0.3);
  });

  it('PP528-6 MT19937 in src/core is the reference generator (mt19937ar.c init_by_array({0x123, 0x234, 0x345, 0x456}) first outputs)', () => {
    const g = new MT19937([0x123, 0x234, 0x345, 0x456]);
    expect([g.nextU32(), g.nextU32(), g.nextU32(), g.nextU32(), g.nextU32()]).toEqual([1067595299, 955945823, 477289528, 4107218783, 4228976476]);
  });
});
