// v2.16.0 tech-debt part C: no double post, review concurrency, idempotency hygiene, block-list ReDoS, /media limits, F9/F24.
import { randomUUID } from 'node:crypto';
import { delay, http, HttpResponse } from 'msw';
import { sql } from 'kysely';
import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { logCapture, makeApp } from '../../helpers/app.js';
import { testDb as db } from '../../helpers/db.js';
import { makePng, b64 } from '../../helpers/images.js';
import { issueToken } from '../../helpers/tokens.js';
import { mswServer } from '../../setup/network.js';
import { checkText } from '../../../src/modules/outreach/blocklist.js';
import { requestHash, pruneIdempotencyKeys, STALE_IN_PROGRESS_MS } from '../../../src/http/idempotency.js';
import { postsRefresh } from '../../../src/modules/outreach/posting/posts.js';
import { introspectionAnswer, refuseBadCreate } from '../../helpers/buffer-schema.js';
import { BufferClient } from '../../../src/modules/outreach/posting/buffer.js';

const BUF_KEY = 'buf_fake_key_0123456789abcdefABCDEF';
const T0 = Date.parse('2026-10-20T10:00:00Z');
const apps: FastifyInstance[] = [];
afterEach(async () => { await Promise.all(apps.splice(0).map((a) => a.close())); });

// ---------------------------------------------------------------- posts
const bufCalls: string[] = [];
function bufferMock(onCreate: () => Response | Promise<Response> = () => HttpResponse.json({ data: { createPost: { __typename: 'PostActionSuccess', post: { id: 'buf_post_1', status: 'sending', externalLink: null, sentAt: null } } } })) {
  bufCalls.length = 0;
  mswServer.use(http.post('https://api.buffer.com', async ({ request }) => {
    const body = (await request.json()) as { query: string; variables: { name?: string; input?: unknown } };
    const q = body.query;
    if (q.includes('__type(')) return introspectionAnswer(body.variables.name!);
    const op = q.includes('createPost') ? 'create' : q.includes('GetPost') ? 'get' : q.includes('organizations') ? 'account' : q.includes('channels') ? 'channels' : 'other';
    bufCalls.push(op);
    if (op === 'account') return HttpResponse.json({ data: { account: { organizations: [{ id: 'org1' }] } } });
    if (op === 'channels') return HttpResponse.json({ data: { channels: [{ id: 'ch_x', name: 'x', service: 'twitter' }] } });
    if (op === 'get') return HttpResponse.json({ data: { post: { id: 'buf_post_1', status: 'sent', externalLink: 'https://x.com/co/status/1', sentAt: '2026-10-20T10:00:05Z' } } });
    const bad = refuseBadCreate(body.variables.input);
    return bad ?? onCreate();
  }));
}
const creates = () => bufCalls.filter((c) => c === 'create').length;

async function bootPosts() {
  const clock = { t: T0 };
  const app = await makeApp({ now: () => clock.t, env: { BUFFER_API_KEY: BUF_KEY }, testRoutes: false });
  apps.push(app);
  const w = (await issueToken('write')).auth;
  const r = (await issueToken('read')).auth;
  const post = (url: string, payload?: object, key: string = randomUUID()) => app.inject({ method: 'POST', url, headers: { ...w, 'idempotency-key': key }, ...(payload === undefined ? {} : { payload }) });
  const get = (url: string) => app.inject({ method: 'GET', url, headers: r });
  return { app, clock, post, get, w, r };
}
const rows = () => db.selectFrom('posts').selectAll().orderBy('created_at').execute();

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
