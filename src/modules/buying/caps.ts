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

export interface LaneCounts { total: number; line1: number; s8: number }

/** v5.8.0 (CR-059): active names in total, in Line 1 (lane NULL) and in Line 2 (lane S8). */
export async function activeLaneCounts(db: Kysely<Database>): Promise<LaneCounts> {
  const r = await db
    .selectFrom('domains')
    .select([sql<number>`count(*)::int`.as('total'), sql<number>`count(*) filter (where lane is null)::int`.as('line1'), sql<number>`count(*) filter (where lane = 'S8')::int`.as('s8')])
    .where('status', 'in', ['owned', 'listed', 'delisted', 'pending_purchase'])
    .executeTakeFirstOrThrow();
  return { total: Number(r.total), line1: Number(r.line1), s8: Number(r.s8) };
}

/**
 * The domain cap (founder rule 2, migration only). Since 5.52.0 both lines share the total: a Line 1 buy and an S8 import are each refused
 * once the total reaches max_domains (no slots are reserved any more). Returns the refusing code or null.
 */
export function laneCapBlock(c: LaneCounts, cfg: { max_domains: number }): 'DOMAIN_CAP_REACHED' | null {
  return c.total >= cfg.max_domains ? 'DOMAIN_CAP_REACHED' : null;
}
