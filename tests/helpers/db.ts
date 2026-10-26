import { sql, type Kysely } from 'kysely';
import { createDb } from '../../src/db/client.js';
import type { Database, DomainInsert } from '../../src/db/types.js';
import { TEST_DATABASE_URL } from './env.js';

export const testDb: Kysely<Database> = createDb(TEST_DATABASE_URL);

const TABLES = [
  'lift_models',
  'kb_loads', 'kb_verdicts', 'kb_evidence', 'kb_source_links', 'kb_claims', 'kb_questions', 'kb_sources', 'kb_authors',
  'bid_plan_events', 'bid_plans', 'prebid_checks', 'disappearances', 'closeout_expiries', 'lookup_usage', 'rdap_cache', 'pickproof_labels', 'pickproof_picks_history', 'pickproof_arms', 'pickproof_pool', 'pickproof_days', 'forward_cost_lines', 'forward_cost_plans', 'market_matched_sets', 'market_dq_runs', 'market_names', 'market_sales', 'snapshot_manifests', 'datasave_pool', 'dynadot_rows', 'godaddy_auctions', 'godaddy_auctions_live', 'auction_shortlist', 'auction_outcomes', 'daily_candidate_lists', 'candidate_screenings', 'candidate_intake',
  'review_retries', 'review_settings_changes', 'review_item_statuses', 'review_items', 'review_feedback', 'review_packets', 'forbidden_term_retirements', 'forbidden_terms', 'company_documents',
  'cohort_outcomes', 'cohort_decisions', 'cohort_names', 'cohorts', 'drop_list_checks', 'drop_list_rows', 'drop_lists', 'job_runs', 'job_steps', 'job_queue_runs', 'portfolio_checks', 'registrar_state_checks', 'venue_listings', 'sibling_scans', 'keyword_demand', 'keyword_demand_uploads', 'visit_forwards', 'visit_daily', 'sales_comps', 'bigco_names', 'tm_kills', 'live_checks', 'domain_rdap', 'engine_models', 'owned_ending_events', 'engine_endings', 'engine_unsold', 'engine_sales', 'engine_uploads', 'listing_sync_log', 'scout_lessons', 'sales_pattern_rows', 'sales_pattern_uploads', 'holdout', 'outreach_emails', 'portfolio_stats', 'api_usage', 'replay_runs', 'test_set_rows', 'test_sets', 'holdout_suites', 'labelled_names', 'registrar_presence', 'rdap_lookups', 'reference_files', 'namebio_keyword_stats', 'namebio_calls', 'manual_quotes', 'tranche_members', 'tranches', 'screening_packs', 'screening_verdicts', 'screening_results', 'screening_runs', 'screening_evidence', 'domain_records', 'sibling_method_approvals', 'selection_lists', 'selection_settings',
  'sales', 'offers', 'price_schedule', 'pricing_evidence', 'pricing_settings', 'export_uploads', 'export_runs', 'idempotency_keys', 'audit_log', 'receipts', 'purchases', 'quotes', 'listing_history',
  'ledger_entries', 'domains', 'deals', 'api_tokens',
];

/** What one table looks like: row count, newest row-version xid and (for tables with a serial id) the sequence position. */
type Fingerprint = Map<string, string>;

// `settings` is not in TABLES (it is emptied and re-inserted, never truncated) but a test can change it, so it is fingerprinted too.
const fingerprintSql = [...TABLES, 'settings'].map((t) => `SELECT '${t}' AS t, count(*)::text || ':' || coalesce(max(xmin::text::bigint), 0)::text AS f FROM ${t}`).join(' UNION ALL ');
// sequence -> owning table, read once per process (the schema does not change while tests run)
const sequenceOwnersSql = `SELECT s.relname AS seq, t.relname AS tbl FROM pg_class s JOIN pg_depend d ON d.objid = s.oid AND d.deptype IN ('a', 'i') JOIN pg_class t ON t.oid = d.refobjid WHERE s.relkind = 'S'`;
let sequenceOwners: Map<string, string> | undefined;

