import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createDb } from '../../../src/db/client.js';
import { makeApp } from '../../helpers/app.js';
import { testDb } from '../../helpers/db.js';
import { issueToken } from '../../helpers/tokens.js';

let app: FastifyInstance;
afterEach(async () => app?.close());

describe('GET /health (R-11)', () => {
  it('needs a bot token (401 without, 200 with READ) and returns exactly status, db, jobs, posting, posting_reason, review, review_model, version, adapters', async () => {
    app = await makeApp({ testRoutes: false });
    expect((await app.inject({ method: 'GET', url: '/health' })).statusCode).toBe(401);
    const { auth } = await issueToken('read');
    const res = await app.inject({ method: 'GET', url: '/health', headers: auth });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(Object.keys(body).sort()).toEqual(['adapters', 'db', 'jobs', 'posting', 'posting_reason', 'review', 'review_model', 'status', 'version']);
    expect(body).toMatchObject({ status: 'ok', db: 'ok' });
    expect(body.version).toMatch(/^\d+\.\d+\.\d+/);
    for (const a of body.adapters) expect(Object.keys(a).sort()).toEqual(['enabled', 'name']);
  });

  it('never reveals secrets or key prefixes', async () => {
    app = await makeApp({ testRoutes: false });
    const { auth } = await issueToken('write');
    const text = (await app.inject({ method: 'GET', url: '/health', headers: auth })).body;
    expect(text).not.toMatch(/pk1_|sk1_|fake_|github_pat/);
  });

  it('returns 503 degraded when the DB is down', async () => {
    const deadDb = createDb('postgres://dt:dt@127.0.0.1:1/nothing_test');
    // Token lookup (updateTable) goes to the live test DB; the health ping hits the dead one.
    const mixed = new Proxy(deadDb, {
      get: (t, p) => (p === 'updateTable' ? testDb.updateTable.bind(testDb) : (Reflect.get(t, p) as unknown) instanceof Function ? (Reflect.get(t, p) as (...a: unknown[]) => unknown).bind(t) : Reflect.get(t, p)),
    });
    app = await makeApp({ testRoutes: false, db: mixed });
    const { auth } = await issueToken('read');
    const res = await app.inject({ method: 'GET', url: '/health', headers: auth });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({ status: 'degraded', db: 'down' });
    await deadDb.destroy();
  });
});
