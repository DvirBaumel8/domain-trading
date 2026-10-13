// v4.0.0 (CR-045 item 5, as amended): the outreach log Gavriel writes to for every email he sends. The service never sends email (founder rule 10).
// The recipient is stored as the company's domain only, never a person's address. The 6th email for one name (outreach.max_emails_per_name 5) is refused.
import type { FastifyInstance } from 'fastify';
import type { Kysely } from 'kysely';
import { sql } from 'kysely';
import { z } from 'zod';
import { isIsoWithOffset, isRealDate, toJerusalemIso } from '../../../core/dates.js';
import { piiError } from '../../../core/validation.js';
import type { Database } from '../../../db/types.js';
import { normalizeDomain } from '../../../domain-name.js';
import { AppError } from '../../../http/errors.js';
import { activeSelectionSettings } from '../../selection/index.js';

const FUTURE_SKEW_MS = 5 * 60_000;
const HOST = /^(?=.{4,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,24}$/;
const Body = z.object({
  domain: z.string().min(1), recipient_domain: z.string().min(1).max(253), sent_at: z.string(),
  reply: z.boolean().optional(), outcome: z.enum(['interested', 'declined', 'offer', 'sold', 'bounced', 'other']).nullable().optional(),
}).strict();

export function registerEmails(app: FastifyInstance, deps: { db: Kysely<Database>; now: () => number }): void {
  app.post('/outreach/emails', { config: { openapiBody: Body } }, async (req, reply) => {
    const b = Body.parse(req.body ?? {});
    const recipient = b.recipient_domain.trim().toLowerCase();
    if (/[@\s<>]/.test(recipient) || recipient.includes('/') || recipient.includes(':')) throw piiError('recipient_domain is the company domain only (for example example.com), never an email address or a name');
    if (!HOST.test(recipient)) throw new AppError(422, 'VALIDATION_ERROR', 'recipient_domain must be a domain name such as example.com');
    let domain: string;
    try { domain = normalizeDomain(b.domain); } catch { throw new AppError(404, 'DOMAIN_NOT_FOUND', 'Domain not found'); }
    if (!isIsoWithOffset(b.sent_at) || !isRealDate(b.sent_at.slice(0, 10))) throw new AppError(422, 'VALIDATION_ERROR', 'sent_at must be a real ISO 8601 time with an offset');
    const sentAt = new Date(b.sent_at);
    if (sentAt.getTime() > deps.now() + FUTURE_SKEW_MS) throw new AppError(422, 'VALIDATION_ERROR', 'sent_at must not be in the future');
    const d = await deps.db.selectFrom('domains').select(['id', 'status']).where('domain', '=', domain).executeTakeFirst();
    if (!d || d.status === 'pending_purchase') throw new AppError(404, 'DOMAIN_NOT_FOUND', `${domain} is not in the portfolio`);
    const max = (await activeSelectionSettings(deps.db)).values.outreach.max_emails_per_name;

    const view = (r: { id: number; domain: string; recipient_domain: string; sent_at: Date; reply: boolean; outcome: string | null }, n: number) => ({
      id: r.id, domain: r.domain, recipient_domain: r.recipient_domain, sent_at: toJerusalemIso(r.sent_at), reply: r.reply, outcome: r.outcome, emails_for_name: n, max_emails_per_name: max, audit_id: req.auditId ?? null,
    });
    return deps.db.transaction().execute(async (trx) => {
      await sql`select pg_advisory_xact_lock(hashtext(${'outreach:' + domain}))`.execute(trx);
      const existing = await trx.selectFrom('outreach_emails').selectAll().where('domain', '=', domain).where('recipient_domain', '=', recipient).where('sent_at', '=', sentAt).executeTakeFirst();
      const n = Number((await trx.selectFrom('outreach_emails').select(sql<string>`count(*)`.as('n')).where('domain', '=', domain).executeTakeFirstOrThrow()).n);
      if (existing) {
        // the same send again: only its reply and outcome change (a late answer); it is not another email
        const upd = await trx.updateTable('outreach_emails').set({
          ...(b.reply !== undefined ? { reply: b.reply } : {}), ...(b.outcome !== undefined ? { outcome: b.outcome } : {}), updated_at: new Date(deps.now()),
        }).where('id', '=', existing.id).returningAll().executeTakeFirstOrThrow();
        return reply.code(200).send(view(upd, n));
      }
      if (n >= max) throw new AppError(409, 'EMAIL_CAP', `${domain} already has ${n} emails logged; the cap is ${max} per name`, { domain, emails: n, max_emails_per_name: max });
      const row = await trx.insertInto('outreach_emails').values({
        domain, recipient_domain: recipient, sent_at: sentAt, reply: b.reply ?? false, outcome: b.outcome ?? null, token_name: req.auth?.name ?? null, audit_id: req.auditId ?? null,
      }).returningAll().executeTakeFirstOrThrow();
      return reply.code(201).send(view(row, n + 1));
    });
  });

  app.get('/outreach/emails/summary', async () => {
    const per = await sql<{ domain: string; emails: string; replies: string; sold: boolean }>`
      select e.domain, count(*)::text as emails, count(*) filter (where e.reply)::text as replies,
        exists (select 1 from sales s join domains d on d.id = s.domain_id where d.domain = e.domain and s.sold_at >= min(e.sent_at)) as sold
      from outreach_emails e group by e.domain order by e.domain`.execute(deps.db);
    const emails = per.rows.reduce((s, r) => s + Number(r.emails), 0);
    const replies = per.rows.reduce((s, r) => s + Number(r.replies), 0);
    const sales = per.rows.filter((r) => r.sold).length;
    const per100 = (n: number) => (emails === 0 ? null : Math.round((n * 10_000) / emails) / 100);
    const max = (await activeSelectionSettings(deps.db)).values.outreach.max_emails_per_name;
    return {
      emails, replies, sales_after_outreach: sales, replies_per_100_emails: per100(replies), sales_per_100_emails: per100(sales), max_emails_per_name: max,
      names: per.rows.map((r) => ({ domain: r.domain, emails: Number(r.emails), replies: Number(r.replies), sold_after_outreach: r.sold, at_cap: Number(r.emails) >= max })),
    };
  });
}
