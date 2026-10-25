import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { logCapture, makeApp } from '../../helpers/app.js';
import { testDb } from '../../helpers/db.js';
import { issueToken } from '../../helpers/tokens.js';

const JOB_TOKEN = 'job_token_fake_0123456789abcdef0123456789';
let app: FastifyInstance;
afterEach(async () => { vi.restoreAllMocks(); await app?.close(); });

describe('v5.40.0 query counter in the API (G-125)', () => {
  it('DQ540-5 the request-completed log line carries db_queries and db_ms for a handler that queries the DB; the body is unchanged', async () => {
    const logs = logCapture();
    app = await makeApp({ logStream: logs.stream });
    const r = await issueToken('read');
    const res = await app.inject({ method: 'GET', url: '/__test/ping', headers: r.auth });
    expect(res.statusCode).toBe(200);
    expect(Object.keys(res.json())).not.toContain('db_queries');
    const done = logs.text().split('\n').filter((l) => l.includes('request completed')).map((l) => JSON.parse(l));
    expect(done).toHaveLength(1);
    expect(done[0].db_queries).toBeGreaterThan(0);
    expect(typeof done[0].db_ms).toBe('number');
    expect(done[0].db_top).toBeUndefined(); // under 20 queries
  });

  it('DQ540-6 a job step record carries db.queries next to ms, and the summary does not show the internal counter', async () => {
    app = await makeApp({ testRoutes: false, env: { JOB_TRIGGER_TOKEN: JOB_TOKEN } });
    vi.spyOn(app.reconciler, 'runOnce').mockImplementation(async () => {
      await testDb.selectFrom('domains').select('id').execute();
      await testDb.selectFrom('domains').select('id').execute();
      return { resolved: [] } as never;
    });
    const res = await app.inject({ method: 'POST', url: '/jobs/run', headers: { authorization: `Bearer ${JOB_TOKEN}`, 'idempotency-key': 'dq540-6' }, payload: { job: 'tick' } });
    expect(res.statusCode).toBe(202);
    await app.jobQueue.idle();
    const read = await issueToken('read');
    const runs = (await app.inject({ method: 'GET', url: '/jobs/runs?job=tick', headers: read.auth })).json().runs;
    const step = runs[0].steps.reconciler;
    expect(step.db.queries).toBeGreaterThanOrEqual(2);
    expect(step.db.ms).toEqual(expect.any(Number));
    expect(step.db.top).toBeUndefined();
    expect(step.summary).toEqual({ resolved: [] });
    expect(JSON.stringify(step.summary)).not.toContain('_db');
  });
});
