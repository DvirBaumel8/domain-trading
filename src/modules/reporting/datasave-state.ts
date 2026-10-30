// v5.21.0 (CR-071): is the daily data save healthy? One state for GET /health (`datasave`), the /report warning DATASAVE_MISSED and GET /snapshots/missing.
//   ok       every configured GoDaddy file has a complete save within the last 26 h and the last run did not fail after it
//   partial  some files are saved and some are not (or the last run failed for some files)
//   error    the last run's godaddyInventory step failed and nothing from that run was saved
//   overdue  nothing complete within 26 h (also: it never ran)
// The Dynadot steps (not_configured) never count. Since v5.22.0 a bot-uploaded Dynadot kind counts once an upload of that kind has ever arrived: after 16:00 UTC
// (the 15:00 run plus its 60-minute retry window) the day's sealed upload must exist, else the state is at best `partial` and the kind is in `dynadot_missing`.
import { sql, type Kysely } from 'kysely';
import { coverageRatio, lowCoverageSql } from '../../core/snapshot-coverage.js';
import type { Database } from '../../db/types.js';

export const DATASAVE_OVERDUE_HOURS = 26;
const HOUR = 3_600_000;
const SOURCE = 'godaddy_inventory';

export type DatasaveState = 'ok' | 'overdue' | 'partial' | 'error';

export interface DatasaveStatus {
  state: DatasaveState;
  /** True once any save or any datasave run exists (the report raises DATASAVE_MISSED only then, like DAILY_JOB_MISSED). */
  started: boolean;
  files: string[];
  complete_files: string[];
  missing_files: string[];
  last_complete_at: Date | null;
  /** v5.22.0: Dynadot kinds (`dynadot_<kind>`) that have had an upload but have none sealed for the day that is due. */
  dynadot_missing: string[];
  /** The UTC data date those uploads are due for (today after 16:00 UTC, else yesterday). */
  dynadot_due_date: string;
  /** v5.75.0 (CR-090): the latest finished datasave run, step by step (null before the first run). */
  last_run: DatasaveRunDetail | null;
  /** v5.80.0 (CR-099): sealed Dynadot days of the last 3 days with under 90% of their planned pages read (LOW_COVERAGE), newest first. */
  dynadot_low_coverage: DynadotLowCoverage[];
}
export interface DynadotLowCoverage { source: string; data_date: string; coverage_ratio: number; pages_ok_n: number; pages_planned_n: number }

/** v5.80.0 (CR-099): the LOW_COVERAGE Dynadot days since `since` (YYYY-MM-DD). */
export async function dynadotLowCoverage(db: Kysely<Database>, since: string): Promise<DynadotLowCoverage[]> {
  const rows = await db.selectFrom('snapshot_manifests as m').select(['m.source', 'm.data_date', 'm.coverage']).where('m.source', 'in', [...DYNADOT_SOURCES]).where('m.status', '=', 'complete')
    .where('m.data_date', '>=', since).where(lowCoverageSql('m')).orderBy('m.data_date', 'desc').orderBy('m.source').execute();
  return rows.map((r) => {
    const c = r.coverage as { pages_ok: unknown[]; pages_planned: unknown[] };
    return { source: r.source, data_date: String(r.data_date), coverage_ratio: Math.round((coverageRatio(c) ?? 0) * 1000) / 1000, pages_ok_n: c.pages_ok.length, pages_planned_n: c.pages_planned.length };
  });
}

export type DatasaveStepState = 'ok' | 'partial' | 'error' | 'skipped' | 'not_configured';
export interface DatasaveRunDetail {
  run_id: string | null;
  finished_at: Date;
  steps: Record<string, { status: DatasaveStepState; data_date: string | null; error: string | null }>;
}

