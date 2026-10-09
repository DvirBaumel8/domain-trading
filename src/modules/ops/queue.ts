// The job queue (refactor R3, contract 3.0.0): a small table-based queue in Postgres, worked only while the process is awake.
// POST /jobs/run enqueues a run (job_queue_runs + one job_steps row per step). The in-process worker takes the run's job lock (a session lock, so the CLI
// and a second instance never work the same job at once), then claims the steps one after the other (FOR UPDATE SKIP LOCKED), strictly in position order.
// A step has attempts and a timeout; a failed attempt is requeued while attempts remain; a step left `running` by a dead instance is reclaimed (attempt counts).
// When every step is terminal the run is written once to job_runs (append-only), which keeps JOB_OVERDUE and the history working as before.
import { randomUUID } from 'node:crypto';
import { sql, type Kysely } from 'kysely';
import { newAuditId } from '../../http/audit.js';
import { advisoryXactLock, trySessionLock, type LockKey } from '../../core/locks.js';
import type { Database } from '../../db/types.js';
import { stepView } from '../reporting/index.js';
import { triggeredByOf, type JobKind, type JobRunner, type PlanStep, type RunOptions, type StepResult } from './jobs/runner.js';

/** Extra time on a step's lock beyond its timeout, so the in-process timeout always fires before the lock counts as expired. */
const LOCK_GRACE_MS = 5_000;

export interface EnqueueResult {
  runId: string;
  job: JobKind;
  status: 'queued' | 'running';
  steps: string[];
  /** True when a run of the same job was already queued or running: its id is returned and nothing new is queued. */
  skipped: boolean;
}

export interface JobQueueDeps {
  db: Kysely<Database>;
  now: () => number;
  runner: JobRunner;
  log?: { warn: (obj: unknown, msg?: string) => void };
  /** Test hook: per-step overrides of the attempts and the timeout, applied when a run is enqueued. */
  overrides?: Record<string, { maxAttempts?: number; timeoutMs?: number }>;
  /** v3.2.0 (CR-018 A): resumes screening runs a dead process left `running`; called by every kickIfNeeded, `atStart` true on the first call of this process. */
  resumeScreening?: (atStart: boolean) => Promise<unknown>;
  /** Off when absent. While the worker is busy, GET `${url}/health/ping` every KEEPALIVE_MS so the instance is not spun down mid-run. */
  keepAlive?: { url: string; fetch?: typeof fetch };
}

/** Render free sleeps 15 min after the last inbound request; while the worker runs, the service pings itself this often. */
export const KEEPALIVE_MS = 300_000;
const PING_TIMEOUT_MS = 10_000;

const TIMEOUT = Symbol('step timeout');
const OPEN = ['queued', 'running'] as const;

export class JobQueue {
  readonly instanceId = `${process.pid}-${randomUUID().slice(0, 8)}`;
  private active: Promise<void> | null = null;
  private stopped = false;
  private resumedScreening = false;

  constructor(private readonly deps: JobQueueDeps) {}

  /** Queues a run of `job`, or returns the run of that job that is still open (`skipped: true`). */
  async enqueue(job: JobKind, opts: RunOptions = {}): Promise<EnqueueResult> {
    const { db } = this.deps;
    return db.transaction().execute(async (trx) => {
      await advisoryXactLock(trx, 'job_enqueue');
      const open = await trx.selectFrom('job_queue_runs as r').select('r.id')
        .where('r.job', '=', job)
        .where((eb) => eb.exists(eb.selectFrom('job_steps as s').select('s.id').whereRef('s.run_id', '=', 'r.id').where('s.status', 'in', OPEN)))
        .orderBy('r.created_at').limit(1).executeTakeFirst();
      if (open) {
        const steps = await trx.selectFrom('job_steps').select(['step', 'status']).where('run_id', '=', open.id).orderBy('position').execute();
        return { runId: open.id, job, status: steps.some((s) => s.status === 'running') ? 'running' as const : 'queued' as const, steps: steps.map((s) => s.step), skipped: true };
      }
      const runId = `run_${randomUUID()}`;
      await trx.insertInto('job_queue_runs').values({
        id: runId, job, trigger: opts.trigger ?? 'manual', scheduled_for: opts.scheduledFor ?? null, triggered_by: triggeredByOf(opts), created_at: new Date(this.deps.now()),
        params: opts.params === undefined ? null : JSON.stringify(opts.params),
      }).execute();
      const plan = this.deps.runner.plan(job);
      await trx.insertInto('job_steps').values(plan.map((e, position) => ({
        run_id: runId, job, step: e.name, position,
        max_attempts: this.deps.overrides?.[e.name]?.maxAttempts ?? e.maxAttempts,
        timeout_ms: this.deps.overrides?.[e.name]?.timeoutMs ?? e.timeoutMs,
      }))).execute();
      return { runId, job, status: 'queued' as const, steps: plan.map((e) => e.name), skipped: false };
    });
  }

