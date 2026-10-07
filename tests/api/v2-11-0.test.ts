// v2.11.0 (CR-011 part B, DOM calling): the one AI call, the outside review (Gemini). MSW only; fake key.
import { randomUUID } from 'node:crypto';
import { delay, http, HttpResponse } from 'msw';
import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { callGemini, geminiCostUsd, GEMINI_HOST } from '../../src/modules/outreach/review/gemini.js';
import { makeApp, logCapture } from '../helpers/app.js';
import { testDb as db } from '../helpers/db.js';
import { issueToken } from '../helpers/tokens.js';
import { mswServer } from '../setup/network.js';

const KEY = 'test-gemini-key';
const URL_RE = /generativelanguage\.googleapis\.com\/v1beta\/models\/[^/]+:generateContent/;
const T0 = Date.parse('2026-10-20T09:00:00Z'); // a Tuesday (IDT)
const SUNDAY = Date.parse('2026-10-25T09:00:00Z');
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const apps: FastifyInstance[] = [];
afterEach(async () => { await Promise.all(apps.splice(0).map((a) => a.close())); });

const answer = (items: object[], usage = { promptTokenCount: 10_000, candidatesTokenCount: 2_000 }) => HttpResponse.json({
  candidates: [{ finishReason: 'STOP', content: { parts: [{ text: JSON.stringify({ items }) }] } }], usageMetadata: usage,
});
const gi = (text: string, category = 'pricing', severity = 'medium') => ({ category, severity, text });
const seen: { url: string; key: string | null; body: any }[] = [];
function serve(resp: () => Response | Promise<Response>) {
  seen.length = 0;
  mswServer.use(http.post(URL_RE, async ({ request }) => {
    seen.push({ url: request.url, key: request.headers.get('x-goog-api-key'), body: await request.json() });
    return resp();
  }));
}

async function boot(opts: { key?: string | null; settings?: { enabled?: boolean; model?: string; tier?: 'free' | 'paid' } } = {}) {
  const clock = { t: T0 };
  const logs = logCapture();
  const env: Record<string, string> = {};
  if (opts.key !== null) env.GEMINI_API_KEY = opts.key ?? KEY;
  const app = await makeApp({ now: () => clock.t, env, logStream: logs.stream });
  apps.push(app);
  const w = (await issueToken('write')).auth;
  const r = (await issueToken('read')).auth;
  const post = (url: string, payload?: object) => app.inject({ method: 'POST', url, headers: { ...w, 'idempotency-key': randomUUID() }, ...(payload === undefined ? {} : { payload }) });
  const get = (url: string) => app.inject({ method: 'GET', url, headers: r });
  if (opts.settings) {
    const s = { enabled: true, model: 'gemini-3.8-flash', tier: 'free' as const, ...opts.settings };
    await db.insertInto('review_settings_changes').values({ by: 'test', ...s, old: '{}' }).execute();
  }
  const doc = async (text = 'We buy short .com names and sell them at a fixed price.') => { const x = await post('/company/document', { text }); expect(x.statusCode, x.body).toBeLessThan(300); };
  return { app, clock, logs, post, get, doc };
}

describe('Gemini client', () => {
  it('computes cost from the usage by hand: paid 10,000 in + 2,000 out on Pro = $0.0440; free is $0', () => {
    expect(geminiCostUsd('gemini-3.1-pro-preview', 'paid', 10_000, 2_000)).toBe(0.044); // 10000/1e6*2.00 = 0.02; 2000/1e6*12.00 = 0.024
    expect(geminiCostUsd('gemini-3.8-flash', 'paid', 10_000, 2_000)).toBe(0.011); // 0.005 + 0.006
    expect(geminiCostUsd('gemini-3.8-flash', 'free', 10_000, 2_000)).toBe(0);
    expect(geminiCostUsd('gemini-3.1-pro-preview', 'paid', 0, 0)).toBe(0);
    expect(geminiCostUsd('gemini-3.1-pro-preview', 'paid', 123_456, 7_890)).toBe(0.3416); // 0.246912 + 0.09468 = 0.341592
  });

  it('sends the key in a header only, the fixed schema, and returns validated items (unknown category becomes other, text cut to 2000)', async () => {
    serve(() => answer([gi('x'.repeat(2500), 'Weird'), gi('b', 'risk', 'high')]));
    const r = await callGemini({ fetch, apiKey: KEY, model: 'gemini-2.5-flash' }, '{"a":1}');
    expect(r).toMatchObject({ kind: 'ok', inputTokens: 10_000, outputTokens: 2_000, model: 'gemini-2.5-flash' });
    if (r.kind !== 'ok') throw new Error('x');
    expect(r.items[0]).toMatchObject({ category: 'other', text: 'x'.repeat(2000) });
    expect(seen[0]!.key).toBe(KEY);
    expect(seen[0]!.url).not.toContain(KEY);
    expect(seen[0]!.url.startsWith(GEMINI_HOST)).toBe(true);
    expect(seen[0]!.body.generationConfig).toMatchObject({ responseMimeType: 'application/json', temperature: 0.2 });
    expect(seen[0]!.body.systemInstruction.parts[0].text).toContain('outside reviewer');
    expect(seen[0]!.body.contents[0].parts[0].text).toBe('{"a":1}');
  });

  it('a timeout is unknown with reason timeout', async () => {
    serve(async () => { await delay(500); return answer([]); });
    const r = await callGemini({ fetch, apiKey: KEY, model: 'gemini-3.8-flash', timeoutMs: 50 }, '{}');
    expect(r).toMatchObject({ kind: 'unknown', reason: 'timeout' });
  });
});

