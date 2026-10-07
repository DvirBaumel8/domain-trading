// Daily step `cohortOutcomes` (CR-007 §22, G-1): freezes cohorts whose feature run has finished, then asks the registry (RDAP, fresh, 4 at a time)
// what happened to each included name of the frozen cohorts: the drop outcome from the day after the expected drop date, and the
// re-registration check at 30, 60 and 90 days after an available_after_drop outcome. It never calls a registrar or marketplace and sends nothing.
// Writes only cohort_decisions / cohort_outcomes (append-only), the cohorts status, rdap rows and one audit row.
import { sql, type Kysely } from 'kysely';
import { jerusalemDate } from '../dates.js';
import type { Database } from '../db/types.js';
import { COHORT_OUTCOMES_MAX_PER_RUN, FINAL_DROP, REREG_DAYS, freezeReadyCohorts } from '../drops/cohorts.js';
import { MAX_UNKNOWN_CHECKS, addDays, freshLookups, isPendingDelete, todayIdt } from '../drops/drop-lists.js';
import { newAuditId } from '../http/audit.js';
import type { CachedLookup } from '../screening/rdap-batch.js';
import type { ScreeningDeps } from '../screening/types.js';

export interface CohortOutcomesSummary {
  dryRun: boolean; skipped: boolean; frozen: number; checked: number;
  drop: { available_after_drop: number; caught_at_drop: number; restored: number; still_pending: number; unknown: number };
  rereg: { yes: number; no: number; unknown: number };
  left_for_next_run: number;
}

type Kind = 'drop' | 'rereg30' | 'rereg60' | 'rereg90';
type Result = Database['cohort_outcomes']['result'];
interface Task { cohort: string; domain: string; kind: Kind; expected: string; dropDay: string | null; dropAt: Date | null }
interface Outcome { result: Result; created_at_registry: Date | null; registrar: string | null; reason_code: string | null }

const dayOf = (iso: string | null | undefined): string | null => (iso && !Number.isNaN(Date.parse(iso)) ? jerusalemDate(new Date(Date.parse(iso))) : null);

/** The drop outcome of a fresh lookup. created_at on or after (expected drop date - 1 day) means someone caught the name at the drop. */
export function dropOutcomeOf(r: Pick<CachedLookup, 'outcome' | 'facts' | 'reasonCode'>, expected: string): Outcome {
  const blank = { created_at_registry: null, registrar: null, reason_code: null };
  if (r.outcome === 'not_registered') return { result: 'available_after_drop', ...blank };
  if (r.outcome === 'unknown' || !r.facts) return { result: 'unknown', ...blank, reason_code: r.reasonCode ?? 'SOURCE_ERROR' };
  const created = r.facts.created_at && !Number.isNaN(Date.parse(r.facts.created_at)) ? new Date(r.facts.created_at) : null;
  const base = { created_at_registry: created, registrar: r.facts.registrar, reason_code: null };
  if (isPendingDelete(r.facts)) return { result: 'still_pending', ...base };
  if (created === null) return { result: 'unknown', ...base, reason_code: 'no_created_at' };
  return { result: dayOf(created.toISOString())! >= addDays(expected, -1) ? 'caught_at_drop' : 'restored', ...base };
}

/** A re-registration outcome: registered with a creation date at or after the drop outcome's check is yes; not registered is no; anything else unknown. */
export function rereg(r: Pick<CachedLookup, 'outcome' | 'facts' | 'reasonCode'>, dropAt: Date): Outcome {
  const blank = { created_at_registry: null, registrar: null, reason_code: null };
  if (r.outcome === 'not_registered') return { result: 'no', ...blank };
  if (r.outcome === 'unknown' || !r.facts) return { result: 'unknown', ...blank, reason_code: r.reasonCode ?? 'SOURCE_ERROR' };
  const created = r.facts.created_at && !Number.isNaN(Date.parse(r.facts.created_at)) ? new Date(r.facts.created_at) : null;
  const base = { created_at_registry: created, registrar: r.facts.registrar };
  if (created === null) return { result: 'unknown', ...base, reason_code: 'no_created_at' };
  if (created.getTime() < dropAt.getTime() - 86_400_000) return { result: 'unknown', ...base, reason_code: 'created_before_drop' };
  return { result: 'yes', ...base, reason_code: null };
}

export class CohortOutcomesJob {
  private running = false;

  constructor(private readonly deps: { db: Kysely<Database>; screening: ScreeningDeps; now: () => number; /** Tests only: a smaller per-run cap. */ maxPerRun?: number; log?: { warn(o: object, m: string): void } }) {}

