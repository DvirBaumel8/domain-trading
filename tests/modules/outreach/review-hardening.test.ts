// v2.15.0 (CR-013 acceptance findings F-1..F-11, Q1): the weekly rule, bot names out of the packet, the term retire route, 503 retry, key shapes,
// plural/possessive matching, public /media/*, the review run limiter, review settings history, removed drop-list rows, an empty cohort window.
import { randomBytes, randomUUID } from 'node:crypto';
import { http, HttpResponse } from 'msw';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { checkText, termMatches } from '../../../src/modules/outreach/blocklist.js';
import { makeApp } from '../../helpers/app.js';
import { testDb as db } from '../../helpers/db.js';
import { screeningHarness } from '../../helpers/screening.js';
import { issueToken } from '../../helpers/tokens.js';
import { mswServer } from '../../setup/network.js';

vi.mock('../../../src/modules/selection/test-sets.js', async (orig) => {
  const real = await orig<typeof import('../../../src/modules/selection/test-sets.js')>();
  return { ...real, featuresOfRun: async (...a: Parameters<typeof real.featuresOfRun>) => (globalThis as { __featuresOverride?: unknown }).__featuresOverride ?? real.featuresOfRun(...a) };
});

const KEY = 'test-gemini-key';
const URL_RE = /generativelanguage\.googleapis\.com\/v1beta\/models\/[^/]+:generateContent/;
const T0 = Date.parse('2026-10-20T00:05:00Z'); // 03:05 IDT, a Tuesday
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const SUNDAY = Date.parse('2026-10-25T00:05:00Z'); // 03:05 IDT, a Sunday
const apps: FastifyInstance[] = [];
afterEach(async () => { delete (globalThis as { __featuresOverride?: unknown }).__featuresOverride; await Promise.all(apps.splice(0).map((a) => a.close())); });

