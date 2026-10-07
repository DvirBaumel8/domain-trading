// v2.16.0 tech-debt part C: no double post, review concurrency, idempotency hygiene, block-list ReDoS, /media limits, F9/F24.
import { randomUUID } from 'node:crypto';
import { delay, http, HttpResponse } from 'msw';
import { sql } from 'kysely';
import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { logCapture, makeApp } from '../helpers/app.js';
import { testDb as db } from '../helpers/db.js';
import { makePng, b64 } from '../helpers/images.js';
import { issueToken } from '../helpers/tokens.js';
import { mswServer } from '../setup/network.js';
import { checkText } from '../../src/services/blocklist.js';
import { requestHash, pruneIdempotencyKeys, STALE_IN_PROGRESS_MS } from '../../src/http/idempotency.js';
import { postsRefresh } from '../../src/services/posting/posts.js';
import { BufferClient } from '../../src/services/posting/buffer.js';

const BUF_KEY = 'buf_fake_key_0123456789abcdefABCDEF';
const T0 = Date.parse('2026-10-20T10:00:00Z');
const apps: FastifyInstance[] = [];
afterEach(async () => { await Promise.all(apps.splice(0).map((a) => a.close())); });

// ---------------------------------------------------------------- posts
const bufCalls: string[] = [];
function bufferMock(onCreate: () => Response | Promise<Response> = () => HttpResponse.json({ data: { createPost: { __typename: 'PostActionSuccess', post: { id: 'buf_post_1', status: 'sending', externalLink: null, sentAt: null } } } })) {
  bufCalls.length = 0;
  mswServer.use(http.post('https://api.buffer.com', async ({ request }) => {
    const q = ((await request.json()) as { query: string }).query;
    const op = q.includes('createPost') ? 'create' : q.includes('GetPost') ? 'get' : q.includes('organizations') ? 'account' : q.includes('channels') ? 'channels' : 'other';
    bufCalls.push(op);
    if (op === 'account') return HttpResponse.json({ data: { account: { organizations: [{ id: 'org1' }] } } });
    if (op === 'channels') return HttpResponse.json({ data: { channels: [{ id: 'ch_x', name: 'x', service: 'twitter' }] } });
    if (op === 'get') return HttpResponse.json({ data: { post: { id: 'buf_post_1', status: 'sent', externalLink: 'https://x.com/co/status/1', sentAt: '2026-10-20T10:00:05Z' } } });
    return onCreate();
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

describe('review concurrency and cost (v2.16.0)', () => {
  it('a second concurrent run is 409 REVIEW_IN_PROGRESS and a scheduled run skips IN_PROGRESS; Google is called once', async () => {
    let calls = 0;
    mswServer.use(http.post(GEMINI, async () => { calls++; await delay(300); return ok(); }));
    const t = await bootReview();
    const first = t.post('/reviews/run');
    await delay(100);
    const second = await t.post('/reviews/run');
    expect(second.statusCode).toBe(409);
    expect(second.json().error.code).toBe('REVIEW_IN_PROGRESS');
    const daily = await t.app.jobRunner.run('daily');
    expect(daily.steps.outsideReview).toMatchObject({ summary: { skipped: true, reason: 'IN_PROGRESS' } });
    expect((await first).statusCode).toBe(200);
    expect(calls).toBe(1);
    // free again afterwards
    expect((await t.post('/reviews/run')).statusCode).toBe(200);
  });

  it('F9: feedback a bot posts never counts toward the monthly cap (cost_usd above 5 is refused); the service\'s own gemini feedback does', async () => {
    const t = await bootReview();
    const packet = (await t.post('/reviews/packet')).json().packet_id as string;
    const over = await t.post(`/reviews/${packet}/feedback`, { status: 'ok', provider: 'bot', model: 'm', cost_usd: 6, items: [] });
    expect(over.statusCode).toBe(422);
    const fb = await t.post(`/reviews/${packet}/feedback`, { status: 'ok', provider: 'bot', model: 'm', cost_usd: 5, items: [] });
    expect(fb.statusCode, fb.body).toBe(201);
    const { monthSpend } = await import('../../src/services/review/packet.js');
    expect((await monthSpend(db, t.clock.t)).spentUsd).toBe(0);
    mswServer.use(http.post(GEMINI, () => ok()));
    expect((await t.post('/reviews/run')).statusCode).toBe(200);
    const second = (await t.post('/reviews/packet')).json().packet_id as string;
    await db.insertInto('review_feedback').values({ packet_id: second, created_by: 'dom-review', status: 'ok', provider: 'gemini', model: 'm', cost_usd: 5 }).execute();
    const capped = await t.post('/reviews/run');
    expect(capped.json().error.code).toBe('REVIEW_COST_CAP');
  });

  it('F24: "changes since" starts at the latest packet that has ok feedback, not at a later packet nobody answered', async () => {
    const t = await bootReview();
    const a = (await t.post('/reviews/packet')).json().packet_id as string;
    const fb = await t.post(`/reviews/${a}/feedback`, { status: 'ok', provider: 'bot', model: 'm', cost_usd: 0, items: [] });
    expect(fb.statusCode).toBe(201);
    const aAt = (await db.selectFrom('review_packets').select('created_at').where('id', '=', a).executeTakeFirstOrThrow()).created_at;
    t.clock.t += 3_600_000;
    expect((await t.post('/reviews/packet')).statusCode).toBe(201); // B: no feedback
    t.clock.t += 3_600_000;
    const preview = await t.post('/reviews/packet', { preview: true });
    const { toJerusalemIso } = await import('../../src/time.js');
    expect(preview.json().content.dom_changes.since).toBe(toJerusalemIso(aAt));
  });
});
