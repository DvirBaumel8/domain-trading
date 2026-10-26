// v5.59.0 (CR-081): the replay job. A run is a row of `replay_day_runs` (queued -> running -> done | error); the in-process runner works the queue one run at a time (a run reads
// two or three gzip files, scores the field and writes the report). Rows left `running` by a dead process are queued again. No outside call, nothing is written but the run row.
import { z } from 'zod';
import type { Kysely } from 'kysely';
import { sql } from 'kysely';
import { isRealDate } from '../../../core/dates.js';
import type { Database } from '../../../db/types.js';
import { AppError } from '../../../http/errors.js';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { archiveExists, archivePath, readArchive, type ArchiveKind } from '../archive/godaddy-archive.js';
import { dayRow, logicContext, randomGroup, rankDay, type DayRow, type ReplayKind } from './logic.js';
import { readOutcomes } from './outcomes.js';
import { buildReport } from './report.js';

export const ReplayBody = z.object({
  date: z.string().refine(isRealDate, 'must be a real date (YYYY-MM-DD)'),
  kind: z.enum(['auctions', 'closeouts']),
  n: z.number().int().min(1).max(200).default(25),
  seed: z.string().min(1).max(100).optional(),
  /** v1 accepts only "current": today's logic on day D's point-in-time data. */
  logic: z.literal('current').optional(),
  dry_run: z.boolean().optional(),
}).strict();
export type ReplayBodyT = z.infer<typeof ReplayBody>;

const FILE: Record<ReplayKind, ArchiveKind> = { auctions: 'all_biddable_auctions', closeouts: 'closeout_listings' };
/** v1 has one logic: today's, run on day D's point-in-time data. A request for the logic as it stood on D is refused until recipe versions are stored per day. */
export function refuseAsOf(o: unknown): void {
  if (o && typeof o === 'object' && 'as_of_date' in o) throw new AppError(422, 'REPLAY_LOGIC_UNAVAILABLE', 'The logic as it stood on day D is not available: recipe versions are not stored per day. Only logic "current" (today\'s logic on day D\'s data) is accepted', { logic: 'current' });
}

/** The seed: an explicit one, else derived from the sha256 of the day's archive file (plus the kind). */
export async function resolveSeed(archiveDir: string, date: string, kind: ReplayKind, seed?: string): Promise<string> {
  if (seed) return seed;
  const h = createHash('sha256').update(await readFile(archivePath(archiveDir, date, FILE[kind]))).update(`:${kind}`).digest('hex');
  return `sha:${h.slice(0, 16)}`;
}

const STALE_RUNNING_MS = 30 * 60_000;

export interface ReplayDeps { db: Kysely<Database>; now: () => number; archiveDir: string; log?: { warn: (obj: unknown, msg?: string) => void } }

/** The whole replay of one archived day; used by the queue and by dry_run. */
export async function computeReplay(deps: ReplayDeps, b: { date: string; kind: ReplayKind; n: number; seed: string }): Promise<{ report: ReturnType<typeof buildReport>; logic_version: string }> {
  const { db, archiveDir } = deps;
  if (!(await archiveExists(archiveDir, b.date, FILE[b.kind]))) throw new AppError(404, 'ARCHIVE_DAY_MISSING', `No archived ${b.kind} list for ${b.date} (GET /health archive shows the days on disk)`, { date: b.date, kind: b.kind });
  const rows: DayRow[] = [];
  for await (const raw of readArchive(archiveDir, b.date, FILE[b.kind])) { const r = dayRow(raw); if (r) rows.push(r); }
  const ctx = await logicContext(db, b.date, b.kind);
  const day = rankDay(rows, ctx);
  const ours = day.field.slice(0, b.n);
  const random = randomGroup(day.field, b.n, b.seed, b.date);
  const outcomes = await readOutcomes(db, archiveDir, { date: b.date, kind: b.kind, names: [...ours, ...random], nowMs: deps.now() });
  return { report: buildReport({ ctx, day, n: b.n, seed: b.seed, ours, random, outcomes, kind: b.kind }), logic_version: ctx.version };
}

export interface RunView {
  id: number; date: string; kind: ReplayKind; n: number; seed: string; status: 'queued' | 'running' | 'done' | 'error'; logic_version: string | null; error: string | null; requested_by: string | null;
  created_at: string; finished_at: string | null; report?: unknown;
}

const view = (r: { id: string | number; date: string | Date; kind: 'auctions' | 'closeouts'; n: number; seed: string; status: RunView['status']; logic_version: string | null; error: string | null; requested_by: string | null; created_at: Date; finished_at: Date | null; report?: unknown }, withReport: boolean): RunView => ({
  id: Number(r.id), date: typeof r.date === 'string' ? r.date.slice(0, 10) : r.date.toISOString().slice(0, 10), kind: r.kind, n: r.n, seed: r.seed, status: r.status, logic_version: r.logic_version, error: r.error, requested_by: r.requested_by,
  created_at: r.created_at.toISOString(), finished_at: r.finished_at ? r.finished_at.toISOString() : null, ...(withReport ? { report: r.report ?? null } : {}),
});

