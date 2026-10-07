// v2.12.0 (CR-011 part A through Buffer, addendum A images): posts to the company's X account. MSW for api.buffer.com, fake key.
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { http, HttpResponse } from 'msw';
import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { logCapture, makeApp } from '../helpers/app.js';
import { testDb as db } from '../helpers/db.js';
import { b64, commentSegment, exifSegment, makeJpeg, makePng, textChunk } from '../helpers/images.js';
import { issueToken } from '../helpers/tokens.js';
import { mswServer } from '../setup/network.js';
import { inspectImage } from '../../src/services/posting/images.js';

const KEY = 'buf_fake_key_0123456789abcdefABCDEF';
const BASE = 'https://domain-trading-api.onrender.com';
const T0 = Date.parse('2026-10-20T10:00:00Z'); // 13:00 IDT
const DAY = 24 * 3_600_000;
const apps: FastifyInstance[] = [];
afterEach(async () => { await Promise.all(apps.splice(0).map((a) => a.close())); });

interface Call { op: string; body: { query: string; variables: { input?: any } }; auth: string | null }
const calls: Call[] = [];
const opOf = (q: string) => (q.includes('createPost') ? 'create' : q.includes('deletePost') ? 'delete' : q.includes('GetPost') ? 'get' : q.includes('organizations') ? 'account' : q.includes('channels') ? 'channels' : 'other');
type Answer = (c: Call) => Response | undefined;
const created = (over: Record<string, unknown> = {}) => HttpResponse.json({ data: { createPost: { __typename: 'PostActionSuccess', post: { id: 'buf_post_1', status: 'sending', externalLink: null, sentAt: null, ...over } } } });
function bufferMock(answer: Answer = () => undefined) {
  calls.length = 0;
  mswServer.use(http.post('https://api.buffer.com', async ({ request }) => {
    const body = (await request.json()) as Call['body'];
    const c: Call = { op: opOf(body.query), body, auth: request.headers.get('authorization') };
    calls.push(c);
    const a = answer(c);
    if (a) return a;
    if (c.op === 'account') return HttpResponse.json({ data: { account: { organizations: [{ id: 'org1' }] } } });
    if (c.op === 'channels') return HttpResponse.json({ data: { channels: [{ id: 'ch_ig', name: 'ig', service: 'instagram' }, { id: 'ch_x', name: 'x', service: 'twitter' }] } });
    if (c.op === 'create') return created();
    if (c.op === 'delete') return HttpResponse.json({ data: { deletePost: { __typename: 'DeletePostSuccess' } } });
    if (c.op === 'get') return HttpResponse.json({ data: { post: { id: 'buf_post_1', status: 'sent', externalLink: 'https://x.com/co/status/1', sentAt: '2026-10-20T10:00:05Z' } } });
    return HttpResponse.json({ data: {} });
  }));
}

async function boot(opts: { env?: Record<string, string>; clock?: { t: number }; logStream?: ReturnType<typeof logCapture>['stream'] } = {}) {
  const clock = opts.clock ?? { t: T0 };
  const env = opts.env ?? { BUFFER_API_KEY: KEY };
  const app = await makeApp({ now: () => clock.t, env, logStream: opts.logStream, testRoutes: false });
  apps.push(app);
  const w = (await issueToken('write')).auth;
  const r = (await issueToken('read')).auth;
  const post = (url: string, payload?: object, key = randomUUID()) => app.inject({ method: 'POST', url, headers: { ...w, 'idempotency-key': key }, ...(payload === undefined ? {} : { payload }) });
  const get = (url: string) => app.inject({ method: 'GET', url, headers: r });
  return { app, clock, post, get, w, r };
}
const img = (data: Buffer, alt = 'A grey square') => ({ data_base64: b64(data), alt });
const png = () => makePng(16, 16);
const postRows = () => db.selectFrom('posts').selectAll().orderBy('created_at').execute();

describe('POST /posts dry run (T11-1, T11-30)', () => {
  it('reports lengths, images and the allowance; no Buffer call, no allowance used', async () => {
    bufferMock();
    const t = await boot();
    const r = await t.post('/posts', { text: 'Hello from the company', images: [img(png())], dry_run: true });
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json()).toEqual({
      dry_run: true, ok: true,
      parts: [{ part: 1, length: 22, limit: 280, ok: true }],
      images: [{ part: 1, position: 1, ok: true, width: 16, height: 16, bytes: expect.any(Number) }],
      allowance: { today_cap: 1, used_today: 0, remaining: 1 },
    });
    expect(calls).toHaveLength(0);
    expect(await postRows()).toHaveLength(0);
    expect(await db.selectFrom('post_images').selectAll().execute()).toHaveLength(0);
  });

  it('a dry run with a bad text and bad images answers 200 ok:false with the reasons and category only', async () => {
    bufferMock();
    const t = await boot();
    const r = await t.post('/posts', {
      text: 'mail me: someone@example.com',
      images: [{ data_base64: b64(png()) }, { data_base64: b64(png()), alt: 'call +1 415 555 0132 now' }],
      dry_run: true,
    });
    expect(r.statusCode).toBe(200);
    const j = r.json();
    expect(j.ok).toBe(false);
    expect(j.parts[0]).toMatchObject({ ok: false, reason: 'TEXT_BLOCKED', category: 'email' });
    expect(j.images.map((i: { reason: string }) => i.reason)).toEqual(['ALT_MISSING', 'ALT_BLOCKED']);
    expect(j.images[1].category).toBe('phone');
    expect(r.body).not.toContain('someone@example.com');
    expect(r.body).not.toContain('555 0132');
    expect(calls).toHaveLength(0);
  });

  it('works while paused and without a key', async () => {
    const t = await boot({ env: {} });
    await t.post('/posts/pause', { paused: true, reason: 'test' });
    const r = await t.post('/posts', { text: 'hi', dry_run: true });
    expect(r.statusCode).toBe(200);
  });
});

