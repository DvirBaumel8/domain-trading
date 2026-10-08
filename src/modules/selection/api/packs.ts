// Screening packs (CAP-19): POST /screening/packs (WRITE) freezes a pack; GET reads one or lists a domain's versions (READ).
import type { FastifyInstance } from 'fastify';
import type { Kysely } from 'kysely';
import { z } from 'zod';
import type { Database } from '../../../db/types.js';
import { normalizeDomain } from '../../../domain-name.js';
import { AppError } from '../../../http/errors.js';
import { issuePack, JudgmentRecord, type PackRow } from '../pack.js';

export interface PackApiDeps { db: Kysely<Database>; now: () => number }

const Body = z.object({ run_id: z.string().trim().min(1).max(64), domain: z.string().trim().min(1).max(253), judgment: JudgmentRecord }).strict();
const Query = z.object({ domain: z.string().trim().min(1).max(253) }).strict();

const summary = (r: PackRow) => ({
  pack_id: r.id, domain: r.domain, version: r.version, status: r.status, missing: r.missing, run_id: r.run_id, settings_version: r.settings_label,
  content_sha256: r.content_sha256, issued_at: r.issued_at.toISOString(), issued_by: r.issued_by,
});

export function registerPacks(app: FastifyInstance, deps: PackApiDeps): void {
  const { db } = deps;
  app.post('/screening/packs', async (req, reply) => {
    const b = Body.parse(req.body ?? {});
    let domain: string;
    try { domain = normalizeDomain(b.domain); } catch { throw new AppError(422, 'DOMAIN_INVALID', `"${b.domain}" is not a valid domain`); }
    const { row, created } = await issuePack(db, { runId: b.run_id, domain, judgment: b.judgment, by: req.auth!.name, auditId: req.auditId ?? null, now: new Date(deps.now()) });
    return reply.code(created ? 201 : 200).send({ ...summary(row), ...(created ? {} : { unchanged: true }) });
  });

  app.get<{ Params: { id: string } }>('/screening/packs/:id', async (req) => {
    const r = await db.selectFrom('screening_packs').selectAll().where('id', '=', req.params.id).executeTakeFirst();
    if (!r) throw new AppError(404, 'PACK_NOT_FOUND', `No screening pack "${req.params.id}"`);
    return { ...summary(r), content: r.content };
  });

  app.get('/screening/packs', async (req) => {
    const parsed = Query.safeParse(req.query ?? {});
    if (!parsed.success) throw new AppError(400, 'VALIDATION_ERROR', 'Invalid query: domain is required and nothing else is accepted');
    const q = parsed.data;
    let domain: string;
    try { domain = normalizeDomain(q.domain); } catch { throw new AppError(422, 'DOMAIN_INVALID', `"${q.domain}" is not a valid domain`); }
    const rows = await db.selectFrom('screening_packs').selectAll().where('domain', '=', domain).orderBy('version', 'desc').execute();
    return { packs: rows.map(summary) };
  });
}
