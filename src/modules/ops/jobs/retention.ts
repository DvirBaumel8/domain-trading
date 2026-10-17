// Daily step `retention` (v5.1.0, G-95, Dvir 14 Oct 2026): "smart retention, a cron job that deletes big old data".
// Prunes only data nobody can need again: old screening results of names we never bought and never packed, the evidence nothing points to,
// finished screening runs left empty, old sibling scans / registrar checks / quotes, and old job logs. Ages are DOM-owned constants below;
// when the database is at or over DB_SIZE_WARN_PERCENT of the free-plan limit every age is halved ("tight" mode).
// It deletes in batches of 5,000 rows, one short transaction each, and stops after a time budget (the next night continues).
// v5.14.0 (R3 D3) adds: drop-list checks / rows / lists past their read window, daily candidate lists, NameBio call counters, superseded listing-sync log rows.
// It never touches audit_log, ledger_entries, sales, offers, listing_history, pricing_*, manual_quotes, screening_verdicts, screening_packs,
// domains, purchases, labelled_names, holdout_suites, replay_runs, export_uploads, test-set / cohort tables, selection_* or api_usage (one row per month).
// The append-only triggers of the pruned append-only tables (migrations 1763500000000 and 1764700000000) allow a DELETE only when the transaction ran
// `SET LOCAL app.retention = 'on'`; this file is the only place that sets it. It never calls a registrar, marketplace or outside service.
import { sql, type Kysely, type RawBuilder } from 'kysely';
import { trySessionLock } from '../../../core/locks.js';
import type { Database } from '../../../db/types.js';
import { pruneDataTables } from '../../engine/index.js';
import { DB_SIZE_WARN_PERCENT, NEON_FREE_STORAGE_BYTES } from '../../reporting/index.js';

export const RETENTION_BATCH_ROWS = 5_000;
export const RETENTION_TIME_BUDGET_MS = 60_000;
const DAY = 86_400_000;

export type RetentionMode = 'normal' | 'tight';

/** Everything the job may prune: keys of the summary, in run order. `days` = [normal, tight]. */
export const RETENTION_RULES = [
  { key: 'screening_results', days: [180, 90], idStart: '0' },
  { key: 'screening_evidence', days: [180, 90], idStart: '0' },
  { key: 'candidate_screenings', days: [180, 90], idStart: '0' },
  { key: 'screening_runs', days: [180, 90], idStart: '' },
  { key: 'sibling_scans', days: [90, 45], idStart: '0' },
  { key: 'registrar_state_checks', days: [90, 45], idStart: '0' },
  { key: 'quotes', days: [180, 90], idStart: '0' },
  { key: 'job_steps', days: [60, 30], idStart: '0' },
  { key: 'job_queue_runs', days: [60, 30], idStart: '' },
  { key: 'job_runs', days: [60, 30], idStart: '0' },
  // v5.14.0 (D3). Drop lists: reads ignore a list 60 days after its list_date (DROP_LIST_RETENTION_DAYS), so rows of a list past 90 / 60 days are dead; checks, then rows, then the list.
  { key: 'drop_list_checks', days: [90, 60], idStart: '0' },
  { key: 'drop_list_rows', days: [90, 60], idStart: '0' },
  { key: 'drop_lists', days: [90, 60], idStart: '', pk: 'name' },
  { key: 'daily_candidate_lists', days: [90, 45], idStart: '0' },
  { key: 'namebio_calls', days: [30, 30], idStart: '0' },
  { key: 'listing_sync_log', days: [180, 90], idStart: '0' },
] as const;
export type RetentionKey = (typeof RETENTION_RULES)[number]['key'];
type Rule = { key: RetentionKey; days: readonly [number, number]; idStart: string; pk?: string };

export interface RetentionSummary {
  mode: RetentionMode;
  dry_run: boolean;
  db_bytes_before: number;
  db_bytes_after: number;
  tables: Record<string, { deleted: number; mode: RetentionMode; days: number }>;
  /** True when the time budget ran out before every table was done; the next run continues. */
  partial: boolean;
}

