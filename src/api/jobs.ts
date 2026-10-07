import type { FastifyInstance } from 'fastify';
import type { Kysely } from 'kysely';
import { z } from 'zod';
import type { Config } from '../config.js';
import { jerusalemDate } from '../dates.js';
import type { Database } from '../db/types.js';
import { AppError } from '../http/errors.js';
import type { JobRunner } from '../jobs/runner.js';
import { jobRunsView, triggerFromKey } from '../services/job-runs.js';
import { ISO_WITH_OFFSET } from '../services/offers.js';

const Body = z.object({ job: z.enum(['tick', 'daily']) }).strict();
const PreviewBody = z.object({ today: z.string().optional() }).strict();
const RunsQuery = z.object({
  job: z.enum(['tick', 'daily']).optional(),
  since: z.string().optional(),
  limit: z.string().regex(/^\d{1,4}$/).optional(),
}).strict();

const bad = (m: string) => new AppError(400, 'VALIDATION_ERROR', m);

interface JobsDeps {
  db: Kysely<Database>;
  now: () => number;
  config: Pick<Config, 'backup'>;
  priceJob: { runOnce(o: { today?: string; dryRun?: boolean }): Promise<{ applied: unknown[]; superseded: unknown[]; held: unknown[]; delisted: unknown[]; cancelled?: number[]; failed?: { domain: string; rowId: number; reason: string }[]; skipped: boolean }> };
  dropJob: { runOnce(o: { today?: string; dryRun?: boolean }): Promise<{ dropped: unknown[]; skipped: boolean }> };
}

/** A real YYYY-MM-DD, not before today (IDT) and at most 3 years ahead. */
function previewDay(v: string, today: string): string {
  const t = /^\d{4}-\d{2}-\d{2}$/.test(v) ? new Date(`${v}T00:00:00Z`) : null;
  if (!t || Number.isNaN(t.getTime()) || t.toISOString().slice(0, 10) !== v) throw new AppError(422, 'VALIDATION_ERROR', 'today must be a real date (YYYY-MM-DD)');
  const max = new Date(`${today}T00:00:00Z`);
  max.setUTCFullYear(max.getUTCFullYear() + 3);
  if (v < today) throw new AppError(422, 'VALIDATION_ERROR', 'today must not be in the past');
  if (t.getTime() > max.getTime()) throw new AppError(422, 'VALIDATION_ERROR', 'today must be at most 3 years ahead');
  return v;
}

/**
 * POST /jobs/run: called by the external scheduler (Cloudflare Worker) with the job-trigger bearer, or by Gavriel's WRITE token (own limit, see http/auth.ts and http/rate-limit.ts).
 * GET /jobs/runs (READ): the recorded runs. POST /jobs/preview (WRITE): the price and drop jobs as a dry run for a chosen day.
 */
export function registerJobs(app: FastifyInstance, runner: JobRunner, deps: JobsDeps): void {
  app.post('/jobs/run', async (req, reply) => {
    const { job } = Body.parse(req.body);
    const started = new Date().toISOString();
    const key = req.headers['idempotency-key'];
    // A WRITE token's run is always `manual` (whatever its key looks like) and records the token's name; the job token keeps the key rule.
    const trigger = req.auth
      ? { trigger: 'manual' as const, scheduledFor: null, triggeredBy: req.auth.name }
      : triggerFromKey(job, typeof key === 'string' ? key : undefined);
    const result = await runner.run(job, trigger);
    const failed = Object.entries(result.steps).filter(([, s]) => !s.ok).map(([k]) => k);
    req.auditSummary = result.skipped ? `${job}: skipped` : failed.length ? `${job}: failed ${failed.join(',')}` : `${job}: ok`;
    return reply.code(200).send({ ...result, started_at: started, finished_at: new Date().toISOString() });
  });

  app.get('/jobs/runs', async (req) => {
    const p = RunsQuery.safeParse(req.query);
    if (!p.success) throw bad(`Invalid query: ${p.error.issues.map((i) => i.path.join('.') || i.message).join(', ')}`);
    const q = p.data;
    const limit = q.limit === undefined ? 50 : Number(q.limit);
    if (limit < 1 || limit > 500) throw bad('limit must be 1 to 500');
    if (q.since !== undefined && (!ISO_WITH_OFFSET.test(q.since) || Number.isNaN(Date.parse(q.since)))) throw bad('since must be an ISO 8601 time with an offset');
    return jobRunsView(deps.db, deps.config, deps.now(), { job: q.job, since: q.since ? new Date(q.since) : undefined, limit });
  });

  app.post('/jobs/preview', async (req) => {
    const b = PreviewBody.parse(req.body ?? {});
    const real = jerusalemDate(new Date(deps.now()));
    const today = b.today === undefined ? real : previewDay(b.today, real);
    const price = await deps.priceJob.runOnce({ today, dryRun: true });
    const drop = await deps.dropJob.runOnce({ today, dryRun: true });
    // v2.6.0 (N-2): what the real run would cancel (a due delist cancels the name's other open rows; a sold or dropped name's planned rows) and fail (rows that no longer pass rowValid).
    const cancelled = price.cancelled ?? [];
    const failed = (price.failed ?? []).filter((f) => f.rowId > 0);
    const ids = [...new Set([...cancelled, ...failed.map((f) => f.rowId)])];
    const rows = ids.length === 0 ? [] : await deps.db.selectFrom('price_schedule').innerJoin('domains', 'domains.id', 'price_schedule.domain_id')
      .select(['price_schedule.id as id', 'price_schedule.event as event', 'domains.domain as domain']).where('price_schedule.id', 'in', ids).execute();
    const info = new Map(rows.map((r) => [Number(r.id), r]));
    const would_cancel = cancelled.flatMap((id) => { const r = info.get(id); return r ? [{ row_id: id, domain: r.domain, event: r.event }] : []; });
    const would_fail = failed.map((f) => ({ row_id: f.rowId, domain: f.domain, event: info.get(f.rowId)?.event ?? null, reason: f.reason }));
    req.auditSummary = `preview ${today}: ok`;
    return {
      today,
      priceJob: { would_apply: price.applied, would_supersede: price.superseded, would_cancel, would_fail, held: price.held, would_delist: price.delisted, ...(price.skipped ? { skipped: true } : {}) },
      dropJob: { would_drop: drop.dropped, ...(drop.skipped ? { skipped: true } : {}) },
    };
  });
}
