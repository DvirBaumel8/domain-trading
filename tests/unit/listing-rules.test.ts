import { describe, expect, it } from 'vitest';
import type { Category } from '../../src/db/types.js';
import { presentListing, validateListing, type ListingInput, type ListingSettings } from '../../src/services/listing-rules.js';

const S: ListingSettings = {
  geoBinMinCents: 29900, geoBinMaxCents: 49900,
  highValueCategories: ['trend', 'b2b', 'collision', 'regulation', 'buzzword'],
  highValueMinBinCents: 250000, highValueGuardModes: ['bin'], sedoHybridAs: 'buy_now',
};
const v = (input: ListingInput, category: Category | null = 'geo', extra: Partial<{ override: boolean; overrideReason: string | null; approvalValid: boolean; settings: ListingSettings }> = {}) =>
  validateListing(input, { category, settings: extra.settings ?? S, override: extra.override ?? false, overrideReason: extra.overrideReason ?? null, approvalValid: extra.approvalValid ?? false });
const code = (r: ReturnType<typeof v>) => (r.ok ? 'OK' : r.code);

describe('validateListing: modes (V1–V5)', () => {
  it('LS-1: unknown mode → MODE_INVALID', () => expect(code(v({ mode: 'auction', bin: 399 }))).toBe('MODE_INVALID'));
  it('V2: no category → CATEGORY_REQUIRED', () => expect(code(v({ mode: 'bin', bin: 399 }, null))).toBe('CATEGORY_REQUIRED'));
  it('LS-2: bin without bin → BIN_REQUIRED', () => expect(code(v({ mode: 'bin' }))).toBe('BIN_REQUIRED'));
  it('LS-3: bin 399 + floor 350 → BIN_MODE_NO_NEGOTIATION', () =>
    expect(code(v({ mode: 'bin', bin: 399, floor: 350 }))).toBe('BIN_MODE_NO_NEGOTIATION'));
  it('LS-4: bin 399 → floor = min_offer = bin', () => {
    const r = v({ mode: 'bin', bin: 399 });
    expect(r.ok && r.listing).toEqual({ mode: 'bin', binCents: 39900, floorCents: 39900, minOfferCents: 39900, ltoMaxMonths: null });
  });
  it('bin with floor = min_offer = bin is accepted', () => expect(code(v({ mode: 'bin', bin: 399, floor: 399, min_offer: 399 }))).toBe('OK'));
  it('LS-5: bin + LTO → LTO_NOT_ALLOWED', () => expect(code(v({ mode: 'bin', bin: 399, lto_max_months: 12 }))).toBe('LTO_NOT_ALLOWED'));
  it('LS-6: offer + bin → OFFER_MODE_HAS_BIN', () => expect(code(v({ mode: 'offer', bin: 2000, min_offer: 500 }, 'trend'))).toBe('OFFER_MODE_HAS_BIN'));
  it('LS-7: offer without / below-$20 min_offer', () => {
    expect(code(v({ mode: 'offer' }, 'trend'))).toBe('MIN_OFFER_REQUIRED');
    expect(code(v({ mode: 'offer', min_offer: 10 }, 'trend'))).toBe('MIN_OFFER_TOO_LOW');
  });
  it('LS-8: offer floor < min_offer → FLOOR_BELOW_MIN_OFFER', () =>
    expect(code(v({ mode: 'offer', min_offer: 500, floor: 400 }, 'trend'))).toBe('FLOOR_BELOW_MIN_OFFER'));
  it('LS-9: offer min 500 → OK + NO_BIN_LESS_EXPOSURE', () => {
    const r = v({ mode: 'offer', min_offer: 500 }, 'trend');
    expect(r.ok && r.warnings).toContain('NO_BIN_LESS_EXPOSURE');
  });
  it('LS-10: hybrid missing floor → HYBRID_FIELDS_REQUIRED', () =>
    expect(code(v({ mode: 'hybrid', bin: 1995, min_offer: 950 }, 'trend'))).toBe('HYBRID_FIELDS_REQUIRED'));
  it('LS-11: hybrid floor > bin, or min > floor → HYBRID_PRICES_INVALID', () => {
    expect(code(v({ mode: 'hybrid', bin: 1995, floor: 2100, min_offer: 950 }, 'trend'))).toBe('HYBRID_PRICES_INVALID');
    expect(code(v({ mode: 'hybrid', bin: 1995, floor: 950, min_offer: 1000 }, 'trend'))).toBe('HYBRID_PRICES_INVALID');
  });
  it('LS-12: hybrid LTO with bin 450 / LTO 61 → LTO_INVALID', () => {
    expect(code(v({ mode: 'hybrid', bin: 450, floor: 400, min_offer: 300, lto_max_months: 24 }, 'trend'))).toBe('LTO_INVALID');
    expect(code(v({ mode: 'hybrid', bin: 4999, floor: 2500, min_offer: 1000, lto_max_months: 61 }, 'trend'))).toBe('LTO_INVALID');
  });
  it('LS-13: hybrid 4999/2500/1000 + LTO 24 → OK + FLOOR_AUTO_ACCEPT', () => {
    const r = v({ mode: 'hybrid', bin: 4999, floor: 2500, min_offer: 1000, lto_max_months: 24 }, 'trend');
    expect(r.ok && r.warnings).toContain('FLOOR_AUTO_ACCEPT');
    expect(r.ok && r.listing.ltoMaxMonths).toBe(24);
  });
  it('prices with >2 decimals → LISTING_PRICE_INVALID', () => expect(code(v({ mode: 'bin', bin: 399.999 }))).toBe('LISTING_PRICE_INVALID'));
});