  async runOnce(opts: { dryRun?: boolean } = {}): Promise<CohortOutcomesSummary> {
    const dryRun = opts.dryRun ?? false;
    const out: CohortOutcomesSummary = {
      dryRun, skipped: false, frozen: 0, checked: 0,
      drop: { available_after_drop: 0, caught_at_drop: 0, restored: 0, still_pending: 0, unknown: 0 }, rereg: { yes: 0, no: 0, unknown: 0 }, left_for_next_run: 0,
    };
    if (this.running) return { ...out, skipped: true };
    this.running = true;
    try {
      const { db, now } = this.deps;
      if (!dryRun) out.frozen = (await freezeReadyCohorts(db, now())).length;
      const today = todayIdt(now());
      const names = (await sql<{ cohort: string; domain: string; expected: string }>`
        select n.cohort, n.domain, n.expected_drop_date::text as expected from cohort_names n join cohorts c on c.name = n.cohort
        where n.included and c.status = 'frozen' order by n.expected_drop_date, n.cohort, n.id`.execute(db)).rows;
      const rows = names.length === 0 ? [] : (await sql<{ cohort: string; domain: string; kind: Kind; result: Result; checked_at: Date }>`
        select o.cohort, o.domain, o.kind, o.result, o.checked_at from cohort_outcomes o join cohorts c on c.name = o.cohort
        where c.status = 'frozen' order by o.id`.execute(db)).rows;
      const hist = new Map<string, { result: Result; checked_at: Date }[]>();
      for (const r of rows) (hist.get(`${r.cohort}\t${r.domain}\t${r.kind}`) ?? hist.set(`${r.cohort}\t${r.domain}\t${r.kind}`, []).get(`${r.cohort}\t${r.domain}\t${r.kind}`)!).push(r);

      // What is due. One attempt per name and kind per IDT day.
      const tasks: Task[] = [];
      for (const n of names) {
        const h = (k: Kind) => hist.get(`${n.cohort}\t${n.domain}\t${k}`) ?? [];
        const retryable = (xs: { result: Result; checked_at: Date }[]) =>
          xs.length === 0 || (jerusalemDate(xs[xs.length - 1]!.checked_at) < today && xs.filter((x) => x.result === 'unknown').length < MAX_UNKNOWN_CHECKS);
        const drops = h('drop');
        const final = drops.find((d) => (FINAL_DROP as readonly string[]).includes(d.result));
        if (!final) {
          if (today >= addDays(n.expected, 1) && retryable(drops)) tasks.push({ cohort: n.cohort, domain: n.domain, kind: 'drop', expected: n.expected, dropDay: null, dropAt: null });
          continue;
        }
        if (final.result !== 'available_after_drop') continue;
        const dropDay = jerusalemDate(final.checked_at);
        for (const k of ['rereg30', 'rereg60', 'rereg90'] as const) {
          const xs = h(k);
          if (xs.some((x) => x.result === 'yes' || x.result === 'no')) continue;
          if (today >= addDays(dropDay, REREG_DAYS[k]) && retryable(xs)) tasks.push({ cohort: n.cohort, domain: n.domain, kind: k, expected: n.expected, dropDay, dropAt: final.checked_at });
        }
      }
      const domains = [...new Set(tasks.map((t) => t.domain))];
      const batch = new Set(domains.slice(0, this.deps.maxPerRun ?? COHORT_OUTCOMES_MAX_PER_RUN));
      out.left_for_next_run = domains.length - batch.size;
      const byDomain = new Map<string, Task[]>();
      for (const t of tasks) if (batch.has(t.domain)) (byDomain.get(t.domain) ?? byDomain.set(t.domain, []).get(t.domain)!).push(t);

      await freshLookups(db, this.deps.screening, now, [...batch], async (domain, r) => {
        out.checked += 1;
        const values = byDomain.get(domain)!.map((t) => {
          const o = t.kind === 'drop' ? dropOutcomeOf(r, t.expected) : rereg(r, t.dropAt!);
          if (t.kind === 'drop') out.drop[o.result as keyof typeof out.drop] += 1;
          else out.rereg[o.result as 'yes' | 'no' | 'unknown'] += 1;
          return { cohort: t.cohort, domain, kind: t.kind, checked_at: r.checkedAt, result: o.result, created_at_registry: o.created_at_registry, registrar: o.registrar, reason_code: o.reason_code };
        });
        if (!dryRun) await db.insertInto('cohort_outcomes').values(values).execute();
      });
      if (!dryRun) {
        await db.insertInto('audit_log').values({
          id: newAuditId(), at: new Date(now()), scope: 'job', method: 'JOB', path: 'cohort-outcomes', request: JSON.stringify({}), status_code: 200,
          result_summary: `frozen ${out.frozen}; checked ${out.checked}; left ${out.left_for_next_run}`,
        }).execute();
      }
      return out;
    } finally {
      this.running = false;
    }
  }
}
