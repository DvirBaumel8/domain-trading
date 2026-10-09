// v3.2.0 part A (CR-017): the Buffer createPost shape, POST /posts/schema-check, the cap/health rules, review_reason, replay and rate limit,
// triggered_by, and the manual tick. MSW only; fake keys. The Buffer mock validates inputs like Buffer's GraphQL layer (tests/helpers/buffer-schema.ts).
import { randomUUID } from 'node:crypto';
import { http, HttpResponse } from 'msw';
import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { makeApp, runJobToEnd } from '../helpers/app.js';
import { testDb as db } from '../helpers/db.js';
import { b64, makePng } from '../helpers/images.js';
import { createPostErrors, introspectionAnswer, refuseBadCreate } from '../helpers/buffer-schema.js';
import { issueToken } from '../helpers/tokens.js';
import { mswServer } from '../setup/network.js';
import { BufferClient, buildCreateInput, SAMPLE_INPUT } from '../../src/modules/outreach/posting/buffer.js';
import { shapeReviewReason } from '../../src/modules/ops/api/health.js';

const KEY = 'buf_fake_key_0123456789abcdefABCDEF';
const T0 = Date.parse('2026-10-20T10:00:00Z');
const apps: FastifyInstance[] = [];
afterEach(async () => { await Promise.all(apps.splice(0).map((a) => a.close())); });

interface Seen { op: string; vars: any }
const seen: Seen[] = [];
const ok = () => HttpResponse.json({ data: { createPost: { __typename: 'PostActionSuccess', post: { id: 'buf_post_1', status: 'sending', externalLink: null, sentAt: null } } } });
/** `typeOverride` lets a test change what introspection says (Buffer changed its API); `onCreate` the create answer. */
function bufferMock(o: { typeOverride?: (name: string) => Response | undefined; onCreate?: (input: unknown) => Response } = {}) {
  seen.length = 0;
  mswServer.use(http.post('https://api.buffer.com', async ({ request }) => {
    const body = (await request.json()) as { query: string; variables: any };
    const q = body.query;
    const op = q.includes('__type(') ? 'schema' : q.includes('createPost') ? 'create' : q.includes('organizations') ? 'account' : q.includes('channels') ? 'channels' : q.includes('GetPost') ? 'get' : 'other';
    seen.push({ op, vars: body.variables });
    if (op === 'schema') return o.typeOverride?.(body.variables.name) ?? introspectionAnswer(body.variables.name);
    if (op === 'account') return HttpResponse.json({ data: { account: { organizations: [{ id: 'org1' }] } } });
    if (op === 'channels') return HttpResponse.json({ data: { channels: [{ id: 'ch_x', name: 'x', service: 'twitter' }] } });
    if (op === 'create') return o.onCreate?.(body.variables.input) ?? refuseBadCreate(body.variables.input) ?? ok();
    return HttpResponse.json({ data: {} });
  }));
}
const ops = () => seen.map((s) => s.op);

async function boot(env: Record<string, string> = { BUFFER_API_KEY: KEY }) {
  const clock = { t: T0 };
  const app = await makeApp({ now: () => clock.t, env, testRoutes: false });
  apps.push(app);
  const w = (await issueToken('write', 'gavriel-write')).auth;
  const r = (await issueToken('read')).auth;
  const post = (url: string, payload?: object, key = randomUUID()) => app.inject({ method: 'POST', url, headers: { ...w, 'idempotency-key': key }, ...(payload === undefined ? {} : { payload }) });
  const get = (url: string) => app.inject({ method: 'GET', url, headers: r });
  return { app, clock, post, get, w, r };
}
const withImage = { text: 'Hello', images: [{ data_base64: b64(makePng(16, 16)), alt: 'A grey square' }], thread: [{ text: 'Part two', images: [{ data_base64: b64(makePng(10, 10)), alt: 'Second' }] }] };

