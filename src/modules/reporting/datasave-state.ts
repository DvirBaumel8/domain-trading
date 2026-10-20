// v5.21.0 (CR-071): is the daily data save healthy? One state for GET /health (`datasave`), the /report warning DATASAVE_MISSED and GET /snapshots/missing.
//   ok       every configured GoDaddy file has a complete save within the last 26 h and the last run did not fail after it
//   partial  some files are saved and some are not (or the last run failed for some files)
//   error    the last run's godaddyInventory step failed and nothing from that run was saved
//   overdue  nothing complete within 26 h (also: it never ran)
// The Dynadot steps (not_configured) never count.
import { sql, type Kysely } from 'kysely';
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
  const lastRun = await db.selectFrom('job_runs').select(['started_at', 'finished_at', 'steps']).where('job', '=', 'datasave').where('skipped', '=', false).orderBy('finished_at', 'desc').orderBy('id', 'desc').limit(1).executeTakeFirst();
  const everManifest = await db.selectFrom('snapshot_manifests').select('id').where('source', '=', SOURCE).limit(1).executeTakeFirst();
  const started = Boolean(lastRun || everManifest);
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
  return { state, started, files, complete_files, missing_files, last_complete_at: lastComplete === undefined ? null : new Date(lastComplete) };
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
