// F47 (v5.66.0). POST /handreg/weeks (bots or WRITE, Idempotency-Key, audited; non-money), GET /handreg/weeks, GET /handreg/weeks/:week, GET /handreg/report.
import type { FastifyInstance } from 'fastify';
import type { Kysely } from 'kysely';
import { z } from 'zod';
import { isRealDate } from '../../../core/dates.js';
import type { RdapLookupFn } from '../../../core/rdap.js';
import type { Database } from '../../../db/types.js';
import { AppError } from '../../../http/errors.js';
import { listWeeks, report, submitWeek, weekView } from '../handreg.js';

const SubmitBody = z.object({
  pool: z.array(z.string().min(1).max(253)).min(1).max(20000),
  picks: z.array(z.string().min(1).max(253)).min(1).max(100),
  dry_run: z.boolean().optional(),
}).strict();

export function registerHandreg(app: FastifyInstance, deps: { db: Kysely<Database>; now: () => number; rdap?: RdapLookupFn; sleep?: (ms: number) => Promise<void> }): void {
  const { db } = deps;

  app.post('/handreg/weeks', { config: { openapiBody: SubmitBody } }, async (req, reply) => {
    const b = SubmitBody.parse(req.body ?? {});
    const r = await submitWeek(deps, { pool: b.pool, picks: b.picks, dryRun: b.dry_run === true, by: req.auth?.name ?? 'unknown', auditId: req.auditId ?? null });
    req.auditSummary = r.dry_run ? `handreg dry run ${r.week}: ${r.picks_n} picks of ${r.pool_n}` : `handreg sealed ${r.week}: ${r.picks_n} picks of ${r.pool_n}`;
    return reply.code(r.dry_run ? 200 : 201).send({ ...r, audit_id: req.auditId ?? null });
  });

  app.get('/handreg/weeks', async () => listWeeks(db));

  app.get('/handreg/weeks/:week', async (req) => {
    const week = (req.params as { week?: string }).week ?? '';
    if (!isRealDate(week)) throw new AppError(422, 'VALIDATION_ERROR', 'week must be a real date (YYYY-MM-DD)');
    return weekView(db, week);
  });

  app.get('/handreg/report', async () => report(db));
}