/** A run nobody needs: old, finished, not a backtest, no results left, and no pack / test set / cohort / holdout / tranche / record / verdict points to it. */
const emptyOldRun = (cut: Date): RawBuilder<unknown> => sql`
  select r.id from screening_runs r
  where r.created_at < ${cut} and r.status <> 'running' and not r.backtest
    and not exists (select 1 from screening_results x where x.run_id = r.id)
    and not exists (select 1 from screening_packs x where x.run_id = r.id)
    and not exists (select 1 from test_sets x where x.run_id = r.id)
    and not exists (select 1 from cohorts x where x.run_id = r.id)
    and not exists (select 1 from holdout x where x.run_id = r.id)
    and not exists (select 1 from tranche_members x where x.run_id = r.id)
    and not exists (select 1 from domain_records x where x.source_run_id = r.id)
    and not exists (select 1 from screening_verdicts x where x.run_id = r.id)`;

/** The next `limit` deletable ids after `cursor` for a rule, oldest id first. */
function candidates(key: RetentionKey, cut: Date, cursor: string, limit: number): RawBuilder<unknown> {
  switch (key) {
    case 'screening_results':
      return sql`select t.id from screening_results t
        where t.id > ${cursor} and t.checked_at < ${cut}
          and not exists (select 1 from domains d where d.domain = t.domain)
          and not exists (select 1 from screening_packs p where p.domain = t.domain or p.run_id = t.run_id)
          and not exists (select 1 from screening_runs r where r.id = t.run_id and r.backtest)
          and not exists (select 1 from cohorts x where x.run_id = t.run_id)
          and not exists (select 1 from test_sets x where x.run_id = t.run_id)
          and not exists (select 1 from holdout x where x.run_id = t.run_id or x.domain = t.domain)
          and not exists (select 1 from tranche_members x where x.run_id = t.run_id)
          and not exists (select 1 from domain_records x where x.source_run_id = t.run_id)
          and not exists (select 1 from test_set_rows x where x.domain = t.domain)
          and not exists (select 1 from cohort_names x where x.domain = t.domain)
          and not exists (select 1 from labelled_names x where x.domain = t.domain)
          and not exists (select 1 from screening_verdicts v where v.result_id = t.id)
          and not exists (select 1 from screening_results x where x.cached_from = t.id)
          and exists (select 1 from screening_results n where n.domain = t.domain and n.check_id = t.check_id
                        and (n.checked_at > t.checked_at or (n.checked_at = t.checked_at and n.id > t.id)))
        order by t.id limit ${limit}`;
    case 'screening_evidence':
      return sql`select t.id from screening_evidence t
        where t.id > ${cursor} and t.created_at < ${cut}
          and not exists (select 1 from retention_evidence_refs r where r.id = t.id)
        order by t.id limit ${limit}`;
    case 'drop_list_checks':
      return sql`select t.id from drop_list_checks t where t.id > ${cursor} and exists (select 1 from drop_lists l where l.name = t.list_name and l.list_date < ${cut}::date) order by t.id limit ${limit}`;
    case 'drop_list_rows':
      return sql`select t.id from drop_list_rows t where t.id > ${cursor} and exists (select 1 from drop_lists l where l.name = t.list_name and l.list_date < ${cut}::date) order by t.id limit ${limit}`;
    case 'drop_lists':
      return sql`select t.name as id from drop_lists t where t.name > ${cursor} and t.list_date < ${cut}::date
        and not exists (select 1 from drop_list_rows r where r.list_name = t.name) and not exists (select 1 from drop_list_checks c where c.list_name = t.name)
        order by t.name limit ${limit}`;
    case 'daily_candidate_lists': // never the newest list
      return sql`select t.id from daily_candidate_lists t where t.id > ${cursor} and t.built_at < ${cut} and exists (select 1 from daily_candidate_lists n where n.id > t.id) order by t.id limit ${limit}`;
    case 'namebio_calls': // the rate limits look back 24 h
      return sql`select t.id from namebio_calls t where t.id > ${cursor} and t.called_at < ${cut} order by t.id limit ${limit}`;
    case 'listing_sync_log': // the newest row per (domain, venue, action) stays: the lifecycle report reads the latest sold_seen
      return sql`select t.id from listing_sync_log t
        where t.id > ${cursor} and t.at < ${cut} and exists (select 1 from listing_sync_log n where n.domain = t.domain and n.venue = t.venue and n.action = t.action and n.id > t.id)
        order by t.id limit ${limit}`;
    case 'candidate_screenings':
      return sql`select t.id from candidate_screenings t
        where t.id > ${cursor} and t.run_id in (${emptyOldRun(cut)}) order by t.id limit ${limit}`;
    case 'screening_runs':
      return sql`select t.id from (${emptyOldRun(cut)}) t
        where t.id > ${cursor} and not exists (select 1 from candidate_screenings c where c.run_id = t.id) order by t.id limit ${limit}`;
    case 'sibling_scans':
      return sql`select t.id from sibling_scans t
        where t.id > ${cursor} and t.fetched_at < ${cut} and exists (select 1 from sibling_scans n where n.domain = t.domain and n.id > t.id)
        order by t.id limit ${limit}`;
    case 'registrar_state_checks':
      return sql`select t.id from registrar_state_checks t
        where t.id > ${cursor} and t.checked_at < ${cut} and exists (select 1 from registrar_state_checks n where n.domain = t.domain and n.id > t.id)
        order by t.id limit ${limit}`;
    case 'quotes': // never a quote a purchase names, never the newest check of a name (GET /portfolio/:domain shows it)
      return sql`select t.id from quotes t
        where t.id > ${cursor} and t.quoted_at < ${cut}
          and not exists (select 1 from purchases p where p.check_id = t.check_id)
          and exists (select 1 from quotes n where n.domain = t.domain and n.check_id <> t.check_id and (n.quoted_at > t.quoted_at or (n.quoted_at = t.quoted_at and n.id > t.id)))
        order by t.id limit ${limit}`;
    case 'job_steps':
      return sql`select t.id from job_steps t where t.id > ${cursor} and t.created_at < ${cut} and not exists (select 1 from job_steps u where u.run_id = t.run_id and u.status in ('queued', 'running')) order by t.id limit ${limit}`;
    case 'job_queue_runs':
      return sql`select t.id from job_queue_runs t
        where t.id > ${cursor} and t.created_at < ${cut} and not exists (select 1 from job_steps s where s.run_id = t.id) order by t.id limit ${limit}`;
    case 'job_runs':
      return sql`select t.id from job_runs t where t.id > ${cursor} and t.finished_at < ${cut} order by t.id limit ${limit}`;
  }
}

