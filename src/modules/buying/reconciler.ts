import type { Kysely } from 'kysely';
import { addOneYear, idtDay } from '../../core/dates.js';
import type { Category, Database } from '../../db/types.js';
import { errorBody } from '../../http/errors.js';
import type { RegistrarAdapter } from '../registrars/index.js';
import { bookPurchase, failPurchase, registrarApiOf } from './bookkeeping.js';

export interface ReconcileResult { booked: number; failed: number; abandoned: number; receipts: number; skipped: boolean }

/** buy.md §6: finishes register_sent/unknown purchases, fails never-sent ones, fetches missing receipts. Never registers, and (v3.9.0) never fails an open purchase: /report PURCHASE_UNRESOLVED + the admin resolve-purchase command do. */
export class Reconciler {
  private running = false;

  constructor(private readonly deps: {
    db: Kysely<Database>; adapters: RegistrarAdapter[]; now: () => number;
    log?: { warn(o: object, m: string): void; error(o: object, m: string): void };
  }) {}

  async runOnce(): Promise<ReconcileResult> {
    const out: ReconcileResult = { booked: 0, failed: 0, abandoned: 0, receipts: 0, skipped: false };
    if (this.running) return { ...out, skipped: true };
    this.running = true;
    try {
      await this.abandonCreated(out);
      await this.resolveOpen(out);
      await this.fetchReceipts(out);
      return out;
    } finally {
      this.running = false;
    }
  }

  private adapter(name: string | null): RegistrarAdapter | undefined {
    return this.deps.adapters.find((a) => a.name === name);
  }

  private async isolated(purchaseId: number, fn: () => Promise<void>): Promise<void> {
    try {
      await fn();
    } catch (e) {
      this.deps.log?.error({ purchaseId, errMessage: (e as Error).message }, 'reconciler: row failed');
    }
  }

  private async abandonCreated(out: ReconcileResult): Promise<void> {
    const cutoff = new Date(this.deps.now() - 10 * 60_000);
    const rows = await this.deps.db.selectFrom('purchases').select(['id', 'domain'])
      .where('state', '=', 'created').where('dry_run', '=', false).where('updated_at', '<', cutoff).execute();
    for (const p of rows) {
      await this.isolated(p.id, async () => {
        await failPurchase(this.deps.db, p.id, p.domain, {
          status: 409, body: errorBody('PURCHASE_ABANDONED', 'The purchase never reached the registrar; nothing was bought'),
        }, { fromStates: ['created'], updatedBefore: cutoff });
        out.abandoned++;
      });
    }
  }

  private async resolveOpen(out: ReconcileResult): Promise<void> {
    const { db } = this.deps;
    const now = this.deps.now();
    const rows = await db.selectFrom('purchases').selectAll()
      .where('state', 'in', ['register_sent', 'unknown']).where('updated_at', '<', new Date(now - 2 * 60_000)).execute();
    for (const p of rows) {
      await this.isolated(p.id, async () => {
      const adapter = this.adapter(p.registrar);
      if (!adapter) {
        this.deps.log?.warn({ purchaseId: p.id, registrar: p.registrar }, 'reconciler: no adapter');
        return;
      }
      let info;
      try {
        info = await adapter.findDomain(p.domain);
      } catch {
        return; // unknown stays unknown
      }
      if (info) {
        const rec = await adapter.findRegistration(p.domain, { since: idtDay(new Date(p.created_at.getTime() - 86_400_000)) }).catch(() => null);
        if (!rec) return;
        const req = (p.request ?? {}) as { category?: Category; deal_id?: string | null; proposed_listing?: unknown; drop_policy?: string };
        const q = await db.selectFrom('quotes').select('renewal_cents')
          .where('check_id', '=', p.check_id ?? '').where('registrar', '=', adapter.name).executeTakeFirst();
        const expiry = info.expiryDate ?? rec.expiryDate ?? addOneYear(rec.invoiceDate);
        const r = await bookPurchase(db, {
          purchaseId: p.id, domain: p.domain, registrar: adapter.name, registrarApi: registrarApiOf(adapter.capabilities),
          orderId: rec.orderId, chargedCents: rec.chargedCents, renewalCents: q?.renewal_cents ?? null, expiryDate: expiry,
          buyDate: rec.invoiceDate, category: req.category ?? 'other', dealId: req.deal_id ?? null, checkId: p.check_id,
          auditId: p.audit_id ?? 'reconciler', receiptRaw: rec.raw, now: new Date(now),
          ...(req.drop_policy === 'at_first_expiry' ? { dropDate: expiry } : {}), // v3.9.0: the stored request's drop policy
        });
        if (r.booked) {
          out.booked++;
          // v3.9.0: the post-buy auto-renew step /buy runs; a failure is only logged (/report AUTO_RENEW_ON covers the rest)
          await adapter.setAutoRenew(p.domain, false).catch((e: unknown) => {
            this.deps.log?.warn({ purchaseId: p.id, domain: p.domain, errMessage: (e as Error).message }, 'reconciler: setAutoRenew(false) failed after booking');
          });
          if ((req as { proposed_listing?: unknown }).proposed_listing) {
            this.deps.log?.warn({ purchaseId: p.id, domain: p.domain }, 'reconciler booked a purchase; proposed listing not applied — call /list');
          }
        }
      }
      // v3.9.0 (Dvir, 10 Oct 2026): absent at the registrar stays open, never auto-failed (registrar lag can look like absence); /report PURCHASE_UNRESOLVED, then admin resolve-purchase
      });
    }
  }

  private async fetchReceipts(out: ReconcileResult): Promise<void> {
    const { db } = this.deps;
    const rows = await db.selectFrom('purchases as p').leftJoin('receipts as r', 'r.purchase_id', 'p.id')
      .select(['p.id', 'p.registrar', 'p.order_id'])
      .where('p.state', '=', 'succeeded').where('p.order_id', 'is not', null).where('r.id', 'is', null).execute();
    for (const p of rows) {
      await this.isolated(p.id, async () => {
      const adapter = this.adapter(p.registrar);
      if (!adapter || !p.order_id) return;
      const raw = await adapter.getReceipt(p.order_id).catch(() => null);
      if (raw === null) return;
      await db.insertInto('receipts').values({ purchase_id: p.id, registrar: adapter.name, order_id: p.order_id, raw: JSON.stringify(raw) })
        .onConflict((oc) => oc.column('purchase_id').doNothing()).execute();
      out.receipts++;
      });
    }
  }
}