/** v5.75.0 (CR-090): one step's state from its stored view. A Dynadot pull that ends `gap`/`error` is a finished step (ok) whose summary says what failed. */
export function datasaveStepState(v: { ok?: boolean | null; skipped?: boolean; error?: string; summary?: unknown }): { status: DatasaveStepState; data_date: string | null; error: string | null } {
  const sum = (typeof v.summary === 'object' && v.summary !== null && !Array.isArray(v.summary) ? v.summary : {}) as { status?: unknown; data_date?: unknown; error?: unknown; reason?: unknown; gap?: { reason?: unknown }; failed?: Array<{ error?: unknown }> };
  const dataDate = typeof sum.data_date === 'string' ? sum.data_date : null;
  const text = (x: unknown): string | null => (typeof x === 'string' && x.length > 0 ? x.slice(0, 200) : null);
  const failedText = Array.isArray(sum.failed) ? text(sum.failed.map((f) => f.error).filter((e) => typeof e === 'string').join('; ')) : null;
  if (v.skipped) return { status: 'skipped', data_date: dataDate, error: text(sum.reason) };
  if (sum.status === 'not_configured') return { status: 'not_configured', data_date: dataDate, error: text(sum.reason) };
  if (v.ok === false) return { status: 'error', data_date: dataDate, error: text(v.error) ?? failedText ?? text(sum.error) };
  if (sum.status === 'gap') return { status: 'error', data_date: dataDate, error: `GAP: ${text(sum.gap?.reason) ?? 'unknown'}` };
  if (sum.status === 'error') return { status: 'error', data_date: dataDate, error: text(sum.error) };
  if (sum.status === 'partial') return { status: 'partial', data_date: dataDate, error: text(sum.error) };
  return { status: 'ok', data_date: dataDate, error: null };
}

const DYNADOT_SOURCES = ['dynadot_aftermarket', 'dynadot_closed_auctions', 'dynadot_closeouts'] as const;
const DYNADOT_DUE_HOUR_UTC = 16;

/** The data date a bot upload is due for at `nowMs`: today's from 16:00 UTC on, yesterday's before. */
export function dynadotDueDate(nowMs: number): string {
  const d = new Date(nowMs);
  return new Date(nowMs - (d.getUTCHours() >= DYNADOT_DUE_HOUR_UTC ? 0 : 86_400_000)).toISOString().slice(0, 10);
}

/** v5.50.0 (P8): a Dynadot kind is expected only if one was sealed in the last 3 days; otherwise the source counts as paused (the bots are away) and is quiet. */
const DYNADOT_PAUSED_DAYS = 3;
/** Sources that have had a bot upload (any day) and have no sealed upload for the due date. Quiet until the first upload of a kind, and again once none was sealed for 3 days. */
export async function dynadotMissing(db: Kysely<Database>, nowMs: number): Promise<{ due_date: string; started: boolean; missing: string[] }> {
  const due = dynadotDueDate(nowMs);
  const ever = await db.selectFrom('snapshot_manifests').select('source').distinct().where('origin', 'in', ['bot_upload', 'server']).execute();
  const recentSince = new Date(nowMs - DYNADOT_PAUSED_DAYS * 86_400_000).toISOString().slice(0, 10);
  const active = new Set((await db.selectFrom('snapshot_manifests').select('source').distinct().where('origin', 'in', ['bot_upload', 'server']).where('status', '=', 'complete').where('data_date', '>=', recentSince).execute()).map((r) => r.source));
  const sealed = new Set((await db.selectFrom('snapshot_manifests').select('source').where('origin', 'in', ['bot_upload', 'server']).where('data_date', '=', due).where('status', '=', 'complete').execute()).map((r) => r.source));
  const missing = DYNADOT_SOURCES.filter((s) => active.has(s) && !sealed.has(s));
  return { due_date: due, started: ever.length > 0, missing };
}

export async function configuredFiles(db: Kysely<Database>): Promise<string[]> {
  return (await db.selectFrom('settings').select('datasave_godaddy_files').executeTakeFirstOrThrow()).datasave_godaddy_files;
}