  /** Starts the worker in the background unless it is already working. Never throws. */
  kick(): void {
    if (this.active || this.stopped) return;
    this.active = this.processAll().catch((e: unknown) => {
      this.deps.log?.warn({ err: e instanceof Error ? e.message : String(e) }, 'job queue worker failed');
    }).finally(() => { this.active = null; });
  }

  /** Kicks the worker when unfinished steps exist and none is working in this process (a cheap check: used by GET /jobs/runs and GET /health). */
  async kickIfNeeded(): Promise<void> {
    if (this.stopped) return;
    if (this.deps.resumeScreening) {
      const atStart = !this.resumedScreening;
      this.resumedScreening = true;
      try {
        await this.deps.resumeScreening(atStart);
      } catch (e) {
        this.deps.log?.warn({ err: e instanceof Error ? e.message : String(e) }, 'screening resume failed');
      }
    }
    if (this.active) return;
    try {
      const open = await this.deps.db.selectFrom('job_steps').select('id').where('status', 'in', OPEN).limit(1).executeTakeFirst();
      if (open) this.kick();
    } catch (e) {
      this.deps.log?.warn({ err: e instanceof Error ? e.message : String(e) }, 'job queue check failed');
    }
  }

  /** Resolves when the worker has nothing left to do in this process. */
  async idle(): Promise<void> {
    while (this.active) await this.active;
  }

  /** Stops taking new work and waits for the step in flight (app close). */
  async stop(): Promise<void> {
    this.stopped = true;
    await this.idle();
  }

  private async processAll(): Promise<void> {
    const ka = this.deps.keepAlive;
    const timer = ka ? setInterval(() => {
      const f = ka.fetch ?? fetch;
      void Promise.resolve().then(() => f(`${ka.url.replace(/\/+$/, '')}/health/ping`, { signal: AbortSignal.timeout(PING_TIMEOUT_MS) })).catch(() => { /* a failed ping is ignored */ });
    }, KEEPALIVE_MS) : undefined;
    try {
      await this.processRuns();
    } finally {
      clearInterval(timer);
    }
  }

  private async processRuns(): Promise<void> {
    const tried = new Set<string>();
    while (!this.stopped) {
      const runs = await this.deps.db.selectFrom('job_steps as s').innerJoin('job_queue_runs as r', 'r.id', 's.run_id')
        .select(['s.run_id as id', 'r.job as job']).select((eb) => eb.fn.min('s.id').as('first'))
        .where('s.status', 'in', OPEN).groupBy(['s.run_id', 'r.job']).orderBy('first').execute();
      const next = runs.find((r) => !tried.has(r.id));
      if (!next) return;
      tried.add(next.id);
      await this.processRun(next.id, next.job);
    }
  }

  private async processRun(runId: string, job: JobKind): Promise<void> {
    const { db } = this.deps;
    const lock = await trySessionLock(db, `job:${job}` as LockKey);
    if (!lock) return; // the CLI or another instance is working this job; the run waits for the next kick
    try {
      // With the job lock held, no other process runs a step of this job: a step still `running` was left by a dead process (or an expired lock).
      await this.reclaim(runId);
      const q = await db.selectFrom('job_queue_runs').select('params').where('id', '=', runId).executeTakeFirst();
      const plan = this.deps.runner.plan(job, { params: q?.params });
      while (!this.stopped) {
        const step = await this.claim(runId);
        if (!step) break;
        await this.execute(step, plan.find((e) => e.name === step.step));
      }
      await this.finalize(runId);
    } finally {
      await lock.release();
    }
  }

  /** Running steps left behind: requeued (attempt already counted), or failed when no attempt is left. */
  private async reclaim(runId: string): Promise<void> {
    await sql`
      update job_steps set
        status = case when attempt >= max_attempts then 'failed' else 'queued' end,
        error = 'lock expired', locked_by = null, locked_until = null,
        finished_at = case when attempt >= max_attempts then now() else null end
      where run_id = ${runId} and status = 'running' and (locked_until < now() or locked_by is distinct from ${this.instanceId})`.execute(this.deps.db);
  }

