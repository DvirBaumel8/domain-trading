import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { makeApp } from '../../helpers/app.js';
import { issueToken } from '../../helpers/tokens.js';

let app: FastifyInstance;
afterEach(async () => app?.close());

describe('error format', () => {
  it('unknown route (with auth handled later) → error envelope', async () => {
    app = await makeApp({ testRoutes: false });
    const res = await app.inject({ method: 'GET', url: '/health/nope' });
    // Before Task 4 this is 404 NOT_FOUND; after Task 4 auth runs first and it is 401 UNAUTHORIZED.
    const body = res.json();
    expect(body.error).toMatchObject({ code: expect.stringMatching(/^[A-Z_]+$/), message: expect.any(String) });
    expect(body.error.details).toEqual(expect.any(Object));
  });

  it('exposes a route table of every registered route', async () => {
    app = await makeApp({ testRoutes: false });
    expect(app.routeTable).toEqual(expect.arrayContaining([{ method: 'GET', url: '/health' }]));
  });

  it('Fastify schema validation failure → 400 VALIDATION_ERROR (not 500)', async () => {
    app = await makeApp();
    const { token } = await issueToken('read');
    const res = await app.inject({ method: 'GET', url: '/__test/schema', headers: { authorization: `Bearer ${token}` } });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatchObject({ code: 'VALIDATION_ERROR', details: {} });
  });

  it('BUG-3: a text/plain body on a JSON route is 415 INVALID_BODY (not 422), as is application/xml', async () => {
    app = await makeApp({ testRoutes: false });
    const { token } = await issueToken('write');
    for (const ct of ['text/plain', 'text/plain; charset=utf-8', 'application/xml']) {
      const res = await app.inject({
        method: 'POST', url: '/buy', payload: 'hello',
        headers: { authorization: `Bearer ${token}`, 'idempotency-key': `k-415-${ct}`, 'content-type': ct },
      });
      expect([ct, res.statusCode, res.json().error.code]).toEqual([ct, 415, 'INVALID_BODY']);
    }
  });
});
