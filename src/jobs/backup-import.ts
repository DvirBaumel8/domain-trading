import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { sql, type Kysely } from 'kysely';
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
  { table: 'offer_imports', file: 'tables/offer_imports.json' },
  { table: 'offers', file: 'tables/offers.json' },
  { table: 'sales', file: 'sales.json' },
  { table: 'payouts', file: 'payouts.json' },
  { table: 'export_runs', file: 'tables/export_runs.json' },
  { table: 'export_run_domains', file: 'tables/export_run_domains.json' },
  { table: 'export_uploads', file: 'tables/export_uploads.json' },
  { table: 'registrar_presence', file: 'tables/registrar_presence.json' },
  { table: 'audit_log', file: 'audit.jsonl', jsonl: true },
];

/** Tables without a serial `id` column. */
const NO_SERIAL = new Set(['settings', 'deals', 'pricing_settings', 'export_run_domains', 'registrar_presence', 'audit_log']);

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

/**
 * Restore a backup directory (a checkout of the data branch, containing backup/) into an EMPTY database, in one transaction.
 * Normal inserts only: the append-only triggers reject UPDATE/DELETE/TRUNCATE, not INSERT, so no trigger bypass is needed.
 * Not restored: api_tokens (create new ones with the admin command; audit_log.token_id is set to null) and idempotency_keys.
 */
export async function importBackup(db: Kysely<Database>, dir: string): Promise<Record<string, number>> {
  const data = new Map<string, Row[]>();
  for (const f of ORDER) data.set(f.table, await readRows(dir, f));

  return db.transaction().execute(async (trx) => {
    for (const t of ['domains', 'ledger_entries']) {
      const n = await sql<{ n: string }>`select count(*)::text as n from ${sql.table(t)}`.execute(trx);
      if (n.rows[0]!.n !== '0') throw new ImportError(`refusing to import: ${t} is not empty (restore only into an empty database)`);
    }
    const counts: Record<string, number> = {};
    for (const { table } of ORDER) {
      let rows = data.get(table)!;
      if (table === 'audit_log') rows = rows.map((r) => ({ ...r, token_id: null, client_ip: null }));
      counts[table] = rows.length;
      if (rows.length === 0) continue;
      if (table === 'settings') await sql`delete from settings`.execute(trx); // the migrated default row; the backup's caps replace it
      // OVERRIDING SYSTEM VALUE keeps the original ids (the id columns are GENERATED ALWAYS); the sequences are reset below.
      // jsonb_populate_recordset maps JSON text/numbers/arrays to each column's own type, so timestamps keep full precision.
      // pricing_settings: the migrations already seeded the versions they ship; keep those and add the rest.
      const conflict = table === 'pricing_settings' ? sql`on conflict (version) do nothing` : sql``;
      await sql`insert into ${sql.table(table)} overriding system value select * from jsonb_populate_recordset(null::${sql.table(table)}, ${JSON.stringify(rows)}::jsonb) ${conflict}`.execute(trx);
      if (NO_SERIAL.has(table)) continue;
      const seq = await sql<{ s: string | null }>`select pg_get_serial_sequence(${table}, 'id') as s`.execute(trx);
      if (seq.rows[0]?.s) await sql`select setval(${seq.rows[0].s}, (select coalesce(max(id), 1) from ${sql.table(table)}), (select count(*) > 0 from ${sql.table(table)}))`.execute(trx);
    }
    return counts;
  });
}
