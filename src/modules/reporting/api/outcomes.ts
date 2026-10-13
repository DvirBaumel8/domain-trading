// v4.0.0: GET /portfolio/outcomes, /portfolio/outcomes/monthly, /portfolio/outcomes/quarterly (READ). Registered before the /portfolio/:domain read.
import type { FastifyInstance } from 'fastify';
import type { Kysely } from 'kysely';
import { z } from 'zod';
import type { Database } from '../../../db/types.js';
import { outcomes, outcomesMonthly, outcomesQuarterly } from '../report/outcomes.js';

const Month = z.object({ month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'month must be YYYY-MM').optional() }).strict();

export function registerOutcomes(app: FastifyInstance, deps: { db: Kysely<Database>; now: () => number }): void {
  app.get('/portfolio/outcomes', async () => outcomes(deps.db, new Date(deps.now())));
  app.get('/portfolio/outcomes/monthly', async (req) => outcomesMonthly(deps.db, new Date(deps.now()), Month.parse(req.query ?? {}).month ?? null));
  app.get('/portfolio/outcomes/quarterly', async () => outcomesQuarterly(deps.db));
}
