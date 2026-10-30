import type { FastifyInstance } from 'fastify';
import { sql, type Kysely } from 'kysely';
import type { Config } from '../../../config.js';
import { toJerusalemIso } from '../../../core/dates.js';
import { pingDb } from '../../../db/client.js';
import type { Database } from '../../../db/types.js';
import { archiveStatus } from '../archive/godaddy-archive.js';
import { adapterStatus } from '../../registrars/index.js';
import { DB_SIZE_WARN_PERCENT, datasaveStatus, marketDqStatus, NEON_FREE_STORAGE_BYTES, dailyScheduleState, jobsOverdue, lastJobRunAt, tickOverdue } from '../../reporting/index.js';

export function registerHealth(app: FastifyInstance, config: Config, db: Kysely<Database>, now: () => number = Date.now, kickQueue?: () => Promise<void>, storageLimitBytes: number = NEON_FREE_STORAGE_BYTES): void {
  // Liveness only: the one public route; no auth, no DB (so Render's health checks never wake Neon).
  // v3.7.0 (CR-034): also the version and the deployed commit (Render sets RENDER_GIT_COMMIT), so the deploy-live workflow can tell a deploy is live without a token.
  app.get('/health/ping', async () => ({ status: 'ok', version: config.version, commit: process.env.RENDER_GIT_COMMIT ?? null }));

  // Needs any valid bot token (global auth hook).
  app.get('/health', async (_req, reply) => {
    const dbOk = await pingDb(db);
    if (dbOk) await kickQueue?.(); // resumes unfinished job steps when this process has no worker running (cheap check)
    // v5.14.0: the independent reads run together
    const [jobs, jobsLast, datasave, dqMarket, size, archive] = await Promise.all([
      dbOk ? jobsState(db, now()) : Promise.resolve('unknown'),
      dbOk ? jobsLastRun(db) : Promise.resolve({ daily: null, tick: null }),
      dbOk ? datasaveStatus(db, now()).catch(() => null) : Promise.resolve(null),
      dbOk ? marketDqStatus(db).then((d) => d.state).catch(() => 'unknown') : Promise.resolve('unknown'),
      dbOk ? dbSize(db, storageLimitBytes) : Promise.resolve(null),
      archiveStatus(config.archiveDir).then(({ days_n, first, last, missing_days }) => ({ days_n, first, last, missing_days })),
    ]);
    return reply.code(dbOk ? 200 : 503).send({
      status: dbOk ? 'ok' : 'degraded',
      db: dbOk ? 'ok' : 'down',
      jobs,
      // v5.20.0 (BUG-047): when the daily and the tick job last ran (ISO, Asia/Jerusalem offset); null = never
      jobs_last: jobsLast,
      // v5.21.0 (CR-071): the daily data save: ok | overdue | partial | error (does not change the top-level status; Dynadot not_configured never counts)
      datasave: datasave?.state ?? 'unknown',
      // v5.75.0 (CR-090): which step of the latest datasave run is not ok, and why (additive; `datasave` above is unchanged); null when unknown
      datasave_detail: datasave ? {
        last_run: datasave.last_run ? { run_id: datasave.last_run.run_id, finished_at: toJerusalemIso(datasave.last_run.finished_at), steps: datasave.last_run.steps } : null,
        missing_files: datasave.missing_files, dynadot_missing: datasave.dynadot_missing, dynadot_due_date: datasave.dynadot_due_date,
        dynadot_low_coverage: datasave.dynadot_low_coverage, // v5.80.0 (CR-099)
      } : null,
      // v5.23.0 (CR-075 R-3): the market data-quality checks: ok | alert | unknown (before the first run); does not change the top-level status
      dq_market: dqMarket,
      // v5.59.0 (CR-081): the daily archive on the host's disk: days with both files, first and last day, calendar days in between that lack a file
      archive,
      // v5.17.0 (loop 2026-10-18, Gavriel): the database size against Neon's free 1 GB, so it can be reported with a READ token
      db_size: size,
      version: config.version,
      adapters: adapterStatus(config).map(({ name, enabled }) => ({ name, enabled })),
    });
  });
}

/** The database size against the free-plan limit (the same numbers as /report's DB_SIZE_HIGH); null when it can't be read. */
async function dbSize(db: Kysely<Database>, limitBytes: number): Promise<{ bytes: number; limit_bytes: number; percent: number; warn_percent: number; tables: DbTableSize[] } | null> {
  try {
    const bytes = Number((await sql<{ n: string }>`select pg_database_size(current_database())::text as n`.execute(db)).rows[0]!.n);
    return { bytes, limit_bytes: limitBytes, percent: Math.round(bytes * 1000 / limitBytes) / 10, warn_percent: DB_SIZE_WARN_PERCENT, tables: await largestTables(db) };
  } catch {
    return null;
  }
}

interface DbTableSize { table: string; bytes: number; rows_estimate: number | null; heap_bytes: number; index_bytes: number; dead_rows_estimate: number | null }

/** v5.38.0 (loop 2026-10-25, G-119): the 10 largest tables of the public schema (table + indexes + TOAST); rows from the planner estimate (null before the first ANALYZE).
 * v5.77.0 (CR-095): each also shows its heap (table only) and index bytes, and the dead row versions autovacuum has not yet reclaimed. */
async function largestTables(db: Kysely<Database>): Promise<DbTableSize[]> {
  const rs = await sql<{ table: string; bytes: string; rows: string; heap: string; idx: string; dead: string | null }>`select c.relname as table, pg_total_relation_size(c.oid)::text as bytes, c.reltuples::bigint::text as rows,
      pg_relation_size(c.oid)::text as heap, pg_indexes_size(c.oid)::text as idx, s.n_dead_tup::text as dead
    from pg_class c join pg_namespace n on n.oid = c.relnamespace left join pg_stat_user_tables s on s.relid = c.oid
    where n.nspname = 'public' and c.relkind in ('r', 'p') order by pg_total_relation_size(c.oid) desc, c.relname limit 10`.execute(db);
  return rs.rows.map((r) => ({ table: r.table, bytes: Number(r.bytes), rows_estimate: Number(r.rows) >= 0 ? Number(r.rows) : null,
    heap_bytes: Number(r.heap), index_bytes: Number(r.idx), dead_rows_estimate: r.dead === null ? null : Number(r.dead) }));
}

async function jobsState(db: Kysely<Database>, nowMs: number): Promise<'ok' | 'overdue'> {
  const [sched, overdue, tick] = await Promise.all([dailyScheduleState(db, nowMs), jobsOverdue(db, nowMs), tickOverdue(db, nowMs)]);
  return overdue.overdue || tick.overdue || sched.missed || sched.stuck ? 'overdue' : 'ok';
}

async function jobsLastRun(db: Kysely<Database>): Promise<{ daily: string | null; tick: string | null }> {
  const [daily, tick] = await Promise.all([lastJobRunAt(db, 'daily'), lastJobRunAt(db, 'tick')]);
  return { daily: daily ? toJerusalemIso(daily) : null, tick: tick ? toJerusalemIso(tick) : null };
}
