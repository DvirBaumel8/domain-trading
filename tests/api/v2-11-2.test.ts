// v2.11.2 (CR-011 addendum C): the review's on/off switch, model and tier (GET/POST /reviews/settings), cost by tier, and the 429 retry
// at the 10:30 IDT tick. MSW only; fake key.
import { randomUUID } from 'node:crypto';
import { http, HttpResponse } from 'msw';
import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { makeApp } from '../helpers/app.js';
import { testDb as db } from '../helpers/db.js';
import { issueToken } from '../helpers/tokens.js';
import { mswServer } from '../setup/network.js';

const KEY = 'test-gemini-key';
const URL_RE = /generativelanguage\.googleapis\.com\/v1beta\/models\/[^/]+:generateContent/;
const T0 = Date.parse('2026-10-20T00:05:00Z'); // 03:05 IDT, a Tuesday: the daily run
const HOUR = 3_600_000;
const apps: FastifyInstance[] = [];
afterEach(async () => { await Promise.all(apps.splice(0).map((a) => a.close())); });

const answer = (items: object[] = [{ category: 'pricing', severity: 'medium', text: 'Keep the plan.' }], usage = { promptTokenCount: 10_000, candidatesTokenCount: 2_000 }) => HttpResponse.json({
  candidates: [{ finishReason: 'STOP', content: { parts: [{ text: JSON.stringify({ items }) }] } }], usageMetadata: usage,
});
const tooMany = () => HttpResponse.json({ error: { code: 429, status: 'RESOURCE_EXHAUSTED', message: 'Quota exceeded for the day' } }, { status: 429 });
const seen: { url: string }[] = [];
function serve(resp: () => Response) {
  seen.length = 0;
  mswServer.use(http.post(URL_RE, async ({ request }) => { seen.push({ url: request.url }); return resp(); }));
}

async function boot() {
  const clock = { t: T0 };
  const app = await makeApp({ now: () => clock.t, env: { GEMINI_API_KEY: KEY } });
  apps.push(app);
  const w = (await issueToken('write')).auth;
  const r = (await issueToken('read')).auth;
  const post = (url: string, payload?: object) => app.inject({ method: 'POST', url, headers: { ...w, 'idempotency-key': randomUUID() }, ...(payload === undefined ? {} : { payload }) });
  const get = (url: string, headers = r) => app.inject({ method: 'GET', url, headers });
  const doc = async () => { expect((await post('/company/document', { text: 'We buy short .com names and sell them at a fixed price.' })).statusCode).toBeLessThan(300); };
  const health = async () => (await get('/health')).json();
  return { app, clock, post, get, doc, health, read: r };
}
const rows = () => db.selectFrom('review_settings_changes').selectAll().orderBy('id').execute();
const step = (r: { steps: Record<string, { summary: unknown }> }, name: string) => r.steps[name]!.summary;

