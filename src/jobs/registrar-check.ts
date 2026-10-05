import type { Kysely } from 'kysely';
import type { Database } from '../db/types.js';
import { newAuditId } from '../http/audit.js';
import type { RegistrarAdapter } from '../registrars/types.js';

export interface RegistrarCheckResult {
  dryRun: boolean; skipped: boolean;
  checked: number; present: number; absent: number; errors: number; newlyAbsent: string[];
}

/** Read-only: asks each registrar whether a name is still in our account and records it in registrar_presence. Never writes to a registrar or a domain. */
export class RegistrarCheckJob {
  private running = false;

  constructor(private readonly deps: {
    db: Kysely<Database>; adapters: RegistrarAdapter[]; now: () => number;
    log?: { warn(o: object, m: string): void; error(o: object, m: string): void };
  }) {}

  async runOnce(opts: { dryRun?: boolean } = {}): Promise<RegistrarCheckResult> {
    const dryRun = opts.dryRun ?? false;
    const out: RegistrarCheckResult = { dryRun, skipped: false, checked: 0, present: 0, absent: 0, errors: 0, newlyAbsent: [] };
    if (this.running) return { ...out, skipped: true };
    this.running = true;
    try {
      const byName = new Map(this.deps.adapters.map((a) => [a.name, a]));
      const doms = await this.deps.db.selectFrom('domains').select(['id', 'domain', 'registrar'])
        .where('status', 'in', ['owned', 'listed', 'delisted']).where('registrar_api', 'in', ['full', 'manage']).orderBy('domain').execute();
      for (const d of doms) {
        const adapter = d.registrar ? byName.get(d.registrar) : undefined;
        if (!adapter) continue;
        let info;
        try {
          info = await adapter.findDomain(d.domain);
        } catch (e) {
          out.errors += 1;
          this.deps.log?.warn({ domain: d.domain, registrar: d.registrar, errMessage: (e as Error).message }, 'registrar check failed for domain');
          continue;
        }
        out.checked += 1;
        const now = new Date(this.deps.now());
        if (info === null) {
          out.absent += 1;
          const prev = await this.deps.db.selectFrom('registrar_presence').select(['status']).where('domain_id', '=', d.id).executeTakeFirst();
          if (prev?.status !== 'absent') out.newlyAbsent.push(d.domain);
          if (!dryRun) {
            await this.deps.db.insertInto('registrar_presence')
              .values({ domain_id: d.id, status: 'absent', first_absent_at: now, last_checked_at: now })
              .onConflict((oc) => oc.column('domain_id').doUpdateSet((eb) => ({
                status: 'absent', first_absent_at: eb.fn.coalesce('registrar_presence.first_absent_at', eb.val(now)), last_checked_at: now,
              }))).execute();
          }
        } else {
          out.present += 1;
          if (!dryRun) {
            await this.deps.db.insertInto('registrar_presence')
              .values({ domain_id: d.id, status: 'present', first_absent_at: null, last_checked_at: now })
              .onConflict((oc) => oc.column('domain_id').doUpdateSet({ status: 'present', first_absent_at: null, last_checked_at: now })).execute();
          }
        }
      }
      if (!dryRun) {
        await this.deps.db.insertInto('audit_log').values({
          id: newAuditId(), scope: 'job', method: 'JOB', path: 'registrar-check',
          request: JSON.stringify({}), status_code: 200,
          result_summary: `checked ${out.checked}; present ${out.present}; absent ${out.absent}; errors ${out.errors}`,
        }).execute();
      }
      return out;
    } finally {
      this.running = false;
    }
  }
}
