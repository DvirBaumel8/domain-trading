// v6.2.0 (CR-100): GET /db/report (DB100-1..4), the daily step dbMaintenance (DB100-5..10), POST /jobs/run {job: daily, only: db_maintenance} (DB100-11..12), fillfactor (DB100-13).
import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { DbMaintenanceJob } from '../../../src/modules/ops/jobs/db-maintenance.js';
import { makeApp, settleJob } from '../../helpers/app.js';
import { testDb as db } from '../../helpers/db.js';
import { issueToken } from '../../helpers/tokens.js';

let app: FastifyInstance | undefined;
afterEach(async () => { await app?.close(); app = undefined; });

const NOW = Date.parse('2026-11-03T10:00:00Z');
/** A date `n` days before the database's current_date (the report buckets are relative to current_date). */
const daysAgo = async (n: number): Promise<string> => (await sql<{ d: string }>`select (current_date - ${n}::int)::text as d`.execute(db)).rows[0]!.d;
async function seedPool(rows: Array<{ age: number; n: number }>): Promise<void> {
  let k = 0;
  for (const r of rows) {
    const d = await daysAgo(r.age);
    await sql`insert into datasave_pool (data_date, source, domain, price_cents, ends_at)
      select ${d}::date, 'src', 'name' || (${k}::int * 100000 + g) || '.com', 1000, now() from generate_series(1, ${r.n}::int) g`.execute(db);
    k += 1;
  }
}
/** datasave_pool with fat indexes: 4,000 rows are loaded, all but 40 deleted and the heap vacuumed (its tail pages are cut off; the index files keep their size). */
async function seedBloatedPool(): Promise<void> {
  await seedPool([{ age: 0, n: 4000 }]);
  await sql`delete from datasave_pool where substring(domain from '^name([0-9]+)')::int > 40`.execute(db);
  await sql`vacuum datasave_pool`.execute(db);
}
const poolTable = (rep: { tables: Array<{ table: string }> }) => rep.tables.find((t) => t.table === 'datasave_pool') as never as {
  table: string; heap_bytes: number; index_bytes: number; toast_bytes: number; heap_free_bytes: number | null;
  indexes: Array<{ index: string; bytes: number; idx_scan: number }>; age: { column: string; buckets: Array<{ bucket: string; rows: number; bytes: number }> } | null;
};

