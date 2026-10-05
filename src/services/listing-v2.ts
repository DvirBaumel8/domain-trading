import { z } from 'zod';
import type { Category, ListingMode } from '../db/types.js';
import { dollarsToCents, formatUsd } from '../money.js';
import { computePlan } from '../pricing/plan.js';
import { addMonthsClamped } from '../pricing/schedule.js';
import type { PricingSettings } from '../pricing/settings.js';

export const CATEGORIES: readonly Category[] = ['geo', 'trend', 'b2b', 'collision', 'regulation', 'buzzword', 'other'];
export const isCategory = (v: unknown): v is Category => typeof v === 'string' && (CATEGORIES as readonly string[]).includes(v);
const MODES: readonly ListingMode[] = ['bin', 'offer', 'hybrid'];
const MIN_OFFER_FLOOR = 2000; // $20: Afternic's minimum (A3), not a pricing setting
const LTO_BIN_MIN = 49_500; // $495: Afternic LTO rule
const LTO_BIN_MAX = 500_000_000; // $5,000,000: Afternic LTO rule
const DATE = /^\d{4}-\d{2}-\d{2}$/;

export interface ListingRequest {
  mode?: unknown; bin?: number | null; floor?: number | null; walkaway?: number | null; min_offer?: number | null;
  lto_max_months?: number | null; pricing_exception?: boolean | null; pricing_exception_reason?: string | null;
}
export interface ListingContext {
  category: Category | null; grade: 'strong' | 'weaker' | null;
  phase: 'buy' | 'change'; // buy/import: geo bin must be the grade price; change: geo_bin_min <= bin <= geo_bin_max
  settings: PricingSettings; highValueMinBinCents: number;
  override: boolean; overrideReason: string | null; approvalValid: boolean;
  today: string; dropDate: string | null; // LTO must end before dropDate
}
export interface ListingPlan {
  mode: ListingMode; category: Category; grade: 'strong' | 'weaker' | null;
  binCents: number | null; floorCents: number | null; walkawayCents: number | null; minOfferCents: number;
  ltoMaxMonths: number | null; pricingSource: 'formula' | 'approved_exception'; settingsVersion: number;
  overrideUsed: boolean; warnings: string[];
  formula: { floorCents: number; walkawayCents: number } | null; // hybrid: what the formula gives
}
export type Fail = { ok: false; status: 422 | 409; code: string; message: string; details?: Record<string, unknown> };
export type ListingResult = { ok: true; plan: ListingPlan } | Fail;

const fail = (code: string, message: string, details?: Record<string, unknown>, status: 422 | 409 = 422): Fail =>
  ({ ok: false, status, code, message, ...(details ? { details } : {}) });

function wholeDollars(c: number): string {
  const s = formatUsd(c);
  return s.endsWith('.00') ? s.slice(0, -3) : s;
}

