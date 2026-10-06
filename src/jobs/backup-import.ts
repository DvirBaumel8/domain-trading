import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { sql, type Kysely } from 'kysely';
import { MIGRATIONS_FILE, migrationNames } from './backup-export.js';
import { newAuditId } from '../http/audit.js';
import type { Database } from '../db/types.js';

export class ImportError extends Error {}

type Row = Record<string, unknown>;

/** Parent tables before children (foreign keys). `file` is relative to the backup directory. */
const ORDER: { table: string; file: string; jsonl?: true }[] = [
  { table: 'settings', file: 'tables/settings.json' },
  { table: 'deals', file: 'tables/deals.json' },
  { table: 'pricing_settings', file: 'tables/pricing_settings.json' },
  { table: 'domains', file: 'tables/domains.json' },
  { table: 'ledger_entries', file: 'tables/ledger_entries.json' },
  { table: 'listing_history', file: 'tables/listing_history.json' },
  { table: 'purchases', file: 'purchases.json' },
  { table: 'receipts', file: 'receipts.json' },
  { table: 'quotes', file: 'tables/quotes.json' },
  { table: 'price_schedule', file: 'tables/price_schedule.json' },
  { table: 'pricing_evidence', file: 'tables/pricing_evidence.json' },
  { table: 'offers', file: 'tables/offers.json' },
  { table: 'sales', file: 'sales.json' },
  { table: 'export_runs', file: 'tables/export_runs.json' },
  { table: 'export_uploads', file: 'tables/export_uploads.json' },
  { table: 'registrar_presence', file: 'tables/registrar_presence.json' },
  { table: 'selection_settings', file: 'tables/selection_settings.json' },
  { table: 'selection_lists', file: 'tables/selection_lists.json' },
  { table: 'screening_evidence', file: 'tables/screening_evidence.json' },
  { table: 'screening_runs', file: 'tables/screening_runs.json' },
  { table: 'screening_results', file: 'tables/screening_results.json' },
  { table: 'manual_quotes', file: 'tables/manual_quotes.json' },
  { table: 'tranches', file: 'tables/tranches.json' },
  { table: 'tranche_members', file: 'tables/tranche_members.json' },
  { table: 'audit_log', file: 'audit.jsonl', jsonl: true },
];

/** A restore targets a fresh database: restore first, THEN create tokens (the admin command writes audit rows). */
const MUST_BE_EMPTY = ['domains', 'ledger_entries', 'deals', 'purchases', 'sales', 'offers', 'audit_log', 'screening_runs', 'screening_evidence', 'manual_quotes', 'tranches'];

/** Tables without a serial `id` column. */
const NO_SERIAL = new Set(['settings', 'deals', 'pricing_settings', 'registrar_presence', 'audit_log', 'screening_runs', 'tranches']);

