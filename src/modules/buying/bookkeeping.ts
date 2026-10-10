import type { Kysely } from 'kysely';
import { addOneYear } from '../../core/dates.js';
import type { Category, Database, PurchaseState, RegistrarApi } from '../../db/types.js';
import type { Capabilities } from '../registrars/index.js';

export function registrarApiOf(c: Capabilities): RegistrarApi {
  if (c.canRegister && c.canManageNs) return 'full';
  if (c.canManageNs) return 'manage';
  return 'none';
}

export interface BookInput {
  purchaseId: number; domain: string; registrar: string; registrarApi: RegistrarApi;
  orderId: string; chargedCents: number; renewalCents: number | null; expiryDate: string; buyDate: string;
  category: Category; dealId: string | null; checkId: string | null; auditId: string; receiptRaw: unknown | null;
  /** The injected clock's current time (used for updated_at). */
  now: Date;
  /** v3.9.0: set in the same transaction (drop policy `at_first_expiry` = the first expiry); default expiry + 1 year. */
  dropDate?: string;
}

/** buy.md step 6: ONE transaction. Idempotent: a succeeded purchase is never booked twice. */
export async function bookPurchase(db: Kysely<Database>, b: BookInput): Promise<{ booked: boolean }> {
  return db.transaction().execute(async (trx) => {
    const p = await trx.selectFrom('purchases').select('state').where('id', '=', b.purchaseId).forUpdate().executeTakeFirstOrThrow();
    if (p.state === 'succeeded') return { booked: false };
    const now = b.now;
    const fields = {
      status: 'owned' as const, registrar: b.registrar, registrar_api: b.registrarApi, buy_date: b.buyDate,
      cost_cents: b.chargedCents, expiry_date: b.expiryDate, renewal_price_cents: b.renewalCents, renewals_used: 0,
      drop_date: b.dropDate ?? addOneYear(b.expiryDate), category: b.category, deal_id: b.dealId, updated_at: now,
    };
    const existing = await trx.selectFrom('domains').select('id').where('domain', '=', b.domain).executeTakeFirst();
    const domainId = existing
      ? (await trx.updateTable('domains').set(fields).where('id', '=', existing.id).returning('id').executeTakeFirstOrThrow()).id
      : (await trx.insertInto('domains').values({ domain: b.domain, ...fields }).returning('id').executeTakeFirstOrThrow()).id;
    await trx.insertInto('ledger_entries').values({
      occurred_on: b.buyDate, domain_id: domainId, deal_id: b.dealId, type: 'registration', amount_cents: -b.chargedCents,
      counterparty: b.registrar, receipt_ref: `${b.registrar}:${b.orderId}`,
      note: `1yr; privacy on; check ${b.checkId ?? '-'}; approval ${b.auditId}`, audit_id: b.auditId,
    }).execute();
    if (b.receiptRaw !== null) {
      await trx.insertInto('receipts')
        .values({ purchase_id: b.purchaseId, registrar: b.registrar, order_id: b.orderId, raw: JSON.stringify(b.receiptRaw) })
        .onConflict((oc) => oc.column('purchase_id').doNothing())
        .execute();
    }
    await trx.updateTable('purchases')
      .set({ state: 'succeeded', charged_cents: b.chargedCents, order_id: b.orderId, updated_at: now })
      .where('id', '=', b.purchaseId).execute();
    if (b.dealId) {
      await trx.insertInto('deals').values({ id: b.dealId, domain: b.domain })
        .onConflict((oc) => oc.column('id').doUpdateSet({ domain: b.domain, updated_at: now }))
        .execute();
    }
    return { booked: true };
  });
}

export async function failPurchase(db: Kysely<Database>, purchaseId: number, domain: string, response: { status: number; body: unknown },
  opts: { fromStates?: PurchaseState[]; updatedBefore?: Date } = {}): Promise<void> {
  await db.transaction().execute(async (trx) => {
    let q = trx.updateTable('purchases')
      .set({ state: 'failed', response: JSON.stringify(response), updated_at: new Date() })
      .where('id', '=', purchaseId).where('state', '!=', 'succeeded');
    if (opts.fromStates) q = q.where('state', 'in', opts.fromStates);
    if (opts.updatedBefore) q = q.where('updated_at', '<', opts.updatedBefore);
    const r = await q.executeTakeFirst();
    if (Number(r.numUpdatedRows) === 0) return;
    await trx.deleteFrom('domains').where('domain', '=', domain).where('status', '=', 'pending_purchase').execute();
  });
}

export async function markUnknown(db: Kysely<Database>, purchaseId: number, response: { status: number; body: unknown }): Promise<void> {
  await db.updateTable('purchases')
    .set({ state: 'unknown', response: JSON.stringify(response), updated_at: new Date() })
    .where('id', '=', purchaseId).where('state', 'in', ['created', 'register_sent', 'unknown']).execute();
}

export async function storeResponse(db: Kysely<Database>, purchaseId: number, response: { status: number; body: unknown }): Promise<void> {
  await db.updateTable('purchases').set({ response: JSON.stringify(response), updated_at: new Date() }).where('id', '=', purchaseId).execute();
}
