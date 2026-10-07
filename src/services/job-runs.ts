import type { Kysely } from 'kysely';
import type { Config } from '../config.js';
import type { Database } from '../db/types.js';
import { latestPopularity } from '../screening/popularity.js';

/** A `daily` run must have finished within this many hours, else `/report` raises JOB_OVERDUE and `/health` says `jobs: "overdue"` (CR-005 N-2). */
export const JOBS_OVERDUE_HOURS = 26;
/** The Worker cron: 00:05 UTC every day (`jobs-trigger/wrangler.toml`). */
const DAILY_AT_UTC = { hour: 0, minute: 5 };
const HOUR = 3_600_000;

export type JobName = 'tick' | 'daily';
export const JOB_NAMES: readonly JobName[] = ['tick', 'daily'];

/** The next 00:05 UTC strictly after `nowMs`. */
export function nextDailyDue(nowMs: number): Date {
  const d = new Date(nowMs);
  const t = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), DAILY_AT_UTC.hour, DAILY_AT_UTC.minute);
  return new Date(t > nowMs ? t : t + 24 * HOUR);
}

/** `scheduled` when the Idempotency-Key is the Worker's `<job>-<ms>`; the slot is the ms in the key. Anything else is `manual`. */
export function triggerFromKey(job: JobName, key: string | undefined): { trigger: 'scheduled' | 'manual'; scheduledFor: Date | null } {
  const m = key === undefined ? null : new RegExp(`^${job}-(\\d{10,15})$`).exec(key);
  const ms = m ? Number(m[1]) : NaN;
  const at = new Date(ms);
  return m && Number.isFinite(ms) && !Number.isNaN(at.getTime()) ? { trigger: 'scheduled', scheduledFor: at } : { trigger: 'manual', scheduledFor: null };
}

/** The last daily run that finished (a skipped overlap is not a run), or null. */
export async function lastDailyFinished(db: Kysely<Database>): Promise<Date | null> {
  const r = await db.selectFrom('job_runs').select('finished_at').where('job', '=', 'daily').where('skipped', '=', false)
    .orderBy('finished_at', 'desc').limit(1).executeTakeFirst();
  return r?.finished_at ?? null;
}

/** True when no daily run finished in the last JOBS_OVERDUE_HOURS (never run counts as overdue). */
export async function jobsOverdue(db: Kysely<Database>, nowMs: number): Promise<{ overdue: boolean; lastRunAt: Date | null }> {
  const last = await lastDailyFinished(db);
  return { overdue: last === null || nowMs - last.getTime() > JOBS_OVERDUE_HOURS * HOUR, lastRunAt: last };
}

export interface RunsQuery { job?: JobName; since?: Date; limit: number }

export async function jobRunsView(db: Kysely<Database>, config: Pick<Config, 'backup'>, nowMs: number, q: RunsQuery) {
  let sel = db.selectFrom('job_runs').selectAll().orderBy('finished_at', 'desc').orderBy('id', 'desc').limit(q.limit);
  if (q.job) sel = sel.where('job', '=', q.job);
  if (q.since) sel = sel.where('finished_at', '>=', q.since);
  const rows = await sel.execute();
  const jobs: Record<string, { last_run_at: Date | null; last_ok_at: Date | null; next_due_at: Date | null }> = {};
  for (const job of JOB_NAMES) {
    const last = await db.selectFrom('job_runs').select('finished_at').where('job', '=', job).where('skipped', '=', false).orderBy('finished_at', 'desc').limit(1).executeTakeFirst();
    const ok = await db.selectFrom('job_runs').select('finished_at').where('job', '=', job).where('skipped', '=', false).where('ok', '=', true).orderBy('finished_at', 'desc').limit(1).executeTakeFirst();
    // `tick` has no schedule (by hand only), so it has no due time.
    jobs[job] = { last_run_at: last?.finished_at ?? null, last_ok_at: ok?.finished_at ?? null, next_due_at: job === 'daily' ? nextDailyDue(nowMs) : null };
  }
  const iana = await db.selectFrom('reference_files').select('fetched_at').where('name', '=', 'iana_rdap_dns').orderBy('id', 'desc').limit(1).executeTakeFirst();
  const pop = await latestPopularity(db);
  const lastDaily = await db.selectFrom('job_runs').select('steps').where('job', '=', 'daily').where('skipped', '=', false).orderBy('finished_at', 'desc').limit(1).executeTakeFirst();
  const backupStep = (lastDaily?.steps as { backupExport?: { ok?: boolean; skipped?: boolean } } | undefined)?.backupExport;
  const lastStatus = !backupStep ? null : backupStep.skipped ? 'skipped' : backupStep.ok ? 'ok' : 'failed';
  return {
    runs: rows.map((r) => ({
      job: r.job, trigger: r.trigger, scheduled_for: r.scheduled_for, started_at: r.started_at, finished_at: r.finished_at,
      skipped: r.skipped, ok: r.ok, steps: r.steps,
    })),
    jobs,
    reference: {
      popularity: pop ? { list_id: pop.listId, list_date: pop.listDate, rows: pop.rows, refreshed_at: pop.fetchedAt } : null,
      iana: { refreshed_at: iana?.fetched_at ?? null },
      namebio: { enabled: false },
    },
    backup: { configured: Boolean(config.backup.token && config.backup.repo), last_status: lastStatus },
  };
}
