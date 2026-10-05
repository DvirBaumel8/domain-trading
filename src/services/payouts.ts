import type { Kysely } from 'kysely';
import type { Database } from '../db/types.js';
import { jerusalemDate } from '../dates.js';
import { AppError } from '../http/errors.js';
import { formatUsd } from '../money.js';
import { withDomainLock } from './plan-store.js';

const money = (c: number) => ({ cents: c, display: formatUsd(c) });

export class PayoutsService {
  constructor(private readonly deps: { db: Kysely<Database>; now: () => number }) {}

  async markReceived(id: number, receivedOn: string): Promise<Record<string, unknown>> {
    const { db } = this.deps;
    const now = new Date(this.deps.now());
    const row = await db.selectFrom('payouts').innerJoin('domains', 'domains.id', 'payouts.domain_id').innerJoin('sales', 'sales.sale_ledger_id', 'payouts.sale_ledger_id')
      .select(['domains.domain as domain', 'sales.sold_at as sold_at']).where('payouts.id', '=', id).executeTakeFirst();
    if (!row) throw new AppError(404, 'PAYOUT_NOT_FOUND', `No payout with id ${id}`);
    if (receivedOn > jerusalemDate(now) || receivedOn < jerusalemDate(row.sold_at)) {
      throw new AppError(422, 'VALIDATION_ERROR', 'received_on must not be in the future or before the sale date');
    }
    return withDomainLock(db, row.domain, (conn) => conn.transaction().execute(async (trx) => {
      const upd = await trx.updateTable('payouts').set({ received_on: receivedOn }).where('id', '=', id).where('received_on', 'is', null).returningAll().executeTakeFirst();
      if (!upd) throw new AppError(409, 'PAYOUT_ALREADY_RECEIVED', 'This payout is already marked received');
      return {
        id: upd.id, domain: row.domain,
        payout: { amount: money(upd.amount_cents), fee: money(upd.fee_cents), method: upd.method, received_on: upd.received_on, status: 'received' },
      };
    }));
  }
}
