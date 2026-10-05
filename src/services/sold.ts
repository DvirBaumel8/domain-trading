import type { Kysely } from 'kysely';
import { sql } from 'kysely';
import type { Database, LedgerEntriesTable } from '../db/types.js';
import { jerusalemDate } from '../dates.js';
import { AppError } from '../http/errors.js';
import { formatUsd } from '../money.js';
import { checkApproval } from './approval.js';
import { withDomainLock } from './plan-store.js';

export const VENUES = ['afternic', 'sedo', 'afternic_checkout', 'escrow', 'other'] as const;
export type Venue = (typeof VENUES)[number];

export interface SoldInput {
  venue: Venue;
  saleCents: number;
  commissionCents: number;
  otherFeesCents: number;
  soldAt: Date;
  payout: { amountCents: number; method: string; feeCents: number; receivedOn: string | null } | null;
  transactionRef: string | null;
  approvalRef: { text?: unknown; approved_at?: unknown };
  offerId: number | null;
}

const SELLABLE = ['owned', 'listed', 'delisted'];
const OFFER_FINAL = ['declined', 'expired', 'withdrawn', 'sold'] as const;
const FUTURE_SKEW_MS = 5 * 60_000;
const SEDO_RATES = [10, 15, 20];
const AFNIC_MIN_COMMISSION_CENTS = 1500;
const money = (c: number) => ({ cents: c, display: formatUsd(c) });
const pct = (cents: number, rate: number) => Math.round((cents * rate) / 100);

function commissionWarning(i: SoldInput, lander: string | null, landerSetAt: Date | null): string | null {
  const got = i.commissionCents;
  const off = (e: number) => Math.abs(got - e) > 100;
  if (i.venue === 'afternic') {
    const rate = lander === 'afternic' && landerSetAt !== null && landerSetAt <= i.soldAt ? 15 : 25;
    const e = Math.max(pct(i.saleCents, rate), AFNIC_MIN_COMMISSION_CENTS);
    return off(e) ? `COMMISSION_UNEXPECTED: expected ${rate}% (${formatUsd(e)}), got ${formatUsd(got)}` : null;
  }
  if (i.venue === 'afternic_checkout') {
    const e = pct(i.saleCents, 5);
    return off(e) ? `COMMISSION_UNEXPECTED: expected 5% (${formatUsd(e)}), got ${formatUsd(got)}` : null;
  }
  if (i.venue === 'sedo') {
    const exp = SEDO_RATES.map((r) => pct(i.saleCents, r));
    if (exp.some((e) => !off(e))) return null;
    return `COMMISSION_UNEXPECTED: expected ${SEDO_RATES.map((r, k) => `${r}% (${formatUsd(exp[k]!)})`).join(', ')}, got ${formatUsd(got)}`;
  }
  return null;
}

export class SoldService {
  constructor(private readonly deps: { db: Kysely<Database>; now: () => number }) {}

  async sold(domain: string, i: SoldInput, ctx: { auditId: string }): Promise<Record<string, unknown>> {
    const now = new Date(this.deps.now());
    if (i.soldAt.getTime() > now.getTime() + FUTURE_SKEW_MS) throw new AppError(422, 'SOLD_AT_IN_FUTURE', 'sold_at is in the future');
    const settings = await this.deps.db.selectFrom('settings').selectAll().executeTakeFirstOrThrow();
    const a = checkApproval(i.approvalRef, domain, now, settings.approval_max_age_hours);
    if (!a.ok) throw new AppError(422, a.code, a.reason);

    return withDomainLock(this.deps.db, domain, (conn) => conn.transaction().execute(async (trx) => {
      const row = await trx.selectFrom('domains').selectAll().where('domain', '=', domain).forUpdate().executeTakeFirst();
      if (!row) throw new AppError(404, 'NOT_IN_PORTFOLIO', `${domain} is not in the portfolio`);
      if (!SELLABLE.includes(row.status)) {
        throw new AppError(409, 'NOT_SELLABLE_STATE', `${domain} is ${row.status}; only owned, listed or delisted domains can be sold`);
      }
      if (i.offerId !== null) {
        const o = await trx.selectFrom('offers').select(['id', 'domain_id', 'outcome']).where('id', '=', i.offerId).forUpdate().executeTakeFirst();
        if (!o || o.domain_id !== row.id) throw new AppError(422, 'OFFER_MISMATCH', 'offer_id does not belong to this domain');
      }

      const occurredOn = jerusalemDate(i.soldAt);
      const base = { occurred_on: occurredOn, domain_id: row.id, deal_id: row.deal_id, counterparty: i.venue, receipt_ref: i.transactionRef, audit_id: ctx.auditId };
      const rows: Omit<LedgerEntriesTable, 'id' | 'currency' | 'created_at'>[] = [{ ...base, type: 'sale', amount_cents: i.saleCents, note: null }];
      if (i.commissionCents > 0) rows.push({ ...base, type: 'commission', amount_cents: -i.commissionCents, note: null });
      if (i.otherFeesCents > 0) rows.push({ ...base, type: 'fee', amount_cents: -i.otherFeesCents, note: null });
      const payoutFee = i.payout?.feeCents ?? 0;
      if (payoutFee > 0) {
        rows.push({ ...base, type: 'payout_fee', amount_cents: -payoutFee, note: i.payout ? `payout via ${i.payout.method}` : null });
      }
      await trx.insertInto('ledger_entries').values(rows).execute();

      await trx.updateTable('domains').set({
        status: 'sold', sold_at: i.soldAt, delisted_at: row.delisted_at ?? i.soldAt, listing_changed_at: now, updated_at: now,
      }).where('id', '=', row.id).execute();

      await trx.updateTable('price_schedule').set({ status: 'cancelled', note: 'sold', updated_at: now })
        .where('domain_id', '=', row.id).where('status', '=', 'planned').execute();

      if (i.offerId !== null) {
        await trx.updateTable('offers').set({ outcome: 'sold', outcome_at: now, outcome_note: 'via /sold' })
          .where('id', '=', i.offerId).where('outcome', 'not in', [...OFFER_FINAL]).execute();
      }

      const warnings: string[] = [];
      const w = commissionWarning(i, row.lander, row.lander_set_at);
      if (w) warnings.push(w);

      const sums = await trx.selectFrom('ledger_entries')
        .select([sql<string>`coalesce(sum(amount_cents), 0)`.as('profit'), sql<string>`coalesce(sum(-amount_cents) filter (where type <> 'sale'), 0)`.as('costs')])
        .where('domain_id', '=', row.id).executeTakeFirstOrThrow();
      const profit = Number(sums.profit);
      const totalCosts = Number(sums.costs);
      const fees = i.otherFeesCents + payoutFee;

      const uploaded = await trx.selectFrom('export_uploads').select('id').where(sql<boolean>`${domain} = any(domains)`).limit(1).executeTakeFirst();
      const checklist = [
        'Remove the listing on the *other* marketplace now (double-sale risk)',
        'Do not send an auth code outside the marketplace flow',
        'Auto-renew stays off',
        ...(uploaded ? ['Remove the listing at Afternic/Sedo (see X-Manual-Delist)'] : []),
      ];

      return {
        domain, status: 'sold',
        sale: money(i.saleCents), commission: money(i.commissionCents), fees: money(fees),
        net_proceeds: money(i.saleCents - i.commissionCents - fees),
        total_costs: money(totalCosts), profit: money(profit),
        checklist, warnings,
      };
    }));
  }
}
