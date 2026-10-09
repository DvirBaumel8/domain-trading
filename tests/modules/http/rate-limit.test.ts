import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { makeApp } from '../../helpers/app.js';
import { testDb as db } from '../../helpers/db.js';
import { issueToken } from '../../helpers/tokens.js';

let app: FastifyInstance;
afterEach(async () => app?.close());

describe('rate limit (AU-9)', () => {
  it('AU-9: the 11th POST in one minute → 429 RATE_LIMITED with Retry-After, and is audited', async () => {
    let t = 0;
    app = await makeApp({ now: () => t });
    const { auth } = await issueToken('write');
    for (let i = 1; i <= 10; i++) {
      const res = await app.inject({
        method: 'POST', url: '/__test/echo', headers: { ...auth, 'idempotency-key': `rl-${i}` }, payload: { value: 'x' },
      });
      expect(res.statusCode, `call ${i}`).toBe(201);
    }
    const res = await app.inject({
      method: 'POST', url: '/__test/echo', headers: { ...auth, 'idempotency-key': 'rl-11' }, payload: { value: 'x' },
    });
    expect(res.statusCode).toBe(429);
    expect(res.json().error.code).toBe('RATE_LIMITED');
    expect(Number(res.headers['retry-after'])).toBeGreaterThan(0);
    const audit = await db.selectFrom('audit_log').selectAll().where('idempotency_key', '=', 'rl-11').execute();
    expect(audit).toMatchObject([{ status_code: 429, result_summary: 'RATE_LIMITED' }]);

    t += 60_001;
    const later = await app.inject({
      method: 'POST', url: '/__test/echo', headers: { ...auth, 'idempotency-key': 'rl-12' }, payload: { value: 'x' },
    });
    expect(later.statusCode).toBe(201);
  });

  it('a rate-limited request does not burn its idempotency key', async () => {
    app = await makeApp({ now: () => 0 });
    const { auth } = await issueToken('write');
    for (let i = 1; i <= 10; i++) {
      await app.inject({ method: 'POST', url: '/__test/echo', headers: { ...auth, 'idempotency-key': `b-${i}` }, payload: { value: 'x' } });
    }
    await app.inject({ method: 'POST', url: '/__test/echo', headers: { ...auth, 'idempotency-key': 'b-11' }, payload: { value: 'x' } });
    const row = await db.selectFrom('idempotency_keys').selectAll().where('key', '=', 'b-11').executeTakeFirst();
    expect(row).toBeUndefined();
  });

  it('61st GET in one minute → 429; GETs and POSTs have separate budgets', async () => {
    app = await makeApp({ now: () => 0 });
    const { auth } = await issueToken('write');
    for (let i = 1; i <= 60; i++) {
      expect((await app.inject({ method: 'GET', url: '/__test/ping', headers: auth })).statusCode).toBe(200);
    }
    expect((await app.inject({ method: 'GET', url: '/__test/ping', headers: auth })).statusCode).toBe(429);
    const post = await app.inject({
      method: 'POST', url: '/__test/echo', headers: { ...auth, 'idempotency-key': 'sep-1' }, payload: { value: 'x' },
    });
    expect(post.statusCode).toBe(201);
  });

  it('limits are per token', async () => {
    app = await makeApp({ now: () => 0 });
    const a = await issueToken('write');
    const b = await issueToken('write');
    for (let i = 1; i <= 10; i++) {
      await app.inject({ method: 'POST', url: '/__test/echo', headers: { ...a.auth, 'idempotency-key': `a-${i}` }, payload: { value: 'x' } });
    }
    const res = await app.inject({
      method: 'POST', url: '/__test/echo', headers: { ...b.auth, 'idempotency-key': 'b-1' }, payload: { value: 'x' },
    });
    expect(res.statusCode).toBe(201);
  });

  it('/health/ping (public) is never rate limited', async () => {
    app = await makeApp({ now: () => 0 });
    for (let i = 0; i < 70; i++) expect((await app.inject({ method: 'GET', url: '/health/ping' })).statusCode).toBe(200);
  });
});
