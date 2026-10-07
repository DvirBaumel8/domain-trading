import type { Kysely } from 'kysely';
import type { Database } from '../db/types.js';
import { jerusalemDate } from '../dates.js';

export interface StepResult {
  ok: boolean;
  skipped?: boolean;
  error?: string;
  summary: unknown;
}

export type JobKind = 'tick' | 'daily';

export type JobTrigger = 'scheduled' | 'manual' | 'cli';

export interface RunOptions {
  /** `scheduled` = the Worker's `<job>-<ms>` key, `manual` = any other job-token call, `cli` = `npm run job`. Default `manual`. */
  trigger?: JobTrigger;
  scheduledFor?: Date | null;
  /** The WRITE token's name for a manual run started through the API (CR-007 T-2); omitted for the job token, the Worker and the CLI. */
  triggeredBy?: string | null;
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
  intakeScreeningJob?: Runnable;
  /** Builds the day's candidate list after the intake run has finished (CR-012 part B); while undefined, that step reports skipped. */
  buildDailyListJob?: Runnable;
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
}


/** Orchestrates the scheduled work for POST /jobs/run. Each step is isolated; jobs' own `running` flags make overlaps skip. */
export class JobRunner {
  private readonly active = new Set<JobKind>();

  constructor(private readonly deps: JobRunnerDeps) {}

  async run(job: JobKind, opts: RunOptions = {}): Promise<JobRunResult> {
    const started = new Date(this.deps.now());
    if (this.active.has(job)) {
      const skipped: JobRunResult = { job, skipped: true, steps: {} };
      await this.record(skipped, opts, started);
      return skipped;
    }
    this.active.add(job);
    try {
      const result: JobRunResult = { job, skipped: false, steps: job === 'tick' ? await this.tickRun() : await this.daily() };
      await this.record(result, opts, started);
      return result;
    } finally {
      this.active.delete(job);
    }
  }

  /** Keeps the run's step summaries (job_runs, append-only). Best effort: a failed write never fails or changes the run. */
  private async record(r: JobRunResult, opts: RunOptions, started: Date): Promise<void> {
    try {
      await this.deps.db.insertInto('job_runs').values({
        job: r.job, trigger: opts.trigger ?? 'manual', scheduled_for: opts.scheduledFor ?? null, started_at: started,
        finished_at: new Date(this.deps.now()), skipped: r.skipped, ok: Object.values(r.steps).every((s) => s.ok), steps: JSON.stringify(r.steps), triggered_by: opts.triggeredBy ?? null,
      }).execute();
    } catch {
      // not recorded; the audit row still records the run
    }
  }

  private async step(fn: () => Promise<unknown>): Promise<StepResult> {
    try {
      const summary = await fn();
      const skipped = typeof summary === 'object' && summary !== null && (summary as { skipped?: unknown }).skipped === true;
      if (skipped) return { ok: true, skipped: true, summary };
      // A step that finished but reports failed items (price job, drop job, ...) is not ok, so the run shows it; the summary is kept.
      const failed = typeof summary === 'object' && summary !== null ? (summary as { failed?: unknown }).failed : undefined;
      if (Array.isArray(failed) && failed.length > 0) return { ok: false, error: `${failed.length} item(s) failed`, summary };
      return { ok: true, summary };
    } catch (e) {
      return { ok: false, error: this.clean((e as Error).message), summary: null };
    }
  }

  /** A sub-step that failed (previous snapshot kept) makes the step `ok: false` but keeps the summary. */
  private async referenceStep(ref: Runnable): Promise<StepResult> {
    const r = await this.step(() => ref.runOnce());
    const errors = (r.summary as { errors?: unknown } | null)?.errors;
    if (r.ok && Array.isArray(errors) && errors.length > 0) return { ok: false, error: this.clean(errors.join('; ')), summary: r.summary };
    return r;
  }

  private clean(message: string): string {
    let m = message;
    for (const v of this.deps.secretValues ?? []) if (v) m = m.split(v).join('[REDACTED]');
    return m.length > 200 ? `${m.slice(0, 200)}...` : m;
  }