describe('text rules (T11-2, T11-3)', () => {
  it('a URL counts 23 characters: 280 passes, 281 is POST_TOO_LONG with the counted length', async () => {
    bufferMock();
    const t = await boot();
    const url = 'https://example.com/a/very/long/path/that/would/not/fit/in/a/tweet/if/counted/by/characters';
    const ok = `${'a'.repeat(280 - 24)} ${url}`; // 256 + 1 + 23 = 280
    const dry = await t.post('/posts', { text: ok, dry_run: true });
    expect(dry.json().parts[0]).toMatchObject({ length: 280, ok: true });
    const long = await t.post('/posts', { text: `b${ok}` });
    expect(long.statusCode).toBe(422);
    expect(long.json().error).toMatchObject({ code: 'POST_TOO_LONG', details: { length: 281, limit: 280, part: 1 } });
    expect(calls).toHaveLength(0);
  });

  it('CJK and emoji count 2', async () => {
    const t = await boot();
    const r = await t.post('/posts', { text: '域'.repeat(141), dry_run: true });
    expect(r.json().parts[0]).toMatchObject({ length: 282, ok: false, reason: 'TOO_LONG' });
  });

  it('the block list refuses a secret, an email, a phone and a listed term with the category only', async () => {
    bufferMock();
    const t = await boot();
    await t.post('/company/forbidden-terms', { term: 'blueberry' });
    const cases: [string, string][] = [
      [`key ${KEY}`, 'secret'], ['write me at a.b@example.org', 'email'], ['call 0501234567 today', 'phone'], ['I like blueberry pie', 'listed_term'],
    ];
    for (const [text, category] of cases) {
      const r = await t.post('/posts', { text });
      expect(r.statusCode, text).toBe(422);
      expect(r.json().error).toMatchObject({ code: 'TEXT_BLOCKED', details: { category } });
      expect(r.body).not.toContain('blueberry');
      expect(r.body).not.toContain(KEY);
    }
    expect(calls).toHaveLength(0);
  });

  it('a thread part is checked too (part number in the error)', async () => {
    const t = await boot();
    const r = await t.post('/posts', { text: 'ok', thread: [{ text: 'fine' }, { text: 'x'.repeat(281) }] });
    expect(r.json().error).toMatchObject({ code: 'POST_TOO_LONG', details: { part: 3, length: 281 } });
  });
});

