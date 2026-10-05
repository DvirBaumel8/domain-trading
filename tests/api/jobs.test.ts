import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createDb } from '../../src/db/client.js';
import { makeApp } from '../helpers/app.js';
import { testDb } from '../helpers/db.js';
import { issueToken } from '../helpers/tokens.js';

const JOB_TOKEN = 'job_token_fake_0123456789abcdef';
const bearer = { authorization: `Bearer ${JOB_TOKEN}` };
let n = 0;
const post = (app: FastifyInstance, job: unknown, headers: Record<string, string> = bearer, key = `k-${++n}`) =>
  app.inject({ method: 'POST', url: '/jobs/run', headers: { ...headers, 'idempotency-key': key }, payload: { job } });

let app: FastifyInstance;
afterEach(async () => {
  vi.restoreAllMocks();
  await app?.close();
});
const make = (extra: Parameters<typeof makeApp>[0] = {}) =>
  makeApp({ testRoutes: false, env: { JOB_TRIGGER_TOKEN: JOB_TOKEN }, ...extra });

describe('POST /jobs/run auth', () => {
  it('401 without a bearer and with a wrong bearer, both audited with scope job', async () => {
    app = await make();
    expect((await post(app, 'tick', {}, 'k-none')).statusCode).toBe(401);
    const wrong = await post(app, 'tick', { authorization: 'Bearer wrong_token' }, 'k-wrong');
    expect(wrong.statusCode).toBe(401);
    expect(wrong.json().error.code).toBe('UNAUTHORIZED');
    const rows = await testDb.selectFrom('audit_log').selectAll().where('path', '=', '/jobs/run').orderBy('at').execute();
    expect(rows).toHaveLength(2);
    for (const r of rows) expect(r).toMatchObject({ scope: 'job', token_id: null, status_code: 401, result_summary: 'UNAUTHORIZED' });
  });

  it('does not accept READ or WRITE API tokens', async () => {
    app = await make();
    const read = await issueToken('read');
    const write = await issueToken('write');
    expect((await post(app, 'tick', read.auth)).statusCode).toBe(401);
    expect((await post(app, 'tick', write.auth)).statusCode).toBe(401);
  });

  it('the job token does not work on other routes', async () => {
    app = await make();
    const res = await app.inject({ method: 'GET', url: '/portfolio', headers: bearer });
    expect(res.statusCode).toBe(401);
  });

  it('503 JOBS_DISABLED when JOB_TRIGGER_TOKEN is not configured', async () => {
    app = await makeApp({ testRoutes: false });
    const res = await post(app, 'tick');
    expect(res.statusCode).toBe(503);
    expect(res.json().error.code).toBe('JOBS_DISABLED');
  });

  it('requires an Idempotency-Key and a valid body', async () => {
    app = await make();
    const noKey = await app.inject({ method: 'POST', url: '/jobs/run', headers: bearer, payload: { job: 'tick' } });
    expect(noKey.statusCode).toBe(400);
    expect(noKey.json().error.code).toBe('IDEMPOTENCY_KEY_REQUIRED');
    expect((await post(app, 'weekly')).statusCode).toBe(422);
    const extra = await app.inject({ method: 'POST', url: '/jobs/run', headers: { ...bearer, 'idempotency-key': 'k-x' }, payload: { job: 'tick', x: 1 } });
    expect(extra.statusCode).toBe(422);
  });

  it('is audited with scope job and no token id on success; same key replays the stored response', async () => {
    app = await make();
    const spy = vi.spyOn(app.reconciler, 'runOnce');
    const a = await post(app, 'tick', bearer, 'same-key');
    expect(a.statusCode).toBe(200);
    const b = await post(app, 'tick', bearer, 'same-key');
    expect(b.statusCode).toBe(200);
    expect(b.headers['idempotent-replayed']).toBe('true');
    expect(b.body).toBe(a.body);
    expect(spy).toHaveBeenCalledTimes(1);
    const rows = await testDb.selectFrom('audit_log').selectAll().where('path', '=', '/jobs/run').orderBy('at').execute();
    expect(rows[0]).toMatchObject({ scope: 'job', token_id: null, status_code: 200, result_summary: 'tick: ok' });
    expect(rows[1]!.result_summary).toBe('replayed:ok');
    const idem = await testDb.selectFrom('idempotency_keys').selectAll().where('key', '=', 'same-key').executeTakeFirstOrThrow();
    expect(idem.token_id).toBeNull();
  });
});

