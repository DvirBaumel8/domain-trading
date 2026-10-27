// v5.64.0 (CR-083): POST /data/card-evidence (WRITE, bots or data scope; { rows, dry_run? }), GET /data/card-evidence (READ, bots, WRITE; a data token gets 403),
// GET /data/card-evidence/:id. Bot-posted evidence only; no route here touches prices, listings, bids, buys, exports or the ledger.
import type { FastifyInstance } from 'fastify';
import type { Kysely } from 'kysely';
import { z } from 'zod';
import type { Database } from '../../../db/types.js';
import { AppError } from '../../../http/errors.js';
import { registerBulkRoute, type DbSizeGuard } from '../../engine/index.js';
import { CARD_EVIDENCE_KINDS, getCardEvidence, loadCardEvidence, readCardEvidence } from '../card-evidence.js';

const MAX_ROWS = 500;
const Doc = z.object({ rows: z.array(z.record(z.string(), z.unknown())).min(1).max(MAX_ROWS), dry_run: z.boolean().optional() }).strict();
const Query = z.object({
  domain: z.string().min(1).max(253).optional(),
  term: z.string().min(1).max(200).optional(),
  kind: z.enum(CARD_EVIDENCE_KINDS).optional(),
  fresh_only: z.enum(['true', 'false']).default('false'),
  limit: z.coerce.number().int().min(1).max(1000).default(100),
  offset: z.coerce.number().int().min(0).max(1_000_000).default(0),
}).strict();
const Params = z.object({ id: z.coerce.number().int().min(1).max(Number.MAX_SAFE_INTEGER) });

export function registerCardEvidence(app: FastifyInstance, deps: { db: Kysely<Database>; now: () => number; dbSize: DbSizeGuard }): void {
  registerBulkRoute(app, deps, {
    path: '/data/card-evidence', doc: Doc, dryRun: true, maxRows: MAX_ROWS,
    load: (rows, ctx) => loadCardEvidence(deps.db, rows, ctx),
    summary: (r, before, after) => `card evidence${r.dry_run ? ' (dry run)' : ''}: ${r.accepted_n} accepted, ${r.duplicate_n} duplicate, ${r.rejected_n} rejected of ${r.received_n}; db ${before} -> ${after} bytes`,
  });

  app.get('/data/card-evidence', async (req) => {
    const parsed = Query.safeParse(req.query ?? {});
    if (!parsed.success) throw new AppError(422, 'VALIDATION_ERROR', 'Invalid query', { issues: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })) });
    const q = parsed.data;
    return { table: 'card_evidence', ...(await readCardEvidence(deps.db, {
      domain: q.domain?.trim().toLowerCase(), term: q.term?.trim().toLowerCase(), kind: q.kind, freshOnly: q.fresh_only === 'true', limit: q.limit, offset: q.offset, now: deps.now(),
    })) };
  });

  app.get('/data/card-evidence/:id', async (req) => {
    const p = Params.safeParse(req.params);
    if (!p.success) throw new AppError(422, 'VALIDATION_ERROR', 'Invalid id');
    const row = await getCardEvidence(deps.db, p.data.id, deps.now());
    if (!row) throw new AppError(404, 'CARD_EVIDENCE_NOT_FOUND', `No card evidence row ${p.data.id}`);
    return row;
  });
}
