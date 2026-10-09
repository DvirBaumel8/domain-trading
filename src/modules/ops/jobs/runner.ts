import { scrubSecrets } from '../../../core/redact.js';
import type { Kysely } from 'kysely';
import type { Database } from '../../../db/types.js';
import { idtDay } from '../../../core/dates.js';
import { trySessionLock, type LockKey, type SessionLock } from '../../../core/locks.js';
export interface StepResult {
  ok: boolean;
  skipped?: boolean;
  error?: string;
  /** How long the step took, in milliseconds. */
  ms: number;
  summary: unknown;
}

/** `screen` (v3.3.0, CR-021): one on-demand screening of the waiting intake names, then a rebuild of the day's list. */
export type JobKind = 'tick' | 'daily' | 'screen';

/** One step of a job: what the queue stores (limits) and runs (exec). `exec` returns the step's summary and throws on failure. */
export interface PlanStep {
  name: string;
  maxAttempts: number;
  timeoutMs: number;
  exec: () => Promise<unknown>;
  /** A summary with a non-empty `errors` list makes the step not ok (the reference refresh keeps its previous snapshot). */
  errorsFail?: boolean;
}

/** Attempts and timeouts per step (v3.0.0). Steps that read outside services get 3 attempts, the review steps 1 (they keep their own retry), the rest 2. */
export const DEFAULT_ATTEMPTS = 2;
export const STEP_ATTEMPTS: Record<string, number> = {
  registrarCheck: 3, portfolioCheck: 3, dropWatch: 3, referenceRefresh: 3, postsRefresh: 3, outsideReview: 1, reviewRetry: 1,
};
export const DEFAULT_TIMEOUT_MS = 5 * 60_000;
export const STEP_TIMEOUT_MS: Record<string, number> = { intakeScreening: 10 * 60_000, onDemandScreen: 10 * 60_000, buildDailyList: 10 * 60_000 };

export type JobTrigger = 'scheduled' | 'manual' | 'cli';

/** v3.2.0 (N-3): who started a run. The WRITE token's name, else `cli` for the CLI, else `job-token` (the Worker and any job-token call). Never null. */
export const triggeredByOf = (o: { trigger?: JobTrigger; triggeredBy?: string | null }): string => o.triggeredBy ?? (o.trigger === 'cli' ? 'cli' : 'job-token');

export interface RunOptions {
  /** `scheduled` = the Worker's `<job>-<ms>` key, `manual` = any other job-token call, `cli` = `npm run job`. Default `manual`. */
  trigger?: JobTrigger;
  scheduledFor?: Date | null;
  /** The WRITE token's name for a manual run started through the API (CR-007 T-2); omitted for the job token, the Worker and the CLI. */
  triggeredBy?: string | null;
  /** The run's request, stored with the run (`screen`: {max_names}). */
  params?: unknown;
}

export interface JobRunResult {
  job: JobKind;
  skipped: boolean;
  steps: Record<string, StepResult>;
}

/** The nightly data export. Wired in by the backup task; while undefined, that step reports skipped. */
export interface BackupExport {
  runOnce(): Promise<unknown>;
}

interface Runnable {
  runOnce(): Promise<unknown>;
}

export interface JobRunnerDeps {
  db: Kysely<Database>;
  now: () => number;
  reconciler: Runnable;
  nsVerifier: Runnable;
  priceJob: Runnable;
  dropJob: Runnable;
  registrarCheckJob: Runnable;
  /** Daily registry, lander and blocklist checks of the live names (CR-007 G-5); while undefined, that step reports skipped. */
  portfolioCheckJob?: Runnable;
  /** Daily registry check of the kept names of the uploaded drop lists (CR-007 §22 G-2); while undefined, that step reports skipped. */
  dropWatchJob?: Runnable;
  /** Screens the queued scout names and the drop-list names about to drop in one full-plan run (CR-012 part C); while undefined, that step reports skipped. */
  intakeScreeningJob?: Runnable & { runOnDemand?: (maxNames: number | null, domains?: string[], force?: boolean) => Promise<unknown> };
  /** Builds the day's candidate list after the intake run has finished (CR-012 part B); while undefined, that step reports skipped. */
  buildDailyListJob?: Runnable & { runOnce(o?: { builtBy?: 'daily' | 'rebuild' | 'auto' }): Promise<unknown> };
  /** Freezes cohorts and checks their drop and re-registration outcomes (CR-007 §22 G-1); while undefined, that step reports skipped. */
  cohortOutcomesJob?: Runnable;
  /** Resumes stalled screening runs (CAP-20); its summary is {resumed[], finalized[]}. */
  screeningWorker: { resumeStalled(): Promise<unknown> };
  /** The one outside review (founder rule 9, v2.11.0); runs after referenceRefresh and before backupExport so the backup includes it. While undefined, that step reports skipped. */
  outsideReview?: () => Promise<unknown>;
  /** The 10:30 IDT tick retries a review that got a 429 in the daily run (CR-011 addendum C); while undefined, that step reports skipped. */
  reviewRetry?: () => Promise<unknown>;
  /** Fills the X link and sent time of recent posts from Buffer (v2.12.0); runs after outsideReview, before backupExport. While undefined, that step reports skipped. */
  postsRefresh?: () => Promise<unknown>;
  backupExport?: BackupExport;
  /** Daily popularity list / IANA bootstrap / cache pruning (CAP-02); while undefined, that step reports skipped. */
  referenceRefresh?: Runnable;
  /** Secret values scrubbed from step error messages. */
  secretValues?: string[];
  /** Takes the run lock (default: a database session lock). Tests of the step order pass a stub. */
  acquireLock?: (key: LockKey) => Promise<SessionLock | null>;
}


