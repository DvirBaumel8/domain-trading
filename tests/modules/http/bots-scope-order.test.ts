// v5.29.0 (CR-076 note): a bots token on a money route gets 403 SCOPE_FORBIDDEN whatever the body is, unless the body has dry_run true.
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { makeApp } from '../../helpers/app.js';
import { issueToken } from '../../helpers/tokens.js';

let app: FastifyInstance;
afterEach(async () => app?.close());
const post = (url: string, h: Record<string, string>, payload: unknown, raw = false) =>
  app.inject({ method: 'POST', url, headers: { ...h, 'idempotency-key': randomUUID(), ...(raw ? { 'content-type': 'application/json' } : {}) }, payload: payload as object });

describe('bots scope is checked before the body (v5.29.0)', () => {
  it('BS529-1: bots token, money route, schema-invalid body without dry_run is 403; with dry_run true it reaches the route validation (422); a WRITE token still gets 422', async () => {
    let clock = Date.parse('2026-10-21T09:00:00Z');
    app = await makeApp({ now: () => clock });
    const bots = (await issueToken('bots', 'bots-order')).auth;
    const write = (await issueToken('write', 'write-order')).auth;
    const bad = { venue: 123, listed_at: 'not a date', shown: 'nope', unknown_field: true };
    clock += 60_000;
    const a = await post('/listings/orderedtest.com/venue', bots, bad);
    expect(a.statusCode).toBe(403);
    expect(a.json().error.code).toBe('SCOPE_FORBIDDEN');
    clock += 60_000;
    const b = await post('/listings/orderedtest.com/venue', bots, { ...bad, dry_run: true });
    expect(b.statusCode).toBe(422);
    expect(b.json().error.code).toBe('VALIDATION_ERROR');
    clock += 60_000;
    const c = await post('/listings/orderedtest.com/venue', write, bad);
    expect(c.statusCode).toBe(422);
    clock += 60_000;
    // a body that is not even JSON: the scope still answers first for a bots token
    const d = await app.inject({ method: 'POST', url: '/buy', headers: { ...bots, 'idempotency-key': randomUUID(), 'content-type': 'application/json' }, payload: '{not json' });
    expect(d.statusCode).toBe(403);
    expect(d.json().error.code).toBe('SCOPE_FORBIDDEN');
  });
});