describe('T17-1 the createPost input follows Buffer\'s reference', () => {
  it('T17-1 a real post with an image (and a thread part) is accepted by the validating Buffer mock: assets is a list of {image: {url, metadata: {altText}}}, mode shareNow (3.2.2: Buffer\'s live schema)', async () => {
    bufferMock();
    const t = await boot();
    const r = await t.post('/posts', withImage);
    expect(r.statusCode, r.body).toBe(201);
    const input = seen.find((s) => s.op === 'create')!.vars.input;
    expect(input).toMatchObject({ mode: 'shareNow', schedulingType: 'automatic', needsApproval: false });
    expect(input).not.toHaveProperty('shareMode');
    expect(input.assets).toEqual([{ image: { url: expect.stringMatching(/\/media\/[0-9a-f]{32}$/), metadata: { altText: 'A grey square' } } }]);
    expect(input.metadata.twitter.thread[0].assets).toEqual([{ image: { url: expect.any(String), metadata: { altText: 'Second' } } }]);
    expect(createPostErrors(input)).toEqual([]);
  });

  it('T17-1 the old shape ({assets: {images: [...]}}, mode) is refused by the mock the way Buffer refuses it', async () => {
    const old = { text: 'x', channelId: 'c', schedulingType: 'automatic', mode: 'shareNow', assets: { images: [{ url: 'https://x.test/a', altText: 'a' }] } };
    const errs = createPostErrors(old);
    expect(errs.join('\n')).toMatch(/Field "images" is not defined by type "AssetInput"/);
    expect(errs.join('\n')).toMatch(/needsApproval.*required/);
    // 3.2.0's shape (shareMode, image altText) is refused too
    const v320 = { text: 'x', channelId: 'c', shareMode: 'shareNow', assets: [{ image: { url: 'https://x.test/a', altText: 'a' } }] };
    const errs320 = createPostErrors(v320).join('\n');
    expect(errs320).toMatch(/Field "shareMode" is not defined by type "CreatePostInput"/);
    expect(errs320).toMatch(/Field "altText" is not defined by type "ImageAssetInput"/);
    expect(errs320).toMatch(/mode.*required/);
    // over the wire: a GraphQL error, which the client reports as `refused`
    bufferMock();
    const c = new BufferClient({ fetch: globalThis.fetch, apiKey: KEY });
    const send = await fetch('https://api.buffer.com', { method: 'POST', body: JSON.stringify({ query: 'mutation { createPost(input: $input) { __typename } }', variables: { input: old } }) });
    expect(((await send.json()) as { errors: unknown[] }).errors.length).toBeGreaterThan(0);
    // and the schema check, run against the current builder, accepts the new shape while rejecting the old one
    expect((await c.checkSchema()).ok).toBe(true);
    const bad = await c.checkSchema(old);
    expect(bad.ok).toBe(false);
    expect(bad.problems.join('\n')).toMatch(/input\.assets must be a list/);
  });

  it('the builder: no images = an empty assets list (required by CreatePostInput and ThreadedPostInput)', () => {
    const i = buildCreateInput('c', { text: 'a', images: [] }, [{ text: 'b', images: [] }]) as any;
    expect(i.assets).toEqual([]);
    expect(i.metadata.twitter.thread).toEqual([{ text: 'b', assets: [] }]);
    expect(createPostErrors(i)).toEqual([]);
    expect(createPostErrors(SAMPLE_INPUT)).toEqual([]);
  });
});

