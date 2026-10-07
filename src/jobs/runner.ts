import type { Kysely } from 'kysely';
import type { Database } from '../db/types.js';

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
  /** Resumes stalled screening runs (CAP-20); its summary is {resumed[], finalized[]}. */
  screeningWorker: { resumeStalled(): Promise<unknown> };
  backupExport?: BackupExport;
  /** Daily popularity list / IANA bootstrap / cache pruning (CAP-02); while undefined, that step reports skipped. */
  referenceRefresh?: Runnable;
  /** Secret values scrubbed from step error messages. */
  secretValues?: string[];
}

const NS_VERIFY_EVERY_MS = 24 * 3_600_000;

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
      const result: JobRunResult = { job, skipped: false, steps: job === 'tick' ? await this.tick() : await this.daily() };
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
      return skipped ? { ok: true, skipped: true, summary } : { ok: true, summary };
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
    return !last || this.deps.now() - last.at.getTime() >= NS_VERIFY_EVERY_MS;
  }

  private async tick(): Promise<Record<string, StepResult>> {
    const steps: Record<string, StepResult> = {};
    steps.reconciler = await this.step(() => this.deps.reconciler.runOnce());
    steps.nsVerifier = await this.step(async () => {
      if (!(await this.nsVerifyDue())) return { skipped: true, reason: 'ran within the last 24 h' };
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
    const ref = this.deps.referenceRefresh;
    steps.referenceRefresh = ref ? await this.referenceStep(ref) : { ok: true, skipped: true, summary: { skipped: true, reason: 'reference refresh not configured' } };
    const backup = this.deps.backupExport;
    steps.backupExport = backup
      ? await this.step(() => backup.runOnce())
      : { ok: true, skipped: true, summary: { skipped: true, reason: 'backup export not configured' } };
    return steps;
  }
}
