// v3.0.0 (refactor R3): the Postgres job queue. POST /jobs/run enqueues (202) and the in-process worker works the steps in order.
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { sql } from 'kysely';
import { makeApp, runJobToEnd } from '../../helpers/app.js';
import { testDb } from '../../helpers/db.js';
import { issueToken } from '../../helpers/tokens.js';

const JOB_TOKEN = 'job_token_fake_0123456789abcdef0123456789';
const bearer = { authorization: `Bearer ${JOB_TOKEN}` };
const TICK = ['reconciler', 'nsVerifier', 'screeningResume', 'reviewRetry'];
const apps: FastifyInstance[] = [];
afterEach(async () => { vi.restoreAllMocks(); while (apps.length) await apps.pop()!.close(); });
const make = async (extra: Parameters<typeof makeApp>[0] = {}) => {
  const a = await makeApp({ testRoutes: false, env: { JOB_TRIGGER_TOKEN: JOB_TOKEN }, ...extra });
  apps.push(a);
  return a;
};
let n = 0;
const post = (app: FastifyInstance, job: string) => app.inject({ method: 'POST', url: '/jobs/run', headers: { ...bearer, 'idempotency-key': `q-${++n}` }, payload: { job } });
const gated = () => { let release!: () => void; const gate = new Promise<void>((r) => { release = r; }); return { gate, release }; };
const stepRows = (runId: string) => testDb.selectFrom('job_steps').selectAll().where('run_id', '=', runId).orderBy('position').execute();
const until = async (f: () => Promise<boolean> | boolean) => { for (let i = 0; i < 400 && !(await f()); i++) await new Promise((r) => setTimeout(r, 10)); expect(await f()).toBe(true); };

describe('enqueue', () => {
  it('Q-1 POST /jobs/run answers 202 at once with run_id and the step names while the first step is still running; GET /jobs/runs shows the live step states', async () => {
    const app = await make();
    const { gate, release } = gated();
    const rec = vi.spyOn(app.reconciler, 'runOnce').mockImplementation(async () => { await gate; return {} as never; });
    const res = await post(app, 'tick');
    expect(res.statusCode).toBe(202);
    const body = res.json();
    expect(body).toMatchObject({ job: 'tick', status: 'queued', skipped: false, steps: TICK });
    expect(body.run_id).toMatch(/^run_/);
    await until(() => rec.mock.calls.length === 1);
    const read = await issueToken('read');
    const runs = (await app.inject({ method: 'GET', url: '/jobs/runs?job=tick', headers: read.auth })).json().runs;
    expect(runs[0]).toMatchObject({ run_id: body.run_id, status: 'running', finished_at: null, ok: null, skipped: false, trigger: 'manual' });
    expect(Object.keys(runs[0].steps)).toEqual(TICK);
    expect(runs[0].steps.reconciler).toMatchObject({ status: 'running', attempts: 1, ok: null });
    expect(runs[0].steps.nsVerifier).toMatchObject({ status: 'queued', attempts: 0, ok: null });
    release();
    await app.jobQueue.idle();
    const done = (await app.inject({ method: 'GET', url: '/jobs/runs?job=tick', headers: read.auth })).json().runs;
    expect(done).toHaveLength(1);
    expect(done[0]).toMatchObject({ run_id: body.run_id, status: 'finished', ok: true });
    expect(done[0].steps.reconciler).toMatchObject({ ok: true, status: 'done', attempts: 1, ms: expect.any(Number), started_at: expect.any(String), finished_at: expect.any(String) });
  });

  it('Q-2 the steps run strictly in position order, one after the other', async () => {
    const app = await make();
    const order: string[] = [];
    const slow = async (name: string, ms: number) => { order.push(`${name} start`); await new Promise((r) => setTimeout(r, ms)); order.push(`${name} end`); return {} as never; };
    vi.spyOn(app.reconciler, 'runOnce').mockImplementation(() => slow('reconciler', 40));
    vi.spyOn(app.nsVerifier, 'runOnce').mockImplementation(() => slow('nsVerifier', 10));
    vi.spyOn(app.screeningWorker, 'resumeStalled').mockImplementation(() => slow('screeningResume', 1));
    const r = await runJobToEnd(app, 'tick');
    expect(Object.keys(r.json().steps)).toEqual(TICK);
    expect(order).toEqual(['reconciler start', 'reconciler end', 'nsVerifier start', 'nsVerifier end', 'screeningResume start', 'screeningResume end']);
  });

  it('Q-3 a run of the same job that is still open is returned with skipped:true and nothing new is queued; another job is independent', async () => {
    const app = await make();
    const { gate, release } = gated();
    const rec = vi.spyOn(app.reconciler, 'runOnce').mockImplementation(async () => { await gate; return {} as never; });
    const first = (await post(app, 'tick')).json();
    await until(() => rec.mock.calls.length === 1);
    const second = await post(app, 'tick');
    expect(second.statusCode).toBe(202);
    expect(second.json()).toMatchObject({ run_id: first.run_id, job: 'tick', skipped: true, status: 'running', steps: TICK });
    expect(await testDb.selectFrom('job_queue_runs').select('id').execute()).toHaveLength(1);
    const audit = await testDb.selectFrom('audit_log').select('result_summary').where('path', '=', '/jobs/run').orderBy('at').execute();
    expect(audit.map((a) => a.result_summary)).toEqual(['tick: queued', 'tick: skipped']);
    release();
    await app.jobQueue.idle();
    expect(await testDb.selectFrom('job_runs').select('id').execute()).toHaveLength(1);
    // finished: the next POST is a new run
    const third = (await post(app, 'tick')).json();
    expect(third.skipped).toBe(false);
    expect(third.run_id).not.toBe(first.run_id);
  });
});