describe('images (T11-28..T11-34)', () => {
  it('every refusal is POST_INVALID with part, position and reason; alt block names the category, never the text', async () => {
    bufferMock();
    const t = await boot();
    await t.post('/company/forbidden-terms', { term: 'blueberry' });
    const big = Buffer.concat([png(), Buffer.alloc(5 * 1024 * 1024)]);
    const images = [
      { data_base64: b64(Buffer.from('GIF89a not an accepted type')), alt: 'a' }, // 1 IMAGE_TYPE
      { data_base64: b64(png().subarray(0, 40)), alt: 'a' }, // 2 IMAGE_CORRUPT (truncated)
      { data_base64: b64(big), alt: 'a' }, // 3 IMAGE_TOO_LARGE
      { data_base64: b64(makePng(2, 2)), alt: 'a' }, // 4 IMAGE_DIMENSIONS
      { data_base64: b64(png()), alt: 'a' }, // 5 TOO_MANY_IMAGES
    ];
    const r = await t.post('/posts', { text: 'pics', images });
    expect(r.statusCode).toBe(422);
    expect(r.json().error.code).toBe('POST_INVALID');
    expect(r.json().error.details.images).toEqual([
      { part: 1, position: 1, reason: 'IMAGE_TYPE' }, { part: 1, position: 2, reason: 'IMAGE_CORRUPT' }, { part: 1, position: 3, reason: 'IMAGE_TOO_LARGE' },
      { part: 1, position: 4, reason: 'IMAGE_DIMENSIONS' }, { part: 1, position: 5, reason: 'TOO_MANY_IMAGES' },
    ]);
    const alts = await t.post('/posts', {
      text: 'pics', thread: [{ text: 'more', images: [
        { data_base64: b64(png()) }, { data_base64: b64(png()), alt: 'x'.repeat(1001) }, { data_base64: b64(png()), alt: 'blueberry muffin' }, { data_base64: b64(png()), alt: '  ' },
      ] }],
    });
    expect(alts.json().error.details.images).toEqual([
      { part: 2, position: 1, reason: 'ALT_MISSING' }, { part: 2, position: 2, reason: 'ALT_TOO_LONG' },
      { part: 2, position: 3, reason: 'ALT_BLOCKED', category: 'listed_term' }, { part: 2, position: 4, reason: 'ALT_MISSING' },
    ]);
    expect(alts.body).not.toContain('blueberry');
    expect(calls).toHaveLength(0);
    expect(await postRows()).toHaveLength(0);
  });

  it('too large is also found on the base64 length and a bad base64 is IMAGE_CORRUPT', async () => {
    expect(inspectImage('A'.repeat(8 * 1024 * 1024))).toMatchObject({ ok: false, reason: 'IMAGE_TOO_LARGE' });
    expect(inspectImage('not base64!!')).toMatchObject({ ok: false, reason: 'IMAGE_CORRUPT' });
    expect(inspectImage(b64(makePng(8193, 8)))).toMatchObject({ ok: false, reason: 'IMAGE_DIMENSIONS', width: 8193 });
    expect(inspectImage(b64(makePng(8192, 4)))).toMatchObject({ ok: true, width: 8192, height: 4 });
  });

  it('metadata is stripped: JPEG APP1/COM and PNG tEXt are gone, the files still parse, the dimensions survive', async () => {
    const jpeg = makeJpeg(20, 10, [exifSegment('GPS 32.08N 34.78E Canon'), commentSegment('secret comment')]);
    const png2 = makePng(12, 9, [textChunk('Author', 'Dvir at home'), textChunk('Software', 'Photoshop')]);
    expect(jpeg.includes('Canon')).toBe(true);
    expect(png2.includes('Photoshop')).toBe(true);
    const j = inspectImage(b64(jpeg));
    const p = inspectImage(b64(png2));
    expect(j).toMatchObject({ ok: true, mime: 'image/jpeg', width: 20, height: 10 });
    expect(p).toMatchObject({ ok: true, mime: 'image/png', width: 12, height: 9 });
    if (!j.ok || !p.ok) throw new Error('unreachable');
    expect(j.data.includes('Canon')).toBe(false);
    expect(j.data.includes('secret comment')).toBe(false);
    expect(j.data.includes('JFIF')).toBe(true); // APP0 stays
    expect(p.data.includes('Photoshop')).toBe(false);
    expect(p.data.includes('Dvir')).toBe(false);
    // the stripped files are still valid for the same parser, and stripping twice changes nothing
    expect(inspectImage(b64(j.data))).toMatchObject({ ok: true, sha256: j.sha256 });
    expect(inspectImage(b64(p.data))).toMatchObject({ ok: true, sha256: p.sha256 });
    expect(j.data.length).toBeLessThan(jpeg.length);
    expect(p.data.length).toBeLessThan(png2.length);
  });

  it('a PNG with a bad chunk CRC is IMAGE_CORRUPT', () => {
    const bad = Buffer.from(makePng());
    bad[bad.length - 20]! ^= 0xff;
    expect(inspectImage(b64(bad))).toMatchObject({ ok: false, reason: 'IMAGE_CORRUPT' });
  });
});

