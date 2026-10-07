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
  priceJob: { runOnce(o: { today?: string; dryRun?: boolean }): Promise<{ applied: unknown[]; superseded: unknown[]; held: unknown[]; delisted: unknown[]; skipped: boolean }> };
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
 * POST /jobs/run: called by the external scheduler (Cloudflare Worker). Auth is the job-trigger bearer (see http/auth.ts).
 * GET /jobs/runs (READ): the recorded runs. POST /jobs/preview (WRITE): the price and drop jobs as a dry run for a chosen day.
 */
export function registerJobs(app: FastifyInstance, runner: JobRunner, deps: JobsDeps): void {
  app.post('/jobs/run', async (req, reply) => {
    const { job } = Body.parse(req.body);
    const started = new Date().toISOString();
    const key = req.headers['idempotency-key'];
    const result = await runner.run(job, triggerFromKey(job, typeof key === 'string' ? key : undefined));
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
    req.auditSummary = `preview ${today}: ok`;
    return {
      today,
      priceJob: { would_apply: price.applied, would_supersede: price.superseded, held: price.held, would_delist: price.delisted, ...(price.skipped ? { skipped: true } : {}) },
      dropJob: { would_drop: drop.dropped, ...(drop.skipped ? { skipped: true } : {}) },
    };
  });
}
