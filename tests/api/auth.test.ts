import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { revokeApiToken } from '../../src/admin/tokens.js';
import { FailedAuthLimiter } from '../../src/http/auth.js';
import { makeApp } from '../helpers/app.js';
import { testDb } from '../helpers/db.js';
import { issueToken } from '../helpers/tokens.js';

let app: FastifyInstance;
afterEach(async () => app?.close());

const ip = (n: number) => `10.${(n >> 16) & 255}.${(n >> 8) & 255}.${n & 255}`;
const count = async (t: 'audit_log' | 'idempotency_keys') =>
  Number((await testDb.selectFrom(t).select((e) => e.fn.countAll().as('c')).executeTakeFirstOrThrow()).c);
const writeCounts = async () => ({ audit: await count('audit_log'), idem: await count('idempotency_keys') });
const concrete = (url: string) => url.replace(/:(\w+)/g, '$1');

describe('auth (AU)', () => {
  it('AU-1: no Authorization → 401 on every route (/health included) except /health/ping, with zero DB writes', async () => {
    // JOB_TRIGGER_TOKEN is set so POST /jobs/run is exercised as 401 (unset it answers 503 JOBS_DISABLED, see jobs.test.ts).
    app = await makeApp({ testRoutes: false, env: { JOB_TRIGGER_TOKEN: 'job_token_fake_0123456789abcdef0123456789' } });
    const before = await writeCounts();
    const routes = app.routeTable.filter((r) => r.method !== 'HEAD' && r.url !== '/health/ping');
    let n = 0;
    for (const r of routes) {
      // A distinct source IP per call keeps the sweep clear of the failed-auth limiter.
      const res = await app.inject({ method: r.method as 'GET', url: concrete(r.url), headers: { 'idempotency-key': `sweep-${n}` }, remoteAddress: ip(n++) });
      expect(res.statusCode, `${r.method} ${r.url}`).toBe(401);
      expect(res.json().error.code).toBe('UNAUTHORIZED');
      const bad = await app.inject({ method: r.method as 'GET', url: concrete(r.url), headers: { authorization: 'Bearer dt_bad_token', 'idempotency-key': `sweep-${n}` }, remoteAddress: ip(n++) });
      expect(bad.statusCode, `bad ${r.method} ${r.url}`).toBe(401);
    }
    expect(await writeCounts()).toEqual(before);
    expect((await app.inject({ method: 'GET', url: '/health/ping' })).statusCode).toBe(200);
    // and the test app's routes too
    const t = await makeApp();
    for (const [method, url] of [['GET', '/__test/ping'], ['POST', '/__test/echo']] as const) {
      expect((await t.inject({ method, url, remoteAddress: ip(n++) })).statusCode).toBe(401);
    }
    expect(await writeCounts()).toEqual(before);
    await t.close();
  });

  it('GET /health: no token → 401, READ token → 200', async () => {
    app = await makeApp({ testRoutes: false });
    expect((await app.inject({ method: 'GET', url: '/health' })).statusCode).toBe(401);
    const { auth } = await issueToken('read');
    expect((await app.inject({ method: 'GET', url: '/health', headers: auth })).statusCode).toBe(200);
  });

  it('POST /health (with or without query) and no token → 401, no idempotency row, no audit row', async () => {
    app = await makeApp({ testRoutes: false });
    for (const url of ['/health', '/health?x=1']) {
      const key = `health-post-${url.length}-${Math.random()}`;
      const before = await writeCounts();
      const res = await app.inject({ method: 'POST', url, headers: { 'idempotency-key': key } });
      expect(res.statusCode, url).toBe(401);
      expect(res.json().error.code).toBe('UNAUTHORIZED');
      expect(await testDb.selectFrom('idempotency_keys').selectAll().where('key', '=', key).execute()).toHaveLength(0);
      expect(await writeCounts(), url).toEqual(before);
    }
  });

  it('every mutating method without a token → 401 on every route and path, zero DB writes', async () => {
    app = await makeApp({ testRoutes: false, env: { JOB_TRIGGER_TOKEN: 'job_token_fake_0123456789abcdef0123456789' } });
    const urls = new Set([...app.routeTable.map((r) => concrete(r.url)), '/health', '/nope']);
    const before = await writeCounts();
    let n = 0;
    for (const url of urls) {
      for (const method of ['POST', 'PUT', 'PATCH', 'DELETE'] as const) {
        const res = await app.inject({ method, url, headers: { 'idempotency-key': 'k-rt' }, remoteAddress: ip(n++) });
        expect(res.statusCode, `${method} ${url}`).toBe(401);
      }
    }
    expect(await writeCounts()).toEqual(before);
  });

  it('AU-1: unknown routes answer 401 without a token (no route probing) and write nothing', async () => {
    app = await makeApp();
    const before = await writeCounts();
    expect((await app.inject({ method: 'GET', url: '/nope' })).statusCode).toBe(401);
    expect((await app.inject({ method: 'POST', url: '/nope', headers: { 'idempotency-key': 'k-nope' } })).statusCode).toBe(401);
    expect(await writeCounts()).toEqual(before);
  });

  it('AU-10: a valid token with the wrong scope (403) is still audited', async () => {
    app = await makeApp();
    const { auth } = await issueToken('read');
    const before = await writeCounts();
    const res = await app.inject({ method: 'POST', url: '/__test/echo', headers: { ...auth, 'idempotency-key': 'k-403' }, payload: { value: 'x' } });
    expect(res.statusCode).toBe(403);
    const after = await writeCounts();
    expect(after.audit - before.audit).toBe(1);
  });

  it('AU-11: failed-auth limiter, 20 failures per IP per 10 min then 429 with no token lookup and no DB access', async () => {
    let t = 1_000_000;
    app = await makeApp({ now: () => t });
    const bad = { authorization: 'Bearer dt_nope' };
    for (let i = 0; i < 20; i++) {
      expect((await app.inject({ method: 'GET', url: '/portfolio', headers: bad, remoteAddress: '203.0.113.9' })).statusCode).toBe(401);
    }
    const { auth } = await issueToken('read'); // issuing writes an ADMIN audit row; count after it
    const before = await writeCounts();
    const spy = vi.spyOn(testDb, 'updateTable');
    const blocked = await app.inject({ method: 'GET', url: '/portfolio', headers: { ...bad }, remoteAddress: '203.0.113.9' });
    expect(blocked.statusCode).toBe(429);
    expect(blocked.json().error.code).toBe('RATE_LIMITED');
    // even a valid token from that IP is refused before any lookup
    expect((await app.inject({ method: 'GET', url: '/portfolio', headers: auth, remoteAddress: '203.0.113.9' })).statusCode).toBe(429);
    expect(spy).not.toHaveBeenCalled();
    expect(await writeCounts()).toEqual(before);
    // another IP is unaffected
    expect((await app.inject({ method: 'GET', url: '/portfolio', headers: auth, remoteAddress: '203.0.113.10' })).statusCode).toBe(200);
    // the window rolls
    t += 10 * 60_000 + 1;
    expect((await app.inject({ method: 'GET', url: '/portfolio', headers: auth, remoteAddress: '203.0.113.9' })).statusCode).toBe(200);
    spy.mockRestore();
  });

  it('AU-11: the limiter bounds its memory (oldest IP dropped beyond the cap)', () => {
    const l = new FailedAuthLimiter(1, 60_000, () => 0);
    for (let i = 0; i < 10_050; i++) l.fail(`ip-${i}`);
    expect(l.blockedFor('ip-0')).toBe(0); // evicted
    expect(l.blockedFor('ip-10049')).toBeGreaterThan(0);
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
