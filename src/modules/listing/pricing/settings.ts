import type { Kysely, Selectable } from 'kysely';
import { z } from 'zod';
import type { Database, PricingSettingsTable } from '../../../db/types.js';
import { AppError } from '../../../http/errors.js';
import type { Cents } from './int.js';

export interface PricingSettings {
  version: number; effectiveAt: Date;
  geoBinStrongCents: Cents; geoBinWeakerCents: Cents; geoBinMinCents: Cents; geoBinMaxCents: Cents;
  geoDropsEnabled: boolean; geoDrops: { afterMonths: number; fromCents?: Cents | null; toCents?: Cents | null; steps?: number | null }[];
  floorBps: number; floorMinCents: Cents; walkawayBps: number; walkawayMinCents: Cents; hybridMinOfferCents: Cents;
  drops: { afterMonths: number; pctBps?: number | null; steps?: number | null }[];
  finalPushDaysBeforeDrop: number; finalPushMode: 'bin_to_floor_ceil95' | 'bin_to_lowest_listed_ge_floor';
  delistDaysBeforeDrop: number; headsupDaysBefore: number;
  compsMin: number; compsMax: number; publicLto: boolean;
  // v3 (listing-strategy.md §10.13); null / defaults = v2 behaviour
  allowedBinsCents: Cents[] | null; nongeoBinMinCents: Cents | null; nongeoDefaultBinCents: Cents | null;
  landerExceptionBinsCents: Cents[]; floorRounding: 'round5' | 'dollar'; dropMode: 'pct' | 'ladder';
}

/** v3 = the settings version has a price list. */
export const isV3 = (s: PricingSettings): boolean => s.allowedBinsCents !== null;

export const RULE_KEYS = [
  'geoBinStrongCents', 'geoBinWeakerCents', 'geoBinMinCents', 'geoBinMaxCents', 'geoDropsEnabled', 'geoDrops',
  'floorBps', 'floorMinCents', 'walkawayBps', 'walkawayMinCents', 'hybridMinOfferCents', 'drops',
  'finalPushDaysBeforeDrop', 'finalPushMode', 'delistDaysBeforeDrop', 'headsupDaysBefore', 'compsMin', 'compsMax', 'publicLto',
] as const satisfies readonly (keyof PricingSettings)[];

// Only present in a v3 fingerprint, so the v2 rule fingerprint (pricing-vectors.v2.json) is unchanged.
export const V3_RULE_KEYS = [
  'allowedBinsCents', 'nongeoBinMinCents', 'nongeoDefaultBinCents', 'landerExceptionBinsCents', 'floorRounding', 'dropMode',
] as const satisfies readonly (keyof PricingSettings)[];

export function ruleFields(s: PricingSettings): Record<string, unknown> {
  const keys: readonly (keyof PricingSettings)[] = isV3(s) ? [...RULE_KEYS, ...V3_RULE_KEYS] : RULE_KEYS;
  return Object.fromEntries(keys.map((k) => [k, s[k]]));
}

const Int = z.number().int().nonnegative();
// jsonb keys are snake_case in the DB (listing-strategy.md §10.1); the TS object is camelCase.
const GeoDrops = z.array(z.object({ after_months: Int.positive(), from_cents: Int.positive(), to_cents: Int.positive() }).strict())
  .transform((a) => a.map((d) => ({ afterMonths: d.after_months, fromCents: d.from_cents, toCents: d.to_cents })));
const Drops = z.array(z.object({ after_months: Int.positive(), pct_bps: Int.min(1).max(9999) }).strict())
  .transform((a) => a.map((d) => ({ afterMonths: d.after_months, pctBps: d.pct_bps })));
const LadderDrops = z.array(z.object({ after_months: Int.positive(), steps: Int.positive() }).strict())
  .transform((a) => a.map((d) => ({ afterMonths: d.after_months, steps: d.steps })));

function checkLadder(s: PricingSettings): void {
  const list = s.allowedBinsCents;
  if (list === null || s.nongeoBinMinCents === null || s.nongeoDefaultBinCents === null) {
    throw new Error('pricing_settings: ladder mode needs allowed_bins_cents, nongeo_bin_min_cents and nongeo_default_bin_cents');
  }
  if (list.length === 0 || list.some((v, i) => !(v > 0) || v % 100 !== 0 || (i > 0 && v <= list[i - 1]!))) {
    throw new Error('pricing_settings.allowed_bins_cents: must be positive whole dollars, strictly ascending and unique');
  }
  if (!list.includes(s.nongeoDefaultBinCents)) throw new Error('pricing_settings.nongeo_default_bin_cents: must be on allowed_bins_cents');
  if (s.nongeoDefaultBinCents < s.nongeoBinMinCents) throw new Error('pricing_settings.nongeo_default_bin_cents: must be >= nongeo_bin_min_cents');
  if (!list.some((v) => v >= s.nongeoBinMinCents!)) throw new Error('pricing_settings.nongeo_bin_min_cents: no allowed BIN is at or above it');
  if (!s.landerExceptionBinsCents.every((v) => list.includes(v))) throw new Error('pricing_settings.lander_exception_bins_cents: must be on allowed_bins_cents');
  if (!list.includes(s.geoBinStrongCents) || !list.includes(s.geoBinWeakerCents)) throw new Error('pricing_settings: geo grade prices must be on allowed_bins_cents');
  if (!list.some((v) => v >= s.geoBinMinCents && v <= s.geoBinMaxCents)) throw new Error('pricing_settings: no allowed BIN is within geo_bin_min_cents..geo_bin_max_cents');
  if (s.drops.some((d) => !(d.steps != null && d.steps >= 1))) throw new Error('pricing_settings.drops: ladder entries need steps >= 1');
  if (s.geoDrops.some((d) => !(d.steps != null && d.steps >= 1))) throw new Error('pricing_settings.geo_drops: ladder entries need steps >= 1');
}