describe('attempts, timeouts, isolation', () => {
  it('Q-4 a failing step is tried max_attempts times, then fails; the later steps still run; the run is not ok', async () => {
    const app = await make();
    const rec = vi.spyOn(app.reconciler, 'runOnce').mockRejectedValue(new Error('rec boom'));
    const ns = vi.spyOn(app.nsVerifier, 'runOnce');
    const r = await runJobToEnd(app, 'tick');
    expect(rec).toHaveBeenCalledTimes(2);
    expect(ns).toHaveBeenCalledTimes(1);
    expect(r.json().ok).toBe(false);
    expect(r.json().steps.reconciler).toMatchObject({ ok: false, error: 'rec boom', status: 'failed', attempts: 2 });
    expect(r.json().steps.nsVerifier).toMatchObject({ ok: true, status: 'done', attempts: 1 });
  });

  it('Q-5 a step that fails once and then works is done on attempt 2', async () => {
    const app = await make();
    const rec = vi.spyOn(app.reconciler, 'runOnce').mockRejectedValueOnce(new Error('flaky')).mockResolvedValue({ booked: 0 } as never);
    const r = await runJobToEnd(app, 'tick');
    expect(rec).toHaveBeenCalledTimes(2);
    expect(r.json().ok).toBe(true);
    expect(r.json().steps.reconciler).toMatchObject({ ok: true, status: 'done', attempts: 2, summary: { booked: 0 } });
  });

  it('Q-6 a step that returns failed items is failed at once (no retry)', async () => {
    const app = await make();
    const rec = vi.spyOn(app.reconciler, 'runOnce').mockResolvedValue({ failed: [{ x: 1 }] } as never);
    const r = await runJobToEnd(app, 'tick');
    expect(rec).toHaveBeenCalledTimes(1);
    expect(r.json().steps.reconciler).toMatchObject({ ok: false, status: 'failed', attempts: 1, error: '1 item(s) failed', summary: { failed: [{ x: 1 }] } });
  });

  it('Q-7 a step that outlives its timeout fails the attempt with "timeout"; after the last attempt it is failed and the next step runs', async () => {
    const app = await make({ jobQueueOverrides: { reconciler: { timeoutMs: 60, maxAttempts: 2 } } });
    const rec = vi.spyOn(app.reconciler, 'runOnce').mockImplementation(() => new Promise(() => {}));
    const ns = vi.spyOn(app.nsVerifier, 'runOnce');
    const r = await runJobToEnd(app, 'tick');
    expect(rec).toHaveBeenCalledTimes(2);
    expect(r.json().steps.reconciler).toMatchObject({ ok: false, error: 'timeout', status: 'failed', attempts: 2 });
    expect(ns).toHaveBeenCalledTimes(1);
  });

  it('Q-8 the limits per step are stored with the step (defaults 2 attempts / 5 min; outside readers 3; review 1; intake and daily list 10 min)', async () => {
    const app = await make();
    const e = await app.jobQueue.enqueue('daily');
    const rows = Object.fromEntries((await stepRows(e.runId)).map((s) => [s.step, s]));
    expect(rows.reconciler).toMatchObject({ max_attempts: 2, timeout_ms: 300_000, position: 0 });
    expect(rows.registrarCheck).toMatchObject({ max_attempts: 3 });
    expect(rows.outsideReview).toMatchObject({ max_attempts: 1 });
    expect(rows.intakeScreening).toMatchObject({ timeout_ms: 600_000 });
    expect(rows.buildDailyList).toMatchObject({ timeout_ms: 600_000 });
    expect(rows.backupExport).toMatchObject({ position: 14 });
  });
});

