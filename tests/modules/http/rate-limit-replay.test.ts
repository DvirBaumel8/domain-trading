// v3.2.0 part A (CR-017): replay and rate limit. MSW only; fake keys.
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { makeApp } from '../../helpers/app.js';
import { issueToken } from '../../helpers/tokens.js';

const T0 = Date.parse('2026-10-20T10:00:00Z');
const apps: FastifyInstance[] = [];
afterEach(async () => { await Promise.all(apps.splice(0).map((a) => a.close())); });

async function boot(env: Record<string, string> = {}) {
  const clock = { t: T0 };
  const app = await makeApp({ now: () => clock.t, env, testRoutes: false });
  apps.push(app);
  const w = (await issueToken('write', 'gavriel-write')).auth;
  const post = (url: string, payload?: object, key = randomUUID()) => app.inject({ method: 'POST', url, headers: { ...w, 'idempotency-key': key }, ...(payload === undefined ? {} : { payload }) });
  return { app, clock, post };
}

describe('T17-6 an idempotent replay does not use a rate-limit slot', () => {
  it('T17-6 15 replays of one completed request never 429 and leave ratelimit-remaining unchanged; a different request still has its slots', async () => {
    const t = await boot({});
    const key = randomUUID();
    const first = await t.post('/company/forbidden-terms', { term: 'zeta-first' }, key);
    expect(first.statusCode).toBe(201);
    const remaining = Number(first.headers['ratelimit-remaining']);
    expect(remaining).toBe(9);
    for (let i = 0; i < 15; i++) {
      const r = await t.post('/company/forbidden-terms', { term: 'zeta-first' }, key);
      expect(r.statusCode).toBe(201);
      expect(r.headers['idempotent-replayed']).toBe('true');
      expect(Number(r.headers['ratelimit-remaining'])).toBe(remaining);
    }
    // 9 more distinct requests fit (10 per minute in all), the 11th is limited
    const codes: number[] = [];
    for (let i = 0; i < 10; i++) codes.push((await t.post('/company/forbidden-terms', { term: `zeta-r${i}` })).statusCode);
    expect(codes.filter((c) => c === 429)).toHaveLength(1);
    // a replay still gets through while the window is full
    expect((await t.post('/company/forbidden-terms', { term: 'zeta-first' }, key)).headers['idempotent-replayed']).toBe('true');
    // a mismatched reuse of the key is not a replay: it counts (and is refused 429 here)
    expect((await t.post('/company/forbidden-terms', { term: 'zeta-other' }, key)).statusCode).toBe(429);
  });
});
