import type { Kysely, Selectable } from 'kysely';
import { z } from 'zod';
import type { Database, PricingSettingsTable } from '../db/types.js';
import { AppError } from '../http/errors.js';
import type { Cents } from './int.js';

export interface PricingSettings {
  version: number; effectiveAt: Date;
  geoBinStrongCents: Cents; geoBinWeakerCents: Cents; geoBinMinCents: Cents; geoBinMaxCents: Cents;
  geoDropsEnabled: boolean; geoDrops: { afterMonths: number; fromCents: Cents; toCents: Cents }[];
  floorBps: number; floorMinCents: Cents; walkawayBps: number; walkawayMinCents: Cents; hybridMinOfferCents: Cents;
  drops: { afterMonths: number; pctBps: number }[];
  finalPushDaysBeforeDrop: number; finalPushMode: 'bin_to_floor_ceil95'; delistDaysBeforeDrop: number; headsupDaysBefore: number;
  compsMin: number; compsMax: number; publicLto: boolean;
}

export const RULE_KEYS = [
  'geoBinStrongCents', 'geoBinWeakerCents', 'geoBinMinCents', 'geoBinMaxCents', 'geoDropsEnabled', 'geoDrops',
  'floorBps', 'floorMinCents', 'walkawayBps', 'walkawayMinCents', 'hybridMinOfferCents', 'drops',
  'finalPushDaysBeforeDrop', 'finalPushMode', 'delistDaysBeforeDrop', 'headsupDaysBefore', 'compsMin', 'compsMax', 'publicLto',
] as const satisfies readonly (keyof PricingSettings)[];

export function ruleFields(s: PricingSettings): Record<string, unknown> {
  return Object.fromEntries(RULE_KEYS.map((k) => [k, s[k]]));
}

const Int = z.number().int().nonnegative();
// jsonb keys are snake_case in the DB (listing-strategy.md §10.1); the TS object is camelCase.
const GeoDrops = z.array(z.object({ after_months: Int.positive(), from_cents: Int.positive(), to_cents: Int.positive() }).strict())
  .transform((a) => a.map((d) => ({ afterMonths: d.after_months, fromCents: d.from_cents, toCents: d.to_cents })));
const Drops = z.array(z.object({ after_months: Int.positive(), pct_bps: Int.min(1).max(9999) }).strict())
  .transform((a) => a.map((d) => ({ afterMonths: d.after_months, pctBps: d.pct_bps })));

function checkCrossFields(s: PricingSettings): PricingSettings {
  if (s.drops.length > 2) throw new Error('pricing_settings.drops: at most 2 entries');
  s.drops.forEach((d, i) => {
    if (d.afterMonths >= 24) throw new Error('pricing_settings.drops: after_months must be < 24');
    if (i > 0 && d.afterMonths <= s.drops[i - 1]!.afterMonths) throw new Error('pricing_settings.drops: after_months must be strictly ascending');
  });
  if (s.geoDrops.length > 1) throw new Error('pricing_settings.geo_drops: at most 1 entry');
  const g = s.geoDrops[0];
  if (g) {
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
    geoDropsEnabled: r.geo_drops_enabled, geoDrops: GeoDrops.parse(r.geo_drops),
    floorBps: r.floor_bps, floorMinCents: r.floor_min_cents, walkawayBps: r.walkaway_bps, walkawayMinCents: r.walkaway_min_cents,
    hybridMinOfferCents: r.hybrid_min_offer_cents, drops: Drops.parse(r.drops),
    finalPushDaysBeforeDrop: r.final_push_days_before_drop, finalPushMode: r.final_push_mode,
    delistDaysBeforeDrop: r.delist_days_before_drop, headsupDaysBefore: r.headsup_days_before,
    compsMin: r.comps_min, compsMax: r.comps_max, publicLto: r.public_lto,
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
