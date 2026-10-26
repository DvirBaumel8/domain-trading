// v5.50.0 (P6): GET /engine/rows, the stored engine labels read back page by page, so a bot can backtest on the production rows.
// Only columns of the label tables are returned (no token, no secret): sales and unsold rows as the uploads and the datasave feed stored them,
// auction_ends = the middle class (ended in-range GoDaddy auctions under the sold line, engine_auction_ends).
import type { Kysely } from 'kysely';
import { z } from 'zod';
import type { Database } from '../../db/types.js';

export const ROWS_DEFAULT_LIMIT = 1000;
export const ROWS_MAX_LIMIT = 5000;

export const RowsQuery = z.object({
  kind: z.enum(['sales', 'unsold', 'auction_ends']),
  limit: z.coerce.number().int().min(1).max(ROWS_MAX_LIMIT).default(ROWS_DEFAULT_LIMIT),
  after_id: z.coerce.number().int().min(0).optional(),
}).strict();
export type RowsQueryT = z.infer<typeof RowsQuery>;

export async function engineRows(db: Kysely<Database>, q: RowsQueryT): Promise<{ kind: string; total: number; rows: Array<Record<string, unknown>>; next_after_id: number | null }> {
  const after = q.after_id ?? 0;
  // one extra row tells whether another page exists
  const take = q.limit + 1;
  let total: number;
  let rows: Array<Record<string, unknown> & { id: number }>;
  if (q.kind === 'sales') {
    total = Number((await db.selectFrom('engine_sales').select((eb) => eb.fn.countAll<string>().as('n')).executeTakeFirstOrThrow()).n);
    rows = (await db.selectFrom('engine_sales').select(['id', 'domain', 'sale_date', 'price_cents', 'source', 'venue', 'upload_id']).where('id', '>', after).orderBy('id').limit(take).execute())
      .map((r) => ({ id: r.id, domain: r.domain, label_date: r.sale_date, price_cents: r.price_cents, source: r.source, venue: r.venue, upload_id: r.upload_id }));
  } else if (q.kind === 'unsold') {
    total = Number((await db.selectFrom('engine_unsold').select((eb) => eb.fn.countAll<string>().as('n')).executeTakeFirstOrThrow()).n);
    rows = (await db.selectFrom('engine_unsold').select(['id', 'domain', 'observation_date', 'type', 'caught_by_catcher', 'upload_id']).where('id', '>', after).orderBy('id').limit(take).execute())
      .map((r) => ({ id: r.id, domain: r.domain, label_date: r.observation_date, type: r.type, caught_by_catcher: r.caught_by_catcher, upload_id: r.upload_id }));
  } else {
    total = Number((await db.selectFrom('engine_auction_ends').select((eb) => eb.fn.countAll<string>().as('n')).executeTakeFirstOrThrow()).n);
    rows = (await db.selectFrom('engine_auction_ends').select(['id', 'domain', 'end_date', 'final_price_cents', 'bids', 'band']).where('id', '>', after).orderBy('id').limit(take).execute())
      .map((r) => ({ id: r.id, domain: r.domain, label_date: r.end_date, price_cents: r.final_price_cents, bids: r.bids, band: r.band }));
  }
  const more = rows.length > q.limit;
  const page = more ? rows.slice(0, q.limit) : rows;
  return { kind: q.kind, total, rows: page, next_after_id: more ? page[page.length - 1]!.id : null };
}
