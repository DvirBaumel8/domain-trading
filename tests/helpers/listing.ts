import type { DomainInsert } from '../../src/db/types.js';
import { insertOwnedDomain, testDb } from './db.js';

/** A listed hybrid trend domain: BIN $1,995 / floor $1,295 / walk-away $960 / min offer $100, pricing v2. */
export function listedDomain(over: Partial<DomainInsert> = {}): Promise<number> {
  return insertOwnedDomain(testDb, {
    status: 'listed', category: 'trend', price_grade: null, listing_mode: 'hybrid', bin_cents: 199500, floor_cents: 129500, walkaway_cents: 96000,
    min_offer_cents: 10000, pricing_source: 'formula', pricing_settings_version: 2, first_listed_at: new Date('2026-10-12T09:00:00Z'), ...over,
  });
}
