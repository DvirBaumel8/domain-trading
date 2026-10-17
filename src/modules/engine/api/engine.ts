// v5.4.0 (CR-056 part 1): POST /engine/sales, POST /engine/unsold (WRITE, Idempotency-Key), GET /engine/health (READ).
// v5.7.0 (CR-058): GET /owned/:domain/endings (READ).
// v5.5.0 (part 2): POST /engine/train (WRITE, Idempotency-Key, 202), GET /engine/train/:id (READ), POST /score (READ scope: the one read-only POST, no Idempotency-Key, no audit row).
import type { FastifyInstance } from 'fastify';
import type { Kysely } from 'kysely';
import { z } from 'zod';
import { idtDay, realYmd } from '../../../core/dates.js';
import type { Database } from '../../../db/types.js';
import { normalizeDomain } from '../../../domain-name.js';
import { approvalRef } from '../../../core/validation.js';
import { AppError } from '../../../http/errors.js';
import { ownedEndingsView } from '../endings.js';
import { engineHealth } from '../health.js';
import { SCORE_MAX_DOMAINS, type Scorer } from '../score.js';
import type { EngineTrainer } from '../train.js';
import { databaseBytes, guardDbSize, salesMaxDate, setSalesMaxDate, type DbSizeGuard } from '../holdout.js';
import { ENGINE_MAX_ROWS, storeSales, storeUnsold, UNSOLD_TYPES } from '../uploads.js';

/** Up to 20,000 rows of about 300 bytes each. */
const BODY_LIMIT = 8 * 1024 * 1024;

// Rows are checked one by one in the handler (a bad row is rejected with a reason, the rest are stored), so the body schema only fixes the envelope.
const Body = z.object({ rows: z.array(z.unknown()).min(1).max(ENGINE_MAX_ROWS) }).strict();
const SaleDoc = z.object({ domain: z.string(), price_usd: z.number().positive(), sale_date: z.string(), venue: z.string(), source: z.string(), source_url: z.string().optional() });
const UnsoldDoc = z.object({ domain: z.string(), type: z.enum(UNSOLD_TYPES), observation_date: z.string(), caught_by_catcher: z.boolean().optional() });
const SalesDoc = z.object({ rows: z.array(SaleDoc).min(1).max(ENGINE_MAX_ROWS) }).strict();
const UnsoldBodyDoc = z.object({ rows: z.array(UnsoldDoc).min(1).max(ENGINE_MAX_ROWS) }).strict();

const ScoreBody = z.object({ domains: z.array(z.string().min(1).max(253)).min(1).max(SCORE_MAX_DOMAINS), as_of: realYmd.optional() }).strict();
const HoldoutBody = z.object({ date: realYmd, approval_ref: approvalRef }).strict();
const HoldoutDoc = z.object({ date: realYmd, approval_ref: z.object({ text: z.string(), approved_at: z.string() }) }).strict();
const EmptyBody = z.object({}).strict();

