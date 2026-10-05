import type { FastifyInstance } from 'fastify';
import type { Kysely } from 'kysely';
import { z } from 'zod';
import type { Database } from '../db/types.js';
import { AppError } from '../http/errors.js';
import { buildReport } from '../services/report/index.js';
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
}
