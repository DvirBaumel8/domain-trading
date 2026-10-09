import { approvalRef } from '../../../core/validation.js';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { normalizeDomain } from '../../../domain-name.js';
import { AppError } from '../../../http/errors.js';
import { OFFER_BANDS, OffersService } from '../offers.js';
import { OFFER_SOURCES } from '../offer-rules.js';
import { reportOffers } from '../offer-stats.js';
import { addDays, idtDay, idtDayStart, isIsoWithOffset, isRealDate, isYmd } from '../../../core/dates.js';
import type { Kysely } from 'kysely';
import type { Database } from '../../../db/types.js';

const Approval = approvalRef;

const RecordSchema = z.object({
  domain: z.string(), amount_usd: z.string(), source: z.string(), received_at: z.string(),
  buyer_type: z.string().nullable().optional(), buyer_ref: z.string().nullable().optional(),
  external_ref: z.string().nullable().optional(), note: z.string().nullable().optional(),
  pricing_hold: z.boolean().nullable().optional(), pricing_hold_reason: z.string().nullable().optional(),
  approval_ref: Approval,
  dry_run: z.boolean().optional(),
}).strict();

const OutcomeSchema = z.object({ outcome: z.string(), note: z.string().nullable().optional(), approval_ref: Approval }).strict();

const Query = z.object({
  domain: z.string().optional(), from: z.string().optional(), to: z.string().optional(),
  band: z.enum(OFFER_BANDS).optional(), source: z.enum(OFFER_SOURCES as [string, ...string[]]).optional(),
}).strict();

const bad = (m: string) => new AppError(400, 'VALIDATION_ERROR', m);

/** One validator for a YYYY-MM-DD calendar day: rejects bad shapes, invalid and rolled-over dates (2026-02-30, 2026-13-01). */
function realDay(v: string, f: string): string {
  if (!isRealDate(v)) throw bad(`${f} must be a real date (YYYY-MM-DD, IDT day)`);
  return v;
}

function bound(v: string | undefined, f: string): { date?: string; at?: Date } | undefined {
  if (v === undefined) return undefined;
  if (isYmd(v)) return { date: realDay(v, f) };
  if (isIsoWithOffset(v)) { realDay(v.slice(0, 10), f); return { at: new Date(v) }; }
  throw bad(`${f} must be a date (YYYY-MM-DD, IDT day) or an ISO time with an offset`);
}

export function registerOffers(app: FastifyInstance, service: OffersService, stats: { db: Kysely<Database>; now: () => number }): void {
  app.post('/offers', { config: { openapiBody: RecordSchema } }, async (req, reply) => {
    const body = RecordSchema.parse(req.body ?? {});
    const r = await service.record({ ...body, domain: normalizeDomain(body.domain) }, { auditId: req.auditId!, recordedBy: req.auth!.name });
    return reply.code(r.status).send(r.body);
  });

  app.post<{ Params: { id: string } }>('/offers/:id/outcome', { config: { openapiBody: OutcomeSchema } }, async (req) => {
    const body = OutcomeSchema.parse(req.body ?? {});
    OffersService.checkOutcomeBody(body); // the body is checked before the id (BUG-4)
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
    const today = idtDay(new Date(stats.now()));
    const to = p.data.to === undefined ? today : realDay(p.data.to, 'to');
    const from = p.data.from === undefined ? addDays(today, -89) : realDay(p.data.from, 'from');
    if (from > to) throw bad('from must not be after to');
    const group_by = p.data.group_by ?? 'domain';
    const rows = await reportOffers(stats.db, { from: idtDayStart(from), to: idtDayStart(to, 1), groupBy: group_by });
    return { from, to, group_by, rows };
  });
}
