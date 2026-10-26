// v5.59.0 (CR-081): the historical replay. POST /replay/runs (WRITE; Idempotency-Key; audited) queues a replay of an archived day (202 {id}); with dry_run it runs at once and answers 200 with
// the report and stores nothing. GET /replay/runs/{id} and GET /replay/runs (READ or bots) return the status and the report. Rules and test ids: docs/internal/replay.md.
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { AppError } from '../../../http/errors.js';
import { isRealDate } from '../../../core/dates.js';
import { computeReplay, refuseAsOf, ReplayBody, resolveSeed, type ReplayRunner } from '../replay/run.js';

const ReportQuery = z.object({ kind: z.enum(['auctions', 'closeouts']).default('auctions'), n: z.coerce.number().int().min(1).max(200).default(25), seed: z.string().min(1).max(100).optional(), logic: z.literal('current').optional() }).strict();
const ListQuery = z.object({ limit: z.coerce.number().int().min(1).max(100).default(20), status: z.enum(['queued', 'running', 'done', 'error']).optional() }).strict();

export function registerReplay(app: FastifyInstance, deps: { runner: ReplayRunner; run: Parameters<typeof computeReplay>[0] }): void {
  app.post('/replay/runs', { config: { openapiBody: ReplayBody, openapiStatus: 202 } }, async (req, reply) => {
    refuseAsOf(req.body);
    const b = ReplayBody.parse(req.body ?? {});
    if (b.dry_run) {
      const r = await computeReplay(deps.run, { ...b, seed: await resolveSeed(deps.run.archiveDir, b.date, b.kind, b.seed).catch(() => { throw new AppError(404, 'ARCHIVE_DAY_MISSING', `No archived ${b.kind} list for ${b.date}`, { date: b.date, kind: b.kind }); }) });
      req.auditSummary = `replay dry run ${b.kind} ${b.date} n=${b.n}`;
      return reply.code(200).send({ dry_run: true, logic_version: r.logic_version, report: r.report, audit_id: req.auditId ?? null });
    }
    const id = await deps.runner.enqueue(b, { by: req.auth?.name ?? null, auditId: req.auditId ?? null });
    req.auditSummary = `replay run ${id}: ${b.kind} ${b.date} n=${b.n} seed=${b.seed}`;
    return reply.code(202).send({ id, status: 'queued', audit_id: req.auditId ?? null });
  });

  // the one bots use: the newest finished report of a day (writes nothing)
  app.get<{ Params: { date: string } }>('/replay/:date', async (req) => {
    refuseAsOf(req.query);
    if (!isRealDate(req.params.date)) throw new AppError(400, 'VALIDATION_ERROR', 'The date must be a real date (YYYY-MM-DD)');
    const p = ReportQuery.safeParse(req.query ?? {});
    if (!p.success) throw new AppError(400, 'VALIDATION_ERROR', `Invalid query: ${p.error.issues.map((i) => `${i.path.join('.') || 'query'} ${i.message}`).join('; ')}`);
    return deps.runner.report({ date: req.params.date, kind: p.data.kind, n: p.data.n, ...(p.data.seed ? { seed: p.data.seed } : {}) });
  });

  app.get<{ Params: { id: string } }>('/replay/runs/:id', async (req) => {
    if (!/^\d{1,9}$/.test(req.params.id) || Number(req.params.id) < 1) throw new AppError(400, 'VALIDATION_ERROR', 'The run id must be a positive whole number');
    return deps.runner.get(Number(req.params.id));
  });

  app.get('/replay/runs', async (req) => {
    const p = ListQuery.safeParse(req.query ?? {});
    if (!p.success) throw new AppError(400, 'VALIDATION_ERROR', `Invalid query: ${p.error.issues.map((i) => `${i.path.join('.') || 'query'} ${i.message}`).join('; ')}`);
    return deps.runner.list(p.data);
  });
}
