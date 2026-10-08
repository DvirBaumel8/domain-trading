import { idtDay } from '../../core/dates.js';
// v2.8.0 (CR-007 §22, G-1): cohorts, the forward test. Pure rate math, the one-time freezing of decisions, and the read models for
// GET /selection/cohorts/{name} and /selection/cohorts/report. Decisions come from the same tier code as a test-set rescore (decideReplayRow).
import type { Kysely } from 'kysely';
import { sql } from 'kysely';
import type { Database } from '../../db/types.js';
import { decideReplayRow, type Decision, type LabelledFeatures } from '../selection/index.js';
import { selectionSettingsByLabel } from '../selection/index.js';
import { featuresOfRun, wilson95 } from '../selection/index.js';


/** Pass line FWD-1: accepted re-registration rate at least this many times the rejected rate, with at least FWD_MIN_N names per class. A change needs a release. */
export const FWD_MIN_RATIO = 2;
export const FWD_MIN_N = 50;
export const COHORT_OUTCOMES_MAX_PER_RUN = 2000;
/** A name in a cohort created within this many days is "in an open cohort" and cannot join another. */
export const COHORT_OPEN_DAYS = 120;
export const REREG_DAYS = { rereg30: 30, rereg60: 60, rereg90: 90 } as const;
export const FINAL_DROP = ['available_after_drop', 'caught_at_drop', 'restored'] as const;

type RunRow = { id: string; input: unknown; gate_plan: unknown; status: string };

/**
 * Freezes a cohort whose feature run has finished: one decision per included name and settings label, computed once, never again.
 * Only a run that is `done` freezes; a `cancelled` or `partial` run marks the cohort `abandoned` and writes no decision (returns false). decided_at is now; `late` when that IDT day is on or after the name's expected drop date. Returns true when the cohort is frozen afterwards.
 */
export async function freezeCohortIfReady(db: Kysely<Database>, name: string, nowMs: number): Promise<boolean> {
  return db.transaction().execute(async (trx) => {
    const cohort = await trx.selectFrom('cohorts').selectAll().where('name', '=', name).forUpdate().executeTakeFirst();
    if (!cohort) return false;
    if (cohort.status === 'frozen') return true;
    if (cohort.status === 'abandoned') return false;
    const run = (await trx.selectFrom('screening_runs').selectAll().where('id', '=', cohort.run_id).executeTakeFirst()) as RunRow | undefined;
    if (!run || run.status === 'running') return false;
    // v2.16.0: only a finished (`done`) run freezes decisions. A cancelled or partial run leaves the cohort abandoned, with no decisions.
    if (run.status !== 'done') {
      await trx.updateTable('cohorts').set({ status: 'abandoned' }).where('name', '=', name).where('status', '=', 'computing').execute();
      return false;
    }
    const names = await trx.selectFrom('cohort_names').select(['domain', 'expected_drop_date']).where('cohort', '=', name).where('included', '=', true).orderBy('id').execute();
    const { byDomain } = await featuresOfRun(trx, run);
    const today = idtDay(nowMs);
    const at = new Date(nowMs);
    const rows: { cohort: string; domain: string; settings_label: string; decision: Decision; tier: string | null; decided_at: Date; late: boolean }[] = [];
    for (const label of cohort.settings_labels) {
      const sel = (await selectionSettingsByLabel(trx, label))!;
      for (const n of names) {
        const f = byDomain.get(n.domain);
        // Cohort names are dropping (previously registered) names, so prior_history is 1; every other feature is DOM's own from the run (null stays unknown).
        const own: LabelledFeatures = {
          prior_history: 1, registered_share: f?.registered_share ?? null, alt_tld_before_n: f?.alt_tld_before_n ?? null,
          n_words: f?.n_words ?? null, sld_chars: f?.sld_chars ?? null, is_geo: f?.is_geo ?? 0,
        };
        const d = decideReplayRow(own, sel.values);
        rows.push({ cohort: name, domain: n.domain, settings_label: label, decision: d.decision, tier: d.tier.fired, decided_at: at, late: today >= n.expected_drop_date! });
      }
    }
    for (let i = 0; i < rows.length; i += 500) await trx.insertInto('cohort_decisions').values(rows.slice(i, i + 500)).execute();
    await trx.updateTable('cohorts').set({ status: 'frozen' }).where('name', '=', name).where('status', '=', 'computing').execute();
    return true;
  });
}

/** Cohorts still computing whose run is no longer running are frozen. Returns the names frozen by this call. */
export async function freezeReadyCohorts(db: Kysely<Database>, nowMs: number): Promise<string[]> {
  const out: string[] = [];
  const open = await db.selectFrom('cohorts').select('name').where('status', '=', 'computing').orderBy('created_at').execute();
  for (const c of open) if (await freezeCohortIfReady(db, c.name, nowMs)) out.push(c.name);
  return out;
}

// ---- report ----

