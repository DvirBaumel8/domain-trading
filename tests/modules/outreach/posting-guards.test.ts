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

describe('no double post (v2.16.0)', () => {
  it('a lost Buffer answer is 502 POST_FAILED outcome unknown; the row is unknown and COUNTS toward the cap; the same key replays the 502 with no second Buffer call', async () => {
    bufferMock(() => HttpResponse.error());
    const t = await bootPosts();
    const key = randomUUID();
    const a = await t.post('/posts', { text: 'maybe live' }, key);
    expect(a.statusCode).toBe(502);
    expect(a.json().error).toMatchObject({ code: 'POST_FAILED', details: { step: 'create', kind: 'unavailable', outcome: 'unknown' } });
    expect((await rows()).map((r) => r.status)).toEqual(['unknown']);
    expect((await t.get('/posts')).json().allowance).toMatchObject({ used_today: 1, remaining: 0 });
    const b = await t.post('/posts', { text: 'maybe live' }, key);
    expect(b.statusCode).toBe(502);
    expect(b.headers['idempotent-replayed']).toBe('true');
    expect(b.body).toBe(a.body);
    expect(creates()).toBe(1);
    const c = await t.post('/posts', { text: 'another' });
    expect(c.statusCode).toBe(409);
    expect(c.json().error.code).toBe('POST_DAILY_CAP');
    expect(creates()).toBe(1);
  });

  it('a Buffer 5xx is unknown, a refusal and a 4xx are failed (no allowance used); the key stays the final answer either way', async () => {
    bufferMock(() => HttpResponse.json({ data: { createPost: { __typename: 'MutationError', message: 'Nope' } } }));
    const t = await bootPosts();
    const key = randomUUID();
    const a = await t.post('/posts', { text: 'refused' }, key);
    expect(a.json().error.details).toMatchObject({ kind: 'refused', outcome: 'failed' });
    expect((await rows()).map((r) => r.status)).toEqual(['failed']);
    expect((await t.get('/posts')).json().allowance).toMatchObject({ used_today: 0, remaining: 1 });
    const again = await t.post('/posts', { text: 'refused' }, key);
    expect(again.headers['idempotent-replayed']).toBe('true');
    expect(creates()).toBe(1);
    bufferMock(() => new Response('bad', { status: 400 }));
    const b = await t.post('/posts', { text: 'four hundred' });
    expect(b.json().error.details).toMatchObject({ kind: 'unavailable', status: 400, outcome: 'failed' });
    bufferMock(() => new Response('boom', { status: 502 }));
    const c = await t.post('/posts', { text: 'five hundred' });
    expect(c.json().error.details).toMatchObject({ status: 502, outcome: 'unknown' });
    expect((await rows()).map((r) => r.status)).toEqual(['failed', 'failed', 'unknown']);
  });

  it('a failing database write AFTER Buffer accepted the post cannot lead to a second post: the key keeps its stored answer and the pending row still counts', async () => {
    bufferMock();
    const t = await bootPosts();
    await sql`CREATE OR REPLACE FUNCTION public.zz_fail_posted() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.status = 'posted' THEN RAISE EXCEPTION 'simulated database failure'; END IF; RETURN NEW; END $$`.execute(db);
    await sql`CREATE TRIGGER zz_fail_posted BEFORE UPDATE ON public.posts FOR EACH ROW EXECUTE FUNCTION public.zz_fail_posted()`.execute(db);
    try {
      const key = randomUUID();
      const a = await t.post('/posts', { text: 'db trouble' }, key);
      expect(a.statusCode).toBe(500);
      expect(creates()).toBe(1);
      expect((await rows()).map((r) => r.status)).toEqual(['pending']);
      const b = await t.post('/posts', { text: 'db trouble' }, key);
      expect(b.statusCode).toBe(500);
      expect(b.headers['idempotent-replayed']).toBe('true');
      expect(creates()).toBe(1);
      expect((await t.post('/posts', { text: 'other key' })).statusCode).toBe(409); // the pending row is counted
    } finally {
      await sql`DROP TRIGGER zz_fail_posted ON public.posts`.execute(db);
      await sql`DROP FUNCTION public.zz_fail_posted()`.execute(db);
    }
  });

  it('two concurrent posts with different keys: exactly one goes to Buffer, the other is POST_DAILY_CAP (advisory lock, no in-process mutex)', async () => {
    bufferMock(async () => { await delay(100); return HttpResponse.json({ data: { createPost: { __typename: 'PostActionSuccess', post: { id: 'buf_post_1', status: 'sending', externalLink: null, sentAt: null } } } }); });
    const t = await bootPosts();
    const [a, b] = await Promise.all([t.post('/posts', { text: 'one' }), t.post('/posts', { text: 'two' })]);
    expect([a.statusCode, b.statusCode].sort()).toEqual([201, 409]);
    expect(creates()).toBe(1);
  });

  it('postsRefresh turns a stale pending row into unknown and resolves an unknown row that has a Buffer id', async () => {
    bufferMock();
    const t = await bootPosts();
    const base = { created_by: 'x', text: 't', thread: '[]', idt_day: '2026-10-20' };
    await db.insertInto('posts').values([
      { id: 'pst_aaaaaaaaaaaa', ...base, status: 'pending', buffer_post_id: null, created_at: new Date(T0 - 3_600_000) },
      { id: 'pst_bbbbbbbbbbbb', ...base, status: 'unknown', buffer_post_id: 'buf_post_1', created_at: new Date(T0 - 7_200_000) },
      { id: 'pst_cccccccccccc', ...base, status: 'pending', buffer_post_id: null, created_at: new Date(T0 - 60_000) },
    ]).execute();
    const buffer = new BufferClient({ fetch, apiKey: BUF_KEY });
    const res = await postsRefresh({ db, now: () => T0, secretValues: [], publicBaseUrl: 'https://x.test', buffer });
    expect(res).toMatchObject({ updated: 1 });
    const byId = Object.fromEntries((await rows()).map((r) => [r.id, r]));
    expect(byId.pst_aaaaaaaaaaaa).toMatchObject({ status: 'unknown' });
    expect(byId.pst_bbbbbbbbbbbb).toMatchObject({ status: 'posted', external_link: 'https://x.com/co/status/1' });
    expect(byId.pst_cccccccccccc).toMatchObject({ status: 'pending' }); // still young
    void t;
  });
});