describe('T17-2 POST /posts/schema-check', () => {
  it('T17-2 T17-2b ok against the reference types (and returns the types): read-only introspection only, no create, audited, Idempotency-Key required', async () => {
    bufferMock();
    const t = await boot();
    const r = await t.post('/posts/schema-check');
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json()).toMatchObject({ ok: true, problems: [], checked_types: expect.arrayContaining(['CreatePostInput', 'AssetInput', 'ImageAssetInput', 'TwitterPostMetadataInput', 'ThreadedPostInput']) });
    expect(r.json().types.CreatePostInput).toMatchObject({ kind: 'input_object', fields: expect.objectContaining({ mode: 'ShareMode!', assets: '[AssetInput!]!' }) });
    expect(Object.keys(r.json().types)).toEqual(expect.arrayContaining(['ImageMetadataInput', 'ThreadedPostInput'])); // only X's metadata is followed, so these fit in the answer // T17-2b (3.2.1): Buffer's definitions are returned
    expect(new Set(ops())).toEqual(new Set(['schema']));
    const audit = await db.selectFrom('audit_log').selectAll().where('path', '=', '/posts/schema-check').executeTakeFirstOrThrow();
    expect(audit).toMatchObject({ status_code: 200 });
    const noKey = await t.app.inject({ method: 'POST', url: '/posts/schema-check', headers: t.w });
    expect(noKey.statusCode).toBe(400);
    expect(noKey.json().error.code).toBe('IDEMPOTENCY_KEY_REQUIRED');
    expect((await t.app.inject({ method: 'POST', url: '/posts/schema-check', headers: { ...t.r, 'idempotency-key': randomUUID() } })).statusCode).toBeGreaterThanOrEqual(401); // a READ token cannot write
  });

  it('T17-2 reports problems when Buffer\'s types differ: a missing field, a non-list assets, a missing required field', async () => {
    // a Buffer that changed: a CreatePostInput without `mode` and `metadata`, with a new required field
    const field = (name: string, type: any) => ({ name, type });
    bufferMock({
      typeOverride: (name) => {
        if (name === 'CreatePostInput') return HttpResponse.json({ data: { __type: { name, kind: 'INPUT_OBJECT', enumValues: null, inputFields: [field('text', { kind: 'NON_NULL', name: null, ofType: { kind: 'SCALAR', name: 'String' } }), field('channelId', { kind: 'NON_NULL', name: null, ofType: { kind: 'SCALAR', name: 'ID' } }), field('assets', { kind: 'LIST', name: null, ofType: { kind: 'INPUT_OBJECT', name: 'AssetInput' } }), field('newRequired', { kind: 'NON_NULL', name: null, ofType: { kind: 'SCALAR', name: 'String' } })] } } });
        if (name === 'ThreadedPostInput') return HttpResponse.json({ data: { __type: { name, kind: 'INPUT_OBJECT', enumValues: null, inputFields: [field('text', { kind: 'NON_NULL', name: null, ofType: { kind: 'SCALAR', name: 'String' } })] } } });
        return undefined;
      },
    });
    const t = await boot();
    const r = await t.post('/posts/schema-check');
    expect(r.statusCode).toBe(200);
    const j = r.json();
    expect(j.ok).toBe(false);
    const text = j.problems.join('\n');
    expect(text).toMatch(/input\.mode is not a field of CreatePostInput/);
    expect(text).toMatch(/input\.newRequired is required/);
    expect(text).toMatch(/input\.metadata is not a field of CreatePostInput/);
  });

  it('T17-2 503 POSTING_NOT_CONFIGURED without a Buffer key; no network', async () => {
    const t = await boot({});
    const r = await t.post('/posts/schema-check');
    expect(r.statusCode).toBe(503);
    expect(r.json().error.code).toBe('POSTING_NOT_CONFIGURED');
  });

  it('T17-2 a real POST /posts runs the check first: a mismatch is 502 POST_FAILED step schema, create is never called, no row, no allowance used, the key is released', async () => {
    bufferMock({ typeOverride: (name) => (name === 'ThreadedPostInput' ? HttpResponse.json({ data: { __type: null } }) : undefined) });
    const t = await boot();
    const key = randomUUID();
    const r = await t.post('/posts', withImage, key);
    expect(r.statusCode).toBe(502);
    expect(r.json().error).toMatchObject({ code: 'POST_FAILED', details: { step: 'schema', outcome: 'failed', problems: expect.any(Array), checked_types: expect.any(Array) } });
    expect(ops()).not.toContain('create');
    expect(await db.selectFrom('posts').selectAll().execute()).toHaveLength(0);
    expect((await t.get('/posts')).json().allowance).toMatchObject({ used_today: 0, remaining: 1 });
    // Buffer fixed: the same key works again
    bufferMock();
    expect((await t.post('/posts', withImage, key)).statusCode).toBe(201);
  });

  it('T17-2 the introspection is cached for an hour (one set of __type calls for two posts-checks), then asked again', async () => {
    bufferMock();
    const t = await boot();
    await t.post('/posts/schema-check');
    const first = ops().length;
    await t.post('/posts/schema-check');
    expect(ops().length).toBe(first);
    t.clock.t += 61 * 60_000;
    await t.post('/posts/schema-check');
    expect(ops().length).toBe(first * 2);
  });

  it('T17-2 the dry run and the schema step stay offline for a dry run: no Buffer call', async () => {
    bufferMock();
    const t = await boot();
    const r = await t.post('/posts', { ...withImage, dry_run: true });
    expect(r.statusCode).toBe(200);
    expect(seen).toHaveLength(0);
  });
});

