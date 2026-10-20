// CR-075 (v5.23.0). POST /data/sales (bots or WRITE or data, Idempotency-Key, add-only), PUT/PATCH/DELETE on it (405 APPEND_ONLY),
// GET /market/episodes, /market/matched, /market/dq, /market/coverage (READ or bots).
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Kysely } from 'kysely';
import { z } from 'zod';
import { isRealDate } from '../../../core/dates.js';
import type { Database } from '../../../db/types.js';
import { AppError } from '../../../http/errors.js';
import { BANDS, utcDay } from '../common.js';
import { coverage } from '../coverage.js';
import { latestDq } from '../dq.js';
import { matchedSet } from '../matched.js';
import { listEpisodes } from '../read.js';
import { loadSales, SalesBody } from '../sales.js';

const day = z.string().refine(isRealDate, 'must be a real date (YYYY-MM-DD)');
const EpisodesQuery = z.object({
  outcome: z.enum(['sold', 'unsold', 'unknown', 'delisted']).optional(),
  rule: z.string().min(1).max(40).optional(),
  band: z.enum(BANDS as unknown as [string, ...string[]]).optional(),
  from: day.optional(), to: day.optional(),
  venue: z.string().min(1).max(40).optional(),
  limit: z.coerce.number().int().min(1).max(1000).default(100),
}).strict();
const MatchedQuery = z.object({
  asof: day,
  ratio: z.coerce.number().int().min(1).max(20).default(4),
  seed: z.coerce.number().int().min(0).max(4_294_967_295).default(1),
}).strict();
const CoverageQuery = z.object({ days: z.coerce.number().int().min(1).max(120).default(30) }).strict();

const bad = (p: { error: z.ZodError }) => new AppError(400, 'VALIDATION_ERROR', `Invalid query: ${p.error.issues.map((i) => `${i.path.join('.') || 'query'} ${i.message}`).join('; ')}`);
const BODY_LIMIT = 4 * 1024 * 1024;

export function registerMarket(app: FastifyInstance, deps: { db: Kysely<Database>; now: () => number }): void {
  const { db } = deps;

  app.post('/data/sales', { config: { openapiBody: SalesBody }, bodyLimit: BODY_LIMIT }, async (req: FastifyRequest, reply) => {
    const b = SalesBody.parse(req.body ?? {});
    const r = await loadSales(db, b.rows, { by: req.auth?.name ?? 'unknown', auditId: req.auditId ?? null, todayUtc: utcDay(deps.now()), dryRun: b.dry_run === true });
    req.auditSummary = `data sales${r.dry_run ? ' (dry run)' : ''}: ${r.accepted_n} accepted, ${r.duplicate_n} duplicate of ${r.received_n}`;
    return reply.code(201).send({ ...r, audit_id: req.auditId ?? null });
  });

  // add-only: no update and no delete, whatever the token (the hook answers before the key check)
  const appendOnly = async (_req: FastifyRequest, reply: { header: (k: string, v: string) => unknown }) => {
    reply.header('allow', 'POST');
    throw new AppError(405, 'APPEND_ONLY', 'Sale reports are add-only: POST /data/sales adds rows; there is no update and no delete');
  };
  for (const url of ['/data/sales', '/data/sales/:id']) {
    app.route({ method: ['PUT', 'PATCH', 'DELETE'], url, onRequest: appendOnly, handler: async () => undefined });
  }

  app.get('/market/episodes', async (req) => {
    const p = EpisodesQuery.safeParse(req.query ?? {});
    if (!p.success) throw bad(p);
    if (p.data.from && p.data.to && p.data.from > p.data.to) throw new AppError(400, 'VALIDATION_ERROR', 'from must not be after to');
    return listEpisodes(db, p.data);
  });

  app.get('/market/matched', async (req) => {
    const p = MatchedQuery.safeParse(req.query ?? {});
    if (!p.success) throw bad(p);
    return matchedSet(db, p.data);
  });

  app.get('/market/dq', async () => latestDq(db));

  app.get('/market/coverage', async (req) => {
    const p = CoverageQuery.safeParse(req.query ?? {});
    if (!p.success) throw bad(p);
    return coverage(db, deps.now(), p.data.days);
  });
}