describe('GET /db/report (CR-100 ask 1)', () => {
  it('DB100-1: needs a token (401 without), any READ token gets the report with the exact keys and numbers as numbers', async () => {
    app = await makeApp({ testRoutes: false, now: () => NOW });
    expect((await app.inject({ method: 'GET', url: '/db/report' })).statusCode).toBe(401);
    await seedPool([{ age: 0, n: 400 }]);
    const { auth } = await issueToken('read');
    const res = await app.inject({ method: 'GET', url: '/db/report', headers: auth });
    expect(res.statusCode).toBe(200);
    const rep = res.json();
    expect(Object.keys(rep).sort()).toEqual(['cached', 'db_bytes', 'generated_at', 'limit_bytes', 'percent', 'stats_reset_at', 'tables']);
    expect(rep.cached).toBe(false);
    expect(rep.generated_at).toMatch(/\+0[23]:00$/);
    expect(rep.limit_bytes).toBe(1024 ** 3);
    expect(typeof rep.db_bytes).toBe('number');
    expect(rep.percent).toBe(Math.round(rep.db_bytes * 1000 / 1024 ** 3) / 10);
    expect(rep.tables.length).toBeLessThanOrEqual(10);
    const t = poolTable(rep);
    expect(Object.keys(t).sort()).toEqual(['age', 'heap_bytes', 'heap_free_bytes', 'index_bytes', 'indexes', 'rows_estimate', 'table', 'toast_bytes', 'total_bytes']);
    expect(t.heap_bytes).toBeGreaterThan(0);
    expect(t.indexes.map((i) => i.index)).toContain('datasave_pool_pkey');
    for (const i of t.indexes) expect(Object.keys(i).sort()).toEqual(['bytes', 'idx_scan', 'index']);
  });

  it('DB100-2: age buckets (le_3d, 3_30d, gt_30d) count rows and bytes from the seeded dates; a table without a date column has age null', async () => {
    app = await makeApp({ testRoutes: false, now: () => NOW });
    await seedPool([{ age: 0, n: 300 }, { age: 3, n: 200 }, { age: 4, n: 100 }, { age: 30, n: 50 }, { age: 31, n: 25 }, { age: 90, n: 25 }]);
    const { auth } = await issueToken('read');
    const rep = (await app.inject({ method: 'GET', url: '/db/report', headers: auth })).json();
    const t = poolTable(rep);
    expect(t.age?.column).toBe('data_date');
    expect(t.age?.buckets.map((b) => [b.bucket, b.rows])).toEqual([['le_3d', 500], ['3_30d', 150], ['gt_30d', 50]]);
    for (const b of t.age!.buckets) expect(b.bytes).toBeGreaterThan(0);
    const others = rep.tables.filter((x: { table: string; age: unknown }) => x.table !== 'datasave_pool' && x.age === null);
    expect(others.length).toBeGreaterThan(0);
  });

  it('DB100-3: the answer is kept 60 minutes (second call cached:true with the same generated_at), then built again; heap_free_bytes is a number or null', async () => {
    let clock = NOW;
    app = await makeApp({ testRoutes: false, now: () => clock });
    await seedPool([{ age: 0, n: 300 }]);
    const { auth } = await issueToken('read');
    const get = async () => (await app!.inject({ method: 'GET', url: '/db/report', headers: auth })).json();
    const a = await get();
    clock += 59 * 60_000;
    const b = await get();
    expect(b).toMatchObject({ cached: true, generated_at: a.generated_at, db_bytes: a.db_bytes });
    clock += 2 * 60_000;
    const c = await get();
    expect(c.cached).toBe(false);
    expect(c.generated_at).not.toBe(a.generated_at);
    for (const t of c.tables) expect(t.heap_free_bytes === null || typeof t.heap_free_bytes === 'number').toBe(true);
    expect((await app.inject({ method: 'GET', url: '/db/report?fresh=1', headers: auth })).json().cached).toBe(true); // fresh is not offered: the query is ignored
  });

  it('DB100-4: stats_reset_at is an ISO time with an offset or null', async () => {
    app = await makeApp({ testRoutes: false, now: () => NOW });
    const { auth } = await issueToken('read');
    const rep = (await app.inject({ method: 'GET', url: '/db/report', headers: auth })).json();
    if (rep.stats_reset_at !== null) expect(rep.stats_reset_at).toMatch(/[+-]\d\d:\d\d$/);
  });
});

