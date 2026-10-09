import { describe, expect, it } from 'vitest';
import { addOneYear, idtDay as jerusalemDate } from '../../../../src/core/dates.js';

describe('dates', () => {
  it('jerusalemDate uses the local calendar day', () => {
    expect(jerusalemDate(new Date('2026-10-05T20:59:00Z'))).toBe('2026-10-05');
    expect(jerusalemDate(new Date('2026-10-05T21:30:00Z'))).toBe('2026-10-06'); // 00:30 IDT
  });
  it('addOneYear, incl. 29 Feb → 28 Feb (B-22 rule)', () => {
    expect(addOneYear('2027-10-05')).toBe('2028-10-05');
    expect(addOneYear('2028-02-29')).toBe('2029-02-28');
    expect(addOneYear('2027-02-28')).toBe('2028-02-28');
    expect(() => addOneYear('2027-13-01')).toThrow();
    expect(() => addOneYear('not a date')).toThrow();
  });
});
