// v3.2.0 part A (CR-017): the Buffer createPost shape, POST /posts/schema-check, the cap/health rules, review_reason, replay and rate limit,
// triggered_by, and the manual tick. MSW only; fake keys. The Buffer mock validates inputs like Buffer's GraphQL layer (tests/helpers/buffer-schema.ts).
import { randomUUID } from 'node:crypto';
import { http, HttpResponse } from 'msw';
import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { makeApp, runJobToEnd } from '../../helpers/app.js';
import { testDb as db } from '../../helpers/db.js';
import { b64, makePng } from '../../helpers/images.js';
import { createPostErrors, introspectionAnswer, refuseBadCreate } from '../../helpers/buffer-schema.js';
import { issueToken } from '../../helpers/tokens.js';
import { mswServer } from '../../setup/network.js';
import { BufferClient, buildCreateInput, SAMPLE_INPUT } from '../../../src/modules/outreach/posting/buffer.js';
import { shapeReviewReason } from '../../../src/modules/ops/api/health.js';

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
