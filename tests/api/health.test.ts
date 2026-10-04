import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createDb } from '../../src/db/client.js';
import { makeApp } from '../helpers/app.js';

let app: FastifyInstance;
afterEach(async () => app?.close());

describe('GET /health (R-11)', () => {
  it('needs no auth and returns exactly status, db, version, adapters', async () => {
    app = await makeApp({ testRoutes: false });
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(Object.keys(body).sort()).toEqual(['adapters', 'db', 'status', 'version']);
    expect(body).toMatchObject({ status: 'ok', db: 'ok' });
    expect(body.version).toMatch(/^\d+\.\d+\.\d+/);
    for (const a of body.adapters) expect(Object.keys(a).sort()).toEqual(['enabled', 'name']);
  });

  it('never reveals secrets or key prefixes', async () => {
    app = await makeApp({ testRoutes: false });
    const text = (await app.inject({ method: 'GET', url: '/health' })).body;
    expect(text).not.toMatch(/pk1_|sk1_|fake_|github_pat/);
  });

  it('returns 503 degraded when the DB is down', async () => {
    const deadDb = createDb('postgres://dt:dt@127.0.0.1:1/nothing_test');
    app = await makeApp({ testRoutes: false, db: deadDb });
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({ status: 'degraded', db: 'down' });
    await deadDb.destroy();
  });
});