describe('tick', () => {
  it('runs the reconciler and, when never run, the NS verifier (which records an ns-verify audit row)', async () => {
    app = await make();
    const rec = vi.spyOn(app.reconciler, 'runOnce');
    const res = await post(app, 'tick');
    expect(res.json()).toMatchObject({ job: 'tick', skipped: false, steps: { reconciler: { ok: true }, nsVerifier: { ok: true } } });
    expect(rec).toHaveBeenCalledTimes(1);
    expect(await testDb.selectFrom('audit_log').select('id').where('path', '=', 'ns-verify').execute()).toHaveLength(1);
  });

  it('runs the NS verifier only when its last run is 24 h old', async () => {
    let now = Date.parse('2026-10-06T00:00:00Z');
    app = await make({ now: () => now });
    const ns = vi.spyOn(app.nsVerifier, 'runOnce');
    await post(app, 'tick');
    expect(ns).toHaveBeenCalledTimes(1);
    now += 23 * 3_600_000;
    const early = await post(app, 'tick');
    expect(ns).toHaveBeenCalledTimes(1);
    expect(early.json().steps.nsVerifier).toMatchObject({ ok: true, skipped: true });
    now += 3_600_000;
    await post(app, 'tick');
    expect(ns).toHaveBeenCalledTimes(2);
  });

  it('a failing reconciler does not stop the NS verifier', async () => {
    app = await make();
    vi.spyOn(app.reconciler, 'runOnce').mockRejectedValue(new Error('rec boom'));
    const ns = vi.spyOn(app.nsVerifier, 'runOnce');
    const res = await post(app, 'tick');
    expect(res.statusCode).toBe(200);
    expect(res.json().steps.reconciler).toMatchObject({ ok: false, error: 'rec boom' });
    expect(ns).toHaveBeenCalledTimes(1);
  });
});

describe('daily', () => {
  it('runs price, drop, registrar check, then the backup export, in order', async () => {
    const order: string[] = [];
    const backup = { runOnce: vi.fn(async () => { order.push('backup'); return { committed: false }; }) };
    app = await make({ backupExport: backup });
    vi.spyOn(app.priceJob, 'runOnce').mockImplementation(async () => { order.push('price'); return { skipped: false } as never; });
    vi.spyOn(app.dropJob, 'runOnce').mockImplementation(async () => { order.push('drop'); return { skipped: false } as never; });
    vi.spyOn(app.registrarCheckJob, 'runOnce').mockImplementation(async () => { order.push('registrar'); return { skipped: false } as never; });
    const res = await post(app, 'daily');
    expect(order).toEqual(['price', 'drop', 'registrar', 'backup']);
    expect(Object.keys(res.json().steps)).toEqual(['priceJob', 'dropJob', 'registrarCheck', 'backupExport']);
    expect(res.json().steps.backupExport).toMatchObject({ ok: true, summary: { committed: false } });
  });

  it('isolates errors: a failing job does not skip the others, and each step has a summary', async () => {
    const backup = { runOnce: vi.fn(async () => ({ committed: true })) };
    app = await make({ backupExport: backup });
    vi.spyOn(app.priceJob, 'runOnce').mockRejectedValue(new Error('price boom'));
    vi.spyOn(app.registrarCheckJob, 'runOnce').mockRejectedValue(new Error('reg boom'));
    const drop = vi.spyOn(app.dropJob, 'runOnce');
    const res = await post(app, 'daily');
    expect(res.statusCode).toBe(200);
    const steps = res.json().steps;
    expect(steps.priceJob).toMatchObject({ ok: false, error: 'price boom' });
    expect(steps.dropJob.ok).toBe(true);
    expect(drop).toHaveBeenCalledTimes(1);
    expect(steps.registrarCheck).toMatchObject({ ok: false, error: 'reg boom' });
    expect(steps.backupExport.ok).toBe(true);
    expect(backup.runOnce).toHaveBeenCalledTimes(1);
    const audit = await testDb.selectFrom('audit_log').select('result_summary').where('path', '=', '/jobs/run').executeTakeFirstOrThrow();
    expect(audit.result_summary).toBe('daily: failed priceJob,registrarCheck');
  });

  it('without a backup export wired, that step is skipped', async () => {
    app = await make();
    const res = await post(app, 'daily');
    expect(res.json().steps.backupExport).toMatchObject({ ok: true, skipped: true });
  });

  it('a concurrent second daily is skipped', async () => {
    app = await make();
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const price = vi.spyOn(app.priceJob, 'runOnce').mockImplementation(async () => { await gate; return { skipped: false } as never; });
    const first = post(app, 'daily');
    await vi.waitFor(() => expect(price).toHaveBeenCalled());
    const second = await post(app, 'daily');
    expect(second.json()).toMatchObject({ job: 'daily', skipped: true });
    expect(price).toHaveBeenCalledTimes(1);
    release();
    expect((await first).json().skipped).toBe(false);
  });

  it('a job already running elsewhere (its own running flag) reports skipped', async () => {
    app = await make();
    vi.spyOn(app.priceJob, 'runOnce').mockResolvedValue({ skipped: false } as never);
    const flag = app.dropJob as unknown as { running: boolean };
    flag.running = true;
    const res = await post(app, 'daily');
    flag.running = false;
    expect(res.json().steps.dropJob).toMatchObject({ ok: true, skipped: true });
  });
});

describe('GET /health/ping', () => {
  it('is public and makes no DB call', async () => {
    const deadDb = createDb('postgres://dt:dt@127.0.0.1:1/nothing_test');
    const spy = vi.spyOn(deadDb, 'selectFrom');
    app = await makeApp({ testRoutes: false, db: deadDb });
    const res = await app.inject({ method: 'GET', url: '/health/ping' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ok' });
    expect(spy).not.toHaveBeenCalled();
    await deadDb.destroy();
  });
});
