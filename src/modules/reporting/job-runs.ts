import type { Kysely } from 'kysely';
import type { Config } from '../../config.js';
import type { Database } from '../../db/types.js';
import { latestPopularity } from '../selection/index.js';

/** A `daily` run must have finished within this many hours, else `/report` raises JOB_OVERDUE and `/health` says `jobs: "overdue"` (CR-005 N-2). */
export const JOBS_OVERDUE_HOURS = 26;
/** The Worker cron: 00:05 UTC every day (`jobs-trigger/wrangler.toml`). */
const DAILY_AT_UTC = { hour: 0, minute: 5 };
const HOUR = 3_600_000;
/** CR-016 R-A3: a `daily` queue run still queued or running after this many hours raises JOB_RUN_INCOMPLETE. */
export const JOB_RUN_STUCK_HOURS = 2;
/** CR-016 R-A3: the 00:05 UTC slot counts as missed when it passed more than this many minutes ago and no daily run was created since. */
export const JOB_MISSED_GRACE_MINUTES = 30;

/** `screen` (v3.3.0): POST /candidates/screen runs; it has no schedule and no entry in `jobs`. */
export type JobName = 'tick' | 'daily' | 'screen';
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

/** The latest 00:05 UTC slot at or before `nowMs`. */
export function lastDailySlot(nowMs: number): Date {
  return new Date(nextDailyDue(nowMs).getTime() - 24 * HOUR);
}

export interface DailyScheduleState {
  stuck: { runId: string; startedAt: Date; openSteps: string[] } | null;
  missed: { slot: Date; lastRunAt: Date | null } | null;
}

