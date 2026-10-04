import type { Kysely } from 'kysely';
import { addOneYear, jerusalemDate } from '../dates.js';
import type { Category, Database } from '../db/types.js';
import { errorBody } from '../http/errors.js';
import type { RdapFn } from '../rdap.js';
import type { RegistrarAdapter } from '../registrars/types.js';
import { bookPurchase, failPurchase, registrarApiOf } from './bookkeeping.js';

export interface ReconcileResult { booked: number; failed: number; abandoned: number; receipts: number; skipped: boolean }

/** buy.md §6: finishes register_sent/unknown purchases, fails dead ones, fetches missing receipts. Never registers. */
export class Reconciler {
  private running = false;

  constructor(private readonly deps: {
    db: Kysely<Database>; adapters: RegistrarAdapter[]; rdap: RdapFn; now: () => number;
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

  private async abandonCreated(out: ReconcileResult): Promise<void> {
    const cutoff = new Date(this.deps.now() - 10 * 60_000);
    const rows = await this.deps.db.selectFrom('purchases').select(['id', 'domain'])
      .where('state', '=', 'created').where('dry_run', '=', false).where('updated_at', '<', cutoff).execute();
    for (const p of rows) {
      await failPurchase(this.deps.db, p.id, p.domain, {
        status: 409, body: errorBody('PURCHASE_ABANDONED', 'The purchase never reached the registrar; nothing was bought'),
      });
      out.abandoned++;
    }
  }

  private async resolveOpen(out: ReconcileResult): Promise<void> {
    const { db } = this.deps;
    const now = this.deps.now();
    const rows = await db.selectFrom('purchases').selectAll()
      .where('state', 'in', ['register_sent', 'unknown']).where('updated_at', '<', new Date(now - 2 * 60_000)).execute();
    for (const p of rows) {
      const adapter = this.adapter(p.registrar);
      if (!adapter) {
        this.deps.log?.warn({ purchaseId: p.id, registrar: p.registrar }, 'reconciler: no adapter');
        continue;
      }
      let info;
      try {
        info = await adapter.findDomain(p.domain);
      } catch {
        continue; // unknown stays unknown
      }
      if (info) {
        const rec = await adapter.findRegistration(p.domain, { since: jerusalemDate(new Date(p.created_at.getTime() - 86_400_000)) }).catch(() => null);
        if (!rec) continue;
        const req = (p.request ?? {}) as { category?: Category; deal_id?: string | null };
        const q = await db.selectFrom('quotes').select('renewal_cents')
          .where('check_id', '=', p.check_id ?? '').where('registrar', '=', adapter.name).executeTakeFirst();
        const expiry = info.expiryDate ?? rec.expiryDate ?? addOneYear(rec.invoiceDate);
        const r = await bookPurchase(db, {
          purchaseId: p.id, domain: p.domain, registrar: adapter.name, registrarApi: registrarApiOf(adapter.capabilities),
          orderId: rec.orderId, chargedCents: rec.chargedCents, renewalCents: q?.renewal_cents ?? null, expiryDate: expiry,
          buyDate: rec.invoiceDate, category: req.category ?? 'other', dealId: req.deal_id ?? null, checkId: p.check_id,
          auditId: p.audit_id ?? 'reconciler', receiptRaw: rec.raw,
        });
        if (r.booked) out.booked++;
      } else if (p.created_at.getTime() < now - 30 * 60_000 && (await this.deps.rdap(p.domain)) === 'not_registered') {
        await failPurchase(db, p.id, p.domain, {
          status: 409, body: errorBody('PURCHASE_FAILED', 'The registrar never registered the domain; nothing was bought'),
        });
        out.failed++;
      }
    }
  }

  private async fetchReceipts(out: ReconcileResult): Promise<void> {
    const { db } = this.deps;
    const rows = await db.selectFrom('purchases as p').leftJoin('receipts as r', 'r.purchase_id', 'p.id')
      .select(['p.id', 'p.registrar', 'p.order_id'])
      .where('p.state', '=', 'succeeded').where('p.order_id', 'is not', null).where('r.id', 'is', null).execute();
    for (const p of rows) {
      const adapter = this.adapter(p.registrar);
      if (!adapter || !p.order_id) continue;
      const raw = await adapter.getReceipt(p.order_id).catch(() => null);
      if (raw === null) continue;
      await db.insertInto('receipts').values({ purchase_id: p.id, registrar: adapter.name, order_id: p.order_id, raw: JSON.stringify(raw) })
        .onConflict((oc) => oc.column('purchase_id').doNothing()).execute();
      out.receipts++;
    }
  }
}
