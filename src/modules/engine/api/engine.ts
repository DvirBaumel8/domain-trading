// v5.4.0 (CR-056 part 1): POST /engine/sales, POST /engine/unsold (WRITE, Idempotency-Key), GET /engine/health (READ).
import type { FastifyInstance } from 'fastify';
import type { Kysely } from 'kysely';
import { z } from 'zod';
import type { Database } from '../../../db/types.js';
import { engineHealth } from '../health.js';
import { ENGINE_MAX_ROWS, storeSales, storeUnsold, UNSOLD_TYPES } from '../uploads.js';

/** Up to 20,000 rows of about 300 bytes each. */
const BODY_LIMIT = 8 * 1024 * 1024;

// Rows are checked one by one in the handler (a bad row is rejected with a reason, the rest are stored), so the body schema only fixes the envelope.
const Body = z.object({ rows: z.array(z.unknown()).min(1).max(ENGINE_MAX_ROWS) }).strict();
const SaleDoc = z.object({ domain: z.string(), price_usd: z.number().positive(), sale_date: z.string(), venue: z.string(), source: z.string(), source_url: z.string().optional() });
const UnsoldDoc = z.object({ domain: z.string(), type: z.enum(UNSOLD_TYPES), observation_date: z.string(), caught_by_catcher: z.boolean().optional() });
const SalesDoc = z.object({ rows: z.array(SaleDoc).min(1).max(ENGINE_MAX_ROWS) }).strict();
const UnsoldBodyDoc = z.object({ rows: z.array(UnsoldDoc).min(1).max(ENGINE_MAX_ROWS) }).strict();

export function registerEngine(app: FastifyInstance, deps: { db: Kysely<Database>; now: () => number }): void {
  const ctx = (req: { auth?: { name: string } | null; auditId?: string | null }) => ({ by: req.auth?.name ?? 'unknown', auditId: req.auditId ?? null, now: deps.now() });

  app.post('/engine/sales', { config: { openapiBody: SalesDoc }, bodyLimit: BODY_LIMIT }, async (req, reply) => {
    const b = Body.parse(req.body ?? {});
    const r = await storeSales(deps.db, b.rows, ctx(req));
    req.auditSummary = `engine sales: ${r.accepted_n} accepted, ${r.duplicate_n} duplicate, ${r.rejected_n} rejected of ${r.received_n}`;
    return reply.code(201).send({ ...r, audit_id: req.auditId ?? null });
  });

  app.post('/engine/unsold', { config: { openapiBody: UnsoldBodyDoc }, bodyLimit: BODY_LIMIT }, async (req, reply) => {
    const b = Body.parse(req.body ?? {});
    const r = await storeUnsold(deps.db, b.rows, ctx(req));
    req.auditSummary = `engine unsold: ${r.accepted_n} accepted, ${r.duplicate_n} duplicate, ${r.rejected_n} rejected of ${r.received_n}`;
    return reply.code(201).send({ ...r, audit_id: req.auditId ?? null });
  });

  app.get('/engine/health', async () => engineHealth(deps.db, deps.now()));
}