const answer = () => HttpResponse.json({
  candidates: [{ finishReason: 'STOP', content: { parts: [{ text: JSON.stringify({ items: [{ category: 'pricing', severity: 'low', text: 'Keep the plan.' }] }) }] } }],
  usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 20 },
});
const busy = () => HttpResponse.json({ error: { code: 503, status: 'UNAVAILABLE', message: 'This model is currently experiencing high demand.' } }, { status: 503 });
const seen: string[] = [];
function serve(resp: () => Response) {
  seen.length = 0;
  mswServer.use(http.post(URL_RE, async ({ request }) => { seen.push(request.url); return resp(); }));
}
async function boot(env: Record<string, string> = { GEMINI_API_KEY: KEY }, start = T0) {
  const clock = { t: start };
  const app = await makeApp({ now: () => clock.t, env });
  apps.push(app);
  const w = (await issueToken('write', 'gavriel')).auth;
  const r = (await issueToken('read')).auth;
  const post = (url: string, payload?: object) => app.inject({ method: 'POST', url, headers: { ...w, 'idempotency-key': randomUUID() }, ...(payload === undefined ? {} : { payload }) });
  const get = (url: string) => app.inject({ method: 'GET', url, headers: r });
  const doc = async () => { expect((await post('/company/document', { text: 'We buy short .com names and sell them at a fixed price.' })).statusCode).toBeLessThan(300); };
  return { app, clock, post, get, doc };
}
const step = (r: { steps: Record<string, { summary: unknown }> }, name: string) => r.steps[name]!.summary;
const unknownFb = { status: 'unknown', provider: 'acme', reason: 'Google said 503' };
const okFb = { status: 'ok', provider: 'acme', model: 'm-1', cost_usd: 0, items: [] };
const rnd = (n: number, alphabet = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789') => Array.from(randomBytes(n), (b) => alphabet[b % alphabet.length]).join('');

describe('F-1 the weekly rule (T13-1, T13-2)', () => {
  it('V215-1 T13-1: a weekly packet whose feedback is unknown, or missing, never counts: the next packet is weekly with the full text', async () => {
    const t = await boot();
    await t.doc();
    const p1 = (await t.post('/reviews/packet')).json();
    expect(p1.kind).toBe('weekly');
    const noFeedback = (await t.post('/reviews/packet', { preview: true })).json();
    expect(noFeedback.kind).toBe('weekly');
    expect(noFeedback.content.document.text).toContain('We buy short');
    expect((await t.post(`/reviews/${p1.packet_id}/feedback`, unknownFb)).statusCode).toBe(201);
    t.clock.t += HOUR;
    const afterUnknown = (await t.post('/reviews/packet', { preview: true })).json();
    expect(afterUnknown).toMatchObject({ kind: 'weekly' });
    expect(afterUnknown.content.document.text).toContain('We buy short');
  });

  it('V215-2 T13-2: after a review with status ok on a weekly packet the next packet that day is daily with text null; Sunday is weekly again; 7 days later too', async () => {
    const t = await boot();
    await t.doc();
    const p1 = (await t.post('/reviews/packet')).json();
    expect((await t.post(`/reviews/${p1.packet_id}/feedback`, okFb)).statusCode).toBe(201);
    t.clock.t += 2 * HOUR;
    const p2 = (await t.post('/reviews/packet', { preview: true })).json();
    expect(p2.kind).toBe('daily');
    expect(p2.content.document.text).toBeNull();
    t.clock.t = SUNDAY;
    expect((await t.post('/reviews/packet', { preview: true })).json().kind).toBe('weekly');
    t.clock.t = T0 + 7 * DAY + 1000;
    expect((await t.post('/reviews/packet', { preview: true })).json().kind).toBe('weekly');
  });

  it('V215-3 the review run uses the same rule: a manual run that gets 503 stores unknown and does not use up the weekly packet', async () => {
    const t = await boot();
    await t.doc();
    serve(busy);
    const r1 = await t.post('/reviews/run');
    expect(r1.json()).toMatchObject({ kind: 'weekly', status: 'unknown' });
    const p = (await t.post('/reviews/packet', { preview: true })).json();
    expect(p.kind).toBe('weekly');
    expect(p.content.document.text).toContain('We buy short');
    serve(answer);
    t.clock.t += HOUR;
    expect((await t.post('/reviews/run')).json()).toMatchObject({ kind: 'weekly', status: 'ok' });
    t.clock.t += HOUR;
    expect((await t.post('/reviews/run')).json()).toMatchObject({ kind: 'daily', status: 'ok' });
  });
});

describe('F-2 bot names out of the packet; retiring a term (T13-4, T13-5, T13-6)', () => {
  it('V215-4 T13-4: with the term "Gavriel" listed and a tranche opened by gavriel, the preview is 200 and the content has no "gavriel"', async () => {
    const x = await screeningHarness();
    try {
      expect((await x.post('/company/document', { text: 'We buy short .com names.' })).statusCode).toBe(201);
      expect((await x.post('/tranches', { name: 'T1' })).statusCode).toBe(201);
      expect(JSON.stringify((await x.get('/tranches')).json())).toContain('gavriel');
      expect((await x.post('/company/forbidden-terms', { term: 'Gavriel' })).statusCode).toBe(201);
      const p = await x.post('/reviews/packet', { preview: true });
      expect(p.statusCode, p.body).toBe(200);
      expect(p.body.toLowerCase()).not.toContain('gavriel');
      expect(p.body).toContain('"operator"');
      // T13-5: the term still blocks text a bot sends
      const dry = await x.post('/posts', { text: 'Hello from Gavriel', dry_run: true });
      expect(dry.json().ok).toBe(false);
      expect(dry.body).toContain('listed_term');
    } finally { await x.app.close(); }
  });

  it('V215-5 anonymizeActors replaces actor keys and token names at any depth', async () => {
    const { anonymizeActors } = await import('../../../src/modules/outreach/review/packet.js');
    const out = anonymizeActors({ a: [{ opened_by: 'x', n: 1, by: 'y', note: 'Gavriel-WRITE-2', keep: 'fine', deep: { token_name: 'zed', closed_by: null } }] }, new Set(['gavriel-write-2']));
    expect(out).toEqual({ a: [{ opened_by: 'operator', n: 1, by: 'operator', note: 'operator', keep: 'fine', deep: { token_name: 'operator', closed_by: null } }] });
  });

  it('V215-6 T13-6: retire is audited, append-only, and makes the same text pass; 404 TERM_NOT_FOUND, 409 TERM_ALREADY_RETIRED; reads show retired_at, never the term', async () => {
    const t = await boot();
    const id = (await t.post('/company/forbidden-terms', { term: 'Blueberry' })).json().id as number;
    expect(await checkText(db, 'I like blueberry pie')).toEqual({ ok: false, category: 'listed_term' });
    expect((await t.post('/company/forbidden-terms/999/retire', {})).json().error.code).toBe('TERM_NOT_FOUND');
    expect((await t.post('/company/forbidden-terms/abc/retire', {})).json().error.code).toBe('TERM_NOT_FOUND');
    expect((await t.post(`/company/forbidden-terms/${id}/retire`, { reason: 'x'.repeat(201) })).statusCode).toBe(422);
    const r = await t.post(`/company/forbidden-terms/${id}/retire`, { reason: 'breaks the packet' });
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json()).toMatchObject({ id, retired_by: expect.any(String), reason: 'breaks the packet' });
    expect(r.body).not.toMatch(/blueberry/i);
    const again = await t.post(`/company/forbidden-terms/${id}/retire`, {});
    expect([again.statusCode, again.json().error.code]).toEqual([409, 'TERM_ALREADY_RETIRED']);
    expect(await checkText(db, 'I like blueberry pie')).toEqual({ ok: true });
    const g = await t.get('/company/forbidden-terms');
    expect(g.json().terms).toEqual([{ id, category: 'listed_term', created_at: expect.any(String), retired_at: expect.any(String) }]);
    expect(g.body).not.toMatch(/blueberry/i);
    const row = await db.selectFrom('forbidden_term_retirements').selectAll().executeTakeFirstOrThrow();
    const audit = await db.selectFrom('audit_log').selectAll().where('id', '=', row.audit_id!).executeTakeFirstOrThrow();
    expect(audit).toMatchObject({ method: 'POST', path: `/company/forbidden-terms/${id}/retire`, scope: 'write' });
    await expect(db.updateTable('forbidden_term_retirements').set({ reason: 'x' }).execute()).rejects.toThrow();
  });
});

