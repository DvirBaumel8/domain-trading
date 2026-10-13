import type { Kysely } from 'kysely';
import type { Database } from '../../../db/types.js';
import { checkApproval } from '../../../core/approval.js';
import { addOneYear, idtDay } from '../../../core/dates.js';
import { formatUsd } from '../../../core/money.js';
import { withDomainLock } from '../../../core/locks.js';
import { AppError } from '../../../http/errors.js';
import { newAuditId } from '../../../http/audit.js';
import { spentAndPending } from '../../buying/index.js';

export class RenewalInputError extends Error {}

export interface RecordRenewalResult { domain: string; chargedCents: number; expiryFrom: string; expiryTo: string; dropDate: string; spentAfterCents: number; auditId: string }

/**
 * v4.0.0 (G-85): admin only. Books the one renewal of a name that Dvir approved and that was paid by hand at the registrar: a `renewal` ledger row,
 * renewals_used = 1 (DB CHECK 0..1) and the expiry moved one year. The renewal counts against the POC cap like any spend. It never calls a registrar.
 * A name whose drop_date is its first expiry (no renewal planned) is refused: change its plan first (founder rule 3 and the schedule follow drop_date).
 */
export async function recordRenewal(
  db: Kysely<Database>,
  o: { domain: string; chargedCents: number; approvalText: string; approvalAt: string; now: Date },
): Promise<RecordRenewalResult> {
  const domain = o.domain.trim().toLowerCase();
  if (!domain) throw new RenewalInputError('domain is required');
  if (!Number.isInteger(o.chargedCents) || o.chargedCents <= 0) throw new RenewalInputError('--charged-cents must be a positive integer (cents)');
  if (!o.approvalText.trim()) throw new RenewalInputError("approval text (Dvir's words) is required");
  return withDomainLock(db, domain, (conn) => conn.transaction().execute(async (trx) => {
    const cfg = await trx.selectFrom('settings').select(['poc_cap_cents', 'approval_max_age_hours']).forUpdate().executeTakeFirstOrThrow();
    const appr = checkApproval({ text: o.approvalText, approved_at: o.approvalAt }, domain, o.now, cfg.approval_max_age_hours);
    if (!appr.ok) throw new AppError(422, appr.code, appr.reason);
    const cur = await trx.selectFrom('domains').selectAll().where('domain', '=', domain).forUpdate().executeTakeFirst();
    if (!cur) throw new AppError(404, 'DOMAIN_NOT_FOUND', `No such domain: ${domain}`);
    if (!['owned', 'listed', 'delisted'].includes(cur.status)) throw new AppError(409, 'INVALID_STATE', `Domain status is ${cur.status}; expected owned, listed or delisted`);
    if (cur.renewals_used !== 0) throw new AppError(422, 'MAX_ONE_RENEWAL_USED', 'A domain is renewed at most once');
    if (!cur.expiry_date || !cur.drop_date) throw new AppError(422, 'NO_EXPIRY_DATE', 'The domain has no expiry or drop date');
    if (cur.drop_date === cur.expiry_date) {
      throw new AppError(422, 'RENEWAL_NOT_PLANNED', 'drop_date is the first expiry (no renewal planned); the plan must change first, with Dvir\'s approval');
    }
    const { spent, pending } = await spentAndPending(trx);
    if (o.chargedCents > cfg.poc_cap_cents - spent - pending) {
      throw new AppError(409, 'POC_CAP_EXCEEDED', `This renewal would exceed the ${formatUsd(cfg.poc_cap_cents)} POC cap`, {
        cap_cents: cfg.poc_cap_cents, spent_cents: spent, pending_cents: pending, cost_cents: o.chargedCents,
      });
    }
    const auditId = newAuditId();
    const newExpiry = addOneYear(cur.expiry_date);
    await trx.insertInto('audit_log').values({
      id: auditId, scope: 'admin', method: 'ADMIN', path: 'record-renewal',
      request: JSON.stringify({ domain, charged_cents: o.chargedCents, expiry_from: cur.expiry_date, expiry_to: newExpiry }), approval_text: o.approvalText, approval_at: appr.approvedAt,
      status_code: 200, result_summary: `renewal ${formatUsd(o.chargedCents)}; expiry ${cur.expiry_date} -> ${newExpiry}`,
    }).execute();
    await trx.insertInto('ledger_entries').values({
      occurred_on: idtDay(o.now), domain_id: cur.id, deal_id: cur.deal_id, type: 'renewal', amount_cents: -o.chargedCents,
      counterparty: cur.registrar, receipt_ref: null, note: `renewal recorded by admin; approval ${auditId}`, audit_id: auditId,
    }).execute();
    await trx.updateTable('domains').set({ renewals_used: 1, expiry_date: newExpiry, updated_at: o.now }).where('id', '=', cur.id).execute();
    return { domain, chargedCents: o.chargedCents, expiryFrom: cur.expiry_date, expiryTo: newExpiry, dropDate: cur.drop_date, spentAfterCents: spent + o.chargedCents, auditId };
  }));
}