function checkCrossFields(s: PricingSettings): PricingSettings {
  if (s.drops.length > 2) throw new Error('pricing_settings.drops: at most 2 entries');
  s.drops.forEach((d, i) => {
    if (d.afterMonths >= 24) throw new Error('pricing_settings.drops: after_months must be < 24');
    if (i > 0 && d.afterMonths <= s.drops[i - 1]!.afterMonths) throw new Error('pricing_settings.drops: after_months must be strictly ascending');
  });
  if (s.geoDrops.length > 1) throw new Error('pricing_settings.geo_drops: at most 1 entry');
  const g = s.geoDrops[0];
  if (s.dropMode === 'ladder') checkLadder(s);
  else if (s.floorRounding !== 'round5' || s.landerExceptionBinsCents.length > 0) {
    throw new Error("pricing_settings: floor_rounding other than round5 and lander_exception_bins_cents need drop_mode ladder");
  }
  else if (s.finalPushMode === 'bin_to_lowest_listed_ge_floor') throw new Error('pricing_settings.final_push_mode bin_to_lowest_listed_ge_floor requires drop_mode ladder');
  if (g && s.dropMode === 'pct') {
    if (g.fromCents !== s.geoBinStrongCents) throw new Error('pricing_settings.geo_drops: from_cents must equal geo_bin_strong_cents');
    if (g.toCents !== s.geoBinWeakerCents) throw new Error('pricing_settings.geo_drops: to_cents must equal geo_bin_weaker_cents');
    if (g.toCents >= g.fromCents) throw new Error('pricing_settings.geo_drops: to_cents must be below from_cents');
  }
  if (s.hybridMinOfferCents > s.walkawayMinCents) throw new Error('pricing_settings: hybrid_min_offer_cents must be <= walkaway_min_cents');
  return s;
}

export function rowToSettings(r: Selectable<PricingSettingsTable>): PricingSettings {
  return checkCrossFields({
    version: r.version, effectiveAt: r.effective_at,
    geoBinStrongCents: r.geo_bin_strong_cents, geoBinWeakerCents: r.geo_bin_weaker_cents,
    geoBinMinCents: r.geo_bin_min_cents, geoBinMaxCents: r.geo_bin_max_cents,
    geoDropsEnabled: r.geo_drops_enabled, geoDrops: (r.drop_mode === 'ladder' ? LadderDrops : GeoDrops).parse(r.geo_drops),
    floorBps: r.floor_bps, floorMinCents: r.floor_min_cents, walkawayBps: r.walkaway_bps, walkawayMinCents: r.walkaway_min_cents,
    hybridMinOfferCents: r.hybrid_min_offer_cents, drops: (r.drop_mode === 'ladder' ? LadderDrops : Drops).parse(r.drops),
    finalPushDaysBeforeDrop: r.final_push_days_before_drop, finalPushMode: r.final_push_mode,
    delistDaysBeforeDrop: r.delist_days_before_drop, headsupDaysBefore: r.headsup_days_before,
    compsMin: r.comps_min, compsMax: r.comps_max, publicLto: r.public_lto,
    allowedBinsCents: r.allowed_bins_cents, nongeoBinMinCents: r.nongeo_bin_min_cents, nongeoDefaultBinCents: r.nongeo_default_bin_cents,
    landerExceptionBinsCents: r.lander_exception_bins_cents, floorRounding: r.floor_rounding, dropMode: r.drop_mode,
  });
}

export async function currentSettings(db: Kysely<Database>, now: Date): Promise<PricingSettings> {
  const r = await db.selectFrom('pricing_settings').selectAll().where('effective_at', '<=', now).orderBy('version', 'desc').executeTakeFirst();
  if (!r) throw new AppError(500, 'PRICING_SETTINGS_MISSING', 'No pricing_settings version is in effect');
  return rowToSettings(r);
}

export async function settingsByVersion(db: Kysely<Database>, version: number): Promise<PricingSettings | null> {
  const r = await db.selectFrom('pricing_settings').selectAll().where('version', '=', version).executeTakeFirst();
  return r ? rowToSettings(r) : null;
}