export function validateListing(req: ListingRequest, ctx: ListingContext): ListingResult {
  // V1
  if (typeof req.mode !== 'string' || !(MODES as readonly string[]).includes(req.mode)) return fail('MODE_INVALID', 'mode must be bin, offer or hybrid');
  const mode = req.mode as ListingMode;
  // V2
  if (!ctx.category) return fail('CATEGORY_REQUIRED', 'The domain needs a category');
  if (ctx.category === 'geo' && ctx.grade !== 'strong' && ctx.grade !== 'weaker') return fail('GEO_GRADE_REQUIRED', 'Geo names need price_grade strong or weaker');

  let bin: number | null, floor: number | null, walk: number | null, min: number | null;
  try {
    const c = (x: number | null | undefined) => (x === null || x === undefined ? null : dollarsToCents(x));
    [bin, floor, walk, min] = [c(req.bin), c(req.floor), c(req.walkaway), c(req.min_offer)];
  } catch {
    return fail('LISTING_PRICE_INVALID', 'Prices must be positive USD amounts with at most 2 decimals');
  }
  const lto = req.lto_max_months ?? null;
  const exception = req.pricing_exception === true;
  const s = ctx.settings;
  const warnings: string[] = [];
  const guards: { code: string; message: string }[] = [];
  let out: Omit<ListingPlan, 'overrideUsed' | 'warnings'>;

  if (mode === 'bin') {
    // V3
    if (bin === null) return fail('BIN_REQUIRED', 'bin mode needs a bin price');
    if ((floor !== null && floor !== bin) || (min !== null && min !== bin) || exception) {
      return fail('BIN_MODE_NO_NEGOTIATION', 'bin mode: floor, walkaway and min_offer must be empty or equal to bin');
    }
    if (walk !== null && walk !== bin) return fail('WALKAWAY_NOT_ALLOWED', 'bin mode: walkaway must be empty or equal to bin');
    if (lto !== null) return fail('LTO_NOT_ALLOWED', 'Lease-to-own is only allowed in hybrid mode');
    if (bin < MIN_OFFER_FLOOR) return fail('MIN_OFFER_TOO_LOW', 'bin mode needs a BIN of at least $20');
    out = { mode, category: ctx.category, grade: ctx.category === 'geo' ? ctx.grade : null, binCents: bin, floorCents: bin, walkawayCents: bin,
      minOfferCents: bin, ltoMaxMonths: null, pricingSource: 'formula', settingsVersion: s.version, formula: null };
    // V6 / V7
    if (ctx.category === 'geo') {
      if (ctx.phase === 'buy') {
        const gradePrice = ctx.grade === 'strong' ? s.geoBinStrongCents : s.geoBinWeakerCents;
        if (bin !== gradePrice) guards.push({ code: 'GEO_BIN_NOT_GRADE_PRICE', message: 'At buy, a geo BIN must be the grade price' });
      } else if (bin < s.geoBinMinCents || bin > s.geoBinMaxCents) {
        guards.push({ code: 'GEO_BIN_OUT_OF_RANGE', message: 'A geo BIN must be within the configured range' });
      }
    } else {
      guards.push({ code: 'MODE_NOT_ALLOWED_FOR_CATEGORY', message: 'Non-geo names are hybrid; plain bin needs an override' });
      if (bin < ctx.highValueMinBinCents) warnings.push('HIGH_VALUE_LOW_BIN');
    }
  } else if (mode === 'offer') {
    // V4
    if (bin !== null) return fail('OFFER_MODE_HAS_BIN', 'offer mode has no bin price');
    if (min === null) return fail('MIN_OFFER_REQUIRED', 'offer mode needs min_offer');
    if (min < MIN_OFFER_FLOOR) return fail('MIN_OFFER_TOO_LOW', 'min_offer must be at least $20');
    if (floor !== null && floor < min) return fail('FLOOR_BELOW_MIN_OFFER', 'floor must be >= min_offer');
    if (walk !== null || exception) return fail('WALKAWAY_NOT_ALLOWED', 'offer mode has no walk-away or pricing exception');
    if (lto !== null) return fail('LTO_NOT_ALLOWED', 'Lease-to-own is only allowed in hybrid mode');
    warnings.push('NO_BIN_LESS_EXPOSURE');
    if (floor !== null) warnings.push('FLOOR_AUTO_ACCEPT');
    out = { mode, category: ctx.category, grade: ctx.category === 'geo' ? ctx.grade : null, binCents: null, floorCents: floor, walkawayCents: null,
      minOfferCents: min, ltoMaxMonths: null, pricingSource: 'formula', settingsVersion: s.version, formula: null };
    guards.push(ctx.category === 'geo'
      ? { code: 'GEO_MODE_NOT_ALLOWED', message: 'Geo names are strict Buy It Now' }
      : { code: 'MODE_NOT_ALLOWED_FOR_CATEGORY', message: 'offer mode needs an override' });
  } else {
    // V5
    if (exception && !req.pricing_exception_reason?.trim()) return fail('EXCEPTION_REASON_REQUIRED', 'A pricing exception needs pricing_exception_reason');
    if (exception && !ctx.approvalValid) return fail('APPROVAL_REQUIRED', "A pricing exception needs a valid approval_ref (Dvir's words)");
    const r = computePlan({ category: ctx.category, mode: 'hybrid', grade: ctx.grade, binCents: bin, floorCents: floor, walkawayCents: walk, exception }, s);
    if (!r.ok) {
      const d = r.details ?? {};
      const display = Object.fromEntries(Object.entries(d).filter(([k]) => k.endsWith('_cents') && typeof d[k] === 'number')
        .map(([k, val]) => [k.slice(0, -'_cents'.length), wholeDollars(val as number)]));
      return fail(r.code, r.message, { ...d, ...display });
    }
    const p = r.plan;
    if (min !== null && min !== p.minOfferCents) return fail('MIN_OFFER_FIXED', 'min_offer is set by the server', { min_offer_cents: p.minOfferCents, min_offer: wholeDollars(p.minOfferCents) });
    if (lto !== null) {
      if (!Number.isInteger(lto) || lto < 2 || lto > 60 || p.binCents < LTO_BIN_MIN || p.binCents > LTO_BIN_MAX
        || (ctx.dropDate !== null && addMonthsClamped(ctx.today, lto) >= ctx.dropDate)) {
        return fail('LTO_INVALID', 'Lease-to-own needs 2-60 months, a BIN of $495-$5,000,000, and must end before drop_date');
      }
      if (!s.publicLto) guards.push({ code: 'LTO_NOT_ALLOWED', message: 'Public lease-to-own is off; it needs an override' });
    }
    warnings.push(...p.warnings);
    out = { mode, category: ctx.category, grade: p.grade, binCents: p.binCents, floorCents: p.floorCents, walkawayCents: p.walkawayCents,
      minOfferCents: p.minOfferCents, ltoMaxMonths: lto, pricingSource: p.pricingSource, settingsVersion: p.settingsVersion, formula: p.formula };
    if (ctx.category === 'geo') guards.unshift({ code: 'GEO_MODE_NOT_ALLOWED', message: 'Geo names are strict Buy It Now' });
  }

  // V8
  let overrideUsed = false;
  if (guards.length > 0) {
    if (!ctx.override) return fail(guards[0]!.code, guards[0]!.message);
    if (!ctx.overrideReason?.trim() || !ctx.approvalValid) {
      return fail('OVERRIDE_NEEDS_APPROVAL', 'An override needs a reason and a valid approval_ref that names the domain');
    }
    overrideUsed = true;
  }
  if (!overrideUsed) {
    const i = warnings.indexOf('HIGH_VALUE_LOW_BIN');
    if (i >= 0) warnings.splice(i, 1);
  }
  if (ctx.category === 'other' && !warnings.includes('CATEGORY_OTHER')) warnings.push('CATEGORY_OTHER');
  return { ok: true, plan: { ...out, overrideUsed, warnings } };
}

