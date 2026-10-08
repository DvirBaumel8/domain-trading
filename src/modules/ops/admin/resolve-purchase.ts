import type { Kysely } from 'kysely';
import type { Database } from '../../../db/types.js';
import { AppError, errorBody } from '../../../http/errors.js';
import { newAuditId } from '../../../http/audit.js';
import { failPurchase } from '../../buying/index.js';

export class ResolvePurchaseInputError extends Error {}

/**
 * Admin only: marks a purchase stuck in `unknown` or `register_sent` as failed, through the reconciler's own path
 * (bookkeeping.failPurchase: state failed, the pending domain row released). There is deliberately no way to book a purchase here.
 * The caller must have checked the registrar account first: if the domain WAS registered, resolving it as failed hides a real cost.
 */
export async function resolvePurchaseFailed(db: Kysely<Database>, o: { purchaseId: number; reason: string }): Promise<{ purchaseId: number; domain: string; from: string }> {
  const reason = o.reason.trim();
  if (!Number.isInteger(o.purchaseId) || o.purchaseId <= 0) throw new ResolvePurchaseInputError('--id must be a positive integer');
  if (reason.length === 0 || reason.length > 500) throw new ResolvePurchaseInputError('--reason is required (1 to 500 characters)');
  const p = await db.selectFrom('purchases').select(['id', 'domain', 'state']).where('id', '=', o.purchaseId).executeTakeFirst();
  if (!p) throw new AppError(404, 'PURCHASE_NOT_FOUND', `No such purchase: ${o.purchaseId}`);
  if (p.state !== 'unknown' && p.state !== 'register_sent') {
    throw new AppError(409, 'INVALID_STATE', `Purchase ${p.id} is ${p.state}; only unknown or register_sent can be resolved`, { state: p.state });
  }
  await failPurchase(db, p.id, p.domain, {
    status: 409, body: errorBody('PURCHASE_FAILED', 'Resolved as failed by the administrator; nothing was bought', { reason }),
  }, { fromStates: ['unknown', 'register_sent'] });
  const after = await db.selectFrom('purchases').select('state').where('id', '=', p.id).executeTakeFirstOrThrow();
  if (after.state !== 'failed') throw new AppError(409, 'INVALID_STATE', `Purchase ${p.id} changed to ${after.state} while resolving; nothing was changed`, { state: after.state });
  await db.insertInto('audit_log').values({
    id: newAuditId(), scope: 'admin', method: 'ADMIN', path: 'resolve-purchase',
    request: JSON.stringify({ purchase_id: p.id, domain: p.domain, from: p.state, reason }), status_code: 200,
    result_summary: `purchase ${p.id} (${p.domain}) ${p.state} -> failed`,
  }).execute();
  return { purchaseId: p.id, domain: p.domain, from: p.state };
}