describe('T17-3 a failed post: cap and retry', () => {
  it('T17-3 a Buffer refusal leaves a failed row that does not count (used_today 0); a retry with a NEW key and the same body works the same day; the old key replays the 502', async () => {
    bufferMock({ onCreate: () => HttpResponse.json({ errors: [{ message: 'Variable "$input" got invalid value' }] }) });
    const t = await boot();
    const k1 = randomUUID();
    const f = await t.post('/posts', withImage, k1);
    expect(f.statusCode).toBe(502);
    expect(f.json().error.details).toMatchObject({ step: 'create', outcome: 'failed' });
    expect((await db.selectFrom('posts').select('status').execute()).map((x) => x.status)).toEqual(['failed']);
    expect((await t.get('/posts')).json().allowance).toEqual({ today_cap: 1, used_today: 0, remaining: 1 });
    bufferMock();
    const replay = await t.post('/posts', withImage, k1);
    expect(replay.statusCode).toBe(502);
    expect(replay.headers['idempotent-replayed']).toBe('true');
    expect(ops()).not.toContain('create');
    const retry = await t.post('/posts', withImage, randomUUID());
    expect(retry.statusCode, retry.body).toBe(201);
    expect((await t.get('/posts')).json().allowance).toEqual({ today_cap: 1, used_today: 1, remaining: 0 });
    expect((await db.selectFrom('posts').select('status').orderBy('created_at').execute()).map((x) => x.status)).toEqual(['failed', 'posted']);
  });
});

describe('T25-1 vendor test posts do not use the daily allowance (v3.3.1, CR-025)', () => {
  it('T25-1 a post listed in post_allowance_exclusions no longer counts: the slot is free again and a new post goes out the same day; the list is append-only', async () => {
    bufferMock();
    const t = await boot();
    expect((await t.post('/posts', withImage, randomUUID())).statusCode).toBe(201);
    expect((await t.get('/posts')).json().allowance).toEqual({ today_cap: 1, used_today: 1, remaining: 0 });
    expect((await t.post('/posts', withImage, randomUUID())).statusCode).toBe(409);
    const first = await db.selectFrom('posts').select('id').where('status', '=', 'posted').executeTakeFirstOrThrow();
    await db.insertInto('post_allowance_exclusions').values({ post_id: first.id, reason: 'vendor test' }).execute();
    expect((await t.get('/posts')).json().allowance).toEqual({ today_cap: 1, used_today: 0, remaining: 1 });
    expect((await t.post('/posts', withImage, randomUUID())).statusCode).toBe(201);
    expect((await t.get('/posts')).json().allowance).toEqual({ today_cap: 1, used_today: 1, remaining: 0 });
    await expect(db.deleteFrom('post_allowance_exclusions').execute()).rejects.toThrow();
  });
});

describe('T17-4 /health posting follows the latest post', () => {
  it('T17-4 failed after a failed post, ok after the next success', async () => {
    bufferMock({ onCreate: () => HttpResponse.json({ errors: [{ message: 'refused' }] }) });
    const t = await boot();
    await t.post('/posts', { text: 'one' });
    const bad = (await t.get('/health')).json();
    expect(bad.posting).toBe('failed');
    expect(bad.posting_reason).toMatch(/refused/);
    bufferMock();
    t.clock.t += 60_000;
    expect((await t.post('/posts', { text: 'two' })).statusCode).toBe(201);
    const good = (await t.get('/health')).json();
    expect(good).toMatchObject({ posting: 'ok', posting_reason: null });
  });
});

describe('T17-5 /health review_reason is `CODE: text`, at most 200 characters', () => {
  const key = 'AIza-fake-key-for-review';
  it('T17-5 uses the Google status, or HTTP <n>; scrubs the key', () => {
    expect(shapeReviewReason('HTTP 503 UNAVAILABLE: This model is currently experiencing high demand.', [key])).toBe('UNAVAILABLE: This model is currently experiencing high demand.');
    expect(shapeReviewReason('HTTP 429 none: Quota exceeded', [key])).toBe('HTTP 429: Quota exceeded');
    expect(shapeReviewReason(`HTTP 400 INVALID_ARGUMENT: bad key ${key}`, [key])).not.toContain(key);
    expect(shapeReviewReason('HTTP none none: network', [])).toBe('UNKNOWN: network');
  });
  it('T17-5 a long reason is cut at a word boundary with an ellipsis, at most 200 characters', () => {
    const long = `HTTP 503 UNAVAILABLE: ${'overloaded model, please try again later '.repeat(30)}`;
    const r = shapeReviewReason(long, []);
    expect(r.length).toBeLessThanOrEqual(200);
    expect(r.endsWith('…')).toBe(true);
    expect(r.startsWith('UNAVAILABLE: ')).toBe(true);
    expect(r.slice(0, -1)).toMatch(/[a-z]$/); // not mid-word: the cut text ends on a whole word
    expect(long).toContain(r.slice('UNAVAILABLE: '.length, -1));
  });
});