/** Orchestrates the scheduled work. `plan(job)` lists the steps in order; the queue (queue.ts) runs them one by one with attempts and timeouts, `run()` runs them in-process once (CLI, tests). A database lock per job kind (and one per job) makes overlaps skip, across instances too. */
export class JobRunner {
  constructor(private readonly deps: JobRunnerDeps) {}

  /** The steps of `job` in run order, each with its attempts and timeout. */
  plan(job: JobKind, run?: { params?: unknown }): PlanStep[] {
    const d = this.deps;
    const step = (name: string, exec: () => Promise<unknown>, errorsFail = false): PlanStep => ({
      name, exec, errorsFail, maxAttempts: STEP_ATTEMPTS[name] ?? DEFAULT_ATTEMPTS, timeoutMs: STEP_TIMEOUT_MS[name] ?? DEFAULT_TIMEOUT_MS,
    });
    const optional = (name: string, job: Runnable | undefined, reason: string, errorsFail = false) =>
      step(name, async () => (job ? job.runOnce() : { skipped: true, reason }), errorsFail);
    const optionalFn = (name: string, fn: (() => Promise<unknown>) | undefined, reason: string) =>
      step(name, async () => (fn ? fn() : { skipped: true, reason }));
    const tick: PlanStep[] = [
      step('reconciler', () => d.reconciler.runOnce()),
      step('nsVerifier', async () => {
        if (!(await this.nsVerifyDue())) return { skipped: true, reason: 'already ran today (IDT)' };
        return d.nsVerifier.runOnce();
      }),
      step('screeningResume', () => d.screeningWorker.resumeStalled()),
    ];
    // v3.3.0 (CR-021): POST /candidates/screen. Screening of the waiting names under the on-demand allowance, then the list; nothing else of the daily run.
    if (job === 'screen') {
      const maxNames = (run?.params as { max_names?: unknown } | null | undefined)?.max_names;
      const force = (run?.params as { force?: unknown } | null | undefined)?.force === true;
      const named = (run?.params as { domains?: unknown } | null | undefined)?.domains;
      return [
        step('onDemandScreen', async () => (d.intakeScreeningJob?.runOnDemand ? d.intakeScreeningJob.runOnDemand(typeof maxNames === 'number' ? maxNames : null, Array.isArray(named) ? (named as string[]) : undefined, force) : { skipped: true, reason: 'intake screening not configured' })),
        step('buildDailyList', async () => (d.buildDailyListJob ? d.buildDailyListJob.runOnce({ builtBy: 'auto' }) : { skipped: true, reason: 'daily list not configured' })),
      ];
    }
    if (job === 'tick') return [...tick, optionalFn('reviewRetry', d.reviewRetry, 'review retry not configured')];
    // Daily-only schedule (CR-005 Amendment A): the former hourly steps run first.
    return [
      ...tick,
      step('priceJob', () => d.priceJob.runOnce()),
      step('dropJob', () => d.dropJob.runOnce()),
      step('registrarCheck', () => d.registrarCheckJob.runOnce()),
      optional('portfolioCheck', d.portfolioCheckJob, 'portfolio check not configured'),
      optional('dropWatch', d.dropWatchJob, 'drop watch not configured'),
      optional('intakeScreening', d.intakeScreeningJob, 'intake screening not configured'),
      optional('buildDailyList', d.buildDailyListJob, 'daily list not configured'),
      optional('cohortOutcomes', d.cohortOutcomesJob, 'cohort outcomes not configured'),
      optional('referenceRefresh', d.referenceRefresh, 'reference refresh not configured', true),
      optionalFn('outsideReview', d.outsideReview, 'outside review not configured'),
      optionalFn('postsRefresh', d.postsRefresh, 'posts refresh not configured'),
      optional('backupExport', d.backupExport, 'backup export not configured'),
    ];
  }