export async function datasaveStatus(db: Kysely<Database>, nowMs: number): Promise<DatasaveStatus> {
  const files = await configuredFiles(db);
  const since = new Date(nowMs - DATASAVE_OVERDUE_HOURS * HOUR);
  const recent = await db.selectFrom('snapshot_manifests').select(['file_name', 'status', 'updated_at']).where('source', '=', SOURCE).where('updated_at', '>=', since).execute();
  const completeSet = new Set(recent.filter((r) => r.status === 'complete').map((r) => r.file_name));
  const complete_files = files.filter((f) => completeSet.has(f));
  const missing_files = files.filter((f) => !completeSet.has(f));
  const lastComplete = recent.filter((r) => r.status === 'complete').map((r) => r.updated_at.getTime()).sort((a, b) => b - a)[0];
  const lastRun = await db.selectFrom('job_runs').select(['started_at', 'finished_at', 'steps', 'queue_run_id']).where('job', '=', 'datasave').where('skipped', '=', false).orderBy('finished_at', 'desc').orderBy('id', 'desc').limit(1).executeTakeFirst();
  const everManifest = await db.selectFrom('snapshot_manifests').select('id').where('source', '=', SOURCE).limit(1).executeTakeFirst();
  const dyn = await dynadotMissing(db, nowMs);
  const started = Boolean(lastRun || everManifest || dyn.started);
  const lastFailed = lastRun !== undefined && (lastRun.steps as { godaddyInventory?: { ok?: boolean } } | null)?.godaddyInventory?.ok === false;
  // the latest run failed its godaddyInventory step: partial when some file is still saved within 26 h, else error
  let state: DatasaveState;
  if (lastFailed) {
    state = complete_files.length > 0 ? 'partial' : 'error';
  } else if (missing_files.length === 0 && files.length > 0) {
    state = 'ok';
  } else if (complete_files.length > 0 || recent.some((r) => r.status === 'partial' || r.status === 'error')) {
    state = 'partial';
  } else {
    state = 'overdue';
  }
  // a Dynadot upload that is due and missing turns an otherwise ok state into partial
  if (state === 'ok' && dyn.missing.length > 0) state = 'partial';
  const views = (lastRun?.steps ?? {}) as Record<string, Parameters<typeof datasaveStepState>[0]>;
  const last_run: DatasaveRunDetail | null = lastRun
    ? { run_id: lastRun.queue_run_id ?? null, finished_at: lastRun.finished_at, steps: Object.fromEntries(Object.entries(views).map(([k, v]) => [k, datasaveStepState(v)])) }
    : null;
  const dynadot_low_coverage = await dynadotLowCoverage(db, new Date(nowMs - 2 * 86_400_000).toISOString().slice(0, 10));
  return { state, started, files, complete_files, missing_files, last_complete_at: lastComplete === undefined ? null : new Date(lastComplete), dynadot_missing: dyn.missing, dynadot_due_date: dyn.due_date, last_run, dynadot_low_coverage };
}

/** The data dates in [from, to] (YYYY-MM-DD, UTC) that have no complete save of every configured file, with the files each lacks. */
export async function missingDays(db: Kysely<Database>, from: string, to: string): Promise<{ expected_files: string[]; missing: Array<{ date: string; missing_files: string[]; status: 'missing' | 'partial' }> }> {
  const files = await configuredFiles(db);
  const rows = await sql<{ data_date: string; file_name: string }>`
    select data_date::text as data_date, file_name from snapshot_manifests
    where source = ${SOURCE} and status = 'complete' and data_date between ${from}::date and ${to}::date`.execute(db);
  const byDay = new Map<string, Set<string>>();
  for (const r of rows.rows) (byDay.get(r.data_date) ?? byDay.set(r.data_date, new Set()).get(r.data_date)!).add(r.file_name);
  const missing: Array<{ date: string; missing_files: string[]; status: 'missing' | 'partial' }> = [];
  for (let t = Date.parse(`${from}T00:00:00Z`); t <= Date.parse(`${to}T00:00:00Z`); t += 24 * HOUR) {
    const date = new Date(t).toISOString().slice(0, 10);
    const have = byDay.get(date) ?? new Set<string>();
    const lack = files.filter((f) => !have.has(f));
    if (lack.length > 0) missing.push({ date, missing_files: lack, status: have.size === 0 ? 'missing' : 'partial' });
  }
  return { expected_files: files, missing };
}
