import { sql, type Kysely } from 'kysely';
import type { Database } from '../../db/types.js';

/** Domains counted against the 40-domain cap (G-86: the money budget is Gavriel's, not the service's). */
export async function activeDomainCount(db: Kysely<Database>): Promise<number> {
  const r = await db
    .selectFrom('domains')
    .select(sql<number>`count(*)::int`.as('n'))
    .where('status', 'in', ['owned', 'listed', 'delisted', 'pending_purchase'])
    .executeTakeFirstOrThrow();
  return Number(r.n);
}