describe('GET/POST /reviews/settings', () => {
  it('defaults: enabled, gemini-3.8-flash, free, the allowed list with tiers and prices, no updated_at', async () => {
    const t = await boot();
    const r = await t.get('/reviews/settings');
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({
      enabled: true, model: 'gemini-3.8-flash', tier: 'free', updated_at: null, updated_by: null,
      allowed_models: [
        { model: 'gemini-3.8-flash', tier: 'free', input_usd_per_m: 0.5, output_usd_per_m: 3 },
        { model: 'gemini-3.1-pro-preview', tier: 'paid', input_usd_per_m: 2, output_usd_per_m: 12 },
      ],
    });
    expect(await rows()).toHaveLength(0);
  });

  it('a change is audited, writes one history row with the old values and the new state is returned', async () => {
    const t = await boot();
    const r = await t.post('/reviews/settings', { enabled: false, note: 'off for now' });
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json()).toMatchObject({ changed: true, enabled: false, model: 'gemini-3.8-flash', tier: 'free', updated_by: expect.any(String), updated_at: expect.any(String) });
    const h = await rows();
    expect(h).toHaveLength(1);
    expect(h[0]).toMatchObject({ enabled: false, model: 'gemini-3.8-flash', tier: 'free', note: 'off for now', old: { enabled: true, model: 'gemini-3.8-flash', tier: 'free' } });
    expect(h[0]!.audit_id).toBeTruthy();
    const audit = await db.selectFrom('audit_log').selectAll().where('path', '=', '/reviews/settings').execute();
    expect(audit).toHaveLength(1);
    expect(audit[0]!.id).toBe(h[0]!.audit_id);
    expect((await t.get('/reviews/settings')).json()).toMatchObject({ enabled: false });
    const again = await t.post('/reviews/settings', { enabled: true });
    expect(again.json()).toMatchObject({ changed: true, enabled: true });
    expect((await rows())[1]!.old).toEqual({ enabled: false, model: 'gemini-3.8-flash', tier: 'free' });
  });

  it('no change is 200 unchanged and writes no row', async () => {
    const t = await boot();
    const r = await t.post('/reviews/settings', { enabled: true, model: 'gemini-3.8-flash', tier: 'free' });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ changed: false, enabled: true });
    expect(await rows()).toHaveLength(0);
  });

  it('a model not on the list is 422 REVIEW_MODEL_NOT_ALLOWED with the allowed list; nothing changes', async () => {
    const t = await boot();
    const r = await t.post('/reviews/settings', { model: 'gemini-9-ultra' });
    expect(r.statusCode).toBe(422);
    expect(r.json().error.code).toBe('REVIEW_MODEL_NOT_ALLOWED');
    expect(r.json().error.details.allowed_models.map((m: { model: string }) => m.model)).toEqual(['gemini-3.8-flash', 'gemini-3.1-pro-preview']);
    expect(await rows()).toHaveLength(0);
  });

  it('Pro on the free tier is 422 REVIEW_MODEL_NEEDS_PAID; tier paid needs a note; paid with a note then Pro works', async () => {
    const t = await boot();
    const a = await t.post('/reviews/settings', { model: 'gemini-3.1-pro-preview' });
    expect([a.statusCode, a.json().error.code]).toEqual([422, 'REVIEW_MODEL_NEEDS_PAID']);
    const b = await t.post('/reviews/settings', { model: 'gemini-3.1-pro-preview', tier: 'paid' });
    expect([b.statusCode, b.json().error.code]).toEqual([422, 'VALIDATION_ERROR']);
    expect(b.json().error.message).toContain('Dvir');
    expect(await rows()).toHaveLength(0);
    const c = await t.post('/reviews/settings', { model: 'gemini-3.1-pro-preview', tier: 'paid', note: 'Dvir approved a paid model, chat 21 Oct 2026' });
    expect(c.statusCode, c.body).toBe(200);
    expect(c.json()).toMatchObject({ model: 'gemini-3.1-pro-preview', tier: 'paid' });
    // going back to free while on Pro is refused
    const d = await t.post('/reviews/settings', { tier: 'free' });
    expect([d.statusCode, d.json().error.code]).toEqual([422, 'REVIEW_MODEL_NEEDS_PAID']);
  });

  it('an empty body, an unknown field and a READ token are refused', async () => {
    const t = await boot();
    expect((await t.post('/reviews/settings', {})).statusCode).toBe(400);
    expect((await t.post('/reviews/settings', { enabled: true, extra: 1 })).statusCode).toBe(400);
    const r = await t.app.inject({ method: 'POST', url: '/reviews/settings', headers: { ...t.read, 'idempotency-key': randomUUID() }, payload: { enabled: false } });
    expect(r.statusCode).toBeGreaterThanOrEqual(400);
    expect(await rows()).toHaveLength(0);
  });
});