describe('a real post (T11-4, T11-7, T11-28)', () => {
  it('2 images + a thread of 2: the Buffer request carries the image links, alt texts and thread in order; the answer, the row and the images', async () => {
    bufferMock((c) => (c.op === 'create' ? created({ externalLink: 'https://x.com/co/status/9', sentAt: '2026-10-20T10:00:03Z' }) : undefined));
    const t = await boot();
    const jpeg = makeJpeg(30, 20, [exifSegment('Canon')]);
    const r = await t.post('/posts', {
      text: 'Launch day', images: [img(png(), 'first picture'), img(jpeg, 'second picture')],
      thread: [{ text: 'Part two', images: [img(makePng(10, 10), 'third picture')] }, { text: 'Part three' }],
    });
    expect(r.statusCode, r.body).toBe(201);
    const j = r.json();
    expect(j).toMatchObject({
      post_id: expect.stringMatching(/^pst_[0-9a-f]{12}$/), buffer_post_id: 'buf_post_1', status: 'posted', external_link: 'https://x.com/co/status/9',
      sent_at: '2026-10-20T13:00:03+03:00', allowance: { today_cap: 1, used_today: 1, remaining: 0 },
    });
    expect(j.images.map((i: { part: number; position: number }) => [i.part, i.position])).toEqual([[1, 1], [1, 2], [2, 1]]);
    expect(calls.map((c) => c.op)).toEqual(['account', 'channels', 'create']);
    expect(calls.every((c) => c.auth === `Bearer ${KEY}`)).toBe(true);
    const input = calls[2]!.body.variables.input;
    expect(input).toMatchObject({ text: 'Launch day', channelId: 'ch_x', schedulingType: 'automatic', mode: 'shareNow' });
    const urls = input.assets.images.map((i: { url: string }) => i.url);
    expect(urls).toHaveLength(2);
    for (const u of urls) expect(u).toMatch(new RegExp(`^${BASE}/media/[0-9a-f]{32}$`));
    expect(input.assets.images.map((i: { altText: string }) => i.altText)).toEqual(['first picture', 'second picture']);
    const thread = input.metadata.twitter.thread;
    expect(thread.map((p: { text: string }) => p.text)).toEqual(['Part two', 'Part three']);
    expect(thread[0].assets.images).toEqual([{ url: expect.stringMatching(/\/media\/[0-9a-f]{32}$/), altText: 'third picture' }]);
    expect(thread[1].assets).toBeUndefined();
    // the row, the images (metadata-free bytes) and the READ routes
    const [row] = await postRows();
    expect(row).toMatchObject({ id: j.post_id, status: 'posted', created_by: expect.any(String), idt_day: '2026-10-20', thread: [{ text: 'Part two' }, { text: 'Part three' }] });
    const stored = await db.selectFrom('post_images').selectAll().orderBy('part').orderBy('position').execute();
    expect(stored.map((s) => [s.part, s.position, s.mime, s.alt])).toEqual([[1, 1, 'image/png', 'first picture'], [1, 2, 'image/jpeg', 'second picture'], [2, 1, 'image/png', 'third picture']]);
    expect(stored[1]!.data!.includes('Canon')).toBe(false);
    const list = (await t.get('/posts')).json();
    expect(list.posts).toHaveLength(1);
    expect(list.posts[0]).toMatchObject({ id: j.post_id, text: 'Launch day', status: 'posted', external_link: 'https://x.com/co/status/9', images: [{ part: 1, position: 1, alt: 'first picture', stored: true }, expect.anything(), expect.anything()] });
    expect(list.posting).toMatchObject({ paused: false });
    const bytes = await t.get(`/posts/${j.post_id}/images/1/2`);
    expect(bytes.statusCode).toBe(200);
    expect(bytes.headers['content-type']).toBe('image/jpeg');
    expect(bytes.rawPayload.equals(stored[1]!.data!)).toBe(true);
    expect((await t.get(`/posts/${j.post_id}/images/3/1`)).statusCode).toBe(404);
    expect((await t.get('/posts/pst_000000000000/images/1/1')).statusCode).toBe(404);
    // audit: the text and the image data never appear, the shape does
    const auditRow = await db.selectFrom('audit_log').select('request').where('path', '=', '/posts').executeTakeFirstOrThrow();
    const audit = { request: JSON.stringify(auditRow.request) };
    expect(audit.request).toContain('[TEXT 10 chars]');
    expect(audit.request).toContain('[IMAGE ');
    expect(audit.request).not.toContain('Launch day');
    expect(audit.request).not.toContain('first picture');
    expect(audit.request).not.toContain(b64(png()).slice(0, 40));
  });

  it('the idempotent replay answers the same and makes exactly one Buffer post', async () => {
    bufferMock();
    const t = await boot();
    const key = randomUUID();
    const a = await t.post('/posts', { text: 'once' }, key);
    const b = await t.post('/posts', { text: 'once' }, key);
    expect(a.statusCode).toBe(201);
    expect(b.statusCode).toBe(201);
    expect(b.headers['idempotent-replayed']).toBe('true');
    expect(b.json()).toEqual(a.json());
    expect(calls.filter((c) => c.op === 'create')).toHaveLength(1);
    expect(await postRows()).toHaveLength(1);
  });

  it('the channel comes from BUFFER_CHANNEL_ID without a lookup; several X channels or none is POST_FAILED channel_unknown', async () => {
    bufferMock();
    const a = await boot({ env: { BUFFER_API_KEY: KEY, BUFFER_CHANNEL_ID: 'ch_fixed' } });
    expect((await a.post('/posts', { text: 'x' })).statusCode).toBe(201);
    expect(calls.map((c) => c.op)).toEqual(['create']);
    expect(calls[0]!.body.variables.input.channelId).toBe('ch_fixed');
    bufferMock((c) => (c.op === 'channels' ? HttpResponse.json({ data: { channels: [{ id: 'a', service: 'twitter' }, { id: 'b', service: 'x' }] } }) : undefined));
    const b = await boot({ clock: { t: T0 + DAY } });
    const r = await b.post('/posts', { text: 'x' });
    expect(r.statusCode).toBe(502);
    expect(r.json().error).toMatchObject({ code: 'POST_FAILED', details: { step: 'channel', kind: 'channel_unknown' } });
  });
});