describe('POST /posts and /media guards (F12, v2.16.0)', () => {
  it('a READ token is refused 403 before the body is parsed (a malformed body is not 400); a body over 40 MB is 413 INVALID_BODY', async () => {
    bufferMock();
    const t = await bootPosts();
    const r = await t.app.inject({ method: 'POST', url: '/posts', headers: { ...t.r, 'content-type': 'application/json', 'idempotency-key': randomUUID() }, payload: '{not json' });
    expect(r.statusCode).toBe(403);
    expect(r.json().error.code).toBe('SCOPE_FORBIDDEN');
    const big = await t.app.inject({ method: 'POST', url: '/posts', headers: { ...t.w, 'content-type': 'application/json', 'idempotency-key': randomUUID(), 'content-length': String(41 * 1024 * 1024) }, payload: '{}' });
    expect(big.statusCode).toBe(413);
    expect(big.json().error.code).toBe('INVALID_BODY');
    expect(creates()).toBe(0);
  });

  it('/media: max-age is the seconds left when under an hour, else 3600; the 121st request in a minute from one IP is 429', async () => {
    bufferMock();
    const t = await bootPosts();
    const png = b64(makePng(16, 16));
    const p = await t.post('/posts', { text: 'with picture', images: [{ data_base64: png, alt: 'grey' }] });
    expect(p.statusCode, p.body).toBe(201);
    const { media_token: token } = await db.selectFrom('post_images').select('media_token').executeTakeFirstOrThrow();
    const get = () => t.app.inject({ method: 'GET', url: `/media/${token}` });
    const first = await get();
    expect(first.headers['cache-control']).toBe('public, max-age=3600');
    t.clock.t += 7 * 24 * 3_600_000 - 90_000; // 90 seconds left
    expect((await get()).headers['cache-control']).toBe('public, max-age=90');
    let last = 0;
    for (let i = 0; i < 125 && last !== 429; i++) last = (await get()).statusCode;
    expect(last).toBe(429);
  });
});
