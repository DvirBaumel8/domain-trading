import { describe, expect, it } from 'vitest';
import { checkSettingsVersion, validateComps, validateListing, type ListingContext, type ListingRequest } from '../../src/services/listing-v2.js';
import { V2 } from '../helpers/pricing.js';

const ctx = (o: Partial<ListingContext> = {}): ListingContext => ({
  category: 'trend', grade: null, phase: 'change', settings: V2, highValueMinBinCents: 250000,
  override: false, overrideReason: null, approvalValid: true, today: '2026-10-12', dropDate: '2028-10-04', ...o,
});
const v = (req: ListingRequest, o: Partial<ListingContext> = {}) => validateListing(req, ctx(o));
const code = (r: ReturnType<typeof validateListing>) => (r.ok ? 'OK' : r.code);
const plan = (r: ReturnType<typeof validateListing>) => { if (!r.ok) throw new Error(`${r.code}: ${r.message}`); return r.plan; };
const OV = { override: true, overrideReason: 'Dvir asked', approvalValid: true };
const geo = (grade: 'strong' | 'weaker' = 'weaker', o: Partial<ListingContext> = {}) => ({ category: 'geo' as const, grade, ...o });

describe('V1–V5 (never overridable)', () => {
  it('LS-1 mode auction → MODE_INVALID', () => expect(code(v({ mode: 'auction' }))).toBe('MODE_INVALID'));
  it('V2: no category → CATEGORY_REQUIRED; geo without grade → GEO_GRADE_REQUIRED', () => {
    expect(code(v({ mode: 'hybrid', bin: 1995 }, { category: null }))).toBe('CATEGORY_REQUIRED');
    expect(code(v({ mode: 'bin', bin: 399 }, { category: 'geo', grade: null }))).toBe('GEO_GRADE_REQUIRED');
  });
  it('LS-2 bin mode without bin → BIN_REQUIRED', () => expect(code(v({ mode: 'bin' }, geo()))).toBe('BIN_REQUIRED'));
  it('LS-3 geo bin 399 + floor 350 → BIN_MODE_NO_NEGOTIATION', () => expect(code(v({ mode: 'bin', bin: 399, floor: 350 }, geo()))).toBe('BIN_MODE_NO_NEGOTIATION'));
  it('LS-4 geo bin 399 → floor = min_offer = walkaway = 399', () => {
    expect(plan(v({ mode: 'bin', bin: 399 }, geo()))).toMatchObject({ mode: 'bin', binCents: 39900, floorCents: 39900, minOfferCents: 39900, walkawayCents: 39900, grade: 'weaker', pricingSource: 'formula', settingsVersion: 2 });
  });
  it('LS-5 bin + lto → LTO_NOT_ALLOWED', () => expect(code(v({ mode: 'bin', bin: 399, lto_max_months: 12 }, geo()))).toBe('LTO_NOT_ALLOWED'));
  it('LS-6–LS-9 offer mode (with override)', () => {
    expect(code(v({ mode: 'offer', bin: 2000, min_offer: 500 }, OV))).toBe('OFFER_MODE_HAS_BIN');
    expect(code(v({ mode: 'offer' }, OV))).toBe('MIN_OFFER_REQUIRED');
    expect(code(v({ mode: 'offer', min_offer: 10 }, OV))).toBe('MIN_OFFER_TOO_LOW');
    expect(code(v({ mode: 'offer', min_offer: 500, floor: 400 }, OV))).toBe('FLOOR_BELOW_MIN_OFFER');
    const p = plan(v({ mode: 'offer', min_offer: 500 }, OV));
    expect(p).toMatchObject({ mode: 'offer', binCents: null, floorCents: null, walkawayCents: null, minOfferCents: 50000, overrideUsed: true });
    expect(p.warnings).toContain('NO_BIN_LESS_EXPOSURE');
  });
  it('offer mode with walkaway → WALKAWAY_NOT_ALLOWED', () => expect(code(v({ mode: 'offer', min_offer: 500, walkaway: 450 }, OV))).toBe('WALKAWAY_NOT_ALLOWED'));
  it('LS-10 hybrid without bin → HYBRID_FIELDS_REQUIRED', () => expect(code(v({ mode: 'hybrid' }))).toBe('HYBRID_FIELDS_REQUIRED'));
  it('LS-11 exception floor 2100 / walkaway 1000 with floor 950 → HYBRID_PRICES_INVALID', () => {
    const ex = { pricing_exception: true, pricing_exception_reason: 'Dvir' };
    expect(code(v({ mode: 'hybrid', bin: 1995, floor: 2100, walkaway: 950, ...ex }))).toBe('HYBRID_PRICES_INVALID');
    expect(code(v({ mode: 'hybrid', bin: 1995, floor: 950, walkaway: 1000, ...ex }))).toBe('HYBRID_PRICES_INVALID');
  });
  it('LS-12 (v2-corrected): LTO without override → LTO_NOT_ALLOWED; with override 1995/12 → OK; 61 months or past drop_date → LTO_INVALID', () => {
    expect(code(v({ mode: 'hybrid', bin: 1995, lto_max_months: 12 }))).toBe('LTO_NOT_ALLOWED');
    expect(plan(v({ mode: 'hybrid', bin: 1995, lto_max_months: 12 }, OV))).toMatchObject({ ltoMaxMonths: 12, overrideUsed: true });
    expect(code(v({ mode: 'hybrid', bin: 1995, lto_max_months: 61 }, OV))).toBe('LTO_INVALID');
    expect(code(v({ mode: 'hybrid', bin: 1995, lto_max_months: 24 }, { ...OV, today: '2026-10-12', dropDate: '2028-10-04' }))).toBe('LTO_INVALID');
  });
  it('LS-13 hybrid 4995 → 3245 / 2400 / 100 + FLOOR_AUTO_ACCEPT', () => {
    const p = plan(v({ mode: 'hybrid', bin: 4995 }));
    expect(p).toMatchObject({ binCents: 499500, floorCents: 324500, walkawayCents: 240000, minOfferCents: 10000 });
    expect(p.warnings).toContain('FLOOR_AUTO_ACCEPT');
  });
  it('LS-15 min_offer 800 / 960 → MIN_OFFER_FIXED; 100 → OK', () => {
    expect(code(v({ mode: 'hybrid', bin: 1995, min_offer: 800 }))).toBe('MIN_OFFER_FIXED');
    expect(code(v({ mode: 'hybrid', bin: 1995, min_offer: 960 }))).toBe('MIN_OFFER_FIXED');
    expect(code(v({ mode: 'hybrid', bin: 1995, min_offer: 100 }))).toBe('OK');
  });
  it('LS-16 bin 1990 / 695 → BIN_NOT_NICE / BIN_BELOW_FLOOR_MIN', () => {
    expect(code(v({ mode: 'hybrid', bin: 1990 }))).toBe('BIN_NOT_NICE');
    expect(code(v({ mode: 'hybrid', bin: 695 }))).toBe('BIN_BELOW_FLOOR_MIN');
  });
  it('LS-17 floor 1200 without exception → PRICING_FORMULA_MISMATCH with computed cents', () => {
    const r = v({ mode: 'hybrid', bin: 1995, floor: 1200 });
    expect(r).toMatchObject({ ok: false, status: 422, code: 'PRICING_FORMULA_MISMATCH', details: { floor_cents: 129500, walkaway_cents: 96000, floor: '$1,295', walkaway: '$960' } });
  });
  it('LS-18 exception 1295/950 with reason + approval → approved_exception + PRICING_EXCEPTION, formula 960', () => {
    const p = plan(v({ mode: 'hybrid', bin: 1995, floor: 1295, walkaway: 950, pricing_exception: true, pricing_exception_reason: 'Dvir 00:39' }));
    expect(p).toMatchObject({ walkawayCents: 95000, pricingSource: 'approved_exception', formula: { floorCents: 129500, walkawayCents: 96000 } });
    expect(p.warnings).toEqual(expect.arrayContaining(['PRICING_EXCEPTION', 'FLOOR_AUTO_ACCEPT']));
  });
  it('exception without reason → EXCEPTION_REASON_REQUIRED; without valid approval → APPROVAL_REQUIRED', () => {
    expect(code(v({ mode: 'hybrid', bin: 1995, floor: 1295, walkaway: 950, pricing_exception: true }))).toBe('EXCEPTION_REASON_REQUIRED');
    expect(code(v({ mode: 'hybrid', bin: 1995, floor: 1295, walkaway: 950, pricing_exception: true, pricing_exception_reason: 'x' }, { approvalValid: false }))).toBe('APPROVAL_REQUIRED');
  });
  it('LS-19 / LS-20: exception floor 700 → FLOOR_BELOW_MIN; walkaway 450 (even with override) → WALKAWAY_BELOW_MIN', () => {
    const ex = { pricing_exception: true, pricing_exception_reason: 'x' };
    expect(code(v({ mode: 'hybrid', bin: 1995, floor: 700, walkaway: 600, ...ex }))).toBe('FLOOR_BELOW_MIN');
    expect(code(v({ mode: 'hybrid', bin: 1995, floor: 1295, walkaway: 450, ...ex }, OV))).toBe('WALKAWAY_BELOW_MIN');
  });
  it('LG-15: an override never bypasses V5 (floor > bin) → HYBRID_PRICES_INVALID', () => {
    expect(code(v({ mode: 'hybrid', bin: 1995, floor: 2100, walkaway: 950, pricing_exception: true, pricing_exception_reason: 'x' }, OV))).toBe('HYBRID_PRICES_INVALID');
  });
});