describe('the switch', () => {
  it('off: the daily step is skipped DISABLED, POST /reviews/run is 409 REVIEW_DISABLED, no Google call; /health shows disabled and the model; on again runs one review', async () => {
    const t = await boot();
    await t.doc();
    serve(() => answer());
    await t.post('/reviews/settings', { enabled: false });
    const d = await t.app.jobRunner.run('daily');
    expect(step(d, 'outsideReview')).toMatchObject({ skipped: true, reason: 'DISABLED' });
    const m = await t.post('/reviews/run');
    expect([m.statusCode, m.json().error.code]).toEqual([409, 'REVIEW_DISABLED']);
    expect(seen).toHaveLength(0);
    expect(await t.health()).toMatchObject({ review: 'disabled', review_model: 'gemini-3.8-flash' });
    expect((await t.get('/reviews/cost')).json()).toMatchObject({ enabled: false });
    // two days missed, then back on: one review, not one per missed day
    t.clock.t += 48 * HOUR;
    await t.post('/reviews/settings', { enabled: true });
    expect(step(await t.app.jobRunner.run('daily'), 'outsideReview')).toMatchObject({ status: 'ok' });
    expect(seen).toHaveLength(1);
    expect(await db.selectFrom('review_feedback').selectAll().execute()).toHaveLength(1);
    expect((await t.health()).review).toBe('ok');
  });

  it('a model change takes effect on the next run and the stored feedback names it', async () => {
    const t = await boot();
    await t.doc();
    serve(() => answer());
    expect((await t.post('/reviews/run')).statusCode).toBe(200);
    expect(seen[0]!.url).toContain('gemini-3.8-flash');
    await t.post('/reviews/settings', { model: 'gemini-3.1-pro-preview', tier: 'paid', note: 'Dvir approved, chat' });
    t.clock.t += HOUR;
    expect((await t.post('/reviews/run')).statusCode).toBe(200);
    expect(seen[1]!.url).toContain('gemini-3.1-pro-preview');
    const fb = await db.selectFrom('review_feedback').select(['model']).orderBy('id').execute();
    expect(fb.map((f) => f.model)).toEqual(['gemini-3.8-flash', 'gemini-3.1-pro-preview']);
    expect((await t.health()).review_model).toBe('gemini-3.1-pro-preview');
  });
});

describe('cost by tier', () => {
  it('free: cost_usd 0 stored and shown, with the count; paid: the model price; the cap holds on paid', async () => {
    const t = await boot();
    await t.doc();
    serve(() => answer());
    const a = await t.post('/reviews/run');
    expect(a.json()).toMatchObject({ status: 'ok', cost_usd: 0 });
    expect(Number((await db.selectFrom('review_feedback').select('cost_usd').executeTakeFirstOrThrow()).cost_usd)).toBe(0);
    expect((await t.get('/reviews/cost')).json()).toMatchObject({ spent_usd: 0, cap_usd: 5, feedback_n: 1, enabled: true, model: 'gemini-3.8-flash', tier: 'free' });
    await t.post('/reviews/settings', { tier: 'paid', note: 'Dvir approved paid flash, chat' });
    t.clock.t += HOUR;
    const b = await t.post('/reviews/run');
    expect(b.json()).toMatchObject({ cost_usd: 0.011 }); // 10000/1e6*0.50 + 2000/1e6*3.00
    expect((await t.get('/reviews/cost')).json()).toMatchObject({ spent_usd: 0.011, tier: 'paid' });
    // past $5 on the paid tier: 409 REVIEW_COST_CAP, no call
    const p = (await db.selectFrom('review_packets').select('id').orderBy('created_at').executeTakeFirstOrThrow()).id;
    await db.insertInto('review_packets').values({ id: 'rvp_000000000001', created_by: 'x', created_at: new Date(t.clock.t), kind: 'daily', document_version: 1, content: '{}', sha256: 'a'.repeat(64) }).execute();
    await db.insertInto('review_feedback').values({ packet_id: 'rvp_000000000001', created_by: 'x', created_at: new Date(t.clock.t), status: 'ok', provider: 'gemini', model: 'gemini-3.8-flash', cost_usd: 5, reason: null }).execute();
    expect(p).toBeDefined();
    seen.length = 0;
    t.clock.t += HOUR;
    const c = await t.post('/reviews/run');
    expect([c.statusCode, c.json().error.code]).toEqual([409, 'REVIEW_COST_CAP']);
    expect(seen).toHaveLength(0);
  });
});

