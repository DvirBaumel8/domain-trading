// CR-073 (v5.28.0). POST /pickproof/{date}/picks (bots or WRITE, Idempotency-Key, audited; non-money), GET /pickproof/{date}/manifest,
// GET /pickproof/{date}/arms, GET /pickproof/report (READ or bots).
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Kysely } from 'kysely';
import { z } from 'zod';
import { isRealDate } from '../../../core/dates.js';
import type { Database } from '../../../db/types.js';
import { AppError } from '../../../http/errors.js';
import { report } from '../report.js';
import { armsView, manifest, postPicks } from '../store.js';

const day = z.string().refine(isRealDate, 'must be a real date (YYYY-MM-DD)');
const PicksBody = z.object({ names: z.array(z.string().min(1).max(253)).min(1).max(300) }).strict();
const ArmsQuery = z.object({ arm: z.enum(['A', 'B1', 'B2', 'C1', 'C2']).optional() }).strict();
const ReportQuery = z.object({ from: day.optional(), to: day.optional() }).strict();
const bad = (e: z.ZodError) => new AppError(400, 'VALIDATION_ERROR', `Invalid request: ${e.issues.map((i) => `${i.path.join('.') || 'value'} ${i.message}`).join('; ')}`);
const dayParam = (req: FastifyRequest): string => {
  const p = day.safeParse((req.params as { date?: string }).date);
  if (!p.success) throw bad(p.error);
  return p.data;
};

export function registerPickproof(app: FastifyInstance, deps: { db: Kysely<Database>; now: () => number }): void {
  const { db } = deps;

  app.post('/pickproof/:date/picks', { config: { openapiBody: PicksBody } }, async (req, reply) => {
    const date = dayParam(req);
    const b = PicksBody.parse(req.body ?? {});
    const r = await postPicks(db, { day: date, names: b.names, by: req.auth?.name ?? 'unknown', auditId: req.auditId ?? null, now: deps.now() });
    req.auditSummary = `pickproof picks ${date}: ${r.n} names`;
    return reply.code(200).send({ ...r, audit_id: req.auditId ?? null });
  });

  app.get('/pickproof/report', async (req) => {
    const p = ReportQuery.safeParse(req.query ?? {});
    if (!p.success) throw bad(p.error);
    if (p.data.from && p.data.to && p.data.from > p.data.to) throw new AppError(400, 'VALIDATION_ERROR', 'from must not be after to');
    return report(db, p.data);
  });

  app.get('/pickproof/:date/manifest', async (req) => manifest(db, dayParam(req), deps.now()));

  app.get('/pickproof/:date/arms', async (req) => {
    const date = dayParam(req);
    const p = ArmsQuery.safeParse(req.query ?? {});
    if (!p.success) throw bad(p.error);
    return armsView(db, date, p.data.arm);
  });
}
