import type { Category, ListingMode } from '../db/types.js';
import { dollarsToCents } from '../money.js';

export const CATEGORIES: readonly Category[] = ['geo', 'trend', 'b2b', 'collision', 'regulation', 'buzzword', 'other'];
export const isCategory = (v: unknown): v is Category => typeof v === 'string' && (CATEGORIES as readonly string[]).includes(v);
const MODES: readonly ListingMode[] = ['bin', 'offer', 'hybrid'];

export interface ListingInput { mode?: unknown; bin?: number | null; floor?: number | null; min_offer?: number | null; lto_max_months?: number | null }
export interface ListingSettings {
  geoBinMinCents: number; geoBinMaxCents: number; highValueCategories: readonly Category[];
  highValueMinBinCents: number; highValueGuardModes: readonly ListingMode[]; sedoHybridAs: 'buy_now' | 'make_offer';
}
export interface NormalizedListing { mode: ListingMode; binCents: number | null; floorCents: number | null; minOfferCents: number | null; ltoMaxMonths: number | null }
export type ListingResult =
  | { ok: true; listing: NormalizedListing; warnings: string[]; overrideUsed: boolean }
  | { ok: false; code: string; message: string };

const MIN_OFFER_FLOOR = 2000;          // $20
const FAST_TRANSFER_MAX = 10_000_000;  // $100,000
const LTO_BIN_MIN = 49_500;            // $495
const LTO_BIN_MAX = 500_000_000;       // $5,000,000

export function listingSettings(row: {
  geo_bin_min_cents: number; geo_bin_max_cents: number; high_value_categories: Category[];
  high_value_min_bin_cents: number; high_value_guard_modes: ListingMode[]; sedo_hybrid_as: 'buy_now' | 'make_offer';
}): ListingSettings {
  return {
    geoBinMinCents: row.geo_bin_min_cents, geoBinMaxCents: row.geo_bin_max_cents,
    highValueCategories: row.high_value_categories, highValueMinBinCents: row.high_value_min_bin_cents,
    highValueGuardModes: row.high_value_guard_modes, sedoHybridAs: row.sedo_hybrid_as,
  };
}

