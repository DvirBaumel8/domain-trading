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

/**
 * spent and pending from ONE statement (one snapshot). Two separate reads can straddle a booking commit
 * (purchase leaves "pending" and its ledger row appears "spent" in between), under-counting the purchase.
 */
export async function spentAndPending(db: Kysely<Database>): Promise<{ spent: number; pending: number }> {
  const r = await sql<{ spent: string; pending: string }>`
    select
      (select coalesce(-sum(amount_cents), 0)::bigint from ledger_entries where type in ('registration', 'renewal', 'fee')) as spent,
      (select coalesce(sum(expected_cents), 0)::bigint from purchases where state in ('created', 'register_sent', 'unknown') and dry_run = false) as pending
  `.execute(db);
  const row = r.rows[0]!;
  return { spent: Number(row.spent), pending: Number(row.pending) };
}