describe('GET /media/:token (public)', () => {
  it('serves the bytes without a token, with the cache header, then 404 after 7 days; writes nothing', async () => {
    bufferMock();
    const t = await boot();
    await t.post('/posts', { text: 'pic', images: [img(png())] });
    const token = (await db.selectFrom('post_images').select('media_token').executeTakeFirstOrThrow()).media_token;
    const before = { audit: (await db.selectFrom('audit_log').selectAll().execute()).length, idem: (await db.selectFrom('idempotency_keys').selectAll().execute()).length };
    const r = await t.app.inject({ method: 'GET', url: `/media/${token}` });
    expect(r.statusCode).toBe(200);
    expect(r.headers['content-type']).toBe('image/png');
    expect(r.headers['cache-control']).toBe('public, max-age=3600');
    expect(r.rawPayload.subarray(0, 4).toString('hex')).toBe('89504e47');
    expect((await t.app.inject({ method: 'HEAD', url: `/media/${token}` })).statusCode).toBe(200);
    expect({ audit: (await db.selectFrom('audit_log').selectAll().execute()).length, idem: (await db.selectFrom('idempotency_keys').selectAll().execute()).length }).toEqual(before);
    t.clock.t += 7 * DAY + 1000;
    const gone = await t.app.inject({ method: 'GET', url: `/media/${token}` });
    expect(gone.statusCode).toBe(404);
    expect(gone.json().error.code).toBe('NOT_FOUND');
    expect((await t.app.inject({ method: 'GET', url: `/media/${'0'.repeat(32)}` })).statusCode).toBe(404);
    expect((await t.app.inject({ method: 'GET', url: '/media/abc' })).statusCode).toBe(404); // v2.15.0 (CR-013 F-6): the whole /media/* path is public; an unknown token is 404
    expect((await t.app.inject({ method: 'POST', url: `/media/${token}`, headers: { 'idempotency-key': 'k' } })).statusCode).toBe(401);
  });
});

describe('the daily cap and the burst (T11-6)', () => {
  it('1 a day: the second is POST_DAILY_CAP with next_allowed_at at the next IDT midnight; a refused post uses none; next day works', async () => {
    bufferMock();
    const t = await boot();
    expect((await t.post('/posts', { text: 'one' })).statusCode).toBe(201);
    const r = await t.post('/posts', { text: 'two' });
    expect(r.statusCode).toBe(409);
    expect(r.json().error).toMatchObject({ code: 'POST_DAILY_CAP', details: { today_cap: 1, used_today: 1, remaining: 0, next_allowed_at: '2026-10-21T00:00:00+03:00' } });
    expect(calls.filter((c) => c.op === 'create')).toHaveLength(1);
    t.clock.t = Date.parse('2026-10-20T21:30:00Z'); // 00:30 IDT, 21 Oct
    expect((await t.post('/posts', { text: 'three' })).statusCode).toBe(201);
  });

  it('a burst of 3 for today allows 3, then POST_DAILY_CAP; a burst needs cap 2..5 and today or later; it ends with the day', async () => {
    bufferMock();
    const t = await boot();
    expect((await t.post('/posts/burst', { day: '2026-10-20', cap: 1 })).statusCode).toBe(422);
    expect((await t.post('/posts/burst', { day: '2026-10-20', cap: 6 })).statusCode).toBe(422);
    expect((await t.post('/posts/burst', { day: '2026-10-19', cap: 3 })).statusCode).toBe(422);
    expect((await t.post('/posts/burst', { day: '2026-02-31', cap: 3 })).statusCode).toBe(422);
    const b = await t.post('/posts/burst', { day: '2026-10-20', cap: 3 });
    expect(b.statusCode, b.body).toBe(201);
    expect(b.json()).toMatchObject({ day: '2026-10-20', cap: 3, ends_at: '2026-10-21T00:00:00+03:00' });
    for (let i = 0; i < 3; i++) expect((await t.post('/posts', { text: `p${i}` })).statusCode).toBe(201);
    const over = await t.post('/posts', { text: 'p3' });
    expect(over.json().error).toMatchObject({ code: 'POST_DAILY_CAP', details: { today_cap: 3, used_today: 3 } });
    expect((await t.get('/posts')).json().allowance).toEqual({ today_cap: 3, used_today: 3, remaining: 0 });
    t.clock.t += DAY;
    expect((await t.get('/posts')).json().allowance).toEqual({ today_cap: 1, used_today: 0, remaining: 1 });
    expect((await t.post('/posts/burst', { day: '2026-10-22', cap: 5 })).statusCode).toBe(201);
    expect((await db.selectFrom('posting_bursts').selectAll().execute())).toHaveLength(2);
  });

  it('a removed post still counts toward the cap', async () => {
    bufferMock();
    const t = await boot();
    const id = (await t.post('/posts', { text: 'one' })).json().post_id as string;
    expect((await t.post(`/posts/${id}/remove`, { reason: 'oops' })).statusCode).toBe(200);
    expect((await t.post('/posts', { text: 'two' })).json().error.code).toBe('POST_DAILY_CAP');
  });
});