describe('V6/V7 guards + V8 override', () => {
  it('LG-1 / LG-2 geo manual change: 299 and 499 OK; 298 / 500 → GEO_BIN_OUT_OF_RANGE', () => {
    expect(code(v({ mode: 'bin', bin: 299 }, geo()))).toBe('OK');
    expect(code(v({ mode: 'bin', bin: 499 }, geo()))).toBe('OK');
    expect(code(v({ mode: 'bin', bin: 298 }, geo()))).toBe('GEO_BIN_OUT_OF_RANGE');
    expect(code(v({ mode: 'bin', bin: 500 }, geo()))).toBe('GEO_BIN_OUT_OF_RANGE');
  });
  it('geo at buy: bin must equal the grade price → GEO_BIN_NOT_GRADE_PRICE (LG-19); grade price OK', () => {
    expect(code(v({ mode: 'bin', bin: 399 }, geo('strong', { phase: 'buy' })))).toBe('GEO_BIN_NOT_GRADE_PRICE');
    expect(plan(v({ mode: 'bin', bin: 499 }, geo('strong', { phase: 'buy' })))).toMatchObject({ binCents: 49900, grade: 'strong' });
  });
  it('LG-3 geo offer / hybrid → GEO_MODE_NOT_ALLOWED', () => {
    expect(code(v({ mode: 'offer', min_offer: 300 }, geo()))).toBe('GEO_MODE_NOT_ALLOWED');
    expect(code(v({ mode: 'hybrid', bin: 1995 }, geo()))).toBe('GEO_MODE_NOT_ALLOWED');
  });
  it('LG-4 geo 650 with override → OK, overrideUsed; LG-5 override without reason / approval → OVERRIDE_NEEDS_APPROVAL', () => {
    expect(plan(v({ mode: 'bin', bin: 650 }, geo('weaker', OV)))).toMatchObject({ binCents: 65000, overrideUsed: true });
    expect(code(v({ mode: 'bin', bin: 650 }, geo('weaker', { override: true, overrideReason: null })))).toBe('OVERRIDE_NEEDS_APPROVAL');
    expect(code(v({ mode: 'bin', bin: 650 }, geo('weaker', { override: true, overrideReason: 'x', approvalValid: false })))).toBe('OVERRIDE_NEEDS_APPROVAL');
  });
  it('LG-6 / LG-7 trend bin 999 or 2500 without override → MODE_NOT_ALLOWED_FOR_CATEGORY', () => {
    expect(code(v({ mode: 'bin', bin: 999 }))).toBe('MODE_NOT_ALLOWED_FOR_CATEGORY');
    expect(code(v({ mode: 'bin', bin: 2500 }))).toBe('MODE_NOT_ALLOWED_FOR_CATEGORY');
  });
  it('LG-8 trend bin 999 with override → OK, HIGH_VALUE_LOW_BIN warning; 2500 → no such warning', () => {
    expect(plan(v({ mode: 'bin', bin: 999 }, OV)).warnings).toContain('HIGH_VALUE_LOW_BIN');
    expect(plan(v({ mode: 'bin', bin: 2500 }, OV)).warnings).not.toContain('HIGH_VALUE_LOW_BIN');
  });
  it('LG-10 trend hybrid 1995 → 1995/1295/960, formula, version 2', () => {
    expect(plan(v({ mode: 'hybrid', bin: 1995 }))).toMatchObject({ binCents: 199500, floorCents: 129500, walkawayCents: 96000, minOfferCents: 10000, pricingSource: 'formula', settingsVersion: 2, overrideUsed: false });
  });
  it('geo hybrid with override → hybrid math', () => {
    expect(plan(v({ mode: 'hybrid', bin: 1995 }, geo('strong', OV)))).toMatchObject({ mode: 'hybrid', floorCents: 129500, grade: 'strong', overrideUsed: true });
  });
  it('CATEGORY_OTHER and BIN_OVER_FAST_TRANSFER_MAX pass through', () => {
    expect(plan(v({ mode: 'hybrid', bin: 1995 }, { category: 'other' })).warnings).toContain('CATEGORY_OTHER');
    expect(plan(v({ mode: 'hybrid', bin: 100095 })).warnings).toContain('BIN_OVER_FAST_TRANSFER_MAX');
  });
  it('non-integer cents / bad amounts → LISTING_PRICE_INVALID', () => {
    expect(code(v({ mode: 'hybrid', bin: 1995.555 }))).toBe('LISTING_PRICE_INVALID');
    expect(code(v({ mode: 'hybrid', bin: -5 }))).toBe('LISTING_PRICE_INVALID');
  });
});