describe('dead instances, two instances, resume', () => {
  it('Q-9 a running step whose lock expired (the instance died) is reclaimed by the next worker pass; the attempt counts', async () => {
    const app = await make();
    const e = await app.jobQueue.enqueue('tick');
    await sql`update job_steps set status = 'running', attempt = 1, locked_by = 'dead-instance', locked_until = now() - interval '1 minute', started_at = now() - interval '10 minutes' where run_id = ${e.runId} and position = 0`.execute(testDb);
    const rec = vi.spyOn(app.reconciler, 'runOnce');
    app.jobQueue.kick();
    await app.jobQueue.idle();
    expect(rec).toHaveBeenCalledTimes(1);
    const rows = await stepRows(e.runId);
    expect(rows[0]).toMatchObject({ status: 'done', attempt: 2, locked_by: null });
    expect(rows.every((r) => r.status === 'done' || r.status === 'skipped')).toBe(true);
    expect(await testDb.selectFrom('job_runs').select('queue_run_id').execute()).toEqual([{ queue_run_id: e.runId }]);
  });

  it('Q-10 an expired step with no attempts left is failed ("lock expired") and the run goes on', async () => {
    const app = await make();
    const e = await app.jobQueue.enqueue('tick');
    await sql`update job_steps set status = 'running', attempt = max_attempts, locked_by = 'dead-instance', locked_until = now() - interval '1 minute' where run_id = ${e.runId} and position = 0`.execute(testDb);
    const rec = vi.spyOn(app.reconciler, 'runOnce');
    app.jobQueue.kick();
    await app.jobQueue.idle();
    expect(rec).not.toHaveBeenCalled();
    const rows = await stepRows(e.runId);
    expect(rows[0]).toMatchObject({ status: 'failed', error: 'lock expired' });
    expect(rows[1]!.status).toBe('done');
    expect((await testDb.selectFrom('job_runs').select('ok').executeTakeFirstOrThrow()).ok).toBe(false);
  });

  it('Q-11 two app instances on one database never run the same step', async () => {
    const a = await make();
    const b = await make();
    const e = await a.jobQueue.enqueue('daily');
    const calls = { a: 0, b: 0 };
    for (const [k, app] of [['a', a], ['b', b]] as const) {
      vi.spyOn(app.reconciler, 'runOnce').mockImplementation(async () => { calls[k]++; await new Promise((r) => setTimeout(r, 30)); return {} as never; });
      vi.spyOn(app.priceJob, 'runOnce').mockImplementation(async () => { calls[k] += 10; return { skipped: false } as never; });
      vi.spyOn(app.referenceRefreshJob, 'runOnce').mockResolvedValue({ skipped: true, reason: 'test' });
    }
    a.jobQueue.kick();
    b.jobQueue.kick();
    await Promise.all([a.jobQueue.idle(), b.jobQueue.idle()]);
    expect(calls.a + calls.b).toBe(11); // reconciler once, priceJob once, in total
    const rows = await stepRows(e.runId);
    expect(rows.every((r) => r.attempt === 1)).toBe(true);
    expect(await testDb.selectFrom('job_runs').select('id').execute()).toHaveLength(1);
  });

  it('Q-12 unfinished runs resume when the app starts and kicks (main.ts), and on GET /health and GET /jobs/runs', async () => {
    const first = await make();
    const e1 = await first.jobQueue.enqueue('tick'); // queued by a process that then died: nothing is working it
    const rec = vi.spyOn(first.reconciler, 'runOnce');
    const app = await make();
    await app.jobQueue.kickIfNeeded(); // what main.ts does after listen
    await app.jobQueue.idle();
    expect((await stepRows(e1.runId)).every((s) => s.status === 'done' || s.status === 'skipped')).toBe(true);
    expect(rec).not.toHaveBeenCalled();

    const read = await issueToken('read');
    const e2 = await app.jobQueue.enqueue('tick');
    expect((await app.inject({ method: 'GET', url: '/health', headers: read.auth })).statusCode).toBe(200);
    await app.jobQueue.idle();
    expect((await stepRows(e2.runId)).every((s) => s.status !== 'queued')).toBe(true);

    const e3 = await app.jobQueue.enqueue('daily');
    await app.inject({ method: 'GET', url: '/jobs/runs', headers: read.auth });
    await app.jobQueue.idle();
    expect((await stepRows(e3.runId)).every((s) => s.status !== 'queued')).toBe(true);
  });
});