async function fingerprint(db: Kysely<Database>): Promise<Fingerprint> {
  const fp: Fingerprint = new Map();
  for (const r of (await sql.raw<{ t: string; f: string }>(fingerprintSql).execute(db)).rows) fp.set(r.t, r.f);
  if (!sequenceOwners) {
    sequenceOwners = new Map((await sql.raw<{ seq: string; tbl: string }>(sequenceOwnersSql).execute(db)).rows.map((r) => [r.seq, r.tbl]));
  }
  // A test that inserted and deleted rows (or rolled back) leaves the table empty but the sequence advanced; count that as dirty too.
  for (const r of (await sql<{ sequencename: string; last_value: string | null }>`SELECT sequencename, last_value::text FROM pg_sequences WHERE schemaname = 'public'`.execute(db)).rows) {
    const tbl = sequenceOwners.get(r.sequencename);
    if (tbl && fp.has(tbl)) fp.set(tbl, `${fp.get(tbl)}:${r.last_value ?? ''}`);
  }
  return fp;
}

const clean = new WeakMap<Kysely<Database>, Fingerprint>();

function differing(now: Fingerprint, base: Fingerprint): string[] {
  return [...now].filter(([t, f]) => base.get(t) !== f).map(([t]) => t);
}

async function fullReset(db: Kysely<Database>): Promise<void> {
  await db.connection().execute(async (conn) => {
    await sql`SET session_replication_role = replica`.execute(conn);
    await sql.raw(`TRUNCATE ${TABLES.join(', ')} RESTART IDENTITY CASCADE`).execute(conn);
    await sql`SELECT seed_pricing_settings_v2()`.execute(conn);
    await sql`SELECT seed_selection_v1()`.execute(conn);
    await sql`SELECT seed_signature_lists_v2()`.execute(conn);
    await sql`SET session_replication_role = origin`.execute(conn);
    await sql`DELETE FROM settings`.execute(conn);
    await sql`INSERT INTO settings DEFAULT VALUES`.execute(conn);
  });
  clean.set(db, await fingerprint(db));
}

/**
 * Bring the database back to its seeded state. The first reset on a Kysely instance is a full one (truncate everything, re-seed) and
 * fingerprints the clean state; later resets read one fingerprint, truncate only the tables that differ and leave the rest alone (a test
 * touches a handful of the ~90 tables). A change to a seeded table (pricing_settings, selection_*, settings, ...) or any doubt falls back
 * to the full reset. Append-only triggers are bypassed with replication role on ONE connection.
 */
export async function resetDb(db: Kysely<Database>): Promise<void> {
  const base = clean.get(db);
  if (!base) return fullReset(db);
  const dirty = differing(await fingerprint(db), base);
  if (dirty.length === 0) return;
  const seeded = (t: string) => !/^0:0(:|$)/.test(base.get(t) ?? '');
  if (dirty.some(seeded)) return fullReset(db);
  await db.connection().execute(async (conn) => {
    await sql`SET session_replication_role = replica`.execute(conn);
    await sql.raw(`TRUNCATE ${dirty.join(', ')} RESTART IDENTITY CASCADE`).execute(conn);
    await sql`SET session_replication_role = origin`.execute(conn);
  });
  // CASCADE may have emptied a seeded child table; if anything is off, start over.
  if (differing(await fingerprint(db), base).length > 0) await fullReset(db);
}

/** Poll until `check()` holds (10 ms steps, `timeoutMs` at most), then return; throws on timeout. A condition wait instead of a fixed sleep. */
export async function waitFor(check: () => boolean | Promise<boolean>, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(`waitFor: condition not met within ${timeoutMs} ms`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

/** Resolves once some session is blocked on a (transaction) advisory lock in this database, i.e. a waiter is really queued behind the holder. */
export async function waitForLockWaiter(db: Kysely<Database>): Promise<void> {
  await waitFor(async () => {
    const r = await sql<{ n: string }>`select count(*)::text as n from pg_locks where locktype = 'advisory' and not granted and database = (select oid from pg_database where datname = current_database())`.execute(db);
    return Number(r.rows[0]?.n) > 0;
  });
}

/** A finished daily job run one hour before `atMs`, so /report carries no JOB_OVERDUE warning (v2.1.0). */
export async function seedDailyRun(db: Kysely<Database>, atMs: number): Promise<void> {
  await db.insertInto('job_runs').values({
    job: 'daily', trigger: 'scheduled', started_at: new Date(atMs - 3_660_000), finished_at: new Date(atMs - 3_600_000), skipped: false, ok: true, steps: '{}',
  }).execute();
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