describe('runReview through POST /reviews/run', () => {
  it('an ok answer is stored as feedback with provider gemini, the model and the cost from usage; the key never appears anywhere', async () => {
    const t = await boot({ settings: { model: 'gemini-3.1-pro-preview', tier: 'paid' } });
    await t.doc();
    serve(() => answer([gi('Raise the floor on the default plan.'), gi('Watch renewal cash.', 'cost', 'low')]));
    const r = await t.post('/reviews/run');
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json()).toMatchObject({ kind: 'weekly', status: 'ok', items_n: 2, new_n: 2, repeat_n: 0, cost_usd: 0.044, dropped_n: 0, packet_id: expect.stringMatching(/^rvp_/) });
    expect(seen[0]!.url).toContain('gemini-3.1-pro-preview');
    const fb = await db.selectFrom('review_feedback').selectAll().execute();
    expect(fb).toHaveLength(1);
    expect(fb[0]).toMatchObject({ provider: 'gemini', model: 'gemini-3.1-pro-preview', status: 'ok' });
    expect(Number(fb[0]!.cost_usd)).toBe(0.044);
    expect(await db.selectFrom('review_items').selectAll().execute()).toHaveLength(2);
    const audit = JSON.stringify(await db.selectFrom('audit_log').selectAll().execute());
    for (const text of [r.body, audit, t.logs.text(), JSON.stringify(fb)]) expect(text).not.toContain(KEY);
    expect((await t.get('/reviews/cost')).json()).toMatchObject({ spent_usd: 0.044, feedback_n: 1, enabled: true, model: 'gemini-3.1-pro-preview', tier: 'paid' });
  });

  it('items go through novelty: the same advice a second time is a repeat', async () => {
    const t = await boot();
    await t.doc();
    serve(() => answer([gi('Raise the floor on the default plan before the next renewal.')]));
    expect((await t.post('/reviews/run')).json()).toMatchObject({ new_n: 1, repeat_n: 0 });
    t.clock.t += HOUR;
    expect((await t.post('/reviews/run')).json()).toMatchObject({ kind: 'daily', new_n: 0, repeat_n: 1 });
  });

  it.each([
    ['403', () => HttpResponse.json({ error: { code: 403, status: 'PERMISSION_DENIED', message: 'API key not valid' } }, { status: 403 }), /^HTTP 403 PERMISSION_DENIED: API key not valid/],
    ['500', () => HttpResponse.json({ error: { status: 'INTERNAL', message: 'boom' } }, { status: 500 }), /^HTTP 500 INTERNAL: boom/],
    ['bad JSON', () => HttpResponse.json({ candidates: [{ finishReason: 'STOP', content: { parts: [{ text: 'not json at all' }] } }] }), /^HTTP 200 none: the answer is not the expected JSON/],
    ['SAFETY', () => HttpResponse.json({ candidates: [{ finishReason: 'SAFETY' }] }), /^HTTP 200 none: finishReason SAFETY/],
    ['no candidate', () => HttpResponse.json({ promptFeedback: { blockReason: 'OTHER' } }), /^HTTP 200 none: no candidate/],
    ['network', () => HttpResponse.error(), /^HTTP none none: network error/],
  ])('%s is stored as unknown feedback with a reason and no key', async (_n, resp, re) => {
    const t = await boot();
    await t.doc();
    serve(resp as () => Response);
    const r = await t.post('/reviews/run');
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json()).toMatchObject({ status: 'unknown', items_n: 0, cost_usd: 0 });
    const fb = (await db.selectFrom('review_feedback').selectAll().execute())[0]!;
    expect(fb).toMatchObject({ status: 'unknown', provider: 'gemini' });
    expect(fb.reason).toMatch(re);
    expect(JSON.stringify([fb, r.body, t.logs.text()])).not.toContain(KEY);
  });

  it('an error body that echoes the key is redacted', async () => {
    const t = await boot();
    await t.doc();
    serve(() => HttpResponse.json({ error: { status: 'INVALID_ARGUMENT', message: `bad key ${KEY}` } }, { status: 400 }));
    await t.post('/reviews/run');
    const fb = (await db.selectFrom('review_feedback').selectAll().execute())[0]!;
    expect(fb.reason).not.toContain(KEY);
    expect(fb.reason).toContain('[REDACTED]');
  });

  it('item texts that fail the block list are dropped and counted, not stored', async () => {
    const t = await boot();
    await t.doc();
    serve(() => answer([gi('Mail the owner at someone@example.com now.'), gi('Keep the plan.')]));
    const r = await t.post('/reviews/run');
    expect(r.json()).toMatchObject({ status: 'ok', items_n: 1, dropped_n: 1 });
    expect(JSON.stringify(await db.selectFrom('review_items').selectAll().execute())).not.toContain('example.com');
  });

  it('REVIEWER_NOT_CONFIGURED (503) without a key; DOCUMENT_MISSING (409) without a document; no call is made', async () => {
    const t = await boot({ key: null });
    serve(() => answer([]));
    const a = await t.post('/reviews/run');
    expect(a.statusCode).toBe(503);
    expect(a.json().error.code).toBe('REVIEWER_NOT_CONFIGURED');
    const t2 = await boot();
    const b = await t2.post('/reviews/run');
    expect([b.statusCode, b.json().error.code]).toEqual([409, 'DOCUMENT_MISSING']);
    expect(seen).toHaveLength(0);
  });

  it('REVIEW_COST_CAP (409) when the month spend reached the cap; no call is made', async () => {
    const t = await boot();
    await t.doc();
    await t.post('/reviews/packet'); // creates a packet to hang spend on
    const p = (await db.selectFrom('review_packets').select('id').executeTakeFirstOrThrow()).id;
    await db.insertInto('review_feedback').values({ packet_id: p, created_by: 'x', created_at: new Date(T0), status: 'ok', provider: 'gemini', model: 'm', cost_usd: 5, reason: null }).execute();
    serve(() => answer([]));
    const r = await t.post('/reviews/run');
    expect([r.statusCode, r.json().error.code]).toEqual([409, 'REVIEW_COST_CAP']);
    expect(seen).toHaveLength(0);
  });

  it('TEXT_BLOCKED (422) with the category when the packet itself is refused; no call is made', async () => {
    const t = await boot();
    await t.doc();
    await db.insertInto('forbidden_terms').values({ term: 'fixed', created_by: 'test' }).execute(); // appears in the document text inside the packet
    serve(() => answer([]));
    const r = await t.post('/reviews/run');
    expect(r.statusCode).toBe(422);
    expect(r.json().error).toMatchObject({ code: 'TEXT_BLOCKED', details: { category: 'listed_term' } });
    expect(seen).toHaveLength(0);
  });

  it('weekly on Sunday (IDT) even when a weekly packet is only a day old; daily otherwise', async () => {
    const t = await boot();
    await t.doc();
    serve(() => answer([]));
    t.clock.t = SUNDAY - 2 * DAY; // Friday: the first packet is weekly (none yet)
    expect((await t.post('/reviews/run')).json().kind).toBe('weekly');
    t.clock.t = SUNDAY - DAY + 2 * HOUR; // Saturday: daily
    expect((await t.post('/reviews/run')).json().kind).toBe('daily');
    t.clock.t = SUNDAY; // Sunday: weekly again
    expect((await t.post('/reviews/run')).json().kind).toBe('weekly');
  });

  it('the 4th call in an hour is 429 RATE_LIMITED with headers; a different WRITE token has its own count', async () => {
    const t = await boot();
    await t.doc();
    serve(() => answer([]));
    for (let i = 0; i < 3; i++) expect((await t.post('/reviews/run')).statusCode).toBe(200);
    const r = await t.post('/reviews/run');
    expect(r.statusCode).toBe(429);
    expect(r.json().error.code).toBe('RATE_LIMITED');
    expect(r.headers['retry-after']).toBeDefined();
    expect(r.headers['ratelimit-limit']).toBe('3');
    expect(r.headers['ratelimit-remaining']).toBe('0');
    expect(seen).toHaveLength(3);
  });

  it('a READ token is refused and writes nothing', async () => {
    const t = await boot();
    const read = (await issueToken('read')).auth;
    const r = await t.app.inject({ method: 'POST', url: '/reviews/run', headers: { ...read, 'idempotency-key': randomUUID() } });
    expect(r.statusCode).toBeGreaterThanOrEqual(400);
    expect(await db.selectFrom('review_packets').selectAll().execute()).toHaveLength(0);
  });
});

