// v3.1.0 (CR-016): JOB_MISSED / JOB_RUN_INCOMPLETE (R-A3), the in-call 503 backoff with attempts (R-1, T16-4), the daily step counting only ok reviews (R-2),
// and /health review_reason (T16-5). MSW only; fake key.
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
const T0 = Date.parse('2026-10-20T00:05:00Z'); // the 00:05 UTC slot
const HOUR = 3_600_000;
const apps: FastifyInstance[] = [];
afterEach(async () => { await Promise.all(apps.splice(0).map((a) => a.close())); });

const answer = () => HttpResponse.json({
  candidates: [{ finishReason: 'STOP', content: { parts: [{ text: JSON.stringify({ items: [{ category: 'pricing', severity: 'low', text: 'Keep the plan.' }] }) }] } }],
  usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 20 },
});
const busy = () => HttpResponse.json({ error: { code: 503, status: 'UNAVAILABLE', message: 'This model is currently experiencing high demand.' } }, { status: 503 });
const tooMany = () => HttpResponse.json({ error: { code: 429, status: 'RESOURCE_EXHAUSTED', message: 'Quota exceeded' } }, { status: 429 });
let calls = 0;
/** Serves the given responses in order; the last one repeats. */
function serve(...resp: (() => Response)[]) {
  calls = 0;
  mswServer.use(http.post(URL_RE, async () => resp[Math.min(calls++, resp.length - 1)]!()));
}

async function boot(start = T0) {
  const clock = { t: start };
  const sleeps: number[] = [];
  const app = await makeApp({ now: () => clock.t, env: { GEMINI_API_KEY: KEY }, sleep: async (ms) => { sleeps.push(ms); } });
  apps.push(app);
  const w = (await issueToken('write')).auth;
  const r = (await issueToken('read')).auth;
  const post = (url: string, payload?: object) => app.inject({ method: 'POST', url, headers: { ...w, 'idempotency-key': randomUUID() }, ...(payload === undefined ? {} : { payload }) });
  const get = (url: string) => app.inject({ method: 'GET', url, headers: r });
  const doc = async () => { expect((await post('/company/document', { text: 'We buy short .com names and sell them at a fixed price.' })).statusCode).toBeLessThan(300); };
  const warnings = async () => ((await get('/report')).json().warnings as { code: string; level: string; details: Record<string, any> }[]);
  return { app, clock, sleeps, post, get, doc, warnings };
}

const queueRun = async (job: 'daily' | 'tick', createdAt: number, status: 'done' | 'queued' | 'running', trigger: 'scheduled' | 'manual' = 'scheduled') => {
  const id = `run_${randomUUID()}`;
  await db.insertInto('job_queue_runs').values({ id, job, trigger, created_at: new Date(createdAt) }).execute();
  await db.insertInto('job_steps').values([
    { run_id: id, job, step: 'reconciler', position: 0, max_attempts: 1, timeout_ms: 1000, status: 'done' as const, started_at: new Date(createdAt), finished_at: new Date(createdAt) },
    { run_id: id, job, step: 'priceJob', position: 1, max_attempts: 1, timeout_ms: 1000, status, ...(status === 'running' ? { started_at: new Date(createdAt) } : {}), ...(status === 'done' ? { started_at: new Date(createdAt), finished_at: new Date(createdAt) } : {}) },
  ]).execute();
  return id;
};

describe('R-A3 missed and unfinished scheduled runs', () => {
  it('JOB_MISSED: the slot passed over 30 minutes ago and no daily run was created since; /health jobs overdue; /jobs/runs missed_slot', async () => {
    const t = await boot(T0 + 40 * 60_000);
    expect((await t.warnings()).map((w) => w.code)).not.toContain('JOB_MISSED'); // no daily run in history yet
    const old = await queueRun('daily', T0 - 20 * HOUR, 'done');
    // a manual daily from 20 h ago is in the history; today's slot has no run
    const w = (await t.warnings()).find((x) => x.code === 'JOB_MISSED')!;
    expect(w).toMatchObject({ level: 'error', details: { slot: expect.stringMatching(/^2026-10-20T03:05:00\+03:00$/), last_run_at: expect.stringMatching(/^2026-10-19T/) } });
    expect((await t.get('/health')).json().jobs).toBe('overdue');
    const jr = (await t.get('/jobs/runs')).json().jobs.daily;
    expect(jr).toMatchObject({ missed_slot: expect.stringMatching(/^2026-10-20T03:05:00\+03:00$/), last_scheduled: { run_id: old, status: 'finished', ok: null } });
    // a run created at or after the slot (any trigger) clears it
    await queueRun('daily', T0 + 10 * 60_000, 'done', 'manual');
    expect((await t.warnings()).map((x) => x.code)).not.toContain('JOB_MISSED');
    expect((await t.get('/jobs/runs')).json().jobs.daily.missed_slot).toBeNull();
  });

  it('JOB_MISSED is not raised within 30 minutes of the slot', async () => {
    const t = await boot(T0 + 20 * 60_000);
    await queueRun('daily', T0 - 20 * HOUR, 'done');
    expect((await t.warnings()).map((w) => w.code)).not.toContain('JOB_MISSED');
  });

  it('JOB_RUN_INCOMPLETE: a daily run open for over 2 hours names the run and the open steps', async () => {
    const t = await boot(T0 + 3 * HOUR);
    const young = await queueRun('daily', T0 + 2.5 * HOUR, 'running');
    expect((await t.warnings()).map((w) => w.code)).not.toContain('JOB_RUN_INCOMPLETE');
    await db.deleteFrom('job_steps').where('run_id', '=', young).execute();
    await db.deleteFrom('job_queue_runs').where('id', '=', young).execute();
    const id = await queueRun('daily', T0 + 0.5 * HOUR, 'running');
    const w = (await t.warnings()).find((x) => x.code === 'JOB_RUN_INCOMPLETE')!;
    expect(w).toMatchObject({ level: 'error', details: { run_id: id, started_at: expect.stringMatching(/^2026-10-20T/), open_steps: ['priceJob'] } });
  });
});

