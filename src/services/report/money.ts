import { sql, type Kysely } from 'kysely';
import type { Database } from '../../db/types.js';
import { formatUsd } from '../../money.js';
import { wholeUsd } from '../../pricing/present.js';
import { activeDomainCount, spentCents } from '../budget.js';

export type Pair<K extends string> = { [P in `${K}_cents`]: number | null } & { [P in K]: string | null };
/** A money field as the flat pair `<key>_cents` + `<key>` (display string), e.g. spent_cents: 2107, spent: "$21.07". */
export function pair<K extends string>(key: K, cents: number | null): Pair<K> {
  return { [`${key}_cents`]: cents, [key]: cents === null ? null : formatUsd(cents) } as Pair<K>;
}
/** The private walk-away: whole dollars with a "(private)" mark, like plan-view ("$960 (private)"). */
export function walkawayPair(cents: number | null): Pair<'walkaway'> {
  return { walkaway_cents: cents, walkaway: cents === null ? null : `${wholeUsd(cents)} (private)` } as Pair<'walkaway'>;
}
/** bin/floor/walkaway as flat pairs. */
export function priceValues(v: { bin_cents: number | null; floor_cents: number | null; walkaway_cents: number | null }) {
  return { ...pair('bin', v.bin_cents), ...pair('floor', v.floor_cents), ...walkawayPair(v.walkaway_cents) };
}

/** Sale-linked ledger rows share the sale's audit_id (written in one transaction by /sold). */
const LINKED = sql`(audit_id is not null and audit_id in (select audit_id from sales where audit_id is not null))`;

/**
 * Every figure is a SQL sum over ledger_entries (R-2). Q1/Q12:
 *  - costs = -sum(registration, renewal, refund, tool, ai) and -sum(fee, adjustment) NOT linked to a sale;
 *  - sale fees = -sum(fee, adjustment) linked to a sale (audit_id in sales) and -sum(payout_fee);
 *  - budget.spent stays spentCents (the /buy cap figure).
 */
export async function reportMoney(db: Kysely<Database>) {
  const cfg = await db.selectFrom('settings').select(['poc_cap_cents', 'max_domains']).executeTakeFirstOrThrow();
  const spent = await spentCents(db);
  const r = await sql<{ gross: string; commission: string; sale_fees: string; costs: string; n: string }>`
    select
      coalesce(sum(amount_cents) filter (where type = 'sale'), 0)::bigint as gross,
      coalesce(-sum(amount_cents) filter (where type = 'commission'), 0)::bigint as commission,
      coalesce(-sum(amount_cents) filter (where type = 'payout_fee' or (type in ('fee', 'adjustment') and ${LINKED})), 0)::bigint as sale_fees,
      coalesce(-sum(amount_cents) filter (where type in ('registration', 'renewal', 'refund', 'tool', 'ai')
        or (type in ('fee', 'adjustment') and not ${LINKED})), 0)::bigint as costs,
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
      ...pair('poc_cap', cfg.poc_cap_cents), ...pair('spent', spent), ...pair('remaining', cfg.poc_cap_cents - spent),
      committed_forward: { ...pair('total', total), complete: missing.length === 0, missing },
      domains: { count: await activeDomainCount(db), max: cfg.max_domains },
    },
    sales: { count: n, ...pair('gross', gross), ...pair('commission', commission), ...pair('fees', fees), ...pair('net', net) },
    ...pair('profit', profit),
    roi: costs > 0 ? Math.round((profit * 100) / costs) / 100 : null,
    roi_pct: costs > 0 ? Math.round((profit * 100) / costs) : null,
  };
}