describe('JOB_OVERDUE and the guard', () => {
  it('Q-13 a daily run counts for JOB_OVERDUE when it finishes (even with a failed step); a queued or running one does not', async () => {
    const app = await make();
    const read = await issueToken('read');
    const jobs = async () => (await app.inject({ method: 'GET', url: '/health', headers: read.auth })).json().jobs;
    expect(await jobs()).toBe('overdue');
    const { gate, release } = gated();
    const price = vi.spyOn(app.priceJob, 'runOnce').mockImplementation(async () => { await gate; return { skipped: false } as never; });
    vi.spyOn(app.referenceRefreshJob, 'runOnce').mockResolvedValue({ skipped: true, reason: 'test' });
    vi.spyOn(app.registrarCheckJob, 'runOnce').mockRejectedValue(new Error('down'));
    await post(app, 'daily');
    await until(() => price.mock.calls.length === 1);
    expect(await jobs()).toBe('overdue');
    release();
    await app.jobQueue.idle();
    expect((await testDb.selectFrom('job_runs').select('ok').executeTakeFirstOrThrow()).ok).toBe(false);
    expect(await jobs()).toBe('ok');
  });

  it('Q-14 job_steps only moves forward: a finished step cannot be reopened and a queued step cannot be marked done', async () => {
    const app = await make();
    const r = await runJobToEnd(app, 'tick');
    const id = r.accepted.run_id;
    await expect(sql`update job_steps set status = 'queued' where run_id = ${id} and position = 0`.execute(testDb)).rejects.toThrow(/not allowed/);
    const e = await app.jobQueue.enqueue('tick');
    await expect(sql`update job_steps set status = 'done' where run_id = ${e.runId} and position = 0`.execute(testDb)).rejects.toThrow(/not allowed/);
    await expect(sql`update job_steps set step = 'x' where run_id = ${e.runId} and position = 0`.execute(testDb)).rejects.toThrow(/identity/);
    await sql`update job_steps set status = 'running' where run_id = ${e.runId} and position = 0`.execute(testDb);
    await sql`update job_steps set status = 'queued' where run_id = ${e.runId} and position = 0`.execute(testDb);
  });
});

describe('keep-alive', () => {
  it('Q-15 while a step runs the service pings /health/ping every 5 minutes (11 min = 2 pings) and stops when idle; off by default', async () => {
    const pings: string[] = [];
    const fake = (async (url: string) => { pings.push(url); return new Response('{}'); }) as unknown as typeof fetch;
    const app = await make({ jobQueueKeepAlive: { url: 'https://svc.example.com/', fetch: fake } });
    const { gate, release } = gated();
    const rec = vi.spyOn(app.reconciler, 'runOnce').mockImplementation(async () => { await gate; return {} as never; });
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    try {
      await post(app, 'tick');
      await until(() => rec.mock.calls.length === 1);
      await vi.advanceTimersByTimeAsync(11 * 60_000);
      expect(pings).toEqual(['https://svc.example.com/health/ping', 'https://svc.example.com/health/ping']);
      release();
      await app.jobQueue.idle();
      await vi.advanceTimersByTimeAsync(20 * 60_000);
      expect(pings).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
    const quiet = await make();
    await runJobToEnd(quiet, 'tick');
    expect(pings).toHaveLength(2);
  });
});
