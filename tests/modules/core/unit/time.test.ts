import { describe, expect, it } from 'vitest';
import { toJerusalemIso } from '../../../../src/core/dates.js';

describe('toJerusalemIso', () => {
  it('summer (IDT, +03:00)', () => {
    expect(toJerusalemIso(new Date('2026-10-04T06:12:03.456Z'))).toBe('2026-10-04T09:12:03+03:00');
  });
  it('winter (IST, +02:00)', () => {
    expect(toJerusalemIso(new Date('2026-01-15T10:00:00Z'))).toBe('2026-01-15T12:00:00+02:00');
  });
  it('DST end, 25 Oct 2026: one second before and at the switch', () => {
    expect(toJerusalemIso(new Date('2026-10-24T22:59:59Z'))).toBe('2026-10-25T01:59:59+03:00');
    expect(toJerusalemIso(new Date('2026-10-24T23:00:00Z'))).toBe('2026-10-25T01:00:00+02:00');
  });
  it('local midnight rolls the date', () => {
    expect(toJerusalemIso(new Date('2026-10-04T21:30:00Z'))).toBe('2026-10-05T00:30:00+03:00');
  });
});
