// The pending reservation of a /buy (a `purchases` row and a `pending_purchase` domains row, both or neither) and the checks that run before it.
import type { Insertable, Kysely, Transaction } from 'kysely';
import type { Database, DomainsTable } from '../../db/types.js';
import { AppError } from '../../http/errors.js';
import { redact } from '../../core/redact.js';
import { activeLaneCounts, laneCapBlock } from './caps.js';
import type { Approved } from './buy-types.js';

export const isUniqueViolation = (e: unknown) => (e as { code?: string }).code === '23505';

/** What a pending purchase needs from the approved /buy (the dry-run ambiguity record uses the same fields). */
export type PendingRec = Pick<Approved, 'input' | 'ctx' | 'approvedAt' | 'check' | 'category' | 'trancheId' | 'smallBuy'>;

/**
 * Inserts the `purchases` row (state `created` for a reservation, `unknown` for an ambiguous dry run) and the `pending_purchase` domains row in the
 * caller's transaction, so the domain cap counts the name. Returns the purchase id.
 */
export async function reservePending(trx: Transaction<Database>, rec: PendingRec, o: {
  idempotencyKey: string; state: 'created' | 'unknown'; registrar: string; expectedCents: number;
  domainExtra?: Pick<Insertable<DomainsTable>, 'display_name' | 'horizon' | 'screening_group' | 'buy_card'>;
}): Promise<number> {
  const { id } = await trx.insertInto('purchases').values({
    idempotency_key: o.idempotencyKey, request_hash: rec.ctx.requestHash, domain: rec.input.domain, state: o.state,
    dry_run: false, registrar: o.registrar, check_id: rec.check.checkId, max_price_cents: rec.input.maxPriceCents,
    approval_text: String(rec.input.approval?.text), approval_at: rec.approvedAt, expected_cents: o.expectedCents,
    request: JSON.stringify(redact(rec.input.requestBody)), audit_id: rec.ctx.auditId, tranche_id: rec.trancheId, small_buy_exception: rec.smallBuy,
  }).returning('id').executeTakeFirstOrThrow();
  await trx.insertInto('domains').values({
    domain: rec.input.domain, status: 'pending_purchase', registrar: o.registrar, category: rec.category, price_grade: rec.input.priceGrade, deal_id: rec.input.dealId,
    ...o.domainExtra,
  }).execute();
  return id;
}

export async function assertNotOwned(db: Kysely<Database>, domain: string): Promise<void> {
  const row = await db.selectFrom('domains').select('status').where('domain', '=', domain).executeTakeFirst();
  if (row && ['pending_purchase', 'owned', 'listed', 'delisted'].includes(row.status)) {
    throw new AppError(409, 'ALREADY_OWNED_OR_PENDING', `${domain} is already owned or being bought`, { status: row.status });
  }
  if (row) throw new AppError(409, 'ALREADY_IN_PORTFOLIO', `${domain} is in the portfolio as ${row.status}`, { status: row.status });
  const open = await db.selectFrom('purchases').select('state').where('domain', '=', domain)
    .where('state', 'in', ['created', 'register_sent', 'unknown']).executeTakeFirst();
  if (open) throw new AppError(409, 'ALREADY_OWNED_OR_PENDING', `A purchase of ${domain} is in progress`, { state: open.state });
}

/** The domain cap: the total of both lines under max_domains (since 5.52.0 no slots are reserved for S8). */
export async function assertDomainCap(db: Kysely<Database>, cfg: { max_domains: number }): Promise<void> {
  const c = await activeLaneCounts(db);
  if (laneCapBlock(c, cfg) !== null) {
    throw new AppError(409, 'DOMAIN_CAP_REACHED', `Domain cap reached (${c.total}/${cfg.max_domains}; Line 1 ${c.line1}, S8 ${c.s8})`,
      { domains: c.total, max_domains: cfg.max_domains, line1_domains: c.line1, s8_domains: c.s8 });
  }
}
