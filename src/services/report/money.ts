import { sql, type Kysely } from 'kysely';
import type { Database } from '../../db/types.js';
import { formatUsd } from '../../money.js';
import { activeDomainCount, spentCents } from '../budget.js';

export interface Money { cents: number; display: string }
export const money = (c: number): Money => ({ cents: c, display: formatUsd(c) });
export const moneyOrNull = (c: number | null): Money | null => (c === null ? null : money(c));

export interface ReportMoney {
  budget: {
    poc_cap: Money; spent: Money; remaining: Money;
    committed_forward: { total: Money; complete: boolean; missing: string[] };
    domains: { count: number; max: number };
  };
  sales: { count: number; gross: Money; commission: Money; fees: Money; net: Money };
  profit: Money;
  roi: number | null;
  roi_pct: number | null;
}

/** Every figure is a SQL sum over ledger_entries (R-2). Sale fees = `fee` rows written by /sold (audit_id in sales) + payout_fee rows (Q1). */
export async function reportMoney(db: Kysely<Database>): Promise<ReportMoney> {
  const cfg = await db.selectFrom('settings').select(['poc_cap_cents', 'max_domains']).executeTakeFirstOrThrow();
  const spent = await spentCents(db);
  const r = await sql<{ gross: string; commission: string; sale_fees: string; costs: string; n: string }>`
    select
      coalesce(sum(amount_cents) filter (where type = 'sale'), 0)::bigint as gross,
      coalesce(-sum(amount_cents) filter (where type = 'commission'), 0)::bigint as commission,
      coalesce(-sum(amount_cents) filter (where type = 'payout_fee'
        or (type = 'fee' and audit_id is not null and audit_id in (select audit_id from sales where audit_id is not null))), 0)::bigint as sale_fees,
      coalesce(-sum(amount_cents) filter (where type in ('registration', 'renewal')
        or (type = 'fee' and not (audit_id is not null and audit_id in (select audit_id from sales where audit_id is not null)))), 0)::bigint as costs,
      (select count(*) from sales)::bigint as n
    from ledger_entries`.execute(db);
  const x = r.rows[0]!;
  const [gross, commission, fees, costs, n] = [Number(x.gross), Number(x.commission), Number(x.sale_fees), Number(x.costs), Number(x.n)];
  const net = gross - commission - fees;
  const profit = net - costs;
  const fwd = await db.selectFrom('domains').select(['domain', 'renewal_price_cents'])
    .where('renewals_used', '=', 0).where('status', 'not in', ['sold', 'dropped', 'pending_purchase']).orderBy('domain').execute();
  const missing = fwd.filter((d) => d.renewal_price_cents === null).map((d) => d.domain);
  const total = fwd.reduce((s, d) => s + (d.renewal_price_cents ?? 0), 0);
  return {
    budget: {
      poc_cap: money(cfg.poc_cap_cents), spent: money(spent), remaining: money(cfg.poc_cap_cents - spent),
      committed_forward: { total: money(total), complete: missing.length === 0, missing },
      domains: { count: await activeDomainCount(db), max: cfg.max_domains },
    },
    sales: { count: n, gross: money(gross), commission: money(commission), fees: money(fees), net: money(net) },
    profit: money(profit),
    roi: costs > 0 ? Math.round((profit * 100) / costs) / 100 : null,
    roi_pct: costs > 0 ? Math.round((profit * 100) / costs) : null,
  };
}
