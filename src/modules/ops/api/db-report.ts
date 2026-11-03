import type { FastifyInstance } from 'fastify';
import { sql, type Kysely } from 'kysely';
import { toJerusalemIso } from '../../../core/dates.js';
import type { Database } from '../../../db/types.js';

// v6.2.0 (CR-100 ask 1): GET /db/report (any READ-capable token). Where the database bytes are: per table heap, indexes, TOAST, free space in the heap
// (when pgstattuple_approx exists), per index bytes and idx_scan, and (for the tables with a date column) rows and bytes by age. Computed in SQL
// (the age buckets are one aggregate query per table, 3 rows come back), kept 60 minutes in process so polls don't wake Neon.
export const DB_REPORT_TTL_MS = 60 * 60_000;

/** The date column of each table that gets age buckets. Identifiers come from this map only, never from a request. */
export const AGE_COLUMNS: Readonly<Record<string, string>> = {
  market_names: 'last_seen',
  dynadot_rows: 'data_date',
  datasave_pool: 'data_date',
  pickproof_pool: 'day',
  screening_results: 'checked_at',
  screening_evidence: 'created_at',
  godaddy_auctions: 'last_seen',
};

type Bucket = 'le_3d' | '3_30d' | 'gt_30d';
const BUCKETS: readonly Bucket[] = ['le_3d', '3_30d', 'gt_30d'];

export interface DbReportTable {
  table: string; total_bytes: number; heap_bytes: number; index_bytes: number; toast_bytes: number; rows_estimate: number | null; heap_free_bytes: number | null;
  indexes: Array<{ index: string; bytes: number; idx_scan: number }>;
  age: null | { column: string; buckets: Array<{ bucket: Bucket; rows: number; bytes: number }> };
}
export interface DbReport {
  generated_at: string; cached: boolean; db_bytes: number; limit_bytes: number; percent: number; stats_reset_at: string | null; tables: DbReportTable[];
}

async function buildReport(db: Kysely<Database>, nowMs: number, limitBytes: number): Promise<DbReport> {
  const bytes = Number((await sql<{ n: string }>`select pg_database_size(current_database())::text as n`.execute(db)).rows[0]!.n);
  const reset = (await sql<{ r: Date | null }>`select stats_reset as r from pg_stat_database where datname = current_database()`.execute(db)).rows[0]?.r ?? null;
  const rs = await sql<{ oid: string; table: string; total: string; heap: string; idx: string; toast: string; rows: string }>`select c.oid::text as oid, c.relname as table, pg_total_relation_size(c.oid)::text as total,
      pg_relation_size(c.oid)::text as heap, pg_indexes_size(c.oid)::text as idx, coalesce(pg_total_relation_size(nullif(c.reltoastrelid, 0)), 0)::text as toast, c.reltuples::bigint::text as rows
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind in ('r', 'p') order by pg_total_relation_size(c.oid) desc, c.relname limit 10`.execute(db);
  let freeOk = true; // pgstattuple_approx exists only where the extension is installed; after the first failure it is not asked again
  const tables: DbReportTable[] = [];
  for (const t of rs.rows) {
    let free: number | null = null;
    if (freeOk) {
      try {
        const n = Number((await sql<{ n: string }>`select approx_free_space::text as n from pgstattuple_approx(${t.oid}::oid::regclass)`.execute(db)).rows[0]?.n);
        free = Number.isFinite(n) ? n : null;
      } catch {
        freeOk = false;
      }
    }
    const ix = await sql<{ index: string; bytes: string; scans: string }>`select ic.relname as index, pg_relation_size(ic.oid)::text as bytes, coalesce(s.idx_scan, 0)::text as scans
      from pg_index i join pg_class ic on ic.oid = i.indexrelid left join pg_stat_user_indexes s on s.indexrelid = i.indexrelid
      where i.indrelid = ${t.oid}::oid order by pg_relation_size(ic.oid) desc, ic.relname`.execute(db);
    const col = AGE_COLUMNS[t.table];
    let age: DbReportTable['age'] = null;
    if (col) {
      const has = await sql`select 1 from information_schema.columns where table_schema = 'public' and table_name = ${t.table} and column_name = ${col}`.execute(db);
      if (has.rows.length > 0) {
        const ref = sql.ref(`t.${col}`);
        const b = await sql<{ b: Bucket; n: string; bytes: string }>`select case when ${ref}::date >= current_date - 3 then 'le_3d' when ${ref}::date >= current_date - 30 then '3_30d' else 'gt_30d' end as b,
            count(*)::text as n, coalesce(sum(pg_column_size(t.*)), 0)::text as bytes from ${sql.table(t.table)} t group by 1`.execute(db);
        const by = new Map(b.rows.map((r) => [r.b, r]));
        age = { column: col, buckets: BUCKETS.map((k) => ({ bucket: k, rows: Number(by.get(k)?.n ?? 0), bytes: Number(by.get(k)?.bytes ?? 0) })) };
      }
    }
    tables.push({
      table: t.table, total_bytes: Number(t.total), heap_bytes: Number(t.heap), index_bytes: Number(t.idx), toast_bytes: Number(t.toast),
      rows_estimate: Number(t.rows) >= 0 ? Number(t.rows) : null, heap_free_bytes: free,
      indexes: ix.rows.map((r) => ({ index: r.index, bytes: Number(r.bytes), idx_scan: Number(r.scans) })), age,
    });
  }
  return { generated_at: toJerusalemIso(new Date(nowMs)), cached: false, db_bytes: bytes, limit_bytes: limitBytes, percent: Math.round(bytes * 1000 / limitBytes) / 10, stats_reset_at: reset ? toJerusalemIso(reset) : null, tables };
}

export function registerDbReport(app: FastifyInstance, db: Kysely<Database>, now: () => number, limitBytes: number): void {
  let cache: { at: number; value: DbReport } | null = null; // per app, 60 minutes; there is no way to force a refresh
  app.get('/db/report', async () => {
    if (cache && now() - cache.at < DB_REPORT_TTL_MS) return { ...cache.value, cached: true };
    const value = await buildReport(db, now(), limitBytes);
    cache = { at: now(), value };
    return value;
  });
}