describe('F-3 a 503, UNAVAILABLE, timeout or network error is retried like a 429 (T13-7, T13-8)', () => {
  const TICK = Date.parse('2026-10-20T07:30:00Z');
  it('V215-7 T13-7/T13-8: the daily run stores no feedback and is retry_pending; the tick retries once; a second failure is unknown', async () => {
    const t = await boot();
    await t.doc();
    serve(busy);
    const d = await t.app.jobRunner.run('daily');
    expect(step(d, 'outsideReview')).toMatchObject({ status: 'retry_pending', reason: 'retry_pending' });
    expect(await db.selectFrom('review_feedback').selectAll().execute()).toHaveLength(0);
    expect(await db.selectFrom('review_retries').selectAll().execute()).toHaveLength(1);
    t.clock.t = TICK;
    const tick = await t.app.jobRunner.run('tick');
    expect(step(tick, 'reviewRetry')).toMatchObject({ status: 'unknown' });
    expect(seen).toHaveLength(6); // v3.1.0 (CR-016 R-1): each call is 3 tries in all (backoff on 503), the daily call and the retry
    const fb = await db.selectFrom('review_feedback').selectAll().execute();
    expect(fb).toHaveLength(1);
    expect(fb[0]!.reason).toMatch(/^HTTP 503 UNAVAILABLE: This model is currently experiencing high demand/);
    // the full weekly packet was not used up
    t.clock.t += HOUR;
    expect((await t.post('/reviews/packet', { preview: true })).json().kind).toBe('weekly');
  });

  it('V215-8 a network error and an UNAVAILABLE status on another code are deferred too; a 400 is stored at once', async () => {
    const t = await boot();
    await t.doc();
    mswServer.use(http.post(URL_RE, () => HttpResponse.error()));
    expect(step(await t.app.jobRunner.run('daily'), 'outsideReview')).toMatchObject({ status: 'retry_pending' });
  });

  it('V215-8b an UNAVAILABLE status on another HTTP code is deferred too', async () => {
    const t = await boot();
    await t.doc();
    serve(() => HttpResponse.json({ error: { status: 'UNAVAILABLE', message: 'overloaded' } }, { status: 500 }));
    expect(step(await t.app.jobRunner.run('daily'), 'outsideReview')).toMatchObject({ status: 'retry_pending' });
  });

  it('V215-8c any other failure (a 400) is stored as unknown at once', async () => {
    const t = await boot();
    await t.doc();
    serve(() => HttpResponse.json({ error: { status: 'INVALID_ARGUMENT', message: 'bad' } }, { status: 400 }));
    expect(step(await t.app.jobRunner.run('daily'), 'outsideReview')).toMatchObject({ status: 'unknown' });
    expect(await db.selectFrom('review_feedback').selectAll().execute()).toHaveLength(1);
  });
});

describe('F-4 key shapes (T13-9)', () => {
  const shapes: [string, () => string][] = [
    ['sk-', () => `sk-${rnd(48)}`], ['sk-proj-', () => `sk-proj-${rnd(40, 'abcdefghijklmnopqrstuvwxyz0123456789_-')}`], ['sk-ant-', () => `sk-ant-api03-${rnd(40)}`],
    ['xoxb-', () => `xoxb-${rnd(12, '0123456789')}-${rnd(12, '0123456789')}-${rnd(24)}`], ['xoxp-', () => `xoxp-${rnd(12, '0123456789')}-${rnd(24)}`],
    ['xapp-', () => `xapp-1-${rnd(12)}-${rnd(20)}`], ['AKIA', () => `AKIA${rnd(16, 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567')}`], ['rnd_', () => `rnd_${rnd(24)}`],
    ['JWT', () => `eyJ${rnd(20)}.eyJ${rnd(30)}.${rnd(30)}`],
  ];
  it('V215-9 T13-9: each shape is refused as secret on a post dry run and on the company document; ordinary words pass', async () => {
    const t = await boot({ BUFFER_API_KEY: 'buf_fake_key_0123456789abcdefABCDEF', GEMINI_API_KEY: KEY });
    for (const [name, make] of shapes) {
      const key = make();
      t.clock.t += 61_000; // the write limiter allows 10 per minute
      expect(await checkText(db, `use ${key} now`), name).toEqual({ ok: false, category: 'secret' });
      const dry = await t.post('/posts', { text: `secret ${key}`, dry_run: true });
      expect(dry.json().ok, name).toBe(false);
      expect(dry.body, name).toContain('secret');
      expect(dry.body).not.toContain(key);
      const doc = await t.post('/company/document', { text: `notes ${key}` });
      expect([name, doc.statusCode, doc.json().error.details.category]).toEqual([name, 422, 'secret']);
    }
    for (const ok of ['sk- alone and skill and skills', 'The task-force-management-committee met', 'risk-assessment-framework-for-everyone', 'rnd_short and AKIAshort', 'eyJ.a.b', 'ask-me-anything-about-domains-today']) {
      expect(await checkText(db, ok), ok).toEqual({ ok: true });
    }
  });
});