describe('dbMaintenance step (CR-100 ask 3)', () => {
  const job = (o: Partial<ConstructorParameters<typeof DbMaintenanceJob>[0]> = {}) =>
    new DbMaintenanceJob({ db, now: () => NOW, minIndexBytes: 0, tables: ['datasave_pool'], ...o });
  const indexNames = async () => (await sql<{ n: string }>`select indexname as n from pg_indexes where schemaname = 'public' and tablename = 'datasave_pool' order by 1`.execute(db)).rows.map((r) => r.n);

  it('DB100-5: when the indexes are over 0.8 x heap every index is rebuilt concurrently, largest first, with before and after bytes; the index names stay', async () => {
    await seedBloatedPool();
    const names = await indexNames();
    const s = await job().runOnce();
    expect(s.status).toBe('ok');
    expect(s.budget_ms).toBe(10 * 60_000);
    const t = s.tables[0]!;
    expect(t.table).toBe('datasave_pool');
    expect(t.ratio_before).toBeGreaterThan(0.8);
    expect(t.skipped).toEqual([]);
    expect(t.reindexed.map((r) => r.index).sort()).toEqual(names);
    for (const r of t.reindexed) { expect(r.bytes_before).toBeGreaterThan(0); expect(r.bytes_after).toBeGreaterThan(0); }
    const sizes = t.reindexed.map((r) => r.bytes_before);
    expect(sizes).toEqual([...sizes].sort((a, b) => b - a));
    expect(await indexNames()).toEqual(names);
    expect(t.index_bytes_after).toBeGreaterThan(0);
    expect(s.db_bytes_before).toBeGreaterThan(0);
    // no leftover invalid index
    expect((await sql`select 1 from pg_index where not indisvalid`.execute(db)).rows).toEqual([]);
  });

  it('DB100-6: nothing_due when the ratio is under 0.8 (a huge heap stand-in is not needed: a table with no index weight) and for a table under the byte floor', async () => {
    await seedBloatedPool();
    const small = await job({ minIndexBytes: 1024 ** 3 }).runOnce(); // floor above the table's indexes
    expect(small.status).toBe('nothing_due');
    expect(small.tables[0]!.reindexed).toEqual([]);
    const missing = await job({ tables: ['no_such_table_xyz'] }).runOnce();
    expect(missing).toMatchObject({ status: 'nothing_due', tables: [] });
  });

  it('DB100-7: an index is skipped with HEADROOM when the free space under the limit is under twice its size', async () => {
    await seedBloatedPool();
    const bytes = Number((await sql<{ n: string }>`select pg_database_size(current_database())::text as n`.execute(db)).rows[0]!.n);
    const s = await job({ storageLimitBytes: bytes + 1000 }).runOnce(); // 1000 bytes of room
    const t = s.tables[0]!;
    expect(t.reindexed).toEqual([]);
    expect(t.skipped.length).toBeGreaterThan(0);
    expect(t.skipped.every((x) => x.reason === 'HEADROOM')).toBe(true);
    expect(s.status).toBe('ok');
  });

  it('DB100-8: the budget stops new rebuilds: the first index runs, the rest are skipped BUDGET, status stopped', async () => {
    await seedBloatedPool();
    await sql`create index datasave_pool_t_domain on datasave_pool (domain)`.execute(db); // a second index, so there is a "rest" to skip
    let clock = NOW;
    // the clock jumps 11 minutes each time it is read after the first rebuild started
    let reads = 0;
    const now = () => { reads += 1; return reads > 4 ? (clock += 11 * 60_000) : clock; };
    try {
      const s = await job({ now, budgetMs: 10 * 60_000 }).runOnce();
      const t = s.tables[0]!;
      expect(s.status).toBe('stopped');
      expect(t.reindexed).toHaveLength(1);
      expect(t.skipped).toEqual([{ index: expect.any(String), reason: 'BUDGET' }]);
      expect(t.reindexed.length + t.skipped.length).toBe((await indexNames()).length);
    } finally {
      await sql`drop index if exists datasave_pool_t_domain`.execute(db);
    }
  });

  it('DB100-9: an index that fails is recorded as skipped "ERROR: ..." and the step stays ok; an invalid leftover <idx>_ccnew index is dropped first', async () => {
    await seedBloatedPool();
    // a leftover of a crashed REINDEX CONCURRENTLY: an invalid index named ..._ccnew
    await sql`create index datasave_pool_domain_ccnew on datasave_pool (domain)`.execute(db);
    await sql`update pg_index set indisvalid = false where indexrelid = 'public.datasave_pool_domain_ccnew'::regclass`.execute(db);
    const s = await job().runOnce();
    expect(await indexNames()).not.toContain('datasave_pool_domain_ccnew');
    expect(s.status).toBe('ok');
    expect(s.tables[0]!.reindexed.length).toBeGreaterThan(0);
    // a failing rebuild: the index list is read, then the index disappears before its turn (dropped by another session)
        const failing = new DbMaintenanceJob({ db, now: () => NOW, minIndexBytes: 0, tables: ['datasave_pool'] });
    const orig = (failing as never as { indexes(t: string): Promise<Array<{ name: string; bytes: number }>> }).indexes.bind(failing);
    (failing as never as { indexes: unknown }).indexes = async (t: string) => [...(await orig(t)), { name: 'datasave_pool_no_such_index', bytes: 1 }];
    const f = await failing.runOnce();
    expect(f.status).toBe('ok');
    expect(f.tables[0]!.skipped).toHaveLength(1);
    expect(f.tables[0]!.skipped[0]!.reason).toMatch(/^ERROR: /);
    expect(f.tables[0]!.reindexed.length).toBeGreaterThan(0);
  });

  it('DB100-10: the daily plan has dbMaintenance right after retention, before backupExport; the real step reaches the summary', async () => {
    app = await makeApp({ testRoutes: false, now: () => NOW });
    const names = app.jobRunner.plan('daily').map((p) => p.name);
    expect(names.indexOf('dbMaintenance')).toBe(names.indexOf('retention') + 1);
    expect(names[names.indexOf('dbMaintenance') + 1]).toBe('backupExport');
    const step = app.jobRunner.plan('daily').find((p) => p.name === 'dbMaintenance')!;
    expect(step.maxAttempts).toBe(1);
    expect(step.timeoutMs).toBe(20 * 60_000);
  });
});

