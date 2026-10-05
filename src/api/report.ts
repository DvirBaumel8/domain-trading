import type { FastifyInstance } from 'fastify';
import type { Kysely } from 'kysely';
import type { Database } from '../db/types.js';
import { buildReport } from '../services/report/index.js';

export function registerReport(app: FastifyInstance, deps: { db: Kysely<Database>; now: () => number }): void {
  app.get('/report', async () => buildReport(deps.db, new Date(deps.now())));
}
