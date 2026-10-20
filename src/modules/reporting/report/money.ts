import { sql, type Kysely } from 'kysely';
import type { Database } from '../../../db/types.js';
import { pair, wholeUsd, type Pair } from '../../../core/money.js';
import { activeDomainCount } from '../../buying/index.js';

/** The private walk-away: whole dollars with a "(private)" mark, like plan-view ("$960 (private)"). */
export function walkawayPair(cents: number | null): Pair<'walkaway'> {
  return { walkaway_cents: cents, walkaway: cents === null ? null : `${wholeUsd(cents)} (private)` } as Pair<'walkaway'>;
}
/** bin/floor/walkaway as flat pairs. */
export function priceValues(v: { bin_cents: number | null; floor_cents: number | null; walkaway_cents: number | null }) {
  return { ...pair('bin', v.bin_cents), ...pair('floor', v.floor_cents), ...walkawayPair(v.walkaway_cents) };
}

/** A live name that has not been renewed yet (renewals_used 0): the names whose next renewal is a committed forward cost. */
export async function unrenewedLiveNames(db: Kysely<Database>) {
  return db.selectFrom('domains').select(['domain', 'renewal_price_cents', 'renewal_price_source', 'expiry_date', 'drop_date'])
    .where('renewals_used', '=', 0).where('status', 'not in', ['sold', 'dropped', 'pending_purchase']).orderBy('domain').execute();
}
/** CR-004 §10.3: a name whose drop date is its first expiry is not renewed. */
export const dropsAtFirstExpiry = (d: { expiry_date: string | null; drop_date: string | null }): boolean => d.drop_date !== null && d.expiry_date !== null && d.drop_date === d.expiry_date;

/** Sale-linked ledger rows share the sale's audit_id (written in one transaction by /sold). */
const LINKED = sql`(audit_id is not null and audit_id in (select audit_id from sales where audit_id is not null))`;

/**
 * Every figure is a SQL sum over ledger_entries (R-2). Q1/Q12:
 *  - costs = -sum(registration, renewal, refund, tool, ai) and -sum(fee, adjustment) NOT linked to a sale;
 *  - sale fees = -sum(fee, adjustment) linked to a sale (audit_id in sales) and -sum(payout_fee);
 *  - spend.spent = -sum(registration, renewal, fee): plain accounting, no cap.
 */
export async function reportMoney(db: Kysely<Database>) {
  const cfg = await db.selectFrom('settings').select(['max_domains']).executeTakeFirstOrThrow();
  const sp = await sql<{ spent: string }>`select coalesce(-sum(amount_cents), 0)::bigint as spent from ledger_entries where type in ('registration', 'renewal', 'fee')`.execute(db);
  const spent = Number(sp.rows[0]!.spent);
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
  // A name set to drop at first expiry (drop_date = expiry_date, CR-004 §10.3) will not be renewed: it commits no forward cost.
  const fwd = (await unrenewedLiveNames(db)).filter((d) => !dropsAtFirstExpiry(d));
  const missing = fwd.filter((d) => d.renewal_price_cents === null).map((d) => d.domain);
  const total = fwd.reduce((s, d) => s + (d.renewal_price_cents ?? 0), 0);
  return {
    spend: {
      ...pair('spent', spent),
      committed_forward: { ...pair('total', total), complete: missing.length === 0, missing },
      domains: { count: await activeDomainCount(db), max: cfg.max_domains },
    },
    sales: { count: n, ...pair('gross', gross), ...pair('commission', commission), ...pair('fees', fees), ...pair('net', net) },
    ...pair('profit', profit),
    roi: costs > 0 ? Math.round((profit * 100) / costs) / 100 : null,
    roi_pct: costs > 0 ? Math.round((profit * 100) / costs) : null,
  };
}
