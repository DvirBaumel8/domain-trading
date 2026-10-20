// v5.25.0 (CR-070). POST /ledger/costs, PUT /portfolio/:domain/forward-costs (bots or WRITE, Idempotency-Key, audited), GET /costs/forward, GET /books.csv (READ or bots; walk-away inside, never public).
import type { FastifyInstance } from 'fastify';
import type { Kysely } from 'kysely';
import { z } from 'zod';
import type { Database } from '../../../db/types.js';
import { normalizeDomain } from '../../../domain-name.js';
import { AppError } from '../../../http/errors.js';
import { toCsv } from '../../listing/index.js';
import { booksRows, COST_TYPES, COSTS_MAX_ROWS, defaultForwardRange, forwardCostHistory, forwardCosts, monthsBetween, parseForwardBody, twelveMonthsFrom, postCosts, putForwardCosts } from '../books.js';

const month = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'must be YYYY-MM');
const ForwardQuery = z.object({ from: month.optional(), to: month.optional() }).strict();
const MAX_MONTHS = 36;

// documented in GET /openapi.json; the handlers validate by hand so every wrong row names its field and a derived field answers DERIVED_FIELD
const CostsBody = z.object({
  rows: z.array(z.object({ date: z.string(), type: z.enum(COST_TYPES), amount_usd: z.string(), note: z.string().max(200), domain: z.string().optional() }).strict()).min(1).max(COSTS_MAX_ROWS),
  dry_run: z.boolean().optional(),
}).strict();
const ForwardBody = z.object({
  lines: z.array(z.object({ month, item: z.string(), planned_usd: z.string(), basis: z.string(), cost_type: z.string() }).strict()),
}).strict();

export function registerBooks(app: FastifyInstance, deps: { db: Kysely<Database>; now: () => number }): void {
  const { db } = deps;

  app.post('/ledger/costs', { config: { openapiBody: CostsBody } }, async (req, reply) => {
    const r = await postCosts(db, req.body ?? {}, { auditId: req.auditId ?? null });
    req.auditSummary = `ledger costs${r.dry_run ? ' (dry run)' : ''}: ${r.accepted_n} row(s), ${r.total_usd}`;
    return reply.code(r.dry_run ? 200 : 201).send({ ...r, audit_id: req.auditId ?? null });
  });

  app.put<{ Params: { domain: string } }>('/portfolio/:domain/forward-costs', { config: { openapiBody: ForwardBody } }, async (req, reply) => {
    const lines = parseForwardBody(req.body ?? {}); // DERIVED_FIELD and shape errors first
    let domain: string;
    try { domain = normalizeDomain(req.params.domain); } catch { throw new AppError(404, 'DOMAIN_NOT_FOUND', 'Domain not found'); }
    const r = await putForwardCosts(db, domain, lines, { tokenName: req.auth?.name ?? null, auditId: req.auditId ?? null });
    req.auditSummary = `forward costs ${domain} v${r.version}: ${r.lines_n} line(s)`;
    return reply.code(200).send({ ...r, audit_id: req.auditId ?? null });
  });

  app.get<{ Params: { domain: string } }>('/portfolio/:domain/forward-costs', async (req) => {
    let domain: string;
    try { domain = normalizeDomain(req.params.domain); } catch { throw new AppError(404, 'DOMAIN_NOT_FOUND', 'Domain not found'); }
    const d = await db.selectFrom('domains').select(['id', 'status']).where('domain', '=', domain).executeTakeFirst();
    if (!d || d.status === 'pending_purchase') throw new AppError(404, 'DOMAIN_NOT_FOUND', `${domain} is not in the portfolio`);
    const versions = await forwardCostHistory(db, domain);
    return { domain, current: versions[0] ?? null, versions };
  });

  app.get('/costs/forward', async (req) => {
    const p = ForwardQuery.safeParse(req.query ?? {});
    if (!p.success) throw new AppError(400, 'VALIDATION_ERROR', `Invalid query: ${p.error.issues.map((i) => `${i.path.join('.') || 'query'} ${i.message}`).join('; ')}`);
    const dflt = defaultForwardRange(new Date(deps.now()));
    const from = p.data.from ?? dflt.from;
    const to = p.data.to ?? (p.data.from ? twelveMonthsFrom(from) : dflt.to);
    if (from > to) throw new AppError(400, 'VALIDATION_ERROR', 'from must not be after to');
    if (monthsBetween(from, to).length > MAX_MONTHS) throw new AppError(400, 'VALIDATION_ERROR', `The range may cover at most ${MAX_MONTHS} months`);
    return forwardCosts(db, from, to);
  });

  app.get('/books.csv', async (_req, reply) => {
    return reply.type('text/csv; charset=utf-8').send(toCsv(await booksRows(db, new Date(deps.now()))));
  });
}
