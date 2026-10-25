// v5.37.0: GET /auctions/live. GoDaddy auctions inside the buying range (price <= settings.s8_max_price_cents, at least datasave_auction_live_min_bids bids),
// stored per data date by the datasave step godaddyInventory in godaddy_auctions_live. Read-only; money is integer cents with a display string.
import { sql, type Kysely } from 'kysely';
import { z } from 'zod';
import { isRealDate } from '../../core/dates.js';
import { formatUsd } from '../../core/money.js';
import type { Database } from '../../db/types.js';

export const AuctionsLiveQuery = z.object({
  date: z.string().refine(isRealDate, 'must be a real date (YYYY-MM-DD)').optional(),
  max_price: z.coerce.number().positive().max(1_000_000).optional(),
  min_bids: z.coerce.number().int().min(0).max(100_000).optional(),
  ends_within_hours: z.coerce.number().int().min(1).max(240).optional(),
  type: z.string().min(1).max(40).optional(),
  sort: z.enum(['end_time', 'bids', 'price']).default('end_time'),
  limit: z.coerce.number().int().min(1).max(500).default(100),
  offset: z.coerce.number().int().min(0).max(1_000_000).default(0),
  include_ended: z.enum(['true', 'false']).default('false').transform((v) => v === 'true'),
}).strict();
export type AuctionsLiveFilter = z.infer<typeof AuctionsLiveQuery>;

export async function listAuctionsLive(db: Kysely<Database>, f: AuctionsLiveFilter, nowMs: number) {
  const band = await db.selectFrom('settings').select(['s8_max_price_cents', 'datasave_auction_live_min_bids']).executeTakeFirstOrThrow();
  const latest = await db.selectFrom('godaddy_auctions_live').select((eb) => eb.fn.max('data_date').as('d')).executeTakeFirst();
  const dataDate = f.date ?? (latest?.d ? String(latest.d) : null);
  const bandOut = { max_price_cents: band.s8_max_price_cents, min_bids: band.datasave_auction_live_min_bids };
  const asOf = new Date(nowMs);
  if (dataDate === null) return { data_date: null, as_of: asOf, band: bandOut, total: 0, rows: [] };
  const filtered = () => {
    let q = db.selectFrom('godaddy_auctions_live').where('data_date', '=', dataDate);
    if (!f.include_ended) q = q.where('end_time', '>', asOf);
    if (f.max_price !== undefined) q = q.where('price_cents', '<=', Math.round(f.max_price * 100));
    if (f.min_bids !== undefined) q = q.where('bid_count', '>=', f.min_bids);
    if (f.ends_within_hours !== undefined) q = q.where('end_time', '<=', new Date(nowMs + f.ends_within_hours * 3_600_000));
    if (f.type) q = q.where(sql<string>`lower(auction_type)`, '=', f.type.toLowerCase());
    return q;
  };
  const total = await filtered().select((eb) => eb.fn.countAll<string>().as('n')).executeTakeFirstOrThrow();
  let q = filtered().selectAll();
  if (f.sort === 'bids') q = q.orderBy('bid_count', 'desc').orderBy('end_time');
  else if (f.sort === 'price') q = q.orderBy('price_cents', 'asc').orderBy('end_time');
  else q = q.orderBy('end_time');
  const rows = await q.orderBy('domain').limit(f.limit).offset(f.offset).execute();
  return {
    data_date: dataDate, as_of: asOf, band: bandOut, total: Number(total.n),
    rows: rows.map((r) => ({
      domain: r.domain, end_time: r.end_time, auction_type: r.auction_type, price_cents: r.price_cents, price: formatUsd(r.price_cents), bid_count: r.bid_count,
      domain_age: r.domain_age, valuation_cents: r.valuation_cents, pageviews: r.pageviews,
    })),
  };
}