describe('V11 comps / V12 version', () => {
  const c = (o: object = {}) => ({ domain: 'compa.com', price_usd: 1500, sold_on: '2026-09-01', venue: 'NameBio', source_url: 'https://namebio.com/compa.com', ...o });
  const vc = (e: unknown) => validateComps(e as never, V2, '2026-10-12');
  it('LG-20: 0/1 comp → COMPS_REQUIRED; 4 → COMPS_INVALID; missing source_url / http / future sold_on / price 0 → COMPS_INVALID', () => {
    expect(vc(null)).toMatchObject({ ok: false, code: 'COMPS_REQUIRED' });
    expect(vc({ comps: [c()] })).toMatchObject({ ok: false, code: 'COMPS_REQUIRED' });
    expect(vc({ comps: [c(), c(), c(), c()] })).toMatchObject({ ok: false, code: 'COMPS_INVALID' });
    expect(vc({ comps: [c(), c({ source_url: undefined })] })).toMatchObject({ ok: false, code: 'COMPS_INVALID' });
    expect(vc({ comps: [c(), c({ source_url: 'http://x.com' })] })).toMatchObject({ ok: false, code: 'COMPS_INVALID' });
    expect(vc({ comps: [c(), c({ sold_on: '2026-10-13' })] })).toMatchObject({ ok: false, code: 'COMPS_INVALID' });
    expect(vc({ comps: [c(), c({ price_usd: 0 })] })).toMatchObject({ ok: false, code: 'COMPS_INVALID' });
    expect(vc({ comps: [c(), c({ sold_on: '2026-02-30' })] })).toMatchObject({ ok: false, code: 'COMPS_INVALID' });
  });
  it('2 or 3 valid comps → ok, rationale kept; extra keys rejected', () => {
    expect(vc({ comps: [c(), c()], rationale: 'two trend comps' })).toMatchObject({ ok: true, rationale: 'two trend comps' });
    expect(vc({ comps: [c(), c(), c()] })).toMatchObject({ ok: true, rationale: null });
    expect(vc({ comps: [c(), c({ extra: 1 })] })).toMatchObject({ ok: false, code: 'COMPS_INVALID' });
  });
  it('LG-21: expected version current − 1 → 409 SETTINGS_VERSION_CHANGED; equal or absent → null', () => {
    expect(checkSettingsVersion(1, V2)).toMatchObject({ ok: false, status: 409, code: 'SETTINGS_VERSION_CHANGED', details: { current_version: 2 } });
    expect(checkSettingsVersion(2, V2)).toBeNull();
    expect(checkSettingsVersion(undefined, V2)).toBeNull();
  });
});

