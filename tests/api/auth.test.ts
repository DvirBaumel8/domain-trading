import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { revokeApiToken } from '../../src/admin/tokens.js';
import { makeApp } from '../helpers/app.js';
import { testDb } from '../helpers/db.js';
import { issueToken } from '../helpers/tokens.js';

let app: FastifyInstance;
afterEach(async () => app?.close());

const concrete = (url: string) => url.replace(/:(\w+)/g, '$1');

describe('auth (AU)', () => {
  it('AU-1: no Authorization → 401 on every route except /health', async () => {
    app = await makeApp({ testRoutes: false });
    const routes = app.routeTable.filter((r) => r.method !== 'HEAD' && r.url !== '/health');
    for (const r of routes) {
      const res = await app.inject({ method: r.method as 'GET', url: concrete(r.url) });
      expect(res.statusCode, `${r.method} ${r.url}`).toBe(401);
      expect(res.json().error.code).toBe('UNAUTHORIZED');
    }
    // and the test app's routes too
    const t = await makeApp();
    for (const [method, url] of [['GET', '/__test/ping'], ['POST', '/__test/echo']] as const) {
      expect((await t.inject({ method, url })).statusCode).toBe(401);
    }
    await t.close();
  });

  it('POST /health (with or without query) and no token → 401, no idempotency row, one audit row', async () => {
    app = await makeApp({ testRoutes: false });
    for (const url of ['/health', '/health?x=1']) {
      const key = `health-post-${url.length}-${Math.random()}`;
      const auditBefore = Number((await testDb.selectFrom('audit_log').select((e) => e.fn.countAll().as('c')).executeTakeFirstOrThrow()).c);
      const res = await app.inject({ method: 'POST', url, headers: { 'idempotency-key': key } });
      expect(res.statusCode, url).toBe(401);
      expect(res.json().error.code).toBe('UNAUTHORIZED');
      const idem = await testDb.selectFrom('idempotency_keys').selectAll().where('key', '=', key).execute();
      expect(idem).toHaveLength(0);
      const auditAfter = Number((await testDb.selectFrom('audit_log').select((e) => e.fn.countAll().as('c')).executeTakeFirstOrThrow()).c);
      expect(auditAfter - auditBefore, url).toBe(1);
    }
  });

  it('every mutating method without a token → 401 on every route and public path', async () => {
    app = await makeApp({ testRoutes: false });
    const urls = new Set([...app.routeTable.map((r) => concrete(r.url)), '/health', '/nope']);
    for (const url of urls) {
      for (const method of ['POST', 'PUT', 'PATCH', 'DELETE'] as const) {
        const res = await app.inject({ method, url, headers: { 'idempotency-key': 'k-rt' } });
        expect(res.statusCode, `${method} ${url}`).toBe(401);
      }
    }
  });

  it('AU-1: unknown routes also answer 401 without a token (no route probing)', async () => {
    app = await makeApp();
    expect((await app.inject({ method: 'GET', url: '/nope' })).statusCode).toBe(401);
  });

  it('AU-2: malformed or unknown token → 401', async () => {
    app = await makeApp();
    for (const authorization of ['Bearer', 'Basic abc', 'Bearer dt_unknown', 'dt_x', 'Bearer a b']) {
      const res = await app.inject({ method: 'GET', url: '/__test/ping', headers: { authorization } });
      expect(res.statusCode, authorization).toBe(401);
    }
  });

  it('accepts a case-insensitive "bearer" scheme', async () => {
    app = await makeApp();
    const { token } = await issueToken('read');
    const res = await app.inject({ method: 'GET', url: '/__test/ping', headers: { authorization: `bearer ${token}` } });
    expect(res.statusCode).toBe(200);
  });

  it('AU-3: READ token on a POST → 403 SCOPE_FORBIDDEN, handler not run', async () => {
    app = await makeApp();
    const { auth } = await issueToken('read');
    const res = await app.inject({
      method: 'POST', url: '/__test/echo',
      headers: { ...auth, 'idempotency-key': 'k-au3' }, payload: { value: 'x' },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('SCOPE_FORBIDDEN');
    const { sideEffects } = await import('../helpers/app.js');
    expect(sideEffects.count).toBe(0);
    const rows = await testDb.selectFrom('audit_log').selectAll().where('method', '=', 'POST').execute();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status_code: 403, scope: 'read', result_summary: 'SCOPE_FORBIDDEN' });
  });

  it('AU-4: READ token on GET → 200', async () => {
    app = await makeApp();
    const { auth } = await issueToken('read');
    expect((await app.inject({ method: 'GET', url: '/__test/ping', headers: auth })).statusCode).toBe(200);
  });

  it('AU-5: WRITE token on GET → 200', async () => {
    app = await makeApp();
    const { auth } = await issueToken('write');
    expect((await app.inject({ method: 'GET', url: '/__test/ping', headers: auth })).statusCode).toBe(200);
  });

  it('AU-6: revoked token → 401 on the very next request', async () => {
    app = await makeApp();
    const { id, auth } = await issueToken('write');
    expect((await app.inject({ method: 'GET', url: '/__test/ping', headers: auth })).statusCode).toBe(200);
    await revokeApiToken(testDb, id);
    expect((await app.inject({ method: 'GET', url: '/__test/ping', headers: auth })).statusCode).toBe(401);
  });

  it('AU-7: no route creates, lists or reveals tokens; no settings route', async () => {
    app = await makeApp({ testRoutes: false });
    for (const r of app.routeTable) {
      expect(r.url).not.toMatch(/token|settings/i);
    }
  });

  it('updates last_used_at', async () => {
    app = await makeApp();
    const { id, auth } = await issueToken('read');
    await app.inject({ method: 'GET', url: '/__test/ping', headers: auth });
    const row = await testDb.selectFrom('api_tokens').select('last_used_at').where('id', '=', id).executeTakeFirstOrThrow();
    expect(row.last_used_at).not.toBeNull();
  });
});