export function validateListing(
  input: ListingInput,
  ctx: { category: Category | null; settings: ListingSettings; override: boolean; overrideReason: string | null; approvalValid: boolean },
): ListingResult {
  const fail = (code: string, message: string): ListingResult => ({ ok: false, code, message });

  // V1, V2
  if (typeof input.mode !== 'string' || !(MODES as readonly string[]).includes(input.mode)) return fail('MODE_INVALID', 'mode must be bin, offer or hybrid');
  const mode = input.mode as ListingMode;
  if (!ctx.category) return fail('CATEGORY_REQUIRED', 'The domain needs a category');

  let bin: number | null, floor: number | null, min: number | null;
  try {
    const c = (x: number | null | undefined) => (x === null || x === undefined ? null : dollarsToCents(x));
    [bin, floor, min] = [c(input.bin), c(input.floor), c(input.min_offer)];
  } catch {
    return fail('LISTING_PRICE_INVALID', 'Prices must be positive USD amounts with at most 2 decimals');
  }
  const lto = input.lto_max_months ?? null;
  const warnings: string[] = [];

  // V3–V5 (never overridable)
  if (mode === 'bin') {
    if (bin === null) return fail('BIN_REQUIRED', 'bin mode needs a bin price');
    if ((floor !== null && floor !== bin) || (min !== null && min !== bin)) return fail('BIN_MODE_NO_NEGOTIATION', 'bin mode: floor and min_offer must be empty or equal to bin');
    if (lto !== null) return fail('LTO_NOT_ALLOWED', 'Lease-to-own is only allowed in hybrid mode');
    if (bin < MIN_OFFER_FLOOR) return fail('MIN_OFFER_TOO_LOW', 'bin mode needs a BIN of at least $20');
    floor = bin;
    min = bin;
  } else if (mode === 'offer') {
    if (bin !== null) return fail('OFFER_MODE_HAS_BIN', 'offer mode has no bin price');
    if (min === null) return fail('MIN_OFFER_REQUIRED', 'offer mode needs min_offer');
    if (min < MIN_OFFER_FLOOR) return fail('MIN_OFFER_TOO_LOW', 'min_offer must be at least $20');
    if (floor !== null && floor < min) return fail('FLOOR_BELOW_MIN_OFFER', 'floor must be ≥ min_offer');
    if (lto !== null) return fail('LTO_NOT_ALLOWED', 'Lease-to-own is only allowed in hybrid mode');
    warnings.push('NO_BIN_LESS_EXPOSURE');
    if (floor !== null) warnings.push('FLOOR_AUTO_ACCEPT');
  } else {
    if (bin === null || floor === null || min === null) return fail('HYBRID_FIELDS_REQUIRED', 'hybrid needs bin, floor and min_offer');
    if (!(MIN_OFFER_FLOOR <= min && min <= floor && floor <= bin)) return fail('HYBRID_PRICES_INVALID', 'hybrid needs $20 ≤ min_offer ≤ floor ≤ bin');
    if (lto !== null && (!Number.isInteger(lto) || lto < 2 || lto > 60 || bin < LTO_BIN_MIN || bin > LTO_BIN_MAX)) {
      return fail('LTO_INVALID', 'Lease-to-own needs 2–60 months and a bin of $495–$5,000,000');
    }
    if (floor < bin) warnings.push('FLOOR_AUTO_ACCEPT');
    if (ctx.settings.sedoHybridAs === 'buy_now') warnings.push('SEDO_NO_FLOOR');
  }

  // V6, V7 (overridable under V8)
  let guard: { code: string; message: string } | null = null;
  const s = ctx.settings;
  if (ctx.category === 'geo') {
    if (mode !== 'bin') guard = { code: 'GEO_MODE_NOT_ALLOWED', message: 'Geo names are strict Buy It Now' };
    else if (bin! < s.geoBinMinCents || bin! > s.geoBinMaxCents) guard = { code: 'GEO_BIN_OUT_OF_RANGE', message: 'Geo BIN must be within the configured range' };
  } else if (s.highValueCategories.includes(ctx.category) && s.highValueGuardModes.includes(mode) && bin !== null && bin < s.highValueMinBinCents) {
    guard = { code: 'HIGH_VALUE_LOW_BIN', message: 'High-value names may not have a BIN below the configured minimum' };
  }
  let overrideUsed = false;
  if (guard) {
    if (!ctx.override) return fail(guard.code, guard.message);
    if (!ctx.overrideReason || ctx.overrideReason.trim() === '' || !ctx.approvalValid) {
      return fail('OVERRIDE_NEEDS_APPROVAL', 'An override needs a reason and a valid approval_ref that names the domain');
    }
    overrideUsed = true;
  }

  if (mode === 'hybrid' && s.highValueCategories.includes(ctx.category) && bin! < s.highValueMinBinCents) warnings.push('HYBRID_BIN_BELOW_HIGH_VALUE_MIN');
  if (bin !== null && bin >= FAST_TRANSFER_MAX) warnings.push('BIN_OVER_FAST_TRANSFER_MAX');
  if (ctx.category === 'other') warnings.push('CATEGORY_OTHER');

  return { ok: true, listing: { mode, binCents: bin, floorCents: floor, minOfferCents: min, ltoMaxMonths: lto }, warnings, overrideUsed };
}

const dollars = (c: number | null) => (c === null ? null : c / 100);

export function presentListing(l: NormalizedListing) {
  return { mode: l.mode, bin: dollars(l.binCents), floor: dollars(l.floorCents), min_offer: dollars(l.minOfferCents), lto_max_months: l.ltoMaxMonths };
}
