import { sql, type Kysely } from 'kysely';
import type { Database } from '../db/types.js';

/** −Σ registration + renewal + fee (money spent against the POC cap). */
export async function spentCents(db: Kysely<Database>): Promise<number> {
  const r = await db
    .selectFrom('ledger_entries')
    .select(sql<number>`coalesce(-sum(amount_cents), 0)::bigint`.as('spent'))
    .where('type', 'in', ['registration', 'renewal', 'fee'])
    .executeTakeFirstOrThrow();
  return Number(r.spent);
}

/** Expected cost of purchases that may still charge. */
export async function pendingCents(db: Kysely<Database>): Promise<number> {
  const r = await db
    .selectFrom('purchases')
    .select(sql<number>`coalesce(sum(expected_cents), 0)::bigint`.as('pending'))
    .where('state', 'in', ['created', 'register_sent', 'unknown'])
    .where('dry_run', '=', false)
    .executeTakeFirstOrThrow();
  return Number(r.pending);
}

export async function activeDomainCount(db: Kysely<Database>): Promise<number> {
  const r = await db
    .selectFrom('domains')
    .select(sql<number>`count(*)::int`.as('n'))
    .where('status', 'in', ['owned', 'listed', 'pending_purchase'])
    .executeTakeFirstOrThrow();
  return Number(r.n);
}
