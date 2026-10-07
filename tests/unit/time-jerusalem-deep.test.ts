import { describe, expect, it } from 'vitest';
import { jerusalemDeep } from '../../src/core/dates.js';

describe('jerusalemDeep (BUG-2)', () => {
  it('rewrites UTC Z strings and Dates to the Asia/Jerusalem offset, nested, whole seconds', () => {
    const out = jerusalemDeep({
      a: '2026-10-06T21:15:42.359Z', b: ['2026-11-06T06:22:24.000Z', { c: new Date('2026-01-10T10:00:00Z') }], n: 5, s: 'text', nul: null,
    });
    expect(out).toEqual({ a: '2026-10-07T00:15:42+03:00', b: ['2026-11-06T08:22:24+02:00', { c: '2026-01-10T12:00:00+02:00' }], n: 5, s: 'text', nul: null });
  });
  it('leaves strings that already carry an offset, plain dates and look-alikes alone', () => {
    const v = { a: '2026-10-07T00:15:42+03:00', b: '2026-10-07', c: 'x2026-10-06T21:15:42Z', d: '2026-10-06T21:15:42Zx' };
    expect(jerusalemDeep(v)).toEqual(v);
  });
  it('keeps the listed top-level keys as they are', () => {
    expect(jerusalemDeep({ uploaded_at: '2026-10-06T21:15:42.000Z', other: '2026-10-06T21:15:42.000Z' }, new Set(['uploaded_at'])))
      .toEqual({ uploaded_at: '2026-10-06T21:15:42.000Z', other: '2026-10-07T00:15:42+03:00' });
  });
  it("does not descend into a check's own recorded `fields`", () => {
    const v = { checked_at: '2026-10-06T21:15:42.359Z', fields: { created_at: '2015-02-02T00:00:00Z', as_of: '2020-01-01T00:00:00.000Z' } };
    expect(jerusalemDeep(v)).toEqual({ checked_at: '2026-10-07T00:15:42+03:00', fields: v.fields });
  });
});