  /** A verifier that throws writes no marker, so it is retried on the next run by design. */
  private async nsVerifyDue(): Promise<boolean> {
    const last = await this.deps.db.selectFrom('audit_log').select('at').where('path', '=', 'ns-verify')
      .orderBy('at', 'desc').limit(1).executeTakeFirst();
    // Once per IDT day: a 00:05 UTC run is never skipped because the last one was a few minutes under 24 h ago.
    return !last || jerusalemDate(last.at) < jerusalemDate(new Date(this.deps.now()));
  }

  /** The standalone tick: the base steps, then the review retry (the daily run does not retry; it just ran the review). */
  private async tickRun(): Promise<Record<string, StepResult>> {
    const steps = await this.tick();
    const retry = this.deps.reviewRetry;
    steps.reviewRetry = retry ? await this.step(retry) : { ok: true, skipped: true, summary: { skipped: true, reason: 'review retry not configured' } };
    return steps;
  }

  private async tick(): Promise<Record<string, StepResult>> {
    const steps: Record<string, StepResult> = {};
    steps.reconciler = await this.step(() => this.deps.reconciler.runOnce());
    steps.nsVerifier = await this.step(async () => {
      if (!(await this.nsVerifyDue())) return { skipped: true, reason: 'already ran today (IDT)' };
      return this.deps.nsVerifier.runOnce();
    });
    steps.screeningResume = await this.step(() => this.deps.screeningWorker.resumeStalled());
    return steps;
  }

  private async daily(): Promise<Record<string, StepResult>> {
    // Daily-only schedule (CR-005 Amendment A): the former hourly steps run first.
    const steps: Record<string, StepResult> = await this.tick();
    steps.priceJob = await this.step(() => this.deps.priceJob.runOnce());
    steps.dropJob = await this.step(() => this.deps.dropJob.runOnce());
    steps.registrarCheck = await this.step(() => this.deps.registrarCheckJob.runOnce());
    const pc = this.deps.portfolioCheckJob;
    steps.portfolioCheck = pc ? await this.step(() => pc.runOnce()) : { ok: true, skipped: true, summary: { skipped: true, reason: 'portfolio check not configured' } };
    const dw = this.deps.dropWatchJob;
    steps.dropWatch = dw ? await this.step(() => dw.runOnce()) : { ok: true, skipped: true, summary: { skipped: true, reason: 'drop watch not configured' } };
    const is = this.deps.intakeScreeningJob;
    steps.intakeScreening = is ? await this.step(() => is.runOnce()) : { ok: true, skipped: true, summary: { skipped: true, reason: 'intake screening not configured' } };
    const bl = this.deps.buildDailyListJob;
    steps.buildDailyList = bl ? await this.step(() => bl.runOnce()) : { ok: true, skipped: true, summary: { skipped: true, reason: 'daily list not configured' } };
    const co = this.deps.cohortOutcomesJob;
    steps.cohortOutcomes = co ? await this.step(() => co.runOnce()) : { ok: true, skipped: true, summary: { skipped: true, reason: 'cohort outcomes not configured' } };
    const ref = this.deps.referenceRefresh;
    steps.referenceRefresh = ref ? await this.referenceStep(ref) : { ok: true, skipped: true, summary: { skipped: true, reason: 'reference refresh not configured' } };
    const review = this.deps.outsideReview;
    steps.outsideReview = review ? await this.step(review) : { ok: true, skipped: true, summary: { skipped: true, reason: 'outside review not configured' } };
    const pr = this.deps.postsRefresh;
    steps.postsRefresh = pr ? await this.step(pr) : { ok: true, skipped: true, summary: { skipped: true, reason: 'posts refresh not configured' } };
    const backup = this.deps.backupExport;
    steps.backupExport = backup
      ? await this.step(() => backup.runOnce())
      : { ok: true, skipped: true, summary: { skipped: true, reason: 'backup export not configured' } };
    return steps;
  }
}
