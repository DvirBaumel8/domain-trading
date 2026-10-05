import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { normalizeDomain } from '../domain-name.js';
import { AppError } from '../http/errors.js';
import { ISO_WITH_OFFSET, OFFER_BANDS, type OffersService } from '../services/offers.js';
import { OFFER_SOURCES } from '../services/offer-rules.js';
import { idtDayStart, reportOffers } from '../services/offer-stats.js';
import { jerusalemDate } from '../dates.js';
import type { Kysely } from 'kysely';
import type { Database } from '../db/types.js';

const Approval = z.object({ text: z.unknown().optional(), approved_at: z.unknown().optional() }).strict().nullable().optional();

const RecordSchema = z.object({
  domain: z.string(), amount_usd: z.string(), source: z.string(), received_at: z.string(),
  buyer_type: z.string().nullable().optional(), buyer_ref: z.string().nullable().optional(),
  external_ref: z.string().nullable().optional(), note: z.string().nullable().optional(),
  pricing_hold: z.boolean().nullable().optional(), pricing_hold_reason: z.string().nullable().optional(),
  approval_ref: Approval,
}).strict();

const OutcomeSchema = z.object({ outcome: z.string(), note: z.string().nullable().optional(), approval_ref: Approval }).strict();

const Query = z.object({
  domain: z.string().optional(), from: z.string().optional(), to: z.string().optional(),
  band: z.enum(OFFER_BANDS).optional(), source: z.enum(OFFER_SOURCES as [string, ...string[]]).optional(),
}).strict();

const bad = (m: string) => new AppError(400, 'VALIDATION_ERROR', m);

function bound(v: string | undefined, f: string): { date?: string; at?: Date } | undefined {
  if (v === undefined) return undefined;
  if (/^\d{4}-\d{2}-\d{2}$/.test(v)) {
    const t = new Date(`${v}T00:00:00Z`);
    if (Number.isNaN(t.getTime()) || t.toISOString().slice(0, 10) !== v) throw bad(`${f} is not a real date`);
    return { date: v };
  }
  if (ISO_WITH_OFFSET.test(v) && !Number.isNaN(Date.parse(v))) return { at: new Date(v) };
  throw bad(`${f} must be a date (YYYY-MM-DD, IDT day) or an ISO time with an offset`);
}

const CSV_LIMIT = 1024 * 1024;

export function registerOffers(app: FastifyInstance, service: OffersService, stats: { db: Kysely<Database>; now: () => number }): void {
  // The CSV import lives in its own plugin so the text/csv parser and the 1 MB limit apply to this route only.
  void app.register(async (csv) => {
    csv.addContentTypeParser('text/csv', { parseAs: 'string', bodyLimit: CSV_LIMIT }, (_req, body, done) => done(null, body));
    csv.post<{ Querystring: Record<string, string> }>('/offers/import', { bodyLimit: CSV_LIMIT }, async (req, reply) => {
      const q = z.object({ dry_run: z.enum(['true', 'false']).optional() }).strict().safeParse(req.query);
      if (!q.success) throw bad('dry_run must be true or false');
      if (typeof req.body !== 'string') throw new AppError(415, 'INVALID_BODY', 'Content-Type must be text/csv');
      const r = await service.importCsv(req.body, { dryRun: q.data.dry_run === 'true' }, { auditId: req.auditId!, recordedBy: req.auth!.name, setSummary: (m) => { req.auditSummary = m; } });
      return reply.code(r.status).send(r.body);
    });
  });

  app.post('/offers', async (req, reply) => {
    const body = RecordSchema.parse(req.body ?? {});
    const r = await service.record({ ...body, domain: normalizeDomain(body.domain) }, { auditId: req.auditId!, recordedBy: req.auth!.name });
    return reply.code(r.status).send(r.body);
  });

  app.post<{ Params: { id: string } }>('/offers/:id/outcome', async (req) => {
    const body = OutcomeSchema.parse(req.body ?? {});
    if (!/^\d{1,15}$/.test(req.params.id)) throw new AppError(404, 'OFFER_NOT_FOUND', 'Offer not found');
    return service.outcome(Number(req.params.id), body);
  });

  app.get('/offers', async (req) => {
    const p = Query.safeParse(req.query);
    if (!p.success) throw bad(`Invalid query: ${p.error.issues.map((i) => i.path.join('.') || i.message).join(', ')}`);
    let domain: string | undefined;
    if (p.data.domain !== undefined) {
      try { domain = normalizeDomain(p.data.domain); } catch { throw bad('domain is not a valid domain name'); }
    }
    const from = bound(p.data.from, 'from');
    const to = bound(p.data.to, 'to');
    if ((from?.date && to?.date && from.date > to.date) || (from?.at && to?.at && from.at > to.at)) throw bad('from must not be after to');
    return service.list({ domain, from, to, band: p.data.band, source: p.data.source });
  });

  app.get('/report/offers', async (req) => {
    const p = z.object({ from: z.string().optional(), to: z.string().optional(), group_by: z.enum(['domain', 'category', 'source', 'month']).optional() }).strict().safeParse(req.query);
    if (!p.success) throw bad(`Invalid query: ${p.error.issues.map((i) => i.path.join('.') || i.message).join(', ')}`);
    const dateOf = (v: string, f: string) => {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(v) || new Date(`${v}T00:00:00Z`).toISOString().slice(0, 10) !== v) throw bad(`${f} must be a real date (YYYY-MM-DD, IDT day)`);
      return v;
    };
    const today = jerusalemDate(new Date(stats.now()));
    const to = p.data.to === undefined ? today : dateOf(p.data.to, 'to');
    const from = p.data.from === undefined ? (await idtDayStartDate(stats.db, today, -89)) : dateOf(p.data.from, 'from');
    if (from > to) throw bad('from must not be after to');
    const group_by = p.data.group_by ?? 'domain';
    const rows = await reportOffers(stats.db, { from: await idtDayStart(stats.db, from), to: await idtDayStart(stats.db, to, 1), groupBy: group_by });
    return { from, to, group_by, rows };
  });
}

async function idtDayStartDate(db: Kysely<Database>, date: string, plus: number): Promise<string> {
  return jerusalemDate(await idtDayStart(db, date, plus));
}
