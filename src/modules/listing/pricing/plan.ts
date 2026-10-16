import { ceil95, pct, round5, roundDollar } from './round.js';
import type { Category } from '../../../db/types.js';
import type { Cents } from './int.js';
import { isV3, type PricingSettings } from './settings.js';

export type PlanCategory = Category;
export interface PlanInput {
  category: PlanCategory; grade?: 'strong' | 'weaker' | null; binCents?: Cents | null;
  floorCents?: Cents | null; walkawayCents?: Cents | null; exception?: boolean;
  mode?: 'hybrid'; // 'hybrid' on a geo category = hybrid math (geo override)
  s8?: boolean; // v5.9.0 (CR-060): an S8 (Line 2) name: its BIN is exempt from the Line 1 price list and the LANDER-1 exception prices
  carried?: boolean; // re-validating a stored plan unchanged: the v3 price list does not apply to it
}
export interface Plan {
  mode: 'bin' | 'hybrid'; category: PlanCategory; grade: 'strong' | 'weaker' | null;
  binCents: Cents; floorCents: Cents; walkawayCents: Cents; minOfferCents: Cents;
  pricingSource: 'formula' | 'approved_exception'; settingsVersion: number; warnings: string[];
  formula: { floorCents: Cents; walkawayCents: Cents } | null;
}
export type PlanResult = { ok: true; plan: Plan } | { ok: false; code: string; message: string; details?: Record<string, unknown> };

export const FAST_TRANSFER_MAX_CENTS = 10_000_000; // Afternic Premium network limit ($100,000); an Afternic rule, not a pricing setting
const BAND = 10000;
const ENDING_95 = 9500;

const fail = (code: string, message: string, details?: Record<string, unknown>): PlanResult => ({ ok: false, code, message, details });

export function hybridBinMin(s: PricingSettings): Cents {
  return isV3(s) ? (s.nongeoBinMinCents ?? ceil95(s.floorMinCents)) : ceil95(s.floorMinCents);
}

/** The one floor / walk-away formula (plans and ladder drops both use it). */
export function priceFormula(bin: Cents, s: PricingSettings): { floorCents: Cents; walkawayCents: Cents; raised: boolean } {
  const rawFloor = (s.floorRounding === 'dollar' ? roundDollar : round5)(pct(bin, s.floorBps));
  const floorCents = Math.min(bin, Math.max(rawFloor, s.floorMinCents));
  const walkawayCents = Math.min(floorCents, Math.max(round5(pct(bin, s.walkawayBps)), s.walkawayMinCents));
  return { floorCents, walkawayCents, raised: rawFloor < s.floorMinCents };
}