export class ReplayRunner {
  private active: Promise<void> | null = null;
  constructor(private readonly deps: ReplayDeps) {}

  /** Queues a run (the day and kind must be archived) and starts the worker. */
  async enqueue(b: { date: string; kind: ReplayKind; n: number; seed?: string }, ctx: { by: string | null; auditId: string | null }): Promise<number> {
    const { db } = this.deps;
    if (!(await archiveExists(this.deps.archiveDir, b.date, FILE[b.kind]))) throw new AppError(404, 'ARCHIVE_DAY_MISSING', `No archived ${b.kind} list for ${b.date} (GET /health archive shows the days on disk)`, { date: b.date, kind: b.kind });
    const row = await db.insertInto('replay_day_runs').values({ date: b.date, kind: b.kind, n: b.n, seed: await resolveSeed(this.deps.archiveDir, b.date, b.kind, b.seed), requested_by: ctx.by, audit_id: ctx.auditId, report: null, error: null, logic_version: null, started_at: null, finished_at: null }).returning('id').executeTakeFirstOrThrow();
    this.kick();
    return Number(row.id);
  }

  /** Starts the worker when it is not running (also called by the reads, so a restart picks up unfinished runs). */
  kick(): void {
    if (this.active) return;
    this.active = this.work().catch((e) => this.deps.log?.warn({ err: (e as Error).message }, 'replay worker failed')).finally(() => { this.active = null; });
  }

  /** Resolves when the worker has nothing left (tests). */
  async idle(): Promise<void> { while (this.active) await this.active; }

  private async work(): Promise<void> {
    const { db, now } = this.deps;
    await sql`update replay_day_runs set status = 'queued', started_at = null where status = 'running' and started_at < ${new Date(now() - STALE_RUNNING_MS)}`.execute(db);
    for (;;) {
      const claimed = await sql<{ id: string; date: string; kind: ReplayKind; n: number; seed: string }>`
        update replay_day_runs set status = 'running', started_at = ${new Date(now())}
        where id = (select id from replay_day_runs where status = 'queued' order by id limit 1 for update skip locked)
        returning id::text as id, to_char(date, 'YYYY-MM-DD') as date, kind, n, seed`.execute(db);
      const run = claimed.rows[0];
      if (!run) return;
      try {
        const r = await computeReplay(this.deps, { date: run.date, kind: run.kind, n: run.n, seed: run.seed });
        await db.updateTable('replay_day_runs').set({ status: 'done', report: JSON.stringify(r.report), logic_version: r.logic_version, error: null, finished_at: new Date(now()) }).where('id', '=', run.id).execute();
      } catch (e) {
        await db.updateTable('replay_day_runs').set({ status: 'error', error: (e instanceof Error ? e.message : String(e)).slice(0, 500), finished_at: new Date(now()) }).where('id', '=', run.id).execute();
      }
    }
  }

  async get(id: number): Promise<RunView> {
    this.kick();
    const r = await this.deps.db.selectFrom('replay_day_runs').selectAll().where('id', '=', String(id)).executeTakeFirst();
    if (!r) throw new AppError(404, 'NOT_FOUND', `No replay run ${id}`, { id });
    return view(r as never, true);
  }

  /** The newest finished report of a date / kind / n / seed (the seed defaults to the one derived from the archive file); 404 REPLAY_NOT_RUN. Writes nothing. */
  async report(q: { date: string; kind: ReplayKind; n: number; seed?: string }): Promise<RunView> {
    this.kick();
    let seed: string;
    try { seed = await resolveSeed(this.deps.archiveDir, q.date, q.kind, q.seed); } catch { throw new AppError(404, 'REPLAY_NOT_RUN', `No replay of ${q.kind} ${q.date}: the day is not archived (GET /health archive)`, q); }
    const r = await this.deps.db.selectFrom('replay_day_runs').selectAll().where('date', '=', q.date).where('kind', '=', q.kind).where('n', '=', q.n).where('seed', '=', seed).where('status', '=', 'done').orderBy('id', 'desc').limit(1).executeTakeFirst();
    if (!r) throw new AppError(404, 'REPLAY_NOT_RUN', `No finished replay of ${q.kind} ${q.date} with n=${q.n} and seed ${seed}; start one with POST /replay/runs`, { ...q, seed });
    return view(r as never, true);
  }

  async list(q: { limit: number; status?: RunView['status'] }): Promise<{ runs: RunView[] }> {
    this.kick();
    let sel = this.deps.db.selectFrom('replay_day_runs').selectAll().orderBy('id', 'desc').limit(q.limit);
    if (q.status) sel = sel.where('status', '=', q.status);
    return { runs: (await sel.execute()).map((r) => view(r as never, false)) };
  }
}
