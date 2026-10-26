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
import { liftView } from '../lift-train.js';
import { engineRows, RowsQuery } from '../rows.js';
import { SCORE_MAX_DOMAINS, type Scorer } from '../score.js';
import type { EngineTrainer } from '../train.js';
import { salesMaxDate, setSalesMaxDate, type DbSizeGuard } from '../holdout.js';
import { registerBulkRoute } from '../bulk.js';
import { ENGINE_MAX_ROWS, storeSales, storeUnsold, UNSOLD_TYPES } from '../uploads.js';

// Rows are checked one by one in the loader (a bad row is rejected with a reason, the rest are stored); the route skeleton is `registerBulkRoute` (bulk.ts).
const SaleDoc = z.object({ domain: z.string(), price_usd: z.number().positive(), sale_date: z.string(), venue: z.string(), source: z.string(), source_url: z.string().optional() });
const UnsoldDoc = z.object({ domain: z.string(), type: z.enum(UNSOLD_TYPES), observation_date: z.string(), caught_by_catcher: z.boolean().optional() });
const SalesDoc = z.object({ rows: z.array(SaleDoc).min(1).max(ENGINE_MAX_ROWS) }).strict();
const UnsoldBodyDoc = z.object({ rows: z.array(UnsoldDoc).min(1).max(ENGINE_MAX_ROWS) }).strict();

const ScoreBody = z.object({ domains: z.array(z.string().min(1).max(253)).min(1).max(SCORE_MAX_DOMAINS), as_of: realYmd.optional() }).strict();
const HoldoutBody = z.object({ date: realYmd, approval_ref: approvalRef }).strict();
const HoldoutDoc = z.object({ date: realYmd, approval_ref: z.object({ text: z.string(), approved_at: z.string() }) }).strict();
const HOLDOUT_EFFECT = 'none since 5.41.0';
const EmptyBody = z.object({}).strict();

export function registerEngine(app: FastifyInstance, deps: { db: Kysely<Database>; now: () => number; trainer: EngineTrainer; scorer: Scorer; dbSize: DbSizeGuard }): void {
  registerBulkRoute(app, deps, {
    path: '/engine/sales', doc: SalesDoc, dryRun: false,
    load: (rows, c) => storeSales(deps.db, rows, c),
    summary: (r) => `engine sales: ${r.accepted_n} accepted, ${r.duplicate_n} duplicate, ${r.rejected_n} rejected of ${r.received_n}`,
  });
  registerBulkRoute(app, deps, {
    path: '/engine/unsold', doc: UnsoldBodyDoc, dryRun: false,
    load: (rows, c) => storeUnsold(deps.db, rows, c),
    summary: (r) => `engine unsold: ${r.accepted_n} accepted, ${r.duplicate_n} duplicate, ${r.rejected_n} rejected of ${r.received_n}`,
  });

  // v5.10.0 (CR-061): the holdout guard date. WRITE only (a data token cannot reach it), Dvir's approval_ref must name the date.
  // 5.41.0: deprecated, no effect (rows are never rejected for their date); the routes stay so no caller breaks.
  app.get('/engine/holdout-date', async () => ({ sales_max_date: await salesMaxDate(deps.db), effect: HOLDOUT_EFFECT }));

  app.post('/engine/holdout-date', { config: { openapiBody: HoldoutDoc } }, async (req) => {
    const b = HoldoutBody.parse(req.body ?? {});
    const r = await setSalesMaxDate(deps.db, b.date, b.approval_ref, new Date(deps.now()));
    req.auditSummary = `engine holdout date ${r.previous} -> ${r.date}`;
    return { sales_max_date: r.date, previous: r.previous, approved_at: r.approved_at, effect: HOLDOUT_EFFECT, audit_id: req.auditId ?? null };
  });

  app.get('/engine/health', async () => engineHealth(deps.db, deps.now()));

  // v5.50.0 (P6): the stored labels, newest cursor last. READ or bots (a data token is 403 for every GET). A bad query is 400 VALIDATION_ERROR.
  app.get('/engine/rows', async (req) => {
    const q = RowsQuery.safeParse(req.query ?? {});
    if (!q.success) throw new AppError(400, 'VALIDATION_ERROR', 'Invalid query', { issues: q.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })) });
    return engineRows(deps.db, q.data);
  });

  // v5.47.0 (F5): the current lift table (bins, lifts, counts, AUC on the seeded holdout)
  app.get('/engine/lift', async () => liftView(deps.db, deps.now()));

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
