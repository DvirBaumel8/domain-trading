import type { FastifyInstance } from 'fastify';
import type { Kysely } from 'kysely';
import { z } from 'zod';
import type { Database } from '../db/types.js';
import { AppError } from '../http/errors.js';
import { buildReport } from '../services/report/index.js';
import { idtDay, idtDayStart } from '../core/dates.js';
import { pricingReview } from '../services/report/pricing-review.js';
import { realDay } from './reads.js';
import { reportMarkdown } from '../services/report/markdown.js';

const Query = z.object({ format: z.enum(['json', 'md']).optional() }).strict();

export function registerReport(app: FastifyInstance, deps: { db: Kysely<Database>; now: () => number }): void {
  app.get('/report', async (req, reply) => {
    const q = Query.safeParse(req.query);
    if (!q.success) throw new AppError(400, 'VALIDATION_ERROR', 'format must be json or md');
    const report = await buildReport(deps.db, new Date(deps.now()));
    if (q.data.format === 'md') return reply.type('text/markdown; charset=utf-8').send(reportMarkdown(report));
    return report;
  });

  app.get('/report/pricing-review', async (req) => {
    const q = z.object({ from: z.string().optional(), to: z.string().optional() }).strict().safeParse(req.query);
    if (!q.success) throw new AppError(400, 'VALIDATION_ERROR', 'Invalid query: only from and to (YYYY-MM-DD) are accepted');
    const today = idtDay(new Date(deps.now()));
    const to = q.data.to === undefined ? today : realDay(q.data.to, 'to');
    const from = q.data.from === undefined ? idtDay(idtDayStart(to, -89)) : realDay(q.data.from, 'from');
    if (from > to) throw new AppError(400, 'VALIDATION_ERROR', 'from must not be after to');
    return pricingReview(deps.db, { from, to });
  });
}