export function registerEngine(app: FastifyInstance, deps: { db: Kysely<Database>; now: () => number; trainer: EngineTrainer; scorer: Scorer; dbSize: DbSizeGuard }): void {
  const ctx = (req: { auth?: { name: string } | null; auditId?: string | null }) => ({ by: req.auth?.name ?? 'unknown', auditId: req.auditId ?? null, now: deps.now() });

  app.post('/engine/sales', { config: { openapiBody: SalesDoc }, bodyLimit: BODY_LIMIT }, async (req, reply) => {
    const b = Body.parse(req.body ?? {});
    const before = await guardDbSize(deps.db, deps.dbSize, Buffer.byteLength(JSON.stringify(b.rows)));
    const r = await storeSales(deps.db, b.rows, { ...ctx(req), sealedAfter: await salesMaxDate(deps.db) });
    const after = await (deps.dbSize.bytes ?? (() => databaseBytes(deps.db)))();
    req.auditSummary = `engine sales: ${r.accepted_n} accepted, ${r.duplicate_n} duplicate, ${r.rejected_n} rejected of ${r.received_n}`;
    return reply.code(201).send({ ...r, db_bytes_before: before, db_bytes_after: after, audit_id: req.auditId ?? null });
  });

  app.post('/engine/unsold', { config: { openapiBody: UnsoldBodyDoc }, bodyLimit: BODY_LIMIT }, async (req, reply) => {
    const b = Body.parse(req.body ?? {});
    const before = await guardDbSize(deps.db, deps.dbSize, Buffer.byteLength(JSON.stringify(b.rows)));
    const r = await storeUnsold(deps.db, b.rows, { ...ctx(req), sealedAfter: await salesMaxDate(deps.db) });
    const after = await (deps.dbSize.bytes ?? (() => databaseBytes(deps.db)))();
    req.auditSummary = `engine unsold: ${r.accepted_n} accepted, ${r.duplicate_n} duplicate, ${r.rejected_n} rejected of ${r.received_n}`;
    return reply.code(201).send({ ...r, db_bytes_before: before, db_bytes_after: after, audit_id: req.auditId ?? null });
  });

  // v5.10.0 (CR-061): the holdout guard date. WRITE only (a data token cannot reach it), Dvir's approval_ref must name the date.
  app.get('/engine/holdout-date', async () => ({ sales_max_date: await salesMaxDate(deps.db) }));

  app.post('/engine/holdout-date', { config: { openapiBody: HoldoutDoc } }, async (req) => {
    const b = HoldoutBody.parse(req.body ?? {});
    const r = await setSalesMaxDate(deps.db, b.date, b.approval_ref, new Date(deps.now()));
    req.auditSummary = `engine holdout date ${r.previous} -> ${r.date}`;
    return { sales_max_date: r.date, previous: r.previous, approved_at: r.approved_at, audit_id: req.auditId ?? null };
  });

  app.get('/engine/health', async () => engineHealth(deps.db, deps.now()));

  // v5.7.0 (CR-058): the other endings of an owned name, current state and event history.
  app.get<{ Params: { domain: string } }>('/owned/:domain/endings', async (req) => {
    let domain: string;
    try { domain = normalizeDomain(req.params.domain); } catch { throw new AppError(404, 'DOMAIN_NOT_FOUND', 'Domain not found'); }
    const r = await ownedEndingsView(deps.db, domain);
    if (!r) throw new AppError(404, 'DOMAIN_NOT_FOUND', `${domain} is not an owned domain`);
    return r;
  });

  // v5.5.0: starts a training run on the job queue (at most one per 24 hours: 409 TRAIN_TOO_SOON); the answer comes from GET /engine/train/:id.
  app.post('/engine/train', { config: { openapiBody: EmptyBody, openapiStatus: 202 } }, async (req, reply) => {
    EmptyBody.parse(req.body ?? {});
    const r = await deps.trainer.start(req.auth?.name ?? 'unknown', req.auditId ?? null);
    req.auditSummary = `engine train started ${r.id}`;
    return reply.code(202).send({ train_id: r.id, status: 'running', poll: `/engine/train/${r.id}`, audit_id: req.auditId ?? null });
  });

  app.get<{ Params: { id: string } }>('/engine/train/:id', async (req) => {
    const v = await deps.trainer.get(req.params.id);
    if (!v) throw new AppError(404, 'NOT_FOUND', 'No such training run', { train_id: req.params.id });
    return v;
  });

  // v5.5.0: the one read-only POST (a query with a body): READ scope, no Idempotency-Key, no audit row (src/http/methods.ts READ_ONLY_POSTS).
  app.post('/score', { config: { openapiBody: ScoreBody } }, async (req) => {
    const b = ScoreBody.parse(req.body ?? {});
    const domains = b.domains.map((d) => normalizeDomain(d));
    const today = idtDay(deps.now());
    if (b.as_of !== undefined && b.as_of > today) throw new AppError(422, 'VALIDATION_ERROR', 'as_of cannot be in the future', { issues: [{ path: 'as_of', message: `must be ${today} or earlier` }] });
    const r = await deps.scorer.score(domains, b.as_of);
    if (!r) throw new AppError(409, 'MODEL_NOT_READY', 'No trained model yet: upload sales and unsold rows, then POST /engine/train');
    return { model_version: r.model_version, as_of: b.as_of ?? today, count: r.results.length, results: r.results };
  });
}
