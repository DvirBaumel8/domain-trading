// Tranches (CAP-04): GET /tranches (READ); open, add/remove a member and close are WRITE.
import type { FastifyInstance } from 'fastify';
import type { Kysely } from 'kysely';
import { z } from 'zod';
import type { Database } from '../../../db/types.js';
import { AppError } from '../../../http/errors.js';
import { dollarsToCents } from '../../../core/money.js';
import { TrancheService } from '../tranches.js';

export interface TrancheApiDeps { db: Kysely<Database>; now: () => number }

const usd = z.number().positive().refine((n) => { try { dollarsToCents(n); return true; } catch { return false; } }, 'a positive USD amount with at most 2 decimals');
const OpenBody = z.object({ name: z.string().trim().min(1).max(80), spend_cap: usd.optional() }).strict();
const MemberBody = z.object({
  action: z.enum(['add', 'remove']), domain: z.string().trim().min(1).max(253), run_id: z.string().trim().min(1).max(80).optional(), est_cost: usd.optional(),
}).strict();
const CloseBody = z.object({ allow_below_target: z.boolean().optional(), reason: z.string().trim().min(1).max(500).optional() }).strict();

export function registerTranches(app: FastifyInstance, deps: TrancheApiDeps): void {
  const svc = new TrancheService(deps.db);
  /** USD inputs are bounded by the POC cap (a larger figure is never meaningful and must not reach an integer column). */
  const cents = async (v: number | undefined, field: string): Promise<number | null> => {
    if (v === undefined) return null;
    const c = dollarsToCents(v);
    const cap = (await deps.db.selectFrom('settings').select('poc_cap_cents').executeTakeFirstOrThrow()).poc_cap_cents;
    if (c > cap) throw new AppError(422, 'VALIDATION_ERROR', `${field} may not exceed the POC cap`, { field, cap_cents: cap });
    return c;
  };
  const actor = (req: { auth?: { name: string } | null; auditId?: string | null }) => ({ by: req.auth!.name, auditId: req.auditId ?? '', now: new Date(deps.now()) });

  app.get('/tranches', async () => svc.list());

  app.post('/tranches', { config: { openapiBody: OpenBody } }, async (req, reply) => {
    const b = OpenBody.parse(req.body ?? {});
    return reply.code(201).send(await svc.open(b.name, await cents(b.spend_cap, 'spend_cap'), actor(req)));
  });

  app.post<{ Params: { id: string } }>('/tranches/:id/members', { config: { openapiBody: MemberBody } }, async (req) => {
    const b = MemberBody.parse(req.body ?? {});
    if (b.action === 'remove') return svc.removeMember(req.params.id, b.domain, actor(req));
    if (!b.run_id) throw new AppError(422, 'VALIDATION_ERROR', 'run_id is required to add a name');
    const r = await svc.addMember(req.params.id, b.domain, b.run_id, await cents(b.est_cost, 'est_cost'), actor(req));
    return { ...r.tranche, duplicate: r.duplicate };
  });

  app.post<{ Params: { id: string } }>('/tranches/:id/close', { config: { openapiBody: CloseBody } }, async (req) => {
    const b = CloseBody.parse(req.body ?? {});
    if (b.allow_below_target && !b.reason) throw new AppError(422, 'VALIDATION_ERROR', 'allow_below_target needs a reason');
    return svc.close(req.params.id, { allowBelowTarget: b.allow_below_target ?? false, reason: b.reason ?? null }, actor(req));
  });
}