  /** Turns a finished step's summary into its result (skipped, failed items, reference errors). */
  classify(entry: PlanStep, summary: unknown, ms: number): StepResult {
    const obj = typeof summary === 'object' && summary !== null ? (summary as { skipped?: unknown; failed?: unknown; errors?: unknown }) : null;
    if (obj?.skipped === true) return { ok: true, skipped: true, ms, summary };
    // A step that finished but reports failed items (price job, drop job, ...) is not ok, so the run shows it; the summary is kept.
    if (Array.isArray(obj?.failed) && obj.failed.length > 0) return { ok: false, error: `${obj.failed.length} item(s) failed`, ms, summary };
    // A sub-step that failed (previous snapshot kept) makes the step not ok but keeps the summary.
    if (entry.errorsFail && Array.isArray(obj?.errors) && obj.errors.length > 0) return { ok: false, error: this.clean(obj.errors.join('; ')), ms, summary };
    return { ok: true, ms, summary };
  }

  /** The step's error text for a result: secrets scrubbed, 200 characters at most. */
  errorText(e: unknown): string {
    return this.clean(e instanceof Error ? e.message : String(e));
  }

  /** Runs one step once, in-process: errors become `ok:false`. */
  async runStepOnce(entry: PlanStep): Promise<StepResult> {
    const t0 = this.deps.now();
    const ms = () => Math.max(0, this.deps.now() - t0);
    try {
      return this.classify(entry, await entry.exec(), ms());
    } catch (e) {
      return { ok: false, error: this.errorText(e), ms: ms(), summary: null };
    }
  }

  async run(job: JobKind, opts: RunOptions = {}): Promise<JobRunResult> {
    const started = new Date(this.deps.now());
    const key: LockKey = job === 'tick' ? 'job:tick' : job === 'screen' ? 'job:screen' : 'job:daily';
    const lock = await (this.deps.acquireLock ? this.deps.acquireLock(key) : trySessionLock(this.deps.db, key));
    if (!lock) {
      const skipped: JobRunResult = { job, skipped: true, steps: {} };
      await this.record(skipped, opts, started);
      return skipped;
    }
    try {
      const steps: Record<string, StepResult> = {};
      for (const entry of this.plan(job)) steps[entry.name] = await this.runStepOnce(entry);
      const result: JobRunResult = { job, skipped: false, steps };
      await this.record(result, opts, started);
      return result;
    } finally {
      await lock.release();
    }
  }

  /** Keeps the run's step summaries (job_runs, append-only). Best effort: a failed write never fails or changes the run. */
  private async record(r: JobRunResult, opts: RunOptions, started: Date): Promise<void> {
    try {
      await this.deps.db.insertInto('job_runs').values({
        job: r.job, trigger: opts.trigger ?? 'manual', scheduled_for: opts.scheduledFor ?? null, started_at: started,
        finished_at: new Date(this.deps.now()), skipped: r.skipped, ok: Object.values(r.steps).every((s) => s.ok), steps: JSON.stringify(r.steps), triggered_by: triggeredByOf(opts),
      }).execute();
    } catch {
      // not recorded; the audit row still records the run
    }
  }

  private clean(message: string): string {
    const m = scrubSecrets(message, this.deps.secretValues ?? []);
    return m.length > 200 ? `${m.slice(0, 200)}...` : m;
  }

  /** A verifier that throws writes no marker, so it is retried on the next run by design. */
  private async nsVerifyDue(): Promise<boolean> {
    const last = await this.deps.db.selectFrom('audit_log').select('at').where('path', '=', 'ns-verify')
      .orderBy('at', 'desc').limit(1).executeTakeFirst();
    // Once per IDT day: a 00:05 UTC run is never skipped because the last one was a few minutes under 24 h ago.
    return !last || idtDay(last.at) < idtDay(new Date(this.deps.now()));
  }
}