export function computePlan(input: PlanInput, s: PricingSettings): PlanResult {
  for (const [field, v] of [['bin_cents', input.binCents], ['floor_cents', input.floorCents], ['walkaway_cents', input.walkawayCents]] as const) {
    if (v != null && !(Number.isSafeInteger(v) && v > 0)) return fail('VALIDATION_ERROR', `${field} must be a positive integer number of cents`);
  }
  const warnings: string[] = [];
  if (input.category === 'other') warnings.push('CATEGORY_OTHER');

  if (input.category === 'geo' && input.mode !== 'hybrid') {
    if (input.grade !== 'strong' && input.grade !== 'weaker') return fail('GEO_GRADE_REQUIRED', 'Geo names need price_grade strong or weaker');
    const bin = input.grade === 'strong' ? s.geoBinStrongCents : s.geoBinWeakerCents;
    const sentBin = input.binCents ?? bin;
    if ((input.floorCents != null && input.floorCents !== sentBin) || (input.walkawayCents != null && input.walkawayCents !== sentBin)) {
      return fail('BIN_MODE_NO_NEGOTIATION', 'Geo names are strict Buy It Now: floor and walk-away equal the BIN');
    }
    if (input.binCents != null && input.binCents !== bin) {
      return fail('GEO_BIN_NOT_GRADE_PRICE', 'A geo BIN must be the grade price', { grade: input.grade, bin_cents: bin });
    }
    return { ok: true, plan: {
      mode: 'bin', category: 'geo', grade: input.grade, binCents: bin, floorCents: bin, walkawayCents: bin, minOfferCents: bin,
      pricingSource: 'formula', settingsVersion: s.version, warnings, formula: null,
    } };
  }

  const bin = input.binCents;
  if (bin == null) return fail('HYBRID_FIELDS_REQUIRED', 'hybrid needs bin');
  const exception = input.exception === true;
  if (exception && (input.floorCents == null || input.walkawayCents == null)) {
    return fail('HYBRID_FIELDS_REQUIRED', 'An exception needs both floor and walkaway');
  }
  const v3 = isV3(s) && input.carried !== true;
  if (v3) {
    // v3 (§10.13): the price list replaces the x95 and minimum-BIN rules; an exception never waives it
    const list = s.allowedBinsCents ?? [];
    if (input.s8 === true) {
      // v5.9.0 (CR-060, Dvir): S8 BINs come from the S8 ladder or an approved override, not the price list; only the minimum BIN holds
      if (bin < hybridBinMin(s)) return fail('BIN_BELOW_FLOOR_MIN', 'BIN is below the minimum hybrid BIN', { min_bin_cents: hybridBinMin(s) });
    } else if (!list.includes(bin) || bin < hybridBinMin(s)) {
      return fail('BIN_NOT_IN_PRICE_LIST', 'A hybrid BIN must be on the price list', { allowed_bins_cents: list.filter((v) => v >= hybridBinMin(s)), min_bin_cents: hybridBinMin(s) });
    }
    if (input.s8 !== true && s.landerExceptionBinsCents.includes(bin)) {
      return fail('LANDER_EXCEPTION_REQUIRED', 'This BIN needs LANDER-1 evidence from the screening pack', { bin_cents: bin, needs: 'screening_pack (CR-001 P1b)' });
    }
  } else {
    if (!exception && bin % BAND !== ENDING_95) return fail('BIN_NOT_NICE', 'A non-geo BIN must be a whole-dollar price ending in 95');
    if (bin < hybridBinMin(s)) return fail('BIN_BELOW_FLOOR_MIN', 'BIN is below the minimum hybrid BIN', { min_bin_cents: hybridBinMin(s) });
  }

  const f = priceFormula(bin, s);
  let floorCents = f.floorCents;
  let walkawayCents = f.walkawayCents;
  let pricingSource: Plan['pricingSource'] = 'formula';

  if (exception) {
    floorCents = input.floorCents ?? floorCents;
    walkawayCents = input.walkawayCents ?? walkawayCents;
    if (!(walkawayCents <= floorCents && floorCents <= bin)) return fail('HYBRID_PRICES_INVALID', 'Need walkaway ≤ floor ≤ bin');
    if (floorCents < s.floorMinCents) return fail('FLOOR_BELOW_MIN', 'Floor is below the minimum', { floor_min_cents: s.floorMinCents });
    if (walkawayCents < s.walkawayMinCents) return fail('WALKAWAY_BELOW_MIN', 'Walk-away is below the minimum', { walkaway_min_cents: s.walkawayMinCents });
    pricingSource = 'approved_exception';
    if (floorCents !== f.floorCents || walkawayCents !== f.walkawayCents || (!v3 && bin % BAND !== ENDING_95)) warnings.push('PRICING_EXCEPTION');
  } else if (
    (input.floorCents != null && input.floorCents !== f.floorCents) ||
    (input.walkawayCents != null && input.walkawayCents !== f.walkawayCents)
  ) {
    return fail('PRICING_FORMULA_MISMATCH', 'floor/walkaway differ from the formula; send pricing_exception with approval_ref, or omit them', {
      floor_cents: f.floorCents, walkaway_cents: f.walkawayCents,
    });
  }

  if (f.raised && pricingSource === 'formula') warnings.push('FLOOR_RAISED_TO_MIN');
  if (floorCents < bin) warnings.push('FLOOR_AUTO_ACCEPT');
  if (bin >= FAST_TRANSFER_MAX_CENTS) warnings.push('BIN_OVER_FAST_TRANSFER_MAX');

  return { ok: true, plan: {
    mode: 'hybrid', category: input.category, grade: input.category === 'geo' ? (input.grade ?? null) : null, binCents: bin, floorCents, walkawayCents,
    minOfferCents: Math.min(s.hybridMinOfferCents, walkawayCents),
    pricingSource, settingsVersion: s.version, warnings, formula: { floorCents: f.floorCents, walkawayCents: f.walkawayCents },
  } };
}

export interface S8LadderStep { max_len: number | null; bin_cents: number }

/** The S8 ladder from the settings row (`settings.s8_bin_ladder`): ascending by max_len, the last step has max_len null. Throws on a malformed row. */
export function parseS8Ladder(raw: unknown): S8LadderStep[] {
  const ok = Array.isArray(raw) && raw.length > 0 && raw.every((x, i) => x && typeof x === 'object'
    && Number.isSafeInteger((x as S8LadderStep).bin_cents) && (x as S8LadderStep).bin_cents > 0
    && (((x as S8LadderStep).max_len === null && i === raw.length - 1) || Number.isSafeInteger((x as S8LadderStep).max_len)));
  if (!ok) throw new Error('settings.s8_bin_ladder is malformed');
  return raw as S8LadderStep[];
}

/**
 * v5.9.0 (CR-060): the default BIN of an imported S8 name = the first ladder step whose max_len is >= the name's length (characters before ".com").
 * Replaces the CR-059 comps rung. The ladder is not the Line 1 price list (Dvir's CR-060 decision).
 */
export function s8LadderBin(domain: string, ladder: unknown): Cents {
  const steps = parseS8Ladder(ladder);
  const len = domain.endsWith('.com') ? domain.length - 4 : domain.length;
  const step = steps.find((x) => x.max_len === null || len <= x.max_len) ?? steps[steps.length - 1]!;
  return step.bin_cents;
}
