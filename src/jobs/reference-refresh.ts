// Daily step `referenceRefresh`: popularity list (TYPO-1), NameBio (disabled stub), IANA RDAP bootstrap, cache pruning.
// Read-only toward the outside world: one GET per source per day, honest User-Agent, no registrar or marketplace call, never a
// create or top-up. Each sub-step is isolated; a failure keeps the previous snapshot and is reported in `errors` (the runner
// shows the step as failed). Nothing here is on a request path: checks only read the stored copies.
import type { Kysely } from 'kysely';
import type { Database } from '../db/types.js';
import { refreshNameBio, NAMEBIO_NAME } from '../screening/namebio.js';
import { rdapBaseFor } from '../screening/rdap-batch.js';
import { activeSelectionSettings } from '../screening/settings.js';
import { refreshTranco } from '../screening/tranco.js';
import type { ScreeningDeps } from '../screening/types.js';

const RDAP_LOOKUP_KEEP_DAYS = 30;
const SNAPSHOTS_KEPT = 10;

export interface ReferenceRefreshSummary { tranco: unknown; namebio: unknown; iana: unknown; pruned: number; errors: string[] }

export class ReferenceRefreshJob {
  private running = false;

  constructor(private readonly deps: { db: Kysely<Database>; screening: ScreeningDeps; now: () => number; log?: { warn(obj: object, msg: string): void } }) {}

  async runOnce(): Promise<ReferenceRefreshSummary | { skipped: true; reason: string }> {
    if (this.running) return { skipped: true, reason: 'already running' };
    this.running = true;
    try {
      const { db, screening, now } = this.deps;
      const s = (await activeSelectionSettings(db)).values;
      const errors: string[] = [];
      const sub = async (name: string, fn: () => Promise<unknown>): Promise<unknown> => {
        try {
          return await fn();
        } catch (e) {
          const m = `${name}: ${String((e as Error).message ?? e).slice(0, 120)}`;
          errors.push(m);
          this.deps.log?.warn({ step: name }, 'reference refresh sub-step failed; the previous snapshot stays');
          return { ok: false, error: m };
        }
      };
      const tranco = await sub('tranco', () => refreshTranco(db, screening, s, now));
      const namebio = await sub('namebio', () => refreshNameBio(db, screening, s));
      const iana = await sub('iana', async () => {
        if (!s.sources.iana_bootstrap) return { skipped: true, reason: 'SOURCE_DISABLED' };
        const before = await db.selectFrom('reference_files').select('id').where('name', '=', 'iana_rdap_dns').orderBy('id', 'desc').limit(1).executeTakeFirst();
        await rdapBaseFor(db, screening, 'net', { enabled: true, now }); // refreshes when the newest copy is over 7 days old
        const after = await db.selectFrom('reference_files').select('id').where('name', '=', 'iana_rdap_dns').orderBy('id', 'desc').limit(1).executeTakeFirst();
        return { refreshed: after?.id !== before?.id };
      });
      const pruned = await this.prune().catch((e: Error) => { errors.push(`prune: ${e.message.slice(0, 120)}`); return 0; });
      return { tranco, namebio, iana, pruned, errors };
    } finally {
      this.running = false;
    }
  }

  /** rdap_lookups older than 30 days; reference_files beyond the newest 10 per name (NameBio snapshots are kept for good, C20). */
  private async prune(): Promise<number> {
    const { db, now } = this.deps;
    const lookups = await db.deleteFrom('rdap_lookups').where('checked_at', '<', new Date(now() - RDAP_LOOKUP_KEEP_DAYS * 86_400_000)).executeTakeFirst();
    const rows = await db.selectFrom('reference_files').select(['id', 'name', 'same_as_id']).where('name', '!=', NAMEBIO_NAME).orderBy('fetched_at', 'desc').orderBy('id', 'desc').execute();
    const seen = new Map<string, number>();
    const keep = new Set<string>();
    for (const r of rows) {
      const n = (seen.get(r.name) ?? 0) + 1;
      seen.set(r.name, n);
      if (n <= SNAPSHOTS_KEPT) { keep.add(String(r.id)); if (r.same_as_id !== null) keep.add(String(r.same_as_id)); } // a kept row may borrow an older body
    }
    const drop = rows.filter((r) => !keep.has(String(r.id))).map((r) => r.id);
    if (drop.length > 0) await db.deleteFrom('reference_files').where('id', 'in', drop).execute();
    return Number(lookups.numDeletedRows) + drop.length;
  }
}
