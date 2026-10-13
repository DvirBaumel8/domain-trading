// v4.0.0 (CR-044 item 4): POST /patterns/sales (WRITE, the CSV of recent sales) and GET /patterns/latest (READ, the clusters of the latest upload).
import type { FastifyInstance } from 'fastify';
import type { Kysely } from 'kysely';
import { z } from 'zod';
import { toJerusalemIso } from '../../../core/dates.js';
import { pair } from '../../../core/money.js';
import type { Database } from '../../../db/types.js';
import { AppError } from '../../../http/errors.js';
import { activeSelectionSettings } from '../../selection/index.js';
import { clusterSales, parseSalesCsv, PATTERN_METHOD, storeSales, type SaleRow } from '../patterns.js';

const Body = z.object({ csv: z.string().min(1).max(60_000) }).strict();
const Query = z.object({
  min_usd: z.string().regex(/^\d{1,9}$/).optional(), max_usd: z.string().regex(/^\d{1,9}$/).optional(), tld: z.string().regex(/^[a-z]{2,10}$/).optional(),
}).strict();

export function registerPatterns(app: FastifyInstance, deps: { db: Kysely<Database>; now: () => number }): void {
  app.post('/patterns/sales', { config: { openapiBody: Body } }, async (req, reply) => {
    const rows = parseSalesCsv(Body.parse(req.body ?? {}).csv);
    const id = await storeSales(deps.db, rows, { token: req.auth?.name ?? null, auditId: req.auditId ?? null });
    return reply.code(201).send({ upload_id: id, rows: rows.length, audit_id: req.auditId ?? null });
  });

  app.get('/patterns/latest', async (req) => {
    const q = Query.parse(req.query ?? {});
    const p = (await activeSelectionSettings(deps.db)).values.portfolio;
    const minCents = q.min_usd ? Number(q.min_usd) * 100 : p.patterns_min_cents;
    const maxCents = q.max_usd ? Number(q.max_usd) * 100 : p.patterns_max_cents;
    if (minCents > maxCents) throw new AppError(422, 'VALIDATION_ERROR', 'min_usd must not be above max_usd');
    const tld = q.tld ?? 'com';
    const up = await deps.db.selectFrom('sales_pattern_uploads').selectAll().orderBy('id', 'desc').limit(1).executeTakeFirst();
    if (!up) throw new AppError(404, 'NO_PATTERN_UPLOAD', 'No sales have been uploaded yet (POST /patterns/sales)');
    const rows = (await deps.db.selectFrom('sales_pattern_rows').selectAll().where('upload_id', '=', up.id).orderBy('id').execute())
      .map((r): SaleRow => ({ domain: r.domain, price_cents: r.price_cents, sold_on: r.sold_on, venue: r.venue }));
    const c = clusterSales(rows, { minCents, maxCents, tld });
    const money = (cl: { median_price_cents: number }) => pair('median_price', cl.median_price_cents);
    return {
      upload_id: up.id, uploaded_at: toJerusalemIso(up.uploaded_at), method: PATTERN_METHOD,
      filter: { ...pair('min_price', minCents), ...pair('max_price', maxCents), tld },
      ...c,
      by_word_count: c.by_word_count.map((x) => ({ ...x, ...money(x) })), by_structure: c.by_structure.map((x) => ({ ...x, ...money(x) })), by_length_band: c.by_length_band.map((x) => ({ ...x, ...money(x) })),
    };
  });
}
