// Daily step `dbMaintenance` (v6.2.0, CR-100 ask 3 and the ask 4 trigger): a concurrent index rebuild, one index at a time, on the four big daily-churn tables
// when a table's indexes weigh more than 0.8 x its heap. No VACUUM FULL, no CLUSTER, no table rewrite (CR-095 headroom rule): REINDEX INDEX CONCURRENTLY builds
// the new index beside the old one, so it needs free space of about the index's size; an index is skipped (HEADROOM) when the free space under the plan limit is
// below twice that. A time budget stops new rebuilds (the next night continues). It never deletes rows and never touches a registrar or marketplace.
// REINDEX CONCURRENTLY can't run inside a transaction: every statement here goes to the pool as a plain statement.
import { sql, type Kysely } from 'kysely';
import type { Database } from '../../../db/types.js';
import { NEON_FREE_STORAGE_BYTES } from '../../reporting/index.js';

/** The tables the step looks at, in order. A table that does not exist is left out of the summary. */
export const DB_MAINTENANCE_TABLES = ['market_episodes', 'market_episode_seen', 'dynadot_rows', 'datasave_pool', 'pickproof_pool'] as const;
const RATIO_DUE = 0.8;
const BUDGET_MS = 10 * 60_000;
/** A table whose indexes are under 1 MiB is never worth a rebuild (an empty table's btree meta pages would otherwise count as "over 0.8 x heap"). */
const MIN_INDEX_BYTES = 1024 * 1024;

export interface DbMaintenanceDeps {
  db: Kysely<Database>;
  now: () => number;
  log?: { warn(obj: object, msg: string): void };
  /** Tests inject the plan limit; default 1 GB (NEON_FREE_STORAGE_BYTES). */
  storageLimitBytes?: number;
  /** Tests inject the time budget in milliseconds; default 10 minutes. */
  budgetMs?: number;
  /** Tests inject the smallest index total worth a rebuild; default 1 MiB. */
  minIndexBytes?: number;
  /** Tests inject the tables; default DB_MAINTENANCE_TABLES. */
  tables?: readonly string[];
}

export interface DbMaintenanceTable {
  table: string;
  heap_bytes: number;
  index_bytes_before: number;
  index_bytes_after: number;
  ratio_before: number | null;
  ratio_after: number | null;
  reindexed: Array<{ index: string; bytes_before: number; bytes_after: number; ms: number }>;
  skipped: Array<{ index: string; reason: string }>;
}

export interface DbMaintenanceSummary {
  status: 'ok' | 'nothing_due' | 'stopped';
  tables: DbMaintenanceTable[];
  db_bytes_before: number;
  db_bytes_after: number;
  budget_ms: number;
}

const ratio = (idx: number, heap: number): number | null => (heap > 0 ? Math.round((idx / heap) * 1000) / 1000 : null);

export class DbMaintenanceJob {
  constructor(private readonly deps: DbMaintenanceDeps) {}

  private async dbBytes(): Promise<number> {
    return Number((await sql<{ n: string }>`select pg_database_size(current_database())::text as n`.execute(this.deps.db)).rows[0]!.n);
  }

  private async sizes(table: string): Promise<{ heap: number; idx: number } | null> {
    const r = await sql<{ heap: string; idx: string }>`select pg_relation_size(c.oid)::text as heap, pg_indexes_size(c.oid)::text as idx
      from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relname = ${table} and c.relkind in ('r', 'p')`.execute(this.deps.db);
    const row = r.rows[0];
    return row ? { heap: Number(row.heap), idx: Number(row.idx) } : null;
  }

  /** Valid indexes of the table, largest first. */
  private async indexes(table: string): Promise<Array<{ name: string; bytes: number }>> {
    const r = await sql<{ name: string; bytes: string }>`select ic.relname as name, pg_relation_size(ic.oid)::text as bytes
      from pg_index i join pg_class ic on ic.oid = i.indexrelid join pg_class t on t.oid = i.indrelid join pg_namespace n on n.oid = t.relnamespace
      where n.nspname = 'public' and t.relname = ${table} and i.indisvalid order by pg_relation_size(ic.oid) desc, ic.relname`.execute(this.deps.db);
    return r.rows.map((x) => ({ name: x.name, bytes: Number(x.bytes) }));
  }

