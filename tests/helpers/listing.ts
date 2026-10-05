import type { DomainInsert } from '../../src/db/types.js';
import { insertOwnedDomain, testDb } from './db.js';

export function listedDomain(over: Partial<DomainInsert> = {}): Promise<number> {
  return insertOwnedDomain(testDb, { status: 'listed', listing_mode: 'bin', bin_cents: 39900, floor_cents: 39900, min_offer_cents: 39900, ...over });
}
