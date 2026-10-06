import type { Kysely } from 'kysely';
import { newPricingSettings } from '../../src/admin/pricing-settings.js';
import type { Database } from '../../src/db/types.js';
import type { PricingSettings } from '../../src/pricing/settings.js';


export const V2: PricingSettings = {
  version: 2, effectiveAt: new Date('2026-10-05T06:17:00Z'),
  geoBinStrongCents: 49900, geoBinWeakerCents: 39900, geoBinMinCents: 29900, geoBinMaxCents: 49900,
  geoDropsEnabled: true, geoDrops: [{ afterMonths: 12, fromCents: 49900, toCents: 39900 }],
  floorBps: 6500, floorMinCents: 75000, walkawayBps: 4800, walkawayMinCents: 50000, hybridMinOfferCents: 10000,
  drops: [{ afterMonths: 6, pctBps: 2000 }, { afterMonths: 18, pctBps: 2000 }],
  finalPushDaysBeforeDrop: 90, finalPushMode: 'bin_to_floor_ceil95', delistDaysBeforeDrop: 7, headsupDaysBefore: 7,
  compsMin: 2, compsMax: 3, publicLto: false,
  allowedBinsCents: null, nongeoBinMinCents: null, nongeoDefaultBinCents: null, landerExceptionBinsCents: [], floorRounding: 'round5', dropMode: 'pct',
};

/** pricing_settings v3 (listing-strategy.md §10.13), built in memory for unit tests. */
export const V3: PricingSettings = {
  ...V2, version: 3, effectiveAt: new Date('2026-10-06T12:00:00Z'),
  allowedBinsCents: [29900, 39900, 49900, 78800, 108800, 148800, 198800, 248800],
  nongeoBinMinCents: 78800, nongeoDefaultBinCents: 148800, landerExceptionBinsCents: [198800, 248800],
  floorRounding: 'dollar', dropMode: 'ladder',
  drops: [{ afterMonths: 6, steps: 1 }, { afterMonths: 18, steps: 1 }],
  geoDrops: [{ afterMonths: 12, steps: 1 }],
  finalPushMode: 'bin_to_lowest_listed_ge_floor',
};

/** The exact `--set` list DOM runs at the gate (docs/internal/cli.md). */
export const V3_SET: Record<string, string> = {
  allowed_bins_cents: '[29900,39900,49900,78800,108800,148800,198800,248800]',
  nongeo_bin_min_cents: '78800', nongeo_default_bin_cents: '148800', lander_exception_bins_cents: '[198800,248800]',
  floor_rounding: 'dollar', drop_mode: 'ladder',
  drops: '[{"after_months":6,"steps":1},{"after_months":18,"steps":1}]',
  geo_drops: '[{"after_months":12,"steps":1}]',
  final_push_mode: 'bin_to_lowest_listed_ge_floor',
};

/** Create v3 through the admin function (effective a minute ago); returns the new version. */
export async function createV3(db: Kysely<Database>): Promise<number> {
  const { version } = await newPricingSettings(db, {
    set: V3_SET, approvalText: 'Dvir 6 Oct 2026: pricing v3 incl. M6/M18 non-geo, M12 geo, final push to lowest list price >= floor, no exception carry',
    approvalAt: new Date(Date.now() - 3_600_000).toISOString(), now: new Date(Date.now() - 60_000),
  });
  return version;
}
