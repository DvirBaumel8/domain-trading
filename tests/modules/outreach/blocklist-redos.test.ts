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

// ---------------------------------------------------------------- block list
describe('block list ReDoS (v2.16.0)', () => {
  it('a 65,000-character run of letters is checked in under 200 ms, with and without an @', async () => {
    for (const text of ['a'.repeat(65_000), `${'a'.repeat(65_000)}@${'b'.repeat(65_000)}`, 'a@'.repeat(32_000), `x@${'a-'.repeat(32_000)}`]) {
      const t0 = performance.now();
      const r = await checkText(db, text);
      expect(performance.now() - t0).toBeLessThan(200);
      expect(r.ok === true || r.category === 'email').toBe(true);
    }
    expect(await checkText(db, 'write to someone@example.com please')).toEqual({ ok: false, category: 'email' });
  });
});

// ---------------------------------------------------------------- reviews
const GEMINI = /generativelanguage\.googleapis\.com\/v1beta\/models\/[^/]+:generateContent/;
const ok = () => HttpResponse.json({ candidates: [{ finishReason: 'STOP', content: { parts: [{ text: JSON.stringify({ items: [{ category: 'risk', severity: 'low', text: 'fine' }] }) }] } }], usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 } });

async function bootReview() {
  const clock = { t: Date.parse('2026-10-20T09:00:00Z') };
  const app = await makeApp({ now: () => clock.t, env: { GEMINI_API_KEY: 'test-gemini-key' }, logStream: logCapture().stream });
  apps.push(app);
  const w = (await issueToken('write')).auth;
  const post = (url: string, payload?: object) => app.inject({ method: 'POST', url, headers: { ...w, 'idempotency-key': randomUUID() }, ...(payload === undefined ? {} : { payload }) });
  expect((await post('/company/document', { text: 'We buy short .com names and sell them at a fixed price.' })).statusCode).toBe(201);
  return { app, clock, post };
}
