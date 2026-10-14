// v2.16.0 tech-debt part C: review concurrency, idempotency hygiene, block-list ReDoS, F9/F24.
import { randomUUID } from 'node:crypto';
import { delay, http, HttpResponse } from 'msw';
import { sql } from 'kysely';
import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { logCapture, makeApp } from '../../helpers/app.js';
import { testDb as db } from '../../helpers/db.js';
import { issueToken } from '../../helpers/tokens.js';
import { mswServer } from '../../setup/network.js';
import { checkText } from '../../../src/modules/outreach/blocklist.js';
import { requestHash, pruneIdempotencyKeys, STALE_IN_PROGRESS_MS } from '../../../src/http/idempotency.js';

const T0 = Date.parse('2026-10-20T10:00:00Z');
const apps: FastifyInstance[] = [];
afterEach(async () => { await Promise.all(apps.splice(0).map((a) => a.close())); });

// ---------------------------------------------------------------- idempotency
describe('idempotency hygiene (v2.16.0)', () => {
  it('an in_progress key older than 15 minutes is still 409 IN_USE but says stale with started_at; a fresh one has no stale flag', async () => {
    const app = await makeApp();
    apps.push(app);
    const { auth } = await issueToken('write');
    const body = { value: 'x' };
    const hash = requestHash('POST', '/__test/echo', body);
    const mk = (key: string, ageMs: number) => db.insertInto('idempotency_keys').values({ key, request_hash: hash, method: 'POST', path: '/__test/echo', state: 'in_progress', created_at: new Date(Date.now() - ageMs) }).execute();
    await mk('old-key', STALE_IN_PROGRESS_MS + 60_000);
    await mk('new-key', 60_000);
    const call = (key: string) => app.inject({ method: 'POST', url: '/__test/echo', headers: { ...auth, 'idempotency-key': key, 'content-type': 'application/json' }, payload: JSON.stringify(body) });
    const old = await call('old-key');
    expect(old.statusCode).toBe(409);
    expect(old.json().error).toMatchObject({ code: 'IDEMPOTENCY_KEY_IN_USE', details: { stale: true, started_at: expect.stringMatching(/^\d{4}-/) } });
    const fresh = await call('new-key');
    expect(fresh.json().error).toMatchObject({ code: 'IDEMPOTENCY_KEY_IN_USE', details: {} });
  });

  it('prune deletes completed keys older than 30 days only; a request prunes lazily', async () => {
    const hash = requestHash('POST', '/x', {});
    const row = (key: string, state: 'completed' | 'in_progress', days: number) => ({
      key, request_hash: hash, method: 'POST', path: '/x', state, status_code: state === 'completed' ? 200 : null, response_body: state === 'completed' ? '{}' : null,
      created_at: new Date(Date.now() - days * 86_400_000), completed_at: state === 'completed' ? new Date(Date.now() - days * 86_400_000) : null,
    });
    await db.insertInto('idempotency_keys').values([row('c-old', 'completed', 31), row('c-new', 'completed', 29), row('p-old', 'in_progress', 40)]).execute();
    expect(await pruneIdempotencyKeys(db)).toBe(1);
    expect((await db.selectFrom('idempotency_keys').select('key').orderBy('key').execute()).map((r) => r.key)).toEqual(['c-new', 'p-old']);
    await db.insertInto('idempotency_keys').values(row('c-old2', 'completed', 45)).execute();
    const app = await makeApp();
    apps.push(app);
    const { auth } = await issueToken('write');
    await app.inject({ method: 'POST', url: '/__test/echo', headers: { ...auth, 'idempotency-key': 'lazy', 'content-type': 'application/json' }, payload: '{"value":"x"}' });
    for (let i = 0; i < 40; i++) {
      if (!(await db.selectFrom('idempotency_keys').select('key').where('key', '=', 'c-old2').executeTakeFirst())) break;
      await delay(25);
    }
    expect(await db.selectFrom('idempotency_keys').select('key').where('key', '=', 'c-old2').executeTakeFirst()).toBeUndefined();
  });
});
