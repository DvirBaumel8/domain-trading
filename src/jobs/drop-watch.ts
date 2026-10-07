// Daily step `dropWatch` (CR-007 §22, G-2): asks the registry (RDAP, fresh, 4 at a time) about each kept name of the uploaded drop lists that has
// no check yet (or whose last check was unknown, up to 5 checks), and records pending delete / redemption / registered / not registered / unknown
// with the expected drop date. It never calls a registrar or marketplace and sends nothing. Writes only drop_list_checks (append-only) and one audit row.
import { sql, type Kysely } from 'kysely';
import type { Database } from '../db/types.js';
import { DROP_WATCH_MAX_PER_RUN, MAX_UNKNOWN_CHECKS, freshLookups, retentionCutoff, watchStatusOf } from '../drops/drop-lists.js';
import { newAuditId } from '../http/audit.js';
import type { ScreeningDeps } from '../screening/types.js';
import { idtDay } from '../core/dates.js';
export interface DropWatchSummary {
  dryRun: boolean; skipped: boolean; checked: number; pending_delete: number; redemption: number; registered: number; not_registered: number; unknown: number; left_for_next_run: number;
}

export class DropWatchJob {
  private running = false;

  constructor(private readonly deps: { db: Kysely<Database>; screening: ScreeningDeps; now: () => number; /** Tests only: a smaller per-run cap. */ maxPerRun?: number; log?: { warn(o: object, m: string): void } }) {}

  async runOnce(opts: { dryRun?: boolean } = {}): Promise<DropWatchSummary> {
    const dryRun = opts.dryRun ?? false;
    const out: DropWatchSummary = { dryRun, skipped: false, checked: 0, pending_delete: 0, redemption: 0, registered: 0, not_registered: 0, unknown: 0, left_for_next_run: 0 };
    if (this.running) return { ...out, skipped: true };
    this.running = true;
    try {
      const { db, now } = this.deps;
      const today = idtDay(now());
      // Kept rows of lists within retention, with their check count and last check (status, IDT day).
      const rows = (await sql<{ list_name: string; domain: string; n: string; last_status: string | null; last_at: Date | null }>`
        select r.list_name, r.domain, count(c.id)::text as n,
          (array_agg(c.status order by c.id desc))[1] as last_status, max(c.checked_at) as last_at
        from drop_list_rows r join drop_lists l on l.name = r.list_name
        left join drop_list_checks c on c.list_name = r.list_name and c.domain = r.domain
        where r.kept and l.list_date >= ${retentionCutoff(now())}::date
        group by r.list_name, r.domain, r.id order by min(l.list_date), r.id`.execute(db)).rows;
      const due = rows.filter((r) => {
        const n = Number(r.n);
        if (n === 0) return true;
        return r.last_status === 'unknown' && n < MAX_UNKNOWN_CHECKS && r.last_at !== null && idtDay(r.last_at) < today; // one try per IDT day
      });
      const domains = [...new Set(due.map((r) => r.domain))];
      const batch = domains.slice(0, this.deps.maxPerRun ?? DROP_WATCH_MAX_PER_RUN);
      out.left_for_next_run = domains.length - batch.length;
      const listsOf = new Map<string, string[]>();
      for (const r of due) (listsOf.get(r.domain) ?? listsOf.set(r.domain, []).get(r.domain)!).push(r.list_name);

      await freshLookups(db, this.deps.screening, now, batch, async (domain, r) => {
        const s = watchStatusOf(r);
        out.checked += 1;
        out[s.status] += 1;
        if (dryRun) return; // a dry run asks the registry and tallies, but records no check
        await db.insertInto('drop_list_checks').values(listsOf.get(domain)!.map((list_name) => ({
          list_name, domain, checked_at: r.checkedAt, status: s.status, last_changed: s.last_changed, expected_drop_date: s.expected_drop_date, drop_date_source: s.drop_date_source, reason_code: s.reason_code,
        }))).execute();
      });
      if (!dryRun) {
        await db.insertInto('audit_log').values({
          id: newAuditId(), at: new Date(now()), scope: 'job', method: 'JOB', path: 'drop-watch', request: JSON.stringify({}), status_code: 200,
          result_summary: `checked ${out.checked}; pending delete ${out.pending_delete}; redemption ${out.redemption}; unknown ${out.unknown}; left ${out.left_for_next_run}`,
        }).execute();
      }
      return out;
    } finally {
      this.running = false;
    }
  }
}