describe('pause and configuration (T11-8)', () => {
  it('paused: POSTING_PAUSED with the reason, dry run still works, /health shows paused; resume works', async () => {
    bufferMock();
    const t = await boot();
    const p = await t.post('/posts/pause', { paused: true, reason: 'Dvir asked to stop' });
    expect(p.statusCode).toBe(200);
    expect(p.json()).toMatchObject({ paused: true, reason: 'Dvir asked to stop' });
    const r = await t.post('/posts', { text: 'blocked' });
    expect(r.statusCode).toBe(409);
    expect(r.json().error).toMatchObject({ code: 'POSTING_PAUSED', details: { reason: 'Dvir asked to stop' } });
    expect(calls).toHaveLength(0);
    expect((await t.get('/health')).json()).toMatchObject({ posting: 'paused', posting_reason: 'Dvir asked to stop' });
    expect((await t.get('/posts')).json().posting).toMatchObject({ paused: true, reason: 'Dvir asked to stop' });
    expect((await t.post('/posts/pause', { paused: false })).json()).toMatchObject({ paused: false });
    expect((await t.post('/posts', { text: 'back' })).statusCode).toBe(201);
    expect((await t.get('/health')).json().posting).toBe('ok');
    expect(await db.selectFrom('posting_switches').selectAll().execute()).toHaveLength(2);
  });

  it('without BUFFER_API_KEY a real post is 503 POSTING_NOT_CONFIGURED and /health says not_configured', async () => {
    const t = await boot({ env: {} });
    const r = await t.post('/posts', { text: 'nothing' });
    expect(r.statusCode).toBe(503);
    expect(r.json().error.code).toBe('POSTING_NOT_CONFIGURED');
    expect((await t.get('/health')).json()).toMatchObject({ posting: 'not_configured', posting_reason: null });
    expect(await postRows()).toHaveLength(0);
  });

  it('a READ token cannot post, pause, burst or remove', async () => {
    const t = await boot();
    for (const [url, payload] of [['/posts', { text: 'x' }], ['/posts/pause', { paused: true }], ['/posts/burst', { day: '2026-10-21', cap: 2 }], ['/posts/pst_000000000000/remove', { reason: 'x' }]] as const) {
      const r = await t.app.inject({ method: 'POST', url, headers: { ...t.r, 'idempotency-key': randomUUID() }, payload });
      expect(r.statusCode, url).toBe(403);
    }
  });
});

describe('Buffer failures (T11-12)', () => {
  it('429 is 502 POST_FAILED rate_limited with retry_after; the row is failed, no allowance used, /health failed; a later success recovers', async () => {
    bufferMock((c) => (c.op === 'create' ? new Response('{}', { status: 429, headers: { 'retry-after': '120' } }) : undefined));
    const t = await boot();
    const r = await t.post('/posts', { text: 'busy' });
    expect(r.statusCode).toBe(502);
    expect(r.json().error).toMatchObject({ code: 'POST_FAILED', details: { step: 'create', kind: 'rate_limited', status: 429, retry_after: 120 } });
    const [row] = await postRows();
    expect(row).toMatchObject({ status: 'failed', buffer_post_id: null });
    expect(row!.error).toContain('rate_limited');
    expect((await t.get('/posts')).json().allowance).toMatchObject({ used_today: 0, remaining: 1 });
    expect((await t.get('/health')).json()).toMatchObject({ posting: 'failed', posting_reason: expect.stringContaining('rate_limited') });
    bufferMock();
    t.clock.t += 1000;
    expect((await t.post('/posts', { text: 'busy' })).statusCode).toBe(201);
    expect((await t.get('/health')).json().posting).toBe('ok');
  });

  it('a GraphQL error and a MutationError are refused with Buffer\'s message; HTTP 500 is unavailable with the status; the key never leaks', async () => {
    const logs = logCapture();
    bufferMock((c) => (c.op === 'create' ? HttpResponse.json({ errors: [{ message: `bad request for key ${KEY}` }] }) : undefined));
    const t = await boot({ logStream: logs.stream });
    const a = await t.post('/posts', { text: 'one' });
    expect(a.json().error).toMatchObject({ code: 'POST_FAILED', details: { step: 'create', kind: 'refused', message: 'bad request for key [REDACTED]' } });
    bufferMock((c) => (c.op === 'create' ? HttpResponse.json({ data: { createPost: { __typename: 'MutationError', message: 'Text too long for X' } } }) : undefined));
    const b = await t.post('/posts', { text: 'two' });
    expect(b.json().error.details).toMatchObject({ kind: 'refused', message: 'Text too long for X' });
    bufferMock((c) => (c.op === 'create' ? new Response('boom', { status: 503 }) : undefined));
    const c = await t.post('/posts', { text: 'three' });
    expect(c.json().error.details).toMatchObject({ kind: 'unavailable', status: 503 });
    expect(c.statusCode).toBe(502);
    const rows = await postRows();
    expect(rows.map((r) => r.status)).toEqual(['failed', 'failed', 'failed']);
    const everything = [a.body, b.body, c.body, logs.text(), JSON.stringify(rows), JSON.stringify(await db.selectFrom('audit_log').selectAll().execute()), JSON.stringify((await t.get('/health')).json()), JSON.stringify((await t.get('/posts')).json())].join('\n');
    expect(everything).not.toContain(KEY);
  });
});

