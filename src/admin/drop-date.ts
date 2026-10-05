import { z } from 'zod';
import type { Kysely } from 'kysely';
import type { Database } from '../db/types.js';
import { jerusalemDate } from '../dates.js';
import { AppError } from '../http/errors.js';
import { newAuditId } from '../http/audit.js';
import { settingsByVersion } from '../pricing/settings.js';
import { currentPlan, withDomainLock, writePlan } from '../services/plan-store.js';

export class DropDateInputError extends Error {}

export interface DropAtFirstExpiryResult {
  warnings: string[];
  domain: string; from: string | null; dropDate: string;
  schedule: { event: string; due_on: string; bin_cents: number | null; floor_cents: number | null; walkaway_cents: number | null; status: string }[];
}

/** Gate F: move drop_date to the first expiry (never renewed), regenerating the schedule from the current values. */
export async function dropAtFirstExpiry(
  db: Kysely<Database>,
  o: { domain: string; approvalText: string; approvalAt: string; now: Date },
): Promise<DropAtFirstExpiryResult> {
  const domain = o.domain.trim().toLowerCase();
  if (!domain) throw new DropDateInputError('domain is required');
  if (!o.approvalText.trim()) throw new DropDateInputError('approval text (Dvir\'s words) is required');
  if (!z.iso.datetime({ offset: true }).safeParse(o.approvalAt).success) throw new DropDateInputError('approval-at must be ISO 8601 with an offset or Z');
  const approvalAt = new Date(o.approvalAt);
  if (approvalAt.getTime() > o.now.getTime()) throw new DropDateInputError('approval-at must not be in the future');

  return withDomainLock(db, domain, (conn) => conn.transaction().execute(async (trx) => {
    const cur = await trx.selectFrom('domains').selectAll().where('domain', '=', domain).forUpdate().executeTakeFirst();
    if (!cur) throw new AppError(404, 'DOMAIN_NOT_FOUND', `No such domain: ${domain}`);
    if (cur.renewals_used !== 0) throw new AppError(422, 'MAX_ONE_RENEWAL_USED', 'A renewed domain cannot drop at its first expiry');
    if (!['owned', 'listed', 'delisted'].includes(cur.status)) throw new AppError(409, 'INVALID_STATE', `Domain status is ${cur.status}; expected owned, listed or delisted`);
    if (!cur.expiry_date) throw new AppError(422, 'NO_EXPIRY_DATE', 'The domain has no expiry date');
    if (cur.drop_date === cur.expiry_date) throw new AppError(409, 'NO_CHANGE', 'drop_date already equals the expiry date');
    const now = o.now;
    const auditId = newAuditId();
    await trx.insertInto('audit_log').values({
      id: auditId, scope: 'admin', method: 'ADMIN', path: 'drop-at-first-expiry',
      request: JSON.stringify({ domain, from: cur.drop_date, to: cur.expiry_date }), approval_text: o.approvalText, approval_at: approvalAt,
      status_code: 200, result_summary: `drop_date ${cur.drop_date} -> ${cur.expiry_date}`,
    }).execute();
    await trx.updateTable('domains').set({ drop_date: cur.expiry_date, updated_at: now }).where('id', '=', cur.id).execute();
    let planId: string | null = cur.plan_id;
    if (cur.plan_id && cur.first_listed_at) {
      const settings = await settingsByVersion(trx, cur.pricing_settings_version ?? 0);
      const plan = currentPlan(cur, cur.pricing_settings_version ?? 0);
      if (!settings || !plan) throw new AppError(422, 'PLAN_UNAVAILABLE', 'Cannot regenerate the schedule: pricing settings or listing missing');
      // keep drops that are due but unapplied (hold, or the command ran before the daily job): only events already handled are skipped
      const done = await trx.selectFrom('price_schedule').select(({ fn }) => fn.max('due_on').as('d')).where('domain_id', '=', cur.id).where('plan_id', '=', cur.plan_id)
        .where('status', 'in', ['applied', 'skipped_at_minimum', 'skipped_no_change', 'skipped_disabled']).executeTakeFirst();
      planId = (await writePlan(trx, {
        domainId: cur.id, plan, anchor: jerusalemDate(cur.first_listed_at), dropDate: cur.expiry_date,
        settings, planAuditId: auditId, startAfter: done?.d ?? undefined, now,
      })).planId;
    }
    const rows = planId
      ? await trx.selectFrom('price_schedule').selectAll().where('domain_id', '=', cur.id).where('plan_id', '=', planId).orderBy('due_on').orderBy('id').execute()
      : [];
    const warnings = cur.expiry_date < jerusalemDate(now) ? ['DROP_DATE_IN_PAST: the next daily run will mark it dropped'] : [];
    return {
      warnings, domain, from: cur.drop_date, dropDate: cur.expiry_date,
      schedule: rows.map((r) => ({ event: r.event, due_on: r.due_on, bin_cents: r.bin_cents, floor_cents: r.floor_cents, walkaway_cents: r.walkaway_cents, status: r.status })),
    };
  }));
}
