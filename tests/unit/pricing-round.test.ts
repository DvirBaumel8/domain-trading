import { describe, expect, it } from 'vitest';
import { ceilDiv, div } from '../../src/modules/listing/pricing/int.js';
import { ceil95, nice95, nice99, pct, round5 } from '../../src/modules/listing/pricing/round.js';

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