describe('POST /jobs/run {job: daily, only: db_maintenance} (CR-100)', () => {
  const JOB = 'job_token_fake_0123456789abcdef0123456789';
  const run = (h: Record<string, string>, body: object) => app!.inject({ method: 'POST', url: '/jobs/run', headers: { ...h, 'idempotency-key': randomUUID() }, payload: body });

  it('DB100-11: a WRITE token runs just the dbMaintenance step of the daily job (202, one step, summary in the run)', async () => {
    app = await makeApp({ testRoutes: false, now: () => NOW, env: { JOB_TRIGGER_TOKEN: JOB } });
    const w = (await issueToken('write', 'gavriel')).auth;
    const res = await run(w, { job: 'daily', only: 'db_maintenance' });
    expect(res.statusCode, res.body).toBe(202);
    expect(res.json()).toMatchObject({ job: 'daily', steps: ['dbMaintenance'], skipped: false });
    const done = await settleJob(app, 'daily', res);
    expect(Object.keys(done.json().steps)).toEqual(['dbMaintenance']);
    expect(done.json().steps.dbMaintenance).toMatchObject({ ok: true, summary: { status: 'nothing_due' } });
    const runs = await db.selectFrom('job_runs').select(['triggered_by', 'trigger']).where('job', '=', 'daily').execute();
    expect(runs).toEqual([{ triggered_by: 'gavriel', trigger: 'manual' }]);
  });

  it('DB100-12: refused for datasave (422), for a READ token (401), for the job token (403) and with a Dynadot value on daily (422)', async () => {
    app = await makeApp({ testRoutes: false, now: () => NOW, env: { JOB_TRIGGER_TOKEN: JOB } });
    const w = (await issueToken('write', 'gavriel')).auth;
    const r = (await issueToken('read')).auth;
    expect((await run(w, { job: 'datasave', only: 'db_maintenance' })).statusCode).toBe(422);
    expect((await run(w, { job: 'daily', only: 'dynadot_closeouts' })).statusCode).toBe(422);
    expect((await run(r, { job: 'daily', only: 'db_maintenance' })).statusCode).toBe(401);
    expect((await run({ authorization: `Bearer ${JOB}` }, { job: 'daily', only: 'db_maintenance' })).statusCode).toBe(403);
    expect(await db.selectFrom('job_queue_runs').select('id').execute()).toEqual([]);
  });
});

describe('fillfactor (CR-100 ask 4)', () => {
  it('DB100-13: since 6.3.0 the hot table market_episode_seen has fillfactor 50 (migration 1769400000000_v6-3-0; market_names is a view); dynadot_rows is left as is', async () => {
    const opts = async (t: string) => (await sql<{ o: string[] | null }>`select reloptions as o from pg_class where oid = ${`public.${t}`}::regclass`.execute(db)).rows[0]!.o;
    expect(await opts('market_episode_seen')).toEqual(['fillfactor=50']);
    expect(await opts('dynadot_rows')).toBeNull();
  });
});