describe('B R-1 the in-call backoff on 503 / UNAVAILABLE (T16-4)', () => {
  it('T16-4 a 503 then a 200 stores ok with attempts 2; one wait of 20 s', async () => {
    const t = await boot();
    await t.doc();
    serve(busy, answer);
    const r = await t.post('/reviews/run');
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ status: 'ok', attempts: 2 });
    expect(calls).toBe(2);
    expect(t.sleeps).toEqual([20_000]);
    expect((await db.selectFrom('review_feedback').selectAll().execute())[0]).toMatchObject({ status: 'ok', attempts: 2 });
  });

  it('3 tries in all (waits 20 s and 40 s), then UNKNOWN with attempts 3', async () => {
    const t = await boot();
    await t.doc();
    serve(busy);
    const r = await t.post('/reviews/run');
    expect(r.json()).toMatchObject({ status: 'unknown', attempts: 3, reason: expect.stringMatching(/^HTTP 503 UNAVAILABLE/) });
    expect(calls).toBe(3);
    expect(t.sleeps).toEqual([20_000, 40_000]);
    expect((await db.selectFrom('review_feedback').selectAll().execute())[0]).toMatchObject({ status: 'unknown', attempts: 3 });
  });

  it('the daily step backs off the same way, then defers to the tick (retry_pending); a 429 is not retried in the call', async () => {
    const t = await boot();
    await t.doc();
    serve(busy);
    const d = await t.app.jobRunner.run('daily');
    expect(d.steps.outsideReview!.summary).toMatchObject({ status: 'retry_pending', attempts: 3 });
    expect(calls).toBe(3);
    expect(t.sleeps).toEqual([20_000, 40_000]);
    expect(await db.selectFrom('review_feedback').selectAll().execute()).toHaveLength(0);
    // a 429 on the manual run: one call, no wait
    t.sleeps.length = 0;
    serve(tooMany);
    const r = await t.post('/reviews/run');
    expect(r.json()).toMatchObject({ status: 'unknown', attempts: 1 });
    expect(calls).toBe(1);
    expect(t.sleeps).toEqual([]);
  });
});

describe('B R-2 only an ok review counts for the day; /health review_reason (T16-5)', () => {
  it('a manual run whose feedback is unknown does not make the daily step ALREADY_DONE_TODAY; an ok one does', async () => {
    const t = await boot();
    await t.doc();
    serve(tooMany);
    expect((await t.post('/reviews/run')).json()).toMatchObject({ status: 'unknown' });
    serve(answer);
    t.clock.t += HOUR;
    const d = await t.app.jobRunner.run('daily');
    expect(d.steps.outsideReview!.summary).toMatchObject({ status: 'ok' });
    expect(calls).toBe(1);
    t.clock.t += HOUR;
    expect((await t.app.jobRunner.run('daily')).steps.outsideReview!.summary).toMatchObject({ skipped: true, reason: 'ALREADY_DONE_TODAY' });
  });

  it('T16-5 when the last review failed, /health names the reason (short, no key); it is absent when review is ok', async () => {
    const t = await boot();
    await t.doc();
    serve(busy);
    await t.post('/reviews/run');
    const h = (await t.get('/health')).json();
    expect(h.review).toBe('failed');
    expect(h.review_reason).toMatch(/^HTTP 503 UNAVAILABLE/);
    expect(h.review_reason.length).toBeLessThanOrEqual(120);
    expect(JSON.stringify(h)).not.toContain(KEY);
    serve(answer);
    t.clock.t += HOUR;
    await t.post('/reviews/run');
    const ok = (await t.get('/health')).json();
    expect(ok.review).toBe('ok');
    expect(ok).not.toHaveProperty('review_reason');
  });
});
