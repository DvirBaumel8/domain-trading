import { sql, type Kysely } from 'kysely';
import type { Database } from '../../../db/types.js';
import { pair } from '../../../core/money.js';

/**
 * v5.8.0 (CR-059): the two lines of the company. Line 1 = hand registration (domains.lane NULL), Line 2 = S8 aftermarket imports (lane 'S8').
 * Every figure is a sum over the ledger rows of the line's domains: spend = registration + renewal + fee (like spend.spent), sales = the sale rows,
 * pnl = every ledger row of the line (sales in, commissions, fees, registrations and renewals out). Ledger rows with no domain (tool, ai costs)
 * belong to no line, so the two lines' pnl need not add up to the top-level profit.
 */
export async function reportLines(db: Kysely<Database>) {
  const r = await sql<{ line: number; names: number; spent: string; sale_count: number; gross: string; pnl: string; committed: string; missing: string[] | null }>`
    select l.line,
      (select count(*) from domains d where d.status in ('owned', 'listed', 'delisted', 'pending_purchase') and (case when d.lane is null then 1 else 2 end) = l.line)::int as names,
      coalesce((select -sum(e.amount_cents) from ledger_entries e join domains d on d.id = e.domain_id
        where (case when d.lane is null then 1 else 2 end) = l.line and e.type in ('registration', 'renewal', 'fee')), 0)::bigint as spent,
      (select count(*) from sales s join domains d on d.id = s.domain_id where (case when d.lane is null then 1 else 2 end) = l.line)::int as sale_count,
      coalesce((select sum(e.amount_cents) from ledger_entries e join domains d on d.id = e.domain_id
        where (case when d.lane is null then 1 else 2 end) = l.line and e.type = 'sale'), 0)::bigint as gross,
      coalesce((select sum(e.amount_cents) from ledger_entries e join domains d on d.id = e.domain_id
        where (case when d.lane is null then 1 else 2 end) = l.line), 0)::bigint as pnl,
      coalesce((select sum(coalesce(d.renewal_price_cents, 0)) from domains d
        where (case when d.lane is null then 1 else 2 end) = l.line and d.renewals_used = 0 and d.status not in ('sold', 'dropped', 'pending_purchase')
          and (d.drop_date is null or d.expiry_date is null or d.drop_date <> d.expiry_date)), 0)::bigint as committed,
      (select array_agg(d.domain order by d.domain) from domains d
        where (case when d.lane is null then 1 else 2 end) = l.line and d.renewals_used = 0 and d.status not in ('sold', 'dropped', 'pending_purchase')
          and (d.drop_date is null or d.expiry_date is null or d.drop_date <> d.expiry_date) and d.renewal_price_cents is null) as missing
    from (values (1), (2)) as l(line)
    order by l.line`.execute(db);
  const cfg = await db.selectFrom('settings').select(['max_domains']).executeTakeFirstOrThrow();
  const one = (row: (typeof r.rows)[number]) => ({
    line: Number(row.line),
    name: Number(row.line) === 1 ? 'hand registration' : 'S8 aftermarket',
    names: Number(row.names),
    max_names: cfg.max_domains,
    shared: true,
    spend: pair('spent', Number(row.spent)),
    sales: { count: Number(row.sale_count), ...pair('gross', Number(row.gross)) },
    ...pair('pnl', Number(row.pnl)),
    committed_forward: { ...pair('total', Number(row.committed)), complete: (row.missing ?? []).length === 0, missing: row.missing ?? [] },
  });
  return r.rows.map(one);
}
