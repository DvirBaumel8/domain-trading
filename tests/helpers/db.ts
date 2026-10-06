import { sql, type Kysely } from 'kysely';
import { createDb } from '../../src/db/client.js';
import type { Database, DomainInsert } from '../../src/db/types.js';
import { TEST_DATABASE_URL } from './env.js';

export const testDb: Kysely<Database> = createDb(TEST_DATABASE_URL);

const TABLES = [
  'registrar_presence', 'manual_quotes', 'screening_results', 'screening_runs', 'screening_evidence', 'selection_lists', 'selection_settings',
  'sales', 'offers', 'price_schedule', 'pricing_evidence', 'pricing_settings', 'export_uploads', 'export_runs', 'idempotency_keys', 'audit_log', 'receipts', 'purchases', 'quotes', 'listing_history',
  'ledger_entries', 'domains', 'deals', 'api_tokens',
];

/** Wipe all data. Append-only triggers are bypassed with replication role on ONE connection. */
export async function resetDb(db: Kysely<Database>): Promise<void> {
  await db.connection().execute(async (conn) => {
    await sql`SET session_replication_role = replica`.execute(conn);
    await sql.raw(`TRUNCATE ${TABLES.join(', ')} RESTART IDENTITY CASCADE`).execute(conn);
    await sql`SELECT seed_pricing_settings_v2()`.execute(conn);
    await sql`SELECT seed_selection_v1()`.execute(conn);
    await sql`SET session_replication_role = origin`.execute(conn);
    await sql`DELETE FROM settings`.execute(conn);
    await sql`INSERT INTO settings DEFAULT VALUES`.execute(conn);
  });
}

export async function insertOwnedDomain(db: Kysely<Database>, overrides: Partial<DomainInsert> = {}): Promise<number> {
  const row: DomainInsert = {
    domain: 'examplecityroofing.com',
    status: 'owned',
    registrar: 'porkbun',
    registrar_api: 'full',
    buy_date: '2026-10-04',
    cost_cents: 1108,
    expiry_date: '2027-10-04',
    renewal_price_cents: 1108,
    drop_date: '2028-10-04',
    category: 'geo',
    price_grade: 'weaker',
    deal_id: null,
    display_name: null,
    listing_mode: null,
    bin_cents: null,
    floor_cents: null,
    min_offer_cents: null,
    lto_max_months: null,
    lander: null,
    lander_ns: null,
    lander_set_at: null,
    ns_verified_at: null,
    sold_at: null,
    ...overrides,
  };
  const r = await db.insertInto('domains').values(row).returning('id').executeTakeFirstOrThrow();
  return r.id;
}