export interface ClassRate { n: number; re_registered: number; rate: number | null; wilson95: [number, number] | null; unknown: number }
const r4 = (x: number) => Math.round(x * 10_000) / 10_000;
export function classRate(results: ('yes' | 'no' | 'unknown')[]): ClassRate {
  const yes = results.filter((r) => r === 'yes').length;
  const no = results.filter((r) => r === 'no').length;
  const n = yes + no; // an unknown answer is neither re-registered nor free: it is left out of n and counted on its own
  return { n, re_registered: yes, rate: n === 0 ? null : r4(yes / n), wilson95: wilson95(yes, n), unknown: results.length - n };
}
export function windowVerdict(accepted: ClassRate, rejected: ClassRate): { accepted: ClassRate; rejected: ClassRate; ratio: number | null; pass: boolean } {
  // from the counts, not from the rounded rates
  const ratio = accepted.n === 0 || rejected.n === 0 || rejected.re_registered === 0 ? null : r4((accepted.re_registered / accepted.n) / (rejected.re_registered / rejected.n));
  return { accepted, rejected, ratio, pass: accepted.n >= FWD_MIN_N && rejected.n >= FWD_MIN_N && ratio !== null && ratio >= FWD_MIN_RATIO };
}

interface NameState {
  cohort: string; domain: string; decision: Decision | null; late: boolean;
  drop: string | null; rereg: Partial<Record<keyof typeof REREG_DAYS, 'yes' | 'no' | 'unknown'>>;
}

/** The latest outcome row of each (cohort, domain, kind) of the given cohorts. */
export async function latestOutcomes(db: Kysely<Database>, cohorts: string[]): Promise<Map<string, { result: string; checked_at: Date; created_at_registry: Date | null; registrar: string | null }>> {
  const out = new Map<string, { result: string; checked_at: Date; created_at_registry: Date | null; registrar: string | null }>();
  if (cohorts.length === 0) return out;
  const rows = await sql<{ cohort: string; domain: string; kind: string; result: string; checked_at: Date; created_at_registry: Date | null; registrar: string | null }>`
    select distinct on (cohort, domain, kind) cohort, domain, kind, result, checked_at, created_at_registry, registrar from cohort_outcomes
    where cohort in (${sql.join(cohorts)}) order by cohort, domain, kind, id desc`.execute(db);
  for (const r of rows.rows) out.set(`${r.cohort}\t${r.domain}\t${r.kind}`, r);
  return out;
}

/** The forward-test report of one settings label across frozen cohorts (all of them, or the named ones). */
export async function cohortReport(db: Kysely<Database>, label: string, only?: string[]) {
  let q = db.selectFrom('cohorts').select('name').where('status', '=', 'frozen').where(sql<boolean>`${label} = any(settings_labels)`).orderBy('created_at').orderBy('name');
  if (only) q = q.where('name', 'in', only);
  const cohorts = (await q.execute()).map((c) => c.name);
  const states: NameState[] = [];
  if (cohorts.length > 0) {
    const names = await db.selectFrom('cohort_names').select(['cohort', 'domain']).where('cohort', 'in', cohorts).where('included', '=', true).orderBy('id').execute();
    const decisions = new Map((await db.selectFrom('cohort_decisions').select(['cohort', 'domain', 'decision', 'late']).where('cohort', 'in', cohorts).where('settings_label', '=', label).execute())
      .map((d) => [`${d.cohort}\t${d.domain}`, d]));
    const outcomes = await latestOutcomes(db, cohorts);
    for (const n of names) {
      const d = decisions.get(`${n.cohort}\t${n.domain}`);
      const rereg: NameState['rereg'] = {};
      for (const k of Object.keys(REREG_DAYS) as (keyof typeof REREG_DAYS)[]) {
        const o = outcomes.get(`${n.cohort}\t${n.domain}\t${k}`);
        if (o) rereg[k] = o.result as 'yes' | 'no' | 'unknown';
      }
      states.push({ cohort: n.cohort, domain: n.domain, decision: d?.decision ?? null, late: d?.late ?? false, drop: outcomes.get(`${n.cohort}\t${n.domain}\tdrop`)?.result ?? null, rereg });
    }
  }
  const rated = states.filter((s) => s.drop === 'available_after_drop' && !s.late && (s.decision === 'accept' || s.decision === 'reject'));
  const win = (k: keyof typeof REREG_DAYS) => windowVerdict(
    classRate(rated.filter((s) => s.decision === 'accept' && s.rereg[k] !== undefined).map((s) => s.rereg[k]!)),
    classRate(rated.filter((s) => s.decision === 'reject' && s.rereg[k] !== undefined).map((s) => s.rereg[k]!)),
  );
  const count = (f: (s: NameState) => boolean) => states.filter(f).length;
  return {
    settings: label, cohorts, fwd_min_ratio: FWD_MIN_RATIO, fwd_min_n: FWD_MIN_N,
    rereg: { d30: win('rereg30'), d60: win('rereg60'), d90: win('rereg90') },
    counts: {
      names: states.length, caught_at_drop: count((s) => s.drop === 'caught_at_drop'), restored: count((s) => s.drop === 'restored'), still_pending: count((s) => s.drop === 'still_pending'),
      unknown_drop: count((s) => s.drop === 'unknown'), drop_not_checked: count((s) => s.drop === null),
      undecided: count((s) => !s.late && s.decision === 'undecided'), late: count((s) => s.late),
    },
  };
}
