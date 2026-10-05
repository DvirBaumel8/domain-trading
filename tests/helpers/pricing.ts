import type { PricingSettings } from '../../src/pricing/settings.js';


export const V2: PricingSettings = {
  version: 2, effectiveAt: new Date('2026-10-05T06:17:00Z'),
  geoBinStrongCents: 49900, geoBinWeakerCents: 39900, geoBinMinCents: 29900, geoBinMaxCents: 49900,
  geoDropsEnabled: true, geoDrops: [{ afterMonths: 12, fromCents: 49900, toCents: 39900 }],
  floorBps: 6500, floorMinCents: 75000, walkawayBps: 4800, walkawayMinCents: 50000, hybridMinOfferCents: 10000,
  drops: [{ afterMonths: 6, pctBps: 2000 }, { afterMonths: 18, pctBps: 2000 }],
  finalPushDaysBeforeDrop: 90, finalPushMode: 'bin_to_floor_ceil95', delistDaysBeforeDrop: 7, headsupDaysBefore: 7,
  compsMin: 2, compsMax: 3, publicLto: false,
};