describe('POST /posts/:id/remove (T11-9)', () => {
  const make = async (t: Awaited<ReturnType<typeof boot>>) => (await t.post('/posts', { text: 'to remove' })).json().post_id as string;

  it('Buffer deletes it: removed with reason and time; the images stay; a second remove is POST_NOT_REMOVABLE', async () => {
    bufferMock();
    const t = await boot();
    const id = (await t.post('/posts', { text: 'to remove', images: [img(png())] })).json().post_id as string;
    const r = await t.post(`/posts/${id}/remove`, { reason: 'wrong price' });
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json()).toMatchObject({ post_id: id, status: 'removed', removed_reason: 'wrong price', deleted_on_buffer: true });
    expect(calls.find((c) => c.op === 'delete')!.body.variables.input).toEqual({ id: 'buf_post_1' });
    const [row] = await postRows();
    expect(row).toMatchObject({ status: 'removed', removed_reason: 'wrong price' });
    expect(await db.selectFrom('post_images').selectAll().execute()).toHaveLength(1);
    const again = await t.post(`/posts/${id}/remove`, { reason: 'again' });
    expect(again.statusCode).toBe(409);
    expect(again.json().error.code).toBe('POST_NOT_REMOVABLE');
    expect((await t.post('/posts/pst_000000000000/remove', { reason: 'x' })).statusCode).toBe(404);
  });

  it('a failed post is not removable', async () => {
    bufferMock((c) => (c.op === 'create' ? new Response('{}', { status: 500 }) : undefined));
    const t = await boot();
    await t.post('/posts', { text: 'x' });
    const [row] = await postRows();
    const r = await t.post(`/posts/${row!.id}/remove`, { reason: 'x' });
    expect(r.json().error.code).toBe('POST_NOT_REMOVABLE');
  });

  it('Buffer refuses: 409 POST_DELETE_UNSUPPORTED with its message; marked_removed_by_hand marks it removed anyway', async () => {
    const t0 = await boot();
    bufferMock();
    const id = await make(t0);
    bufferMock((c) => (c.op === 'delete' ? HttpResponse.json({ data: { deletePost: { __typename: 'MutationError', message: 'A sent post cannot be deleted' } } }) : undefined));
    const r = await t0.post(`/posts/${id}/remove`, { reason: 'wrong' });
    expect(r.statusCode).toBe(409);
    expect(r.json().error).toMatchObject({ code: 'POST_DELETE_UNSUPPORTED', details: { kind: 'refused', message: 'A sent post cannot be deleted' } });
    expect((await postRows())[0]!.status).toBe('posted');
    const hand = await t0.post(`/posts/${id}/remove`, { reason: 'wrong', marked_removed_by_hand: true });
    expect(hand.statusCode).toBe(200);
    expect(hand.json()).toMatchObject({ status: 'removed', deleted_on_buffer: false });
    expect((await postRows())[0]).toMatchObject({ status: 'removed', removed_reason: 'wrong' });
  });
});

describe('postsRefresh daily step', () => {
  it('fills external_link and sent_at of a recent posted row from Buffer; skipped NO_KEY without a key', async () => {
    bufferMock();
    const t = await boot();
    const id = (await t.post('/posts', { text: 'later' })).json().post_id as string;
    expect((await postRows())[0]!.external_link).toBeNull();
    const run = await t.app.jobRunner.run('daily');
    expect(run.steps.postsRefresh).toMatchObject({ ok: true, summary: { checked: 1, updated: 1 } });
    expect(calls.filter((c) => c.op === 'get')).toHaveLength(1);
    const row = (await postRows())[0]!;
    expect(row).toMatchObject({ id, external_link: 'https://x.com/co/status/1', status: 'posted' });
    expect(row.sent_at!.toISOString()).toBe('2026-10-20T10:00:05.000Z');
    const again = await t.app.jobRunner.run('daily');
    expect(again.steps.postsRefresh!.summary).toMatchObject({ checked: 0, updated: 0 });
    const s = await boot({ env: {} });
    expect((await s.app.jobRunner.run('daily')).steps.postsRefresh).toMatchObject({ ok: true, skipped: true, summary: { skipped: true, reason: 'NO_KEY' } });
  });

  it('an old row (over 7 days) is left alone; a Buffer 429 is reported in the summary and the step stays ok', async () => {
    bufferMock((c) => (c.op === 'get' ? new Response('{}', { status: 429 }) : undefined));
    const t = await boot();
    await t.post('/posts', { text: 'x' });
    const r = await t.app.jobRunner.run('daily');
    expect(r.steps.postsRefresh!.summary).toMatchObject({ checked: 1, updated: 0, errors: [expect.stringContaining('rate_limited')] });
    t.clock.t += 8 * DAY;
    bufferMock();
    expect((await t.app.jobRunner.run('daily')).steps.postsRefresh!.summary).toMatchObject({ checked: 0 });
  });
});