export interface Comp { domain: string; price_usd: number; sold_on: string; venue: string; source_url: string }
export interface Evidence { comps?: unknown; rationale?: unknown }

const CompSchema = z.object({
  domain: z.string().trim().min(3).max(253),
  price_usd: z.number().positive().refine((n) => Number.isFinite(n) && Math.round(n * 100) === n * 100, 'at most 2 decimals'),
  sold_on: z.string().regex(DATE),
  venue: z.string().trim().min(1).max(100),
  source_url: z.string().url().refine((u) => u.startsWith('https://'), 'https only'),
}).strict();

export function validateComps(e: Evidence | null | undefined, s: PricingSettings, today: string):
  { ok: true; comps: Comp[]; rationale: string | null } | Fail {
  const list = e && Array.isArray(e.comps) ? e.comps : [];
  if (list.length < s.compsMin) return fail('COMPS_REQUIRED', `Every buy needs ${s.compsMin}-${s.compsMax} comparable sales`, { comps_min: s.compsMin, comps_max: s.compsMax });
  if (list.length > s.compsMax) return fail('COMPS_INVALID', `At most ${s.compsMax} comparable sales`, { comps_max: s.compsMax });
  const comps: Comp[] = [];
  for (const [i, raw] of list.entries()) {
    const r = CompSchema.safeParse(raw);
    if (!r.success) return fail('COMPS_INVALID', `comps[${i}] is invalid`, { index: i, issues: r.error.issues.map((x) => x.message) });
    const t = new Date(`${r.data.sold_on}T00:00:00Z`);
    if (Number.isNaN(t.getTime()) || t.toISOString().slice(0, 10) !== r.data.sold_on) return fail('COMPS_INVALID', `comps[${i}].sold_on is not a real date`, { index: i });
    if (r.data.sold_on > today) return fail('COMPS_INVALID', `comps[${i}].sold_on is in the future`, { index: i });
    comps.push(r.data);
  }
  if (e && e.rationale !== undefined && e.rationale !== null && typeof e.rationale !== 'string') return fail('COMPS_INVALID', 'rationale must be text');
  const rationale = e && typeof e.rationale === 'string' && e.rationale.trim() ? e.rationale.trim() : null;
  return { ok: true as const, comps, rationale };
}

export function checkSettingsVersion(expected: number | null | undefined, s: PricingSettings): Fail | null {
  if (expected === undefined || expected === null || expected === s.version) return null;
  return fail('SETTINGS_VERSION_CHANGED', 'Pricing settings changed since the preview; re-run GET /pricing/preview and re-ask Dvir',
    { expected_version: expected, current_version: s.version }, 409);
}
