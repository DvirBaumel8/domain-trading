import type { Kysely, Transaction } from 'kysely';
import type { Database } from '../db/types.js';
import { jerusalemDate } from '../dates.js';
import { newAuditId } from '../http/audit.js';
import { withDomainLock } from '../services/plan-store.js';

type Q = Kysely<Database> | Transaction<Database>;

export interface DropJobResult {
  today: string; dryRun: boolean; skipped: boolean;
  dropped: string[]; failed: { domain: string; reason: string }[];
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Marks domains whose drop_date has passed as `dropped` and cancels their planned schedule rows. Touches only DB rows. */
export class DropJob {
  private running = false;

  constructor(private readonly deps: {
    db: Kysely<Database>; now: () => number; lockTimeoutMs?: number;
    log?: { warn(o: object, m: string): void; error(o: object, m: string): void };
  }) {}

  async runOnce(opts: { today?: string; dryRun?: boolean } = {}): Promise<DropJobResult> {
    const today = opts.today ?? jerusalemDate(new Date(this.deps.now()));
    if (!DATE.test(today)) throw new Error(`today must be YYYY-MM-DD, got ${today}`);
    const dryRun = opts.dryRun ?? false;
    const out: DropJobResult = { today, dryRun, skipped: false, dropped: [], failed: [] };
    if (this.running) return { ...out, skipped: true };
    this.running = true;
    try {
      const doms = await this.deps.db.selectFrom('domains').select(['id', 'domain'])
        .where('status', 'in', ['owned', 'listed', 'delisted']).where('drop_date', '<', today).orderBy('domain').execute();
      for (const d of doms) {
        try {
          const did = dryRun
            ? await this.processDomain(this.deps.db, d.id, d.domain, today, true)
            : await withDomainLock(this.deps.db, d.domain, (conn) => conn.transaction().execute((trx) => this.processDomain(trx, d.id, d.domain, today, false)),
              { timeoutMs: this.deps.lockTimeoutMs });
          if (did) out.dropped.push(d.domain);
        } catch (e) {
          const message = (e as Error).message;
          this.deps.log?.error({ domain: d.domain, errMessage: message }, 'drop job failed for domain');
          out.failed.push({ domain: d.domain, reason: 'error' });
          if (!dryRun) {
            try {
              await this.deps.db.insertInto('audit_log').values({
                id: newAuditId(), scope: 'job', method: 'JOB', path: 'drop',
                request: JSON.stringify({ domain: d.domain, today }), status_code: 500, result_summary: `error: ${message}`,
              }).execute();
            } catch (ae) {
              this.deps.log?.error({ domain: d.domain, errMessage: (ae as Error).message }, 'drop job error audit failed');
            }
          }
        }
      }
      return out;
    } finally {
      this.running = false;
    }
  }

  private async processDomain(q: Q, domainId: number, domain: string, today: string, dry: boolean): Promise<boolean> {
    const now = new Date(this.deps.now());
    let base = q.selectFrom('domains').selectAll().where('id', '=', domainId);
    if (!dry) base = base.forUpdate();
    const cur = await base.executeTakeFirst();
    if (!cur || !['owned', 'listed', 'delisted'].includes(cur.status) || cur.drop_date === null || !(cur.drop_date < today)) return false;
    if (dry) return true;
    await q.updateTable('domains').set({
      status: 'dropped', delisted_at: cur.delisted_at ?? now, listing_changed_at: now, updated_at: now,
    }).where('id', '=', domainId).execute();
    const cancelled = await q.updateTable('price_schedule').set({ status: 'cancelled', note: 'dropped', updated_at: now })
      .where('domain_id', '=', domainId).where('status', '=', 'planned').returning('id').execute();
    await q.insertInto('audit_log').values({
      id: newAuditId(), scope: 'job', method: 'JOB', path: 'drop',
      request: JSON.stringify({ domain, from: cur.status, drop_date: cur.drop_date, today }), status_code: 200,
      result_summary: `dropped; ${cancelled.length} planned price rows cancelled`,
    }).execute();
    return true;
  }
}
