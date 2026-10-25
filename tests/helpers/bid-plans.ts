// v5.39.0 (CR-077): a bid plan (and the pre-bid check it needs) written straight to the tables, for tests of the S8 import that are not about the plan itself.
import type { Kysely } from 'kysely';
import type { Database } from '../../src/db/types.js';

export async function insertBidPlan(db: Kysely<Database>, o: {
  domain: string; maxBidCents?: number; status?: 'open' | 'won' | 'lost' | 'withdrawn' | 'expired'; kind?: 'auction' | 'fixed_price' | 'closeout'; venue?: 'godaddy' | 'dynadot';
  auctionEndAt?: Date | null; createdAt?: Date; approvalText?: string; approvalAt?: Date; finalPriceCents?: number | null;
}): Promise<number> {
  const at = o.createdAt ?? new Date();
  const pre = await db.insertInto('prebid_checks').values({ domain: o.domain, venue: o.venue ?? 'godaddy', verdict: 'pass', answer: JSON.stringify({ domain: o.domain, verdict: 'pass', checks: [] }), created_at: at }).returning('id').executeTakeFirstOrThrow();
  const kind = o.kind ?? 'fixed_price';
  const plan = await db.insertInto('bid_plans').values({
    domain: o.domain, venue: o.venue ?? 'godaddy', kind, auction_end_at: o.auctionEndAt === undefined ? (kind === 'auction' ? new Date('2099-01-01T00:00:00Z') : null) : o.auctionEndAt,
    max_bid_cents: o.maxBidCents ?? 25_000, prebid_id: pre.id, status: o.status ?? 'open',
    manual: JSON.stringify({ exact_string_business: { checked: true, note: 'test' }, history: { checked: true, note: 'test' } }), reasons: JSON.stringify({ buyers: 'test' }),
    approval_text: o.approvalText ?? `Dvir: bid up to $${((o.maxBidCents ?? 25_000) / 100).toFixed(0)} on ${o.domain}`, approval_at: o.approvalAt ?? at, created_by: 'test',
    final_price_cents: o.finalPriceCents ?? null, created_at: at, updated_at: at,
  }).returning('id').executeTakeFirstOrThrow();
  return plan.id;
}

/** An open or won plan exists for the name, else a plan with a maximum bid at the S8 cap. */
export async function ensureBidPlan(db: Kysely<Database>, domain: string): Promise<void> {
  const have = await db.selectFrom('bid_plans').select('id').where('domain', '=', domain).where('status', 'in', ['open', 'won']).executeTakeFirst();
  if (!have) await insertBidPlan(db, { domain });
}