  /** A crashed REINDEX CONCURRENTLY leaves an invalid `<idx>_ccnew*` index behind; it only takes space, so it goes before the next rebuild. */
  private async dropLeftovers(table: string): Promise<void> {
    const r = await sql<{ name: string }>`select ic.relname as name from pg_index i join pg_class ic on ic.oid = i.indexrelid join pg_class t on t.oid = i.indrelid join pg_namespace n on n.oid = t.relnamespace
      where n.nspname = 'public' and t.relname = ${table} and not i.indisvalid and ic.relname like '%\\_ccnew%'`.execute(this.deps.db);
    for (const x of r.rows) await sql`drop index concurrently if exists ${sql.id('public', x.name)}`.execute(this.deps.db);
  }

  async runOnce(): Promise<DbMaintenanceSummary> {
    const d = this.deps;
    const budget = d.budgetMs ?? BUDGET_MS;
    const limit = d.storageLimitBytes ?? NEON_FREE_STORAGE_BYTES;
    const minIdx = d.minIndexBytes ?? MIN_INDEX_BYTES;
    const t0 = d.now();
    const dbBefore = await this.dbBytes();
    const out: DbMaintenanceTable[] = [];
    let anyDue = false;
    let stopped = false;
    for (const table of d.tables ?? DB_MAINTENANCE_TABLES) {
      const s = await this.sizes(table);
      if (!s) continue;
      const entry: DbMaintenanceTable = { table, heap_bytes: s.heap, index_bytes_before: s.idx, index_bytes_after: s.idx, ratio_before: ratio(s.idx, s.heap), ratio_after: ratio(s.idx, s.heap), reindexed: [], skipped: [] };
      out.push(entry);
      if (!(s.idx > RATIO_DUE * s.heap && s.idx >= minIdx)) continue;
      anyDue = true;
      try {
        await this.dropLeftovers(table);
      } catch (e) {
        d.log?.warn({ table, err: e instanceof Error ? e.message : String(e) }, 'dbMaintenance: leftover index drop failed');
      }
      for (const ix of await this.indexes(table)) {
        if (d.now() - t0 >= budget) {
          stopped = true;
          entry.skipped.push({ index: ix.name, reason: 'BUDGET' });
          continue;
        }
        // the new index is built beside the old one: free space under the plan limit must be at least twice the index
        if (limit - (await this.dbBytes()) < 2 * ix.bytes) {
          entry.skipped.push({ index: ix.name, reason: 'HEADROOM' });
          continue;
        }
        const started = d.now();
        try {
          await sql`reindex index concurrently ${sql.id('public', ix.name)}`.execute(d.db);
          const after = await sql<{ bytes: string }>`select pg_relation_size(${`public.${ix.name}`}::regclass)::text as bytes`.execute(d.db);
          entry.reindexed.push({ index: ix.name, bytes_before: ix.bytes, bytes_after: Number(after.rows[0]!.bytes), ms: Math.max(0, d.now() - started) });
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          d.log?.warn({ table, index: ix.name, err: msg }, 'dbMaintenance: reindex failed');
          entry.skipped.push({ index: ix.name, reason: `ERROR: ${msg.slice(0, 160)}` });
        }
      }
      const after = await this.sizes(table);
      if (after) { entry.index_bytes_after = after.idx; entry.ratio_after = ratio(after.idx, after.heap); }
    }
    return { status: stopped ? 'stopped' : anyDue ? 'ok' : 'nothing_due', tables: out, db_bytes_before: dbBefore, db_bytes_after: await this.dbBytes(), budget_ms: budget };
  }
}