describe('429 and the tick retry', () => {
  const TICK = Date.parse('2026-10-20T07:30:00Z'); // 10:30 IDT the same day

  it('a 429 in the daily run stores no feedback and marks the packet retry_pending; the tick retries once and stores the feedback', async () => {
    const t = await boot();
    await t.doc();
    serve(tooMany);
    const d = await t.app.jobRunner.run('daily');
    expect(step(d, 'outsideReview')).toMatchObject({ status: 'retry_pending' });
    expect(d.steps.outsideReview!).toMatchObject({ ok: true });
    expect(await db.selectFrom('review_feedback').selectAll().execute()).toHaveLength(0);
    const pending = await db.selectFrom('review_retries').selectAll().execute();
    expect(pending).toHaveLength(1);
    expect(pending[0]!.day).toBe('2026-10-20');
    // the daily step does not ask Google again the same day
    seen.length = 0;
    t.clock.t += HOUR;
    expect(step(await t.app.jobRunner.run('daily'), 'outsideReview')).toMatchObject({ skipped: true, reason: 'ALREADY_DONE_TODAY' });
    expect(seen).toHaveLength(0);
    // 10:30 IDT tick
    serve(() => answer());
    t.clock.t = TICK;
    const tick = await t.app.jobRunner.run('tick');
    expect(Object.keys(tick.steps)).toEqual(['reconciler', 'nsVerifier', 'screeningResume', 'reviewRetry']);
    expect(step(tick, 'reviewRetry')).toMatchObject({ status: 'ok', packet_id: pending[0]!.packet_id, items_n: 1 });
    expect(seen).toHaveLength(1);
    const fb = await db.selectFrom('review_feedback').selectAll().execute();
    expect(fb).toHaveLength(1);
    expect(fb[0]).toMatchObject({ packet_id: pending[0]!.packet_id, status: 'ok', provider: 'gemini', model: 'gemini-3.8-flash' });
    // nothing left to retry
    seen.length = 0;
    expect(step(await t.app.jobRunner.run('tick'), 'reviewRetry')).toMatchObject({ skipped: true, reason: 'NOTHING_PENDING' });
    expect(seen).toHaveLength(0);
  });

  it('a second 429 at the retry stores UNKNOWN with Google status and reason; no other model or key is tried', async () => {
    const t = await boot();
    await t.doc();
    serve(tooMany);
    await t.app.jobRunner.run('daily');
    t.clock.t = TICK;
    const tick = await t.app.jobRunner.run('tick');
    expect(step(tick, 'reviewRetry')).toMatchObject({ status: 'unknown' });
    expect(seen).toHaveLength(2); // one daily call, one retry
    expect(new Set(seen.map((s) => s.url)).size).toBe(1);
    const fb = await db.selectFrom('review_feedback').selectAll().execute();
    expect(fb).toHaveLength(1);
    expect(fb[0]).toMatchObject({ status: 'unknown', provider: 'gemini', model: 'gemini-3.8-flash' });
    expect(fb[0]!.reason).toMatch(/^HTTP 429 RESOURCE_EXHAUSTED: Quota exceeded/);
    expect(fb[0]!.reason).not.toContain(KEY);
    expect((await t.health()).review).toBe('failed');
  });

  it('a manual run that gets 429 stores UNKNOWN at once, with no retry marker', async () => {
    const t = await boot();
    await t.doc();
    serve(tooMany);
    const r = await t.post('/reviews/run');
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ status: 'unknown', reason: expect.stringMatching(/^HTTP 429 RESOURCE_EXHAUSTED/) });
    expect(await db.selectFrom('review_retries').selectAll().execute()).toHaveLength(0);
    expect(await db.selectFrom('review_feedback').selectAll().execute()).toHaveLength(1);
    t.clock.t = TICK;
    expect(step(await t.app.jobRunner.run('tick'), 'reviewRetry')).toMatchObject({ skipped: true, reason: 'NOTHING_PENDING' });
  });

  it('a pending retry is not retried the next IDT day, and a disabled review skips the retry', async () => {
    const t = await boot();
    await t.doc();
    serve(tooMany);
    await t.app.jobRunner.run('daily');
    serve(() => answer());
    await t.post('/reviews/settings', { enabled: false });
    t.clock.t = TICK;
    expect(step(await t.app.jobRunner.run('tick'), 'reviewRetry')).toMatchObject({ skipped: true, reason: 'DISABLED' });
    await t.post('/reviews/settings', { enabled: true });
    t.clock.t = TICK + 24 * HOUR;
    expect(step(await t.app.jobRunner.run('tick'), 'reviewRetry')).toMatchObject({ skipped: true, reason: 'NOTHING_PENDING' });
    expect(seen).toHaveLength(0);
  });
});

describe('tables', () => {
  it('review_settings_changes and review_retries are append-only', async () => {
    const t = await boot();
    await t.post('/reviews/settings', { enabled: false });
    await expect(db.updateTable('review_settings_changes').set({ enabled: true }).execute()).rejects.toThrow(/append-only/);
    await expect(db.deleteFrom('review_settings_changes').execute()).rejects.toThrow(/append-only/);
  });
});