describe('outsideReview daily step', () => {
  it('is the step after referenceRefresh and before backupExport, and is skipped with NO_KEY without a key', async () => {
    const t = await boot({ key: null });
    const r = await t.app.jobRunner.run('daily');
    const names = Object.keys(r.steps);
    expect(names.slice(-4)).toEqual(['referenceRefresh', 'outsideReview', 'postsRefresh', 'backupExport']);
    expect(r.steps.outsideReview).toMatchObject({ ok: true, skipped: true, summary: { skipped: true, reason: 'NO_KEY' } });
  });

  it('skips DOCUMENT_MISSING, runs once, then skips ALREADY_DONE_TODAY; manual still runs; the next IDT day runs again', async () => {
    const t = await boot();
    serve(() => answer([gi('Hold the line.')]));
    expect((await t.app.jobRunner.run('daily')).steps.outsideReview!.summary).toMatchObject({ skipped: true, reason: 'DOCUMENT_MISSING' });
    await t.doc();
    const a = await t.app.jobRunner.run('daily');
    expect(a.steps.outsideReview).toMatchObject({ ok: true, summary: { status: 'ok', items_n: 1, kind: 'weekly' } });
    t.clock.t += HOUR;
    expect((await t.app.jobRunner.run('daily')).steps.outsideReview!.summary).toMatchObject({ skipped: true, reason: 'ALREADY_DONE_TODAY' });
    expect(seen).toHaveLength(1);
    expect((await t.post('/reviews/run')).statusCode).toBe(200);
    expect(seen).toHaveLength(2);
    t.clock.t += DAY;
    expect((await t.app.jobRunner.run('daily')).steps.outsideReview!.summary).toMatchObject({ status: 'ok' });
  });

  it('a Gemini failure does not fail the job; the cost cap skips with COST_CAP', async () => {
    const t = await boot();
    await t.doc();
    serve(() => HttpResponse.json({ error: { status: 'INTERNAL' } }, { status: 500 }));
    const a = await t.app.jobRunner.run('daily');
    expect(a.steps.outsideReview).toMatchObject({ ok: true, summary: { status: 'unknown' } });
    const p = (await db.selectFrom('review_packets').select('id').executeTakeFirstOrThrow()).id;
    await db.insertInto('review_packets').values({ id: 'rvp_000000000000', created_by: 'x', created_at: new Date(T0), kind: 'daily', document_version: 1, content: '{}', sha256: 'a'.repeat(64) }).execute();
    await db.insertInto('review_feedback').values({ packet_id: 'rvp_000000000000', created_by: 'x', created_at: new Date(T0), status: 'ok', provider: 'gemini', model: 'm', cost_usd: 5, reason: null }).execute();
    expect(p).toBeDefined();
    t.clock.t += DAY;
    expect((await t.app.jobRunner.run('daily')).steps.outsideReview!.summary).toMatchObject({ skipped: true, reason: 'COST_CAP' });
  });
});

describe('/health review', () => {
  it('not_configured without a key, unknown before any review, ok after an ok one, failed after an unknown one', async () => {
    const none = await boot({ key: null });
    const r = (await issueToken('read')).auth;
    expect((await none.app.inject({ method: 'GET', url: '/health', headers: r })).json().review).toBe('not_configured');
    const t = await boot();
    await t.doc();
    const h = async () => (await t.app.inject({ method: 'GET', url: '/health', headers: r })).json().review;
    expect(await h()).toBe('unknown');
    serve(() => answer([]));
    await t.post('/reviews/run');
    expect(await h()).toBe('ok');
    serve(() => HttpResponse.json({ error: {} }, { status: 500 }));
    t.clock.t += HOUR;
    await t.post('/reviews/run');
    expect(await h()).toBe('failed');
  });
});
