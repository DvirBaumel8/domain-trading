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