/** CR-016 R-A3: is a daily run stuck (open for over JOB_RUN_STUCK_HOURS) and was today's scheduled slot missed (no daily run of any trigger created since the slot)? */
export async function dailyScheduleState(db: Kysely<Database>, nowMs: number): Promise<DailyScheduleState> {
  let stuck: DailyScheduleState['stuck'] = null;
  const old = await db.selectFrom('job_queue_runs as r').select(['r.id', 'r.created_at'])
    .where('r.job', '=', 'daily').where('r.created_at', '<', new Date(nowMs - JOB_RUN_STUCK_HOURS * HOUR))
    .where((eb) => eb.exists(eb.selectFrom('job_steps as s').select('s.id').whereRef('s.run_id', '=', 'r.id').where('s.status', 'in', ['queued', 'running'])))
    .orderBy('r.created_at').limit(1).executeTakeFirst();
  if (old) {
    const steps = await db.selectFrom('job_steps').select(['step', 'status', 'started_at']).where('run_id', '=', old.id).orderBy('position').execute();
    const startedAt = steps.map((x) => x.started_at).filter((d): d is Date => d !== null).sort((a, b) => a.getTime() - b.getTime())[0] ?? old.created_at;
    stuck = { runId: old.id, startedAt, openSteps: steps.filter((x) => x.status === 'queued' || x.status === 'running').map((x) => x.step) };
  }
  let missed: DailyScheduleState['missed'] = null;
  const slot = lastDailySlot(nowMs);
  if (nowMs - slot.getTime() > JOB_MISSED_GRACE_MINUTES * 60_000) {
    // A run counts from the moment it was created (queued), whatever its trigger; runs from before the queue (v2) have only job_runs.started_at.
    const q = await db.selectFrom('job_queue_runs').select((eb) => eb.fn.max('created_at').as('at')).where('job', '=', 'daily').executeTakeFirst();
    const j = await db.selectFrom('job_runs').select((eb) => eb.fn.max('started_at').as('at')).where('job', '=', 'daily').where('skipped', '=', false).executeTakeFirst();
    const times = [q?.at, j?.at].filter((d): d is Date => d != null);
    const lastRunAt = times.length ? new Date(Math.max(...times.map((d) => d.getTime()))) : null;
    if (lastRunAt !== null && lastRunAt.getTime() < slot.getTime()) missed = { slot, lastRunAt };
  }
  return { stuck, missed };
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

/** A queue step in the shape job_runs.steps has always had (ok, skipped, error, ms, summary) plus the queue's status, attempts and times. `ok` is null while the step is still queued or running. */
export function stepView(r: { status: string; attempt: number; ms: number | null; summary: unknown; error: string | null; started_at: Date | null; finished_at: Date | null }): Record<string, unknown> {
  return {
    ok: r.status === 'queued' || r.status === 'running' ? null : r.status !== 'failed',
    ...(r.status === 'skipped' ? { skipped: true } : {}),
    ...(r.error ? { error: r.error } : {}),
    ms: r.ms ?? 0,
    summary: r.summary ?? null,
    status: r.status, attempts: r.attempt, started_at: r.started_at, finished_at: r.finished_at,
  };
}

export interface RunsQuery { job?: JobName; since?: Date; limit: number }

export async function jobRunsView(db: Kysely<Database>, config: Pick<Config, 'backup'>, nowMs: number, q: RunsQuery) {
  let sel = db.selectFrom('job_runs').selectAll().orderBy('finished_at', 'desc').orderBy('id', 'desc').limit(q.limit);
  if (q.job) sel = sel.where('job', '=', q.job);
  if (q.since) sel = sel.where('finished_at', '>=', q.since);
  const rows = await sel.execute();
  // Runs still queued or running (v3.0.0): newest first, ahead of the finished ones, with each step's current state.
  let open = db.selectFrom('job_queue_runs as r').selectAll('r').orderBy('r.created_at', 'desc').limit(q.limit)
    .where((eb) => eb.exists(eb.selectFrom('job_steps as s').select('s.id').whereRef('s.run_id', '=', 'r.id').where('s.status', 'in', ['queued', 'running'])));
  if (q.job) open = open.where('r.job', '=', q.job);
  if (q.since) open = open.where('r.created_at', '>=', q.since);
  const openRuns = await open.execute();
  const openSteps = openRuns.length === 0 ? [] : await db.selectFrom('job_steps').selectAll().where('run_id', 'in', openRuns.map((r) => r.id)).orderBy('position').execute();
  const inflight = openRuns.map((r) => {
    const mine = openSteps.filter((s) => s.run_id === r.id);
    return {
      run_id: r.id, status: mine.some((s) => s.status === 'running') ? 'running' : 'queued',
      job: r.job, trigger: r.trigger, scheduled_for: r.scheduled_for, started_at: mine.find((s) => s.started_at)?.started_at ?? null, finished_at: null as Date | null,
      skipped: false, ok: null as boolean | null, steps: Object.fromEntries(mine.map((s) => [s.step, stepView(s)])) as unknown, triggered_by: r.triggered_by,
    };
  });
  const jobs: Record<string, { last_run_at: Date | null; last_ok_at: Date | null; next_due_at: Date | null; last_scheduled?: { run_id: string; status: string; ok: boolean | null } | null; missed_slot?: Date | null }> = {};
  for (const job of JOB_NAMES) {
    const last = await db.selectFrom('job_runs').select('finished_at').where('job', '=', job).where('skipped', '=', false).orderBy('finished_at', 'desc').limit(1).executeTakeFirst();
    const ok = await db.selectFrom('job_runs').select('finished_at').where('job', '=', job).where('skipped', '=', false).where('ok', '=', true).orderBy('finished_at', 'desc').limit(1).executeTakeFirst();
    // `tick` has no schedule (by hand only), so it has no due time.
    jobs[job] = { last_run_at: last?.finished_at ?? null, last_ok_at: ok?.finished_at ?? null, next_due_at: job === 'daily' ? nextDailyDue(nowMs) : null };
  }
  // v3.1.0 (CR-016 R-A3): the newest scheduled daily run (any state) and the slot of JOB_MISSED. next_due_at stays the next 00:05 UTC.
  const sched = await db.selectFrom('job_queue_runs as r').leftJoin('job_runs as j', 'j.queue_run_id', 'r.id').select(['r.id', 'j.ok as ok', 'j.id as finished_id'])
    .select((eb) => eb.selectFrom('job_steps as s').select('s.status').whereRef('s.run_id', '=', 'r.id').where('s.status', 'in', ['queued', 'running']).orderBy('s.position').limit(1).as('open'))
    .where('r.job', '=', 'daily').where('r.trigger', '=', 'scheduled').orderBy('r.created_at', 'desc').limit(1).executeTakeFirst();
  jobs.daily!.last_scheduled = sched ? { run_id: sched.id, status: sched.open ? (sched.open === 'running' ? 'running' : 'queued') : 'finished', ok: sched.finished_id ? sched.ok : null } : null;
  jobs.daily!.missed_slot = (await dailyScheduleState(db, nowMs)).missed?.slot ?? null;
  const iana = await db.selectFrom('reference_files').select('fetched_at').where('name', '=', 'iana_rdap_dns').orderBy('id', 'desc').limit(1).executeTakeFirst();
  const pop = await latestPopularity(db);
  const lastDaily = await db.selectFrom('job_runs').select('steps').where('job', '=', 'daily').where('skipped', '=', false).orderBy('finished_at', 'desc').limit(1).executeTakeFirst();
  const backupStep = (lastDaily?.steps as { backupExport?: { ok?: boolean; skipped?: boolean } } | undefined)?.backupExport;
  const lastStatus = !backupStep ? null : backupStep.skipped ? 'skipped' : backupStep.ok ? 'ok' : 'failed';
  return {
    runs: [...inflight, ...rows.map((r) => ({
      run_id: r.queue_run_id, status: 'finished' as string,
      job: r.job, trigger: r.trigger, scheduled_for: r.scheduled_for, started_at: r.started_at, finished_at: r.finished_at as Date | null,
      skipped: r.skipped, ok: r.ok as boolean | null, steps: r.steps, triggered_by: r.triggered_by,
    }))].slice(0, q.limit),
    jobs,
    reference: {
      popularity: pop ? { list_id: pop.listId, list_date: pop.listDate, rows: pop.rows, refreshed_at: pop.fetchedAt } : null,
      iana: { refreshed_at: iana?.fetched_at ?? null },
      namebio: { enabled: false },
    },
    backup: { configured: Boolean(config.backup.token && config.backup.repo), last_status: lastStatus },
  };
}
