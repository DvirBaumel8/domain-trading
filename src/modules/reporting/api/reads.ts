import { isIsoWithOffset, isRealDate } from '../../../core/dates.js';
import type { FastifyInstance } from 'fastify';
import type { Kysely } from 'kysely';
import { z } from 'zod';
import type { Database, DomainStatus, LedgerType } from '../../../db/types.js';
import { normalizeDomain } from '../../../domain-name.js';
import { AppError } from '../../../http/errors.js';
import { toCsv } from '../../listing/index.js';
import { auditRows, dealView, ledgerCsvRows, ledgerJson, ledgerRows, portfolioDetail, portfolioRows } from '../report/portfolio.js';

const STATUSES: readonly DomainStatus[] = ['owned', 'listed', 'delisted', 'sold', 'dropped'];
const LEDGER_TYPES: readonly LedgerType[] = ['registration', 'renewal', 'fee', 'commission', 'sale', 'payout_fee', 'refund', 'tool', 'ai', 'adjustment'];
const bad = (m: string) => new AppError(400, 'VALIDATION_ERROR', m);

export function realDay(v: string, f: string): string {
  if (!isRealDate(v)) throw bad(`${f} must be a real date (YYYY-MM-DD)`);
  return v;
}
const parse = <T extends z.ZodType>(schema: T, q: unknown): z.infer<T> => {
  const p = schema.safeParse(q);
  if (!p.success) throw bad(`Invalid query: ${p.error.issues.map((i) => i.path.join('.') || i.message).join(', ')}`);
  return p.data;
};

export function registerReads(app: FastifyInstance, deps: { db: Kysely<Database>; now: () => number }): void {
  const now = () => new Date(deps.now());

  app.get('/portfolio', async (req) => {
    const q = parse(z.object({ status: z.enum(STATUSES as [DomainStatus, ...DomainStatus[]]).optional() }).strict(), req.query);
    return { domains: await portfolioRows(deps.db, now(), q.status) };
  });

  app.get<{ Params: { domain: string } }>('/portfolio/:domain', async (req) => {
    let domain: string;
    try { domain = normalizeDomain(req.params.domain); } catch { throw new AppError(404, 'DOMAIN_NOT_FOUND', 'Domain not found'); }
    const r = await portfolioDetail(deps.db, now(), domain);
    if (!r) throw new AppError(404, 'DOMAIN_NOT_FOUND', `${domain} is not in the portfolio`);
    return r;
  });

  app.get('/ledger', async (req, reply) => {
    const q = parse(z.object({
      type: z.enum(LEDGER_TYPES as [LedgerType, ...LedgerType[]]).optional(), domain: z.string().optional(),
      from: z.string().optional(), to: z.string().optional(), format: z.enum(['json', 'csv']).optional(),
    }).strict(), req.query);
    let domain: string | undefined;
    if (q.domain !== undefined) { try { domain = normalizeDomain(q.domain); } catch { throw bad('domain is not a valid domain name'); } }
    const from = q.from === undefined ? undefined : realDay(q.from, 'from');
    const to = q.to === undefined ? undefined : realDay(q.to, 'to');
    if (from && to && from > to) throw bad('from must not be after to');
    const rows = await ledgerRows(deps.db, { type: q.type, domain, from, to });
    if (q.format === 'csv') return reply.type('text/csv; charset=utf-8').send(toCsv(ledgerCsvRows(rows)));
    return { count: rows.length, rows: ledgerJson(rows) };
  });

  app.get<{ Params: { id: string } }>('/deals/:id', async (req) => {
    const r = await dealView(deps.db, req.params.id);
    if (!r) throw new AppError(404, 'DEAL_NOT_FOUND', 'Deal not found');
    return r;
  });

  app.get('/audit', async (req) => {
    const q = parse(z.object({ since: z.string().optional(), limit: z.string().regex(/^\d{1,4}$/).optional() }).strict(), req.query);
    const limit = q.limit === undefined ? 100 : Number(q.limit);
    if (limit < 1 || limit > 500) throw bad('limit must be 1 to 500');
    if (q.since !== undefined && (!isIsoWithOffset(q.since))) throw bad('since must be an ISO 8601 time with an offset');
    const rows = await auditRows(deps.db, { since: q.since ? new Date(q.since) : undefined, limit });
    // v2.16.0 (CR-015 I-2): who made the call, by token name (never the token or its hash); null for a job, an admin command or a deleted token id.
    const ids = [...new Set(rows.map((r) => r.token_id).filter((x): x is number => x !== null))];
    const names = new Map<number, string>();
    if (ids.length > 0) for (const t of await deps.db.selectFrom('api_tokens').select(['id', 'name']).where('id', 'in', ids).execute()) names.set(t.id, t.name);
    return { rows: rows.map((r) => ({ ...r, token_name: r.token_id === null ? null : names.get(r.token_id) ?? null })) };
  });
}