async function readRows(dir: string, f: { file: string; jsonl?: true }): Promise<Row[]> {
  let text: string;
  try {
    text = await readFile(join(dir, 'backup', f.file), 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') throw new ImportError(`missing backup file backup/${f.file} in ${dir}`);
    throw e;
  }
  const rows = f.jsonl ? text.split('\n').filter(Boolean).map((l) => JSON.parse(l) as Row) : (JSON.parse(text) as Row[]);
  if (!Array.isArray(rows)) throw new ImportError(`backup/${f.file} is not a list of rows`);
  return rows;
}

async function readMigrationNames(dir: string): Promise<string[]> {
  let text: string;
  try {
    text = await readFile(join(dir, MIGRATIONS_FILE), 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new ImportError(`MIGRATION_LEVEL_MISMATCH: ${MIGRATIONS_FILE} is missing in ${dir}; this backup predates the migration-level check. Nothing was written.`);
    }
    throw e;
  }
  const names = JSON.parse(text) as unknown;
  if (!Array.isArray(names) || !names.every((x) => typeof x === 'string')) throw new ImportError(`${MIGRATIONS_FILE} is not a list of migration names`);
  return names;
}

/**
 * Restore a backup directory (a checkout of the data branch, containing backup/) into an EMPTY database, in one transaction.
 * Normal inserts only: the append-only triggers reject UPDATE/DELETE/TRUNCATE, not INSERT, so no trigger bypass is needed.
 * The target must be at the same migration level as the source: backup/migrations.json must equal the target's pgmigrations names, in order (MIGRATION_LEVEL_MISMATCH).
 * Then pricing_settings versions that the migrations seed must also match.
 * Empty means domains, ledger_entries, deals, purchases, sales, offers and audit_log: restore first, then create tokens.
 * Writes one admin audit_log row in the same transaction.
 * Not restored: api_tokens (create new ones with the admin command; audit_log.token_id is set to null) and idempotency_keys.
 */
export async function importBackup(db: Kysely<Database>, dir: string): Promise<Record<string, number>> {
  const data = new Map<string, Row[]>();
  for (const f of ORDER) data.set(f.table, await readRows(dir, f));
  const source = await readMigrationNames(dir); // all reads happen before the transaction: a refusal writes nothing

  return db.transaction().execute(async (trx) => {
    const target = await migrationNames(trx);
    const diffs: string[] = [];
    for (let i = 0; i < Math.max(source.length, target.length) && diffs.length < 3; i++) {
      if (source[i] !== target[i]) diffs.push(`${i + 1}: ${source[i] ?? '(none)'} / ${target[i] ?? '(none)'}`);
    }
    if (diffs.length > 0) {
      throw new ImportError(`MIGRATION_LEVEL_MISMATCH: the backup and this database are at different migration levels; first differences (position: backup / database): ${diffs.join('; ')}. Nothing was written.`);
    }
    for (const t of MUST_BE_EMPTY) {
      const n = await sql<{ n: string }>`select count(*)::text as n from ${sql.table(t)}`.execute(trx);
      if (n.rows[0]!.n !== '0') throw new ImportError(`refusing to import: ${t} is not empty (restore only into an empty database)`);
    }
    const counts: Record<string, number> = {};
    for (const { table } of ORDER) {
      let rows = data.get(table)!;
      if (table === 'audit_log') rows = rows.map((r) => ({ ...r, token_id: null, client_ip: null }));
      counts[table] = rows.length;
      if (rows.length === 0) continue;
      if (table === 'pricing_settings') {
        // A version the migrations already seeded must match the backup's exactly (created_at aside); else the rules differ.
        for (const row of rows) {
          const r = await sql<{ same: boolean }>`select (to_jsonb(p) - 'created_at') = (to_jsonb(r) - 'created_at') as same
            from pricing_settings p, jsonb_populate_record(null::pricing_settings, ${JSON.stringify(row)}::jsonb) r where p.version = r.version`.execute(trx);
          if (r.rows[0] && !r.rows[0].same) throw new ImportError(`refusing to import: pricing_settings version ${String(row.version)} differs from the one this database was migrated with (restore needs the same migration level)`);
        }
      }
      if (table === 'selection_settings') {
        // The migration seeds v1. A version the database already has must carry the same values (activation times aside), else the rules differ.
        for (const row of rows) {
          const r = await sql<{ same: boolean }>`select p.values = r.values as same from selection_settings p,
            jsonb_populate_record(null::selection_settings, ${JSON.stringify(row)}::jsonb) r where p.label = r.label`.execute(trx);
          if (r.rows[0] && !r.rows[0].same) throw new ImportError(`refusing to import: selection_settings version ${String(row.label)} differs from the one this database was migrated with (restore needs the same migration level)`);
        }
      }
      if (table === 'selection_lists') {
        for (const row of rows) {
          const r = await sql<{ same: boolean }>`select p.terms = r.terms as same from selection_lists p,
            jsonb_populate_record(null::selection_lists, ${JSON.stringify(row)}::jsonb) r where p.name = r.name and p.version = r.version`.execute(trx);
          if (r.rows[0] && !r.rows[0].same) throw new ImportError(`refusing to import: selection_lists ${String(row.name)} v${String(row.version)} differs from the one this database was migrated with`);
        }
      }
      if (table === 'settings') await sql`delete from settings`.execute(trx); // the migrated default row; the backup's caps replace it
      // OVERRIDING SYSTEM VALUE keeps the original ids (the id columns are GENERATED ALWAYS); the sequences are reset below.
      // jsonb_populate_recordset maps JSON text/numbers/arrays to each column's own type, so timestamps keep full precision.
      // pricing_settings: the migrations already seeded the versions they ship; keep those and add the rest.
      const conflict = table === 'pricing_settings' ? sql`on conflict (version) do nothing` : table === 'selection_settings' || table === 'selection_lists' ? sql`on conflict do nothing` : sql``;
      await sql`insert into ${sql.table(table)} overriding system value select * from jsonb_populate_recordset(null::${sql.table(table)}, ${JSON.stringify(rows)}::jsonb) ${conflict}`.execute(trx);
      if (NO_SERIAL.has(table)) continue;
      const seq = await sql<{ s: string | null }>`select pg_get_serial_sequence(${table}, 'id') as s`.execute(trx);
      if (seq.rows[0]?.s) await sql`select setval(${seq.rows[0].s}, (select coalesce(max(id), 1) from ${sql.table(table)}), (select count(*) > 0 from ${sql.table(table)}))`.execute(trx);
    }
    await trx.insertInto('audit_log').values({
      id: newAuditId(), scope: 'admin', method: 'ADMIN', path: 'import-backup',
      request: JSON.stringify({ source_dir: dir, counts }), status_code: 200, result_summary: `imported backup into an empty database`,
    }).execute();
    return counts;
  });
}