describe('T17-6 an idempotent replay does not use a rate-limit slot', () => {
  it('T17-6 15 replays of one completed request never 429 and leave ratelimit-remaining unchanged; a different request still has its slots', async () => {
    const t = await boot({});
    const key = randomUUID();
    const first = await t.post('/posts/pause', { paused: false }, key);
    expect(first.statusCode).toBe(200);
    const remaining = Number(first.headers['ratelimit-remaining']);
    expect(remaining).toBe(9);
    for (let i = 0; i < 15; i++) {
      const r = await t.post('/posts/pause', { paused: false }, key);
      expect(r.statusCode).toBe(200);
      expect(r.headers['idempotent-replayed']).toBe('true');
      expect(Number(r.headers['ratelimit-remaining'])).toBe(remaining);
    }
    // 9 more distinct requests fit (10 per minute in all), the 11th is limited
    const codes: number[] = [];
    for (let i = 0; i < 10; i++) codes.push((await t.post('/posts/pause', { paused: false, reason: `r${i}` })).statusCode);
    expect(codes.filter((c) => c === 429)).toHaveLength(1);
    // a replay still gets through while the window is full
    expect((await t.post('/posts/pause', { paused: false }, key)).headers['idempotent-replayed']).toBe('true');
    // a mismatched reuse of the key is not a replay: it counts (and is refused 429 here)
    expect((await t.post('/posts/pause', { paused: true, reason: 'other' }, key)).statusCode).toBe(429);
  });
});

describe('N-3 triggered_by is never null', () => {
  it('the CLI trigger records `cli`; a queued run and its job_runs row agree', async () => {
    const t = await boot({});
    await t.app.jobRunner.run('tick', { trigger: 'cli' });
    const row = await db.selectFrom('job_runs').selectAll().where('job', '=', 'tick').orderBy('id', 'desc').executeTakeFirstOrThrow();
    expect(row.triggered_by).toBe('cli');
    const viaApi = await runJobToEnd(t.app, 'tick', { headers: t.w });
    expect(viaApi.statusCode).toBe(202);
    const q = await db.selectFrom('job_queue_runs').select('triggered_by').orderBy('created_at', 'desc').executeTakeFirstOrThrow();
    expect(q.triggered_by).toBe('gavriel-write');
    const rows = await db.selectFrom('job_runs').select('triggered_by').execute();
    expect(rows.every((r) => r.triggered_by !== null)).toBe(true);
  });
});

describe('T17-8 a manual tick runs reviewRetry when one is pending', () => {
  it('T17-8 POST /jobs/run tick (WRITE) retries the pending review once (one Google call); with nothing pending it does not call Google', async () => {
    const GKEY = 'test-gemini-key';
    let g = 0;
    let mode: 'busy' | 'ok' = 'busy';
    mswServer.use(http.post(/generativelanguage\.googleapis\.com\/v1beta\/models\/[^/]+:generateContent/, async () => {
      g++;
      return mode === 'busy'
        ? HttpResponse.json({ error: { code: 429, status: 'RESOURCE_EXHAUSTED', message: 'Quota' } }, { status: 429 })
        : HttpResponse.json({ candidates: [{ finishReason: 'STOP', content: { parts: [{ text: JSON.stringify({ items: [{ category: 'pricing', severity: 'low', text: 'Keep the plan.' }] }) }] } }], usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 20 } });
    }));
    const t = await boot({ GEMINI_API_KEY: GKEY });
    expect((await t.post('/company/document', { text: 'We buy short .com names and sell them at a fixed price.' })).statusCode).toBeLessThan(300);
    await t.app.jobRunner.run('daily');
    expect(await db.selectFrom('review_retries').selectAll().execute()).toHaveLength(1);
    const callsBefore = g;
    mode = 'ok';
    const tick = await runJobToEnd(t.app, 'tick', { headers: t.w });
    expect(tick.json().steps.reviewRetry.summary).toMatchObject({ status: 'ok' });
    expect(g).toBe(callsBefore + 1);
    const again = await runJobToEnd(t.app, 'tick', { headers: t.w });
    expect(again.json().steps.reviewRetry.summary).toMatchObject({ skipped: true, reason: 'NOTHING_PENDING' });
    expect(g).toBe(callsBefore + 1);
  });
});