describe('review fixes (round 1)', () => {
  const c = (o: object = {}) => ({ domain: 'compa.com', price_usd: 1500, sold_on: '2026-09-01', venue: 'NameBio', source_url: 'https://namebio.com/compa.com', ...o });
  const vc = (e: unknown) => validateComps(e as never, V2, '2026-10-12');
  it('comps accept cents prices 19.99 and 1100.10; reject 3 decimals', () => {
    expect(vc({ comps: [c({ price_usd: 19.99 }), c({ price_usd: 1100.1 })] })).toMatchObject({ ok: true });
    expect(vc({ comps: [c(), c({ price_usd: 1.005 })] })).toMatchObject({ ok: false, code: 'COMPS_INVALID' });
  });
  it('listing prices must be whole dollars', () => {
    expect(code(v({ mode: 'bin', bin: 399.5 }, geo()))).toBe('LISTING_PRICE_INVALID');
    expect(code(v({ mode: 'offer', min_offer: 500.25 }, OV))).toBe('LISTING_PRICE_INVALID');
    expect(code(v({ mode: 'hybrid', bin: 1995.5, floor: 1295, walkaway: 950, pricing_exception: true, pricing_exception_reason: 'x' }))).toBe('LISTING_PRICE_INVALID');
  });
  it('bin mode walkaway differing from bin → BIN_MODE_NO_NEGOTIATION', () => {
    expect(code(v({ mode: 'bin', bin: 399, walkaway: 300 }, geo()))).toBe('BIN_MODE_NO_NEGOTIATION');
  });
  it('hybrid without bin reports HYBRID_FIELDS_REQUIRED before exception checks', () => {
    expect(code(v({ mode: 'hybrid', pricing_exception: true }))).toBe('HYBRID_FIELDS_REQUIRED');
  });
  it('LTO needs an override even when publicLto is on', () => {
    expect(code(validateListing({ mode: 'hybrid', bin: 1995, lto_max_months: 12 }, ctx({ settings: { ...V2, publicLto: true } })))).toBe('LTO_NOT_ALLOWED');
  });
  it('bin mode BIN >= $100,000 warns BIN_OVER_FAST_TRANSFER_MAX', () => {
    expect(plan(v({ mode: 'bin', bin: 100000 }, OV)).warnings).toContain('BIN_OVER_FAST_TRANSFER_MAX');
  });
  it('evidence: unknown top-level key and rationale over 500 chars → COMPS_INVALID', () => {
    expect(vc({ comps: [c(), c()], extra: 1 })).toMatchObject({ ok: false, code: 'COMPS_INVALID' });
    expect(vc({ comps: [c(), c()], rationale: 'x'.repeat(501) })).toMatchObject({ ok: false, code: 'COMPS_INVALID' });
    expect(vc({ comps: [c(), c()], rationale: 'x'.repeat(500) })).toMatchObject({ ok: true });
  });
});
