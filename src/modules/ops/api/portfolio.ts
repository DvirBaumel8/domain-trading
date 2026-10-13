// v4.0.0: the write routes of the life of a bought name. POST /portfolio/{domain}/horizon (CR-045 item 2, CR-046 item 1) and POST /portfolio/{domain}/stats (CR-044 item 2, CR-046 item 4, CR-049 item 5).
// Neither contacts a registrar or a venue. The horizon route needs Dvir's approval_ref because it changes the plan of a bought name (drop_date).
import type { FastifyInstance } from 'fastify';
import type { Kysely } from 'kysely';
import { z } from 'zod';
import { checkApproval } from '../../../core/approval.js';
import { addMonthsClamped, idtDay, isYmd, isRealDate, dayNumber } from '../../../core/dates.js';
import { approvalRef, hasAtSign, piiError } from '../../../core/validation.js';
import type { Database } from '../../../db/types.js';
import { normalizeDomain } from '../../../domain-name.js';
import { AppError } from '../../../http/errors.js';
import { activeSelectionSettings } from '../../selection/index.js';
import { dropAtFirstExpiry } from '../admin/drop-date.js';

const HorizonBody = z.object({ horizon: z.enum(['evergreen', 'trend', 'regulation']), approval_ref: approvalRef }).strict();
const Count = z.number().int().min(0).max(100_000_000);
const StatsBody = z.object({
  as_of: z.string(), month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/).optional(), venue: z.enum(['afternic', 'sedo', 'sellerhub']).optional(),
  views: Count.optional(), leads: Count.optional(), inquiries: Count.optional(), offers: Count.optional(), source: z.string().trim().min(1).max(100),
}).strict();

const domainOf = (raw: string): string => {
  try { return normalizeDomain(raw); } catch { throw new AppError(404, 'DOMAIN_NOT_FOUND', 'Domain not found'); }
};

export function registerPortfolioWrites(app: FastifyInstance, deps: { db: Kysely<Database>; now: () => number }): void {
  app.post<{ Params: { domain: string } }>('/portfolio/:domain/horizon', { config: { openapiBody: HorizonBody } }, async (req, reply) => {
    const domain = domainOf(req.params.domain);
    const b = HorizonBody.parse(req.body ?? {});
    const now = new Date(deps.now());
    const cfg = await deps.db.selectFrom('settings').select('approval_max_age_hours').executeTakeFirstOrThrow();
    const appr = checkApproval(b.approval_ref ?? null, domain, now, cfg.approval_max_age_hours);
    if (!appr.ok) throw new AppError(422, appr.code, appr.reason);
    const cur = await deps.db.selectFrom('domains').selectAll().where('domain', '=', domain).executeTakeFirst();
    if (!cur || !['owned', 'listed', 'delisted'].includes(cur.status)) throw new AppError(404, 'DOMAIN_NOT_FOUND', `${domain} is not a live name in the portfolio`);
    const warnings: string[] = [];
    let sellOrDropBy: string | null = null;
    if (b.horizon !== 'evergreen') {
      if (cur.renewals_used !== 0) throw new AppError(422, 'MAX_ONE_RENEWAL_USED', 'A renewed name can no longer drop at its first expiry');
      if (!cur.buy_date || !cur.expiry_date) throw new Error('a live name always has a buy date and an expiry date (domains_owned_fields)');
      const months = (await activeSelectionSettings(deps.db)).values.renewal.horizon_months;
      sellOrDropBy = addMonthsClamped(cur.buy_date, months);
      if (cur.drop_date !== cur.expiry_date) {
        const r = await dropAtFirstExpiry(deps.db, { domain, approvalText: String(b.approval_ref?.text), approvalAt: String(b.approval_ref?.approved_at), now });
        warnings.push(...r.warnings);
      }
      if (cur.lto_max_months !== null) warnings.push('LTO_STILL_ON: lease-to-own is set on this name; change the listing (POST /list) to remove it, a lease would run past the drop date');
    }
    await deps.db.updateTable('domains').set({ horizon: b.horizon, sell_or_drop_by: sellOrDropBy, updated_at: now }).where('id', '=', cur.id).execute();
    const after = await deps.db.selectFrom('domains').select(['drop_date', 'expiry_date']).where('id', '=', cur.id).executeTakeFirstOrThrow();
    return reply.code(200).send({ domain, horizon: b.horizon, sell_or_drop_by: sellOrDropBy, drop_date: after.drop_date, expiry_date: after.expiry_date, warnings, audit_id: req.auditId ?? null });
  });

  app.post<{ Params: { domain: string } }>('/portfolio/:domain/stats', { config: { openapiBody: StatsBody } }, async (req, reply) => {
    const domain = domainOf(req.params.domain);
    const b = StatsBody.parse(req.body ?? {});
    if (!isYmd(b.as_of) || !isRealDate(b.as_of)) throw new AppError(422, 'VALIDATION_ERROR', 'as_of must be a real date YYYY-MM-DD');
    const today = idtDay(new Date(deps.now()));
    if (dayNumber(b.as_of) > dayNumber(today)) throw new AppError(422, 'VALIDATION_ERROR', 'as_of must not be in the future');
    if (b.views === undefined && b.leads === undefined && b.inquiries === undefined && b.offers === undefined) {
      throw new AppError(422, 'VALIDATION_ERROR', 'at least one of views, leads, inquiries, offers is required');
    }
    if (hasAtSign(b.source)) throw piiError("source must not contain an email address or '@'", { field: 'source' }); // CR-051 B-2
    const d = await deps.db.selectFrom('domains').select(['id', 'status']).where('domain', '=', domain).executeTakeFirst();
    if (!d || d.status === 'pending_purchase') throw new AppError(404, 'DOMAIN_NOT_FOUND', `${domain} is not in the portfolio`);
    const row = await deps.db.insertInto('portfolio_stats').values({
      domain, as_of: b.as_of, month: b.month ?? b.as_of.slice(0, 7), venue: b.venue ?? 'afternic', views: b.views ?? null, leads: b.leads ?? null,
      inquiries: b.inquiries ?? null, offers: b.offers ?? null, source: b.source, token_name: req.auth?.name ?? null, audit_id: req.auditId ?? null,
    }).returningAll().executeTakeFirstOrThrow();
    return reply.code(201).send({ id: row.id, domain, as_of: row.as_of, month: row.month, venue: row.venue, views: row.views, leads: row.leads, inquiries: row.inquiries, offers: row.offers, source: row.source, audit_id: row.audit_id });
  });
}
