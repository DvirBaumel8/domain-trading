import { describe, expect, it } from 'vitest';
import { checkApproval } from '../../src/services/approval.js';

const D = 'examplecityroofing.com';
const now = new Date('2026-10-05T09:00:00Z');
const at = (hoursAgo: number) => new Date(now.getTime() - hoursAgo * 3_600_000).toISOString();

describe('checkApproval (founder rule 1)', () => {
  it('valid: names the domain (any case), within 72 h', () => {
    const r = checkApproval({ text: 'yes buy ExampleCityRoofing.com up to $11.50', approved_at: at(1) }, D, now, 72);
    expect(r).toEqual({ ok: true, approvedAt: new Date(at(1)) });
  });
  it('accepts an explicit offset (IDT)', () => {
    expect(checkApproval({ text: `buy ${D}`, approved_at: '2026-10-05T11:30:00+03:00' }, D, now, 72).ok).toBe(true);
  });
  it.each([
    [null, 'APPROVAL_INVALID'],
    [{}, 'APPROVAL_INVALID'],
    [{ text: '   ', approved_at: at(1) }, 'APPROVAL_INVALID'],
    [{ text: 'yes buy it', approved_at: at(1) }, 'APPROVAL_INVALID'],              // B-7: doesn't name the domain
    [{ text: `buy ${D}`, approved_at: at(73) }, 'APPROVAL_EXPIRED'],               // B-7: 73 h old
    [{ text: `buy ${D}`, approved_at: at(-1) }, 'APPROVAL_INVALID'],               // B-7: in the future
    [{ text: `buy ${D}`, approved_at: '2026-10-05T09:00:00' }, 'APPROVAL_INVALID'], // Review Focus 4: no timezone
    [{ text: `buy ${D}`, approved_at: 'yesterday' }, 'APPROVAL_INVALID'],
    [{ text: `buy ${D}`, approved_at: 12345 }, 'APPROVAL_INVALID'],
  ])('%j → %s', (ref, code) => {
    const r = checkApproval(ref as never, D, now, 72);
    expect(r.ok).toBe(false);
    expect(!r.ok && r.code).toBe(code);
  });
  it('accepts up to 60 s of clock skew into the future (B8), not more', () => {
    const plus = (s: number) => new Date(now.getTime() + s * 1000).toISOString();
    expect(checkApproval({ text: D, approved_at: plus(59) }, D, now, 72).ok).toBe(true);
    expect(checkApproval({ text: D, approved_at: plus(61) }, D, now, 72).ok).toBe(false);
  });
  it('72 h exactly is still valid', () => {
    expect(checkApproval({ text: D, approved_at: at(72) }, D, now, 72).ok).toBe(true);
  });
});