describe('validateListing: guards (V6–V8)', () => {
  it('LG-1: geo bin 299 / 499 edges OK', () => {
    expect(code(v({ mode: 'bin', bin: 299 }))).toBe('OK');
    expect(code(v({ mode: 'bin', bin: 499 }))).toBe('OK');
  });
  it('LG-2: geo bin 298 / 500 → GEO_BIN_OUT_OF_RANGE', () => {
    expect(code(v({ mode: 'bin', bin: 298 }))).toBe('GEO_BIN_OUT_OF_RANGE');
    expect(code(v({ mode: 'bin', bin: 500 }))).toBe('GEO_BIN_OUT_OF_RANGE');
  });
  it('LG-3: geo offer/hybrid → GEO_MODE_NOT_ALLOWED', () => {
    expect(code(v({ mode: 'offer', min_offer: 500 }))).toBe('GEO_MODE_NOT_ALLOWED');
    expect(code(v({ mode: 'hybrid', bin: 450, floor: 400, min_offer: 300 }))).toBe('GEO_MODE_NOT_ALLOWED');
  });
  it('LG-4: geo bin 650 with override + reason + valid approval → OK, overrideUsed', () => {
    const r = v({ mode: 'bin', bin: 650 }, 'geo', { override: true, overrideReason: 'premium city', approvalValid: true });
    expect(r.ok && r.overrideUsed).toBe(true);
  });
  it('LG-5: override without approval or reason → OVERRIDE_NEEDS_APPROVAL', () => {
    expect(code(v({ mode: 'bin', bin: 650 }, 'geo', { override: true, overrideReason: 'x', approvalValid: false }))).toBe('OVERRIDE_NEEDS_APPROVAL');
    expect(code(v({ mode: 'bin', bin: 650 }, 'geo', { override: true, overrideReason: '  ', approvalValid: true }))).toBe('OVERRIDE_NEEDS_APPROVAL');
  });
  it('LG-6/LG-7: trend bin 999 → HIGH_VALUE_LOW_BIN; 2500 edge OK', () => {
    expect(code(v({ mode: 'bin', bin: 999 }, 'trend'))).toBe('HIGH_VALUE_LOW_BIN');
    expect(code(v({ mode: 'bin', bin: 2500 }, 'trend'))).toBe('OK');
  });
  it('LG-8: trend bin 999 with override + approval → OK', () =>
    expect(code(v({ mode: 'bin', bin: 999 }, 'trend', { override: true, overrideReason: 'r', approvalValid: true }))).toBe('OK'));
  it('LG-9: D-001 plan trend hybrid 1995/950/950 → OK + HYBRID_BIN_BELOW_HIGH_VALUE_MIN + FLOOR_AUTO_ACCEPT + SEDO_NO_FLOOR', () => {
    const r = v({ mode: 'hybrid', bin: 1995, floor: 950, min_offer: 950 }, 'trend');
    expect(r.ok && r.warnings).toEqual(expect.arrayContaining(['HYBRID_BIN_BELOW_HIGH_VALUE_MIN', 'FLOOR_AUTO_ACCEPT', 'SEDO_NO_FLOOR']));
  });
  it('LG-10: guard modes bin+hybrid → D-001 plan → HIGH_VALUE_LOW_BIN', () =>
    expect(code(v({ mode: 'hybrid', bin: 1995, floor: 950, min_offer: 950 }, 'trend', { settings: { ...S, highValueGuardModes: ['bin', 'hybrid'] } })))
      .toBe('HIGH_VALUE_LOW_BIN'));
  it('LG-15: override never bypasses V1–V5', () =>
    expect(code(v({ mode: 'hybrid', bin: 1995, floor: 2100, min_offer: 950 }, 'trend', { override: true, overrideReason: 'r', approvalValid: true })))
      .toBe('HYBRID_PRICES_INVALID'));
  it('warnings: BIN_OVER_FAST_TRANSFER_MAX at ≥ $100,000; CATEGORY_OTHER', () => {
    expect((v({ mode: 'bin', bin: 100000 }, 'trend') as { warnings: string[] }).warnings).toContain('BIN_OVER_FAST_TRANSFER_MAX');
    expect((v({ mode: 'bin', bin: 399 }, 'other') as { warnings: string[] }).warnings).toContain('CATEGORY_OTHER');
  });
});

describe('presentListing', () => {
  it('whole dollars', () => {
    expect(presentListing({ mode: 'hybrid', binCents: 199500, floorCents: 95000, minOfferCents: 95000, ltoMaxMonths: null }))
      .toEqual({ mode: 'hybrid', bin: 1995, floor: 950, min_offer: 950, lto_max_months: null });
  });
});