describe('storage guards', () => {
  it('posts: fill-ins on a posted row and posted -> removed are allowed; every other change, delete and truncate are refused; the child tables are append-only', async () => {
    bufferMock();
    const t = await boot();
    const id = (await t.post('/posts', { text: 'guard', images: [img(png())] })).json().post_id as string;
    await expect(db.updateTable('posts').set({ text: 'changed' } as never).where('id', '=', id).execute()).rejects.toThrow(/append-only/);
    await db.updateTable('posts').set({ external_link: 'https://x.com/a/1' }).where('id', '=', id).execute();
    await expect(db.updateTable('posts').set({ external_link: 'https://x.com/a/2' }).where('id', '=', id).execute()).rejects.toThrow(/append-only/);
    await expect(db.deleteFrom('posts').where('id', '=', id).execute()).rejects.toThrow(/append-only/);
    await t.post('/posts/pause', { paused: false });
    await expect(db.updateTable('post_images').set({ alt: 'x' }).execute()).rejects.toThrow(/append-only/);
    await expect(db.updateTable('posting_switches').set({ paused: true }).execute()).rejects.toThrow(/append-only/);
    expect((await t.post(`/posts/${id}/remove`, { reason: 'done' })).statusCode).toBe(200);
    await expect(db.updateTable('posts').set({ external_link: 'https://x.com/a/3' }).where('id', '=', id).execute()).rejects.toThrow(/append-only/);
    await expect(db.updateTable('posts').set({ status: 'removed', removed_reason: 'again' }).where('id', '=', id).execute()).rejects.toThrow(/append-only/);
  });
});

describe('founder rule 10: publish only', () => {
  it('no route replies, quotes, likes, follows, mentions or messages; the Buffer client has no such call', () => {
    const src = readFileSync('src/services/posting/buffer.ts', 'utf8');
    for (const word of ['createReply', 'reply', 'retweet', 'quote', 'like', 'follow', 'mention', 'message(', 'direct']) {
      const lines = src.split('\n').filter((l) => !l.trim().startsWith('//') && !l.includes('MutationError') && !/message/.test(l) && l.toLowerCase().includes(word.toLowerCase()));
      expect(lines, word).toEqual([]);
    }
  });

  it('the route table has no reply, like, follow, quote, mention or message route', async () => {
    const t = await boot();
    const posts = t.app.routeTable.filter((r) => /post|media/.test(r.url)).map((r) => `${r.method} ${r.url}`).sort();
    expect(posts).toEqual([
      'GET /media/:token', 'GET /posts', 'GET /posts/:id/images/:part/:position', 'HEAD /media/:token', 'HEAD /posts', 'HEAD /posts/:id/images/:part/:position',
      'POST /posts', 'POST /posts/:id/remove', 'POST /posts/burst', 'POST /posts/pause',
    ]);
    for (const r of t.app.routeTable) expect(r.url).not.toMatch(/repl(y|ies)|like|follow|mention|dm\b|message|retweet/i);
  });
});

describe('config and backup', () => {
  it('BUFFER_API_KEY is a secret value; PUBLIC_BASE_URL defaults and loses a trailing slash; the key is optional', async () => {
    const { loadConfig } = await import('../../src/config.js');
    const { testEnv } = await import('../helpers/env.js');
    const a = loadConfig(testEnv({ BUFFER_API_KEY: KEY }));
    expect(a.secretValues).toContain(KEY);
    expect(a.publicBaseUrl).toBe(BASE);
    expect(loadConfig(testEnv({ PUBLIC_BASE_URL: 'https://example.test/' })).publicBaseUrl).toBe('https://example.test');
    expect(loadConfig(testEnv()).bufferApiKey).toBeUndefined();
    expect(loadConfig(testEnv({ BUFFER_API_KEY: '' })).bufferApiKey).toBeUndefined();
  });

  it('the export carries posts, post_images (rows without the data column), switches and bursts', async () => {
    bufferMock();
    const t = await boot();
    await t.post('/posts/burst', { day: '2026-10-20', cap: 2 });
    await t.post('/posts/pause', { paused: false });
    await t.post('/posts', { text: 'exported', images: [img(png(), 'alt for export')] });
    const { collectBackupFiles } = await import('../../src/jobs/backup-export.js');
    const files = await collectBackupFiles(db);
    const posts = JSON.parse(files.get('backup/tables/posts.json')!) as { text: string }[];
    const images = JSON.parse(files.get('backup/tables/post_images.json')!) as Record<string, unknown>[];
    expect(posts.map((p) => p.text)).toEqual(['exported']);
    expect(images).toHaveLength(1);
    expect(images[0]).toMatchObject({ alt: 'alt for export', mime: 'image/png' });
    expect('data' in images[0]!).toBe(false);
    expect(JSON.parse(files.get('backup/tables/posting_switches.json')!)).toHaveLength(1);
    expect(JSON.parse(files.get('backup/tables/posting_bursts.json')!)).toHaveLength(1);
  });
});
