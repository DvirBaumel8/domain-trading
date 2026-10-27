// v5.63.0 (CR-084 R-7). POST /decisions (WRITE or bots, Idempotency-Key, audited, { rows (1..500), dry_run? }), GET /decisions (READ, bots, WRITE), GET /decisions/:id.
// A decision is a record only: no route here changes a price, a listing or any money.
import type { FastifyInstance } from 'fastify';
import type { Kysely } from 'kysely';
import type { Database } from '../../../db/types.js';
import { AppError } from '../../../http/errors.js';
import { DECISION_ID, DecisionsBody, DecisionsQuery, getDecision, listDecisions, postDecisions } from '../decisions.js';

export function registerDecisions(app: FastifyInstance, deps: { db: Kysely<Database>; now: () => number }): void {
  const { db } = deps;

  app.post('/decisions', { config: { openapiBody: DecisionsBody }, bodyLimit: 2 * 1024 * 1024 }, async (req, reply) => {
    const p = DecisionsBody.safeParse(req.body ?? {});
    if (!p.success) throw new AppError(422, 'VALIDATION_ERROR', `Invalid body: ${p.error.issues.slice(0, 20).map((i) => `${i.path.join('.') || 'body'} ${i.message}`).join('; ')}`, { issues: p.error.issues.slice(0, 50).map((i) => ({ path: i.path.join('.'), message: i.message })) });
    const r = await postDecisions(db, p.data, { by: req.auth?.name ?? 'unknown', auditId: req.auditId ?? null });
    req.auditSummary = `decisions${r.dry_run ? ' (dry run)' : ''}: ${r.accepted_n} accepted, ${r.duplicate_n} duplicate of ${r.received_n}`;
    return reply.code(r.dry_run ? 200 : 201).send({ ...r, audit_id: req.auditId ?? null });
  });

  app.get('/decisions', async (req) => {
    const p = DecisionsQuery.safeParse(req.query ?? {});
    if (!p.success) throw new AppError(400, 'VALIDATION_ERROR', `Invalid query: ${p.error.issues.map((i) => `${i.path.join('.') || 'query'} ${i.message}`).join('; ')}`);
    return listDecisions(db, p.data);
  });

  app.get<{ Params: { id: string } }>('/decisions/:id', async (req) => {
    if (!DECISION_ID.test(req.params.id)) throw new AppError(404, 'DECISION_NOT_FOUND', 'No such decision');
    return getDecision(db, req.params.id);
  });
}
