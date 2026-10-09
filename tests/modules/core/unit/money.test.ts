import { describe, expect, it } from 'vitest';
import { formatUsd, usdStringToCents } from '../../../../src/core/money.js';

describe('usdStringToCents', () => {
  it.each([
    ['9.73', 973], ['11.08', 1108], ['9.7', 970], ['10', 1000], ['0.01', 1], ['1995.00', 199500], ['0', 0],
  ])('%s → %i', (s, c) => expect(usdStringToCents(s)).toBe(c));

  it.each(['', '9.735', '-1', '1e3', '9,73', ' 9.73', '$9.73', '9.', '.5', 'abc', 'NaN'])('rejects %j', (s) => {
    expect(() => usdStringToCents(s)).toThrow();
  });

  it('never goes through floats (0.29 → 29, 1.15 → 115, 4.35 → 435)', () => {
    expect(usdStringToCents('0.29')).toBe(29);
    expect(usdStringToCents('1.15')).toBe(115);
    expect(usdStringToCents('4.35')).toBe(435);
  });
});

describe('formatUsd', () => {
  it.each([
    [1108, '$11.08'], [0, '$0.00'], [5, '$0.05'], [199500, '$1,995.00'], [-500, '-$5.00'], [123456789, '$1,234,567.89'],
  ])('%i → %s', (c, s) => expect(formatUsd(c)).toBe(s));

  it('rejects non-integers', () => {
    expect(() => formatUsd(11.08)).toThrow();
  });
});

import { dollarsToCents } from '../../../../src/core/money.js';

describe('dollarsToCents', () => {
  it.each([[11.5, 1150], [11.08, 1108], [10, 1000], [1995, 199500], [0.01, 1]])('%d → %i', (d, c) => {
    expect(dollarsToCents(d)).toBe(c);
  });
  it.each([0, -1, 11.085, Number.NaN, Number.POSITIVE_INFINITY, 1e21])('rejects %d', (d) => {
    expect(() => dollarsToCents(d)).toThrow();
  });
});
