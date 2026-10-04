import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { makeApp } from '../helpers/app.js';

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
});