export interface RetentionDeps {
  db: Kysely<Database>;
  now: () => number;
  log?: { warn(obj: object, msg: string): void };
  /** Tests inject the free-plan limit; default 1 GB (NEON_FREE_STORAGE_BYTES). */
  storageLimitBytes?: number;
  /** Tests inject the database size in bytes; default pg_database_size. */
  dbBytes?: () => Promise<number>;
  batchRows?: number;
  timeBudgetMs?: number;
}

export class RetentionJob {
  constructor(private readonly deps: RetentionDeps) {}

  private async size(): Promise<number> {
    if (this.deps.dbBytes) return this.deps.dbBytes();
    return Number((await sql<{ n: string }>`select pg_database_size(current_database())::text as n`.execute(this.deps.db)).rows[0]!.n);
  }

  /** Temp table of every evidence id something still points to (results, rdap lookups, sibling scans); dropped when the rule ends. */
  private async withEvidenceRefs<T>(conn: Kysely<Database>, fn: () => Promise<T>): Promise<T> {
    await sql`drop table if exists retention_evidence_refs`.execute(conn);
    await sql`create temp table retention_evidence_refs (id bigint primary key)`.execute(conn);
    try {
      await sql`insert into retention_evidence_refs select distinct unnest(evidence_ids) from screening_results where evidence_ids is not null on conflict do nothing`.execute(conn);
      await sql`insert into retention_evidence_refs select evidence_id from rdap_lookups where evidence_id is not null on conflict do nothing`.execute(conn);
      await sql`insert into retention_evidence_refs select e::bigint from sibling_scans s, jsonb_array_elements_text(s.evidence_ids) e where e ~ '^[0-9]+$' on conflict do nothing`.execute(conn);
      return await fn();
    } finally {
      await sql`drop table if exists retention_evidence_refs`.execute(conn);
    }
  }

