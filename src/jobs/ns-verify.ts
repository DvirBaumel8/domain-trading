import { sql, type Kysely } from 'kysely';
import type { Database } from '../db/types.js';
import type { NsLookup } from '../dns/ns-lookup.js';
import { newAuditId } from '../http/audit.js';
import { sameNsSet } from '../services/lander.js';

/** The row still holds the lander_ns value that was read (compared as a text[]). */
const sameLanderNs = (ns: string[]) => (ns.length > 0 ? sql<boolean>`lander_ns = ARRAY[${sql.join(ns)}]::text[]` : sql<boolean>`lander_ns = '{}'::text[]`);

/** list.md step 4: daily public-DNS check of every owned/listed domain that has a lander target. */
export class NsVerifier {
  private running = false;

  constructor(private readonly deps: { db: Kysely<Database>; nsLookup: NsLookup; now: () => number; log?: { warn(o: object, m: string): void } }) {}

  async runOnce(): Promise<{ checked: number; verified: number; cleared: number; unknown: number; skipped: boolean }> {
    const out = { checked: 0, verified: 0, cleared: 0, unknown: 0, skipped: false };
    if (this.running) return { ...out, skipped: true };
    this.running = true;
    try {
      const rows = await this.deps.db.selectFrom('domains').select(['id', 'domain', 'lander_ns', 'ns_verified_at'])
        .where('status', 'in', ['owned', 'listed']).where('lander_ns', 'is not', null).execute();
      for (const r of rows) {
        out.checked++;
        const seen = await this.deps.nsLookup(r.domain).catch(() => null);
        if (!seen) {
          out.unknown++;
          continue;
        }
        if (sameNsSet(seen, r.lander_ns!)) {
          if (!r.ns_verified_at) {
            await this.deps.db.updateTable('domains').set({ ns_verified_at: new Date(this.deps.now()) }).where('id', '=', r.id)
              .where(sameLanderNs(r.lander_ns!)).execute(); // a /list change since the read is not marked verified
          }
          out.verified++;
        } else {
          if (r.ns_verified_at) await this.deps.db.updateTable('domains').set({ ns_verified_at: null }).where('id', '=', r.id).where(sameLanderNs(r.lander_ns!)).execute();
          out.cleared++;
        }
      }
      await this.deps.db.insertInto('audit_log').values({
        id: newAuditId(), at: new Date(this.deps.now()), scope: 'job', method: 'JOB', path: 'ns-verify',
        status_code: 200, result_summary: `checked ${out.checked}; verified ${out.verified}; cleared ${out.cleared}; unknown ${out.unknown}`,
      }).execute();
      return out;
    } finally {
      this.running = false;
    }
  }
}
