import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createDb } from '../../../src/db/client.js';
import { makeApp } from '../../helpers/app.js';
import { seedDailyRun, testDb } from '../../helpers/db.js';
import { issueToken } from '../../helpers/tokens.js';

let app: FastifyInstance;
afterEach(async () => app?.close());

describe('GET /health jobs and jobs_last (BUG-047)', () => {
  it('L520-1: jobs is overdue when no tick ran in the last 26 h (and when it never ran), ok with a fresh tick; jobs_last shows the last daily and tick run', async () => {
    const NOW = Date.parse('2026-10-20T09:00:00Z');
    app = await makeApp({ testRoutes: false, now: () => NOW });
    const { auth } = await issueToken('read');
    const health = async () => (await app.inject({ method: 'GET', url: '/health', headers: auth })).json();
    await seedDailyRun(testDb, NOW); // started 61 min before NOW // the daily run is fresh and its slot (00:05 UTC) was served
    expect(await health()).toMatchObject({ jobs: 'overdue', jobs_last: { tick: null } }); // never ticked
    const old = new Date(NOW - 27 * 3_600_000);
    await testDb.insertInto('job_runs').values({ job: 'tick', trigger: 'scheduled', started_at: old, finished_at: old, skipped: false, ok: true, steps: '{}' }).execute();
    const stale = await health();
    expect(stale.jobs).toBe('overdue');
    expect(Date.parse(stale.jobs_last.tick)).toBe(old.getTime());
    expect(Date.parse(stale.jobs_last.daily)).toBe(NOW - 3_660_000);
    const fresh = new Date(NOW - 2 * 3_600_000);
    await testDb.insertInto('job_runs').values({ job: 'tick', trigger: 'scheduled', started_at: fresh, finished_at: fresh, skipped: false, ok: true, steps: '{}' }).execute();
    const ok = await health();
    expect(ok.jobs).toBe('ok');
    expect(Date.parse(ok.jobs_last.tick)).toBe(fresh.getTime());
  });
});

describe('GET /health (R-11)', () => {
  it('needs a bot token (401 without, 200 with READ) and returns exactly status, db, db_size, jobs, jobs_last, review, review_model, version, adapters', async () => {
    app = await makeApp({ testRoutes: false });
    expect((await app.inject({ method: 'GET', url: '/health' })).statusCode).toBe(401);
    const { auth } = await issueToken('read');
    const res = await app.inject({ method: 'GET', url: '/health', headers: auth });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(Object.keys(body).sort()).toEqual(['adapters', 'db', 'db_size', 'jobs', 'jobs_last', 'review', 'review_model', 'status', 'version']);
    expect(body).toMatchObject({ status: 'ok', db: 'ok' });
    expect(body.version).toMatch(/^\d+\.\d+\.\d+/);
    for (const a of body.adapters) expect(Object.keys(a).sort()).toEqual(['enabled', 'name']);
  });

  it('L517-1: db_size reports the database bytes against the 1 GB free-plan limit (READ token)', async () => {
    app = await makeApp({ testRoutes: false });
    const { auth } = await issueToken('read');
    const body = (await app.inject({ method: 'GET', url: '/health', headers: auth })).json();
    expect(Object.keys(body.db_size).sort()).toEqual(['bytes', 'limit_bytes', 'percent', 'warn_percent']);
    expect(body.db_size.bytes).toBeGreaterThan(0);
    expect(body.db_size.limit_bytes).toBe(1024 ** 3);
    expect(body.db_size.percent).toBe(Math.round(body.db_size.bytes * 1000 / 1024 ** 3) / 10);
    expect(body.db_size.warn_percent).toBe(70);
  });

  it('never reveals secrets or key prefixes', async () => {
    app = await makeApp({ testRoutes: false });
    const { auth } = await issueToken('write');
    const text = (await app.inject({ method: 'GET', url: '/health', headers: auth })).body;
    expect(text).not.toMatch(/pk1_|sk1_|fake_|github_pat/);
  });

  it('returns 503 degraded when the DB is down', async () => {
    const deadDb = createDb('postgres://dt:dt@127.0.0.1:1/nothing_test');
    // Token lookup (selectFrom('api_tokens'), and the last_used_at updateTable, since 5.13.0 two statements) goes to the live test DB; the health ping and every other read hit the dead one.
    const bound = (t: object, p: string | symbol) => ((Reflect.get(t, p) as unknown) instanceof Function ? (Reflect.get(t, p) as (...a: unknown[]) => unknown).bind(t) : Reflect.get(t, p));
    const mixed = new Proxy(deadDb, {
      get: (t, p) => {
        if (p === 'updateTable') return testDb.updateTable.bind(testDb);
        if (p === 'selectFrom') return (table: string, ...rest: unknown[]) => ((table === 'api_tokens' ? testDb : t) as unknown as { selectFrom: (...a: unknown[]) => unknown }).selectFrom(table, ...rest);
        return bound(t, p);
      },
    });
    app = await makeApp({ testRoutes: false, db: mixed });
    const { auth } = await issueToken('read');
    const res = await app.inject({ method: 'GET', url: '/health', headers: auth });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({ status: 'degraded', db: 'down' });
    await deadDb.destroy();
  });
});
