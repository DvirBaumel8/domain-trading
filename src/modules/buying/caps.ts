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
 * The domain caps (founder rule 2, migration only). A Line 1 buy needs the total under max_domains AND Line 1 under max_domains - s8_reserved_slots;
 * an S8 import needs the total under max_domains AND S8 names under s8_reserved_slots. Returns the refusing code or null.
 */
export function laneCapBlock(lane: 'S8' | null, c: LaneCounts, cfg: { max_domains: number; s8_reserved_slots: number }): 'DOMAIN_CAP_REACHED' | 'S8_SLOTS_FULL' | null {
  if (c.total >= cfg.max_domains) return 'DOMAIN_CAP_REACHED';
  if (lane === 'S8') return c.s8 >= cfg.s8_reserved_slots ? 'S8_SLOTS_FULL' : null;
  return c.line1 >= cfg.max_domains - cfg.s8_reserved_slots ? 'DOMAIN_CAP_REACHED' : null;
}