  /** The next step of the run: queued, with every earlier step terminal. SKIP LOCKED so two workers never take the same row. */
  private async claim(runId: string): Promise<{ id: number; step: string; attempt: number; max_attempts: number; timeout_ms: number } | undefined> {
    const r = await sql<{ id: string; step: string; attempt: number; max_attempts: number; timeout_ms: number }>`
      update job_steps set status = 'running', attempt = attempt + 1, locked_by = ${this.instanceId},
        locked_until = now() + (timeout_ms + ${LOCK_GRACE_MS}) * interval '1 millisecond', started_at = coalesce(started_at, now())
      where id = (
        select s.id from job_steps s
        where s.run_id = ${runId} and s.status = 'queued'
          and not exists (select 1 from job_steps p where p.run_id = s.run_id and p.position < s.position and p.status in ('queued', 'running'))
        order by s.position limit 1 for update skip locked)
      returning id, step, attempt, max_attempts, timeout_ms`.execute(this.deps.db);
    const row = r.rows[0];
    return row && { ...row, id: Number(row.id) };
  }

  private async execute(step: { id: number; attempt: number; max_attempts: number; timeout_ms: number }, entry: PlanStep | undefined): Promise<void> {
    const { runner, db } = this.deps;
    const t0 = this.deps.now();
    const ms = () => Math.max(0, this.deps.now() - t0);
    let result: StepResult | null = null;
    let error = '';
    if (!entry) {
      error = 'unknown step';
    } else {
      let timer: NodeJS.Timeout | undefined;
      const work = Promise.resolve().then(() => entry.exec());
      work.catch(() => { /* a step abandoned by its timeout may still fail later */ });
      try {
        const out = await Promise.race([work, new Promise<typeof TIMEOUT>((res) => { timer = setTimeout(() => res(TIMEOUT), step.timeout_ms); })]);
        if (out === TIMEOUT) error = 'timeout';
        else result = runner.classify(entry, out, ms());
      } catch (e) {
        error = runner.errorText(e);
      } finally {
        clearTimeout(timer);
      }
    }
    const done = { locked_by: null, locked_until: null };
    if (result) {
      const status = result.skipped ? 'skipped' : result.ok ? 'done' : 'failed';
      await db.updateTable('job_steps').set({ ...done, status, finished_at: new Date(this.deps.now()), ms: result.ms, summary: json(result.summary), error: result.error ?? null }).where('id', '=', step.id).execute();
    } else if (step.attempt < step.max_attempts) {
      await db.updateTable('job_steps').set({ ...done, status: 'queued', error }).where('id', '=', step.id).execute();
    } else {
      await db.updateTable('job_steps').set({ ...done, status: 'failed', finished_at: new Date(this.deps.now()), ms: ms(), error }).where('id', '=', step.id).execute();
    }
  }

  /** Writes the run to job_runs once every step is terminal. A second finisher is a no-op (queue_run_id is unique). */
  private async finalize(runId: string): Promise<void> {
    const { db } = this.deps;
    const rows = await db.selectFrom('job_steps').selectAll().where('run_id', '=', runId).orderBy('position').execute();
    if (rows.length === 0 || rows.some((r) => r.status === 'queued' || r.status === 'running')) return;
    const q = await db.selectFrom('job_queue_runs').selectAll().where('id', '=', runId).executeTakeFirstOrThrow();
    const steps = Object.fromEntries(rows.map((r) => [r.step, stepView(r)]));
    const started = rows.map((r) => r.started_at?.getTime()).filter((t): t is number => t !== undefined).sort((a, b) => a - b)[0];
    const inserted = await db.insertInto('job_runs').values({
      job: q.job, trigger: q.trigger, scheduled_for: q.scheduled_for, started_at: started === undefined ? q.created_at : new Date(started),
      finished_at: new Date(this.deps.now()), skipped: false, ok: rows.every((r) => r.status !== 'failed'), steps: JSON.stringify(steps),
      triggered_by: q.triggered_by, queue_run_id: runId,
    }).onConflict((oc) => oc.doNothing()).returning('id').executeTakeFirst();
    if (!inserted) return;
    // The run-level audit row POST /jobs/run used to get when it ran the job in the request (the CLI writes the same kind of row).
    const failed = rows.filter((r) => r.status === 'failed').map((r) => r.step);
    await db.insertInto('audit_log').values({
      id: newAuditId(), scope: 'job', method: 'QUEUE', path: `job ${q.job}`,
      request: JSON.stringify({ job: q.job, run_id: runId, steps: Object.fromEntries(rows.map((r) => [r.step, r.status])) }),
      status_code: failed.length ? 500 : 200,
      result_summary: failed.length ? `${q.job}: failed ${failed.join(',')}` : `${q.job}: ok`,
    }).execute();
  }
}

/** JSON for a jsonb column (a NUL character cannot be stored in jsonb). */
const json = (v: unknown): string => (JSON.stringify(v ?? null) as string).replace(/\\u0000/g, '');