describe('F-8 term matching (T13-13)', () => {
  it('V215-10 a trailing s, es, \'s or ’s also matches; inside a longer word it does not', () => {
    for (const text of ['Shomers', "Shomer's", 'Shomer’s', 'Shomeres', 'the shomer.', '#Shomer', 'Shomer-bot']) expect(termMatches(text, 'Shomer'), text).toBe(true);
    for (const text of ['xshomerx', 'shomerish', 'shomersx', 'ashomer']) expect(termMatches(text, 'Shomer'), text).toBe(false);
  });
});

describe('F-6 /media/* is public (T13-11)', () => {
  it('V215-11 an unknown token of any shape is 404 NOT_FOUND without auth, and nothing is written', async () => {
    const t = await boot();
    const before = (await db.selectFrom('audit_log').selectAll().execute()).length;
    for (const tok of ['abc', 'A'.repeat(43), 'x_-y', '0'.repeat(32)]) {
      const r = await t.app.inject({ method: 'GET', url: `/media/${tok}` });
      expect([tok, r.statusCode, r.json().error.code]).toEqual([tok, 404, 'NOT_FOUND']);
    }
    expect((await t.app.inject({ method: 'POST', url: '/media/abc', headers: { 'idempotency-key': 'k' } })).statusCode).toBe(401);
    expect((await db.selectFrom('audit_log').selectAll().execute()).length).toBe(before);
  });
});

describe('F-9 only calls that reach Google count (T13-14)', () => {
  it('V215-12 T13-14: a refused call (disabled) is not counted; 3 runs pass, the 4th is 429', async () => {
    const t = await boot();
    await t.doc();
    serve(answer);
    expect((await t.post('/reviews/settings', { enabled: false })).statusCode).toBe(200);
    const refused = await t.post('/reviews/run');
    expect([refused.statusCode, refused.json().error.code]).toEqual([409, 'REVIEW_DISABLED']);
    expect((await t.post('/reviews/settings', { enabled: true })).statusCode).toBe(200);
    for (let i = 0; i < 3; i++) {
      t.clock.t += 1000;
      const r = await t.post('/reviews/run');
      expect([i, r.statusCode, r.headers['ratelimit-remaining']]).toEqual([i, 200, String(2 - i)]);
    }
    const r = await t.post('/reviews/run');
    expect([r.statusCode, r.json().error.code]).toEqual([429, 'RATE_LIMITED']);
    expect(seen).toHaveLength(3);
  });
});

describe('F-10 GET /reviews/settings/history (T13-15)', () => {
  it('V215-13 T13-15: off and on give two changes, newest first, with old, new, who, when, idempotency key and note', async () => {
    const t = await boot();
    expect((await t.get('/reviews/settings/history')).json()).toEqual({ changes: [] });
    expect((await t.post('/reviews/settings', { enabled: false, note: 'pause' })).statusCode).toBe(200);
    t.clock.t += 5000;
    expect((await t.post('/reviews/settings', { enabled: true })).statusCode).toBe(200);
    const h = (await t.get('/reviews/settings/history')).json();
    expect(h.changes).toHaveLength(2);
    expect(h.changes[0]).toMatchObject({ old: { enabled: false, model: 'gemini-3.8-flash', tier: 'free' }, new: { enabled: true, model: 'gemini-3.8-flash', tier: 'free' }, note: null, by: expect.any(String), at: expect.stringMatching(/\+03:00$/) });
    expect(h.changes[1]).toMatchObject({ old: { enabled: true }, new: { enabled: false }, note: 'pause' });
    expect(h.changes[0].idempotency_key).toMatch(/^[0-9a-f-]{36}$/);
    expect(h.changes[0].idempotency_key).not.toBe(h.changes[1].idempotency_key);
  });
});