  /** One rule: dry run counts, a real run deletes batch by batch. Returns false when the time budget ran out. */
  private async runRule(db: Kysely<Database>, rule: Rule, cut: Date, dryRun: boolean, batch: number, deadline: number, tables: RetentionSummary['tables']): Promise<boolean> {
    const { now } = this.deps;
    const pk = rule.pk ?? 'id';
    if (dryRun) {
      // Counts what this table would lose now; evidence and runs freed only by this run's own deletions are counted the next night.
      const r = await sql<{ n: string }>`select count(*)::text as n from (${candidates(rule.key, cut, rule.idStart, 2_147_483_647)}) c`.execute(db);
      tables[rule.key]!.deleted = Number(r.rows[0]!.n);
      return true;
    }
    let deleted = 0;
    let cursor: string = rule.idStart;
    for (;;) {
      if (now() >= deadline) return false;
      const ids = await db.transaction().execute(async (trx) => {
        await sql`select set_config('app.retention', 'on', true)`.execute(trx);
        const got = await sql<{ id: string }>`delete from ${sql.table(rule.key)} where ${sql.ref(pk)} in (${candidates(rule.key, cut, cursor, batch)}) returning ${sql.ref(pk)} as id`.execute(trx);
        return got.rows.map((x) => String(x.id));
      });
      if (ids.length === 0) return true;
      deleted += ids.length;
      tables[rule.key]!.deleted = deleted;
      cursor = rule.idStart === '' ? ids.reduce((a, b) => (a > b ? a : b)) : String(ids.reduce((a, b) => (BigInt(a) > BigInt(b) ? a : b)));
    }
  }

  async runOnce(opts: { dryRun?: boolean } = {}): Promise<RetentionSummary | { skipped: true; reason: string }> {
    const { db, now } = this.deps;
    const lock = await trySessionLock(db, 'job:retention');
    if (!lock) return { skipped: true, reason: 'already running' };
    try {
      const dryRun = opts.dryRun === true;
      const batch = this.deps.batchRows ?? RETENTION_BATCH_ROWS;
      const deadline = now() + (this.deps.timeBudgetMs ?? RETENTION_TIME_BUDGET_MS);
      const before = await this.size();
      const limit = this.deps.storageLimitBytes ?? NEON_FREE_STORAGE_BYTES;
      const mode: RetentionMode = before >= (limit * DB_SIZE_WARN_PERCENT) / 100 ? 'tight' : 'normal';
      const tables: RetentionSummary['tables'] = {};
      let partial = false;
      for (const rule of RETENTION_RULES as readonly Rule[]) {
        const days = rule.days[mode === 'tight' ? 1 : 0];
        const cut = new Date(now() - days * DAY);
        tables[rule.key] = { deleted: 0, mode, days };
        if (now() >= deadline) { partial = true; continue; }
        const done = rule.key === 'screening_evidence'
          // the referenced-evidence set is built once per run, in a temp table on one connection, not once per 5,000-row batch (v5.14.0, D3)
          ? await db.connection().execute((conn) => this.withEvidenceRefs(conn, () => this.runRule(conn, rule, cut, dryRun, batch, deadline, tables)))
          : await this.runRule(db, rule, cut, dryRun, batch, deadline, tables);
        if (!done) partial = true;
      }
      // v5.12.0 (CR-063): loaded data tables (live checks 3 / cc 14 days, RDAP rows of names that left the pool); fixed TTLs, the same in tight mode.
      const data = await pruneDataTables(db, now(), dryRun);
      tables.live_checks = { deleted: data.live_checks.deleted, mode, days: data.live_checks.days };
      tables.domain_rdap = { deleted: data.domain_rdap.deleted, mode, days: 0 };
      return { mode, dry_run: dryRun, db_bytes_before: before, db_bytes_after: dryRun ? before : await this.size(), tables, partial };
    } finally {
      await lock.release();
    }
  }
}
