import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createDb } from '../../src/db/client.js';
import { makeApp } from '../helpers/app.js';
import { testDb } from '../helpers/db.js';
import { issueToken } from '../helpers/tokens.js';
import { DOMAIN } from '../helpers/buy.js';
import { FakeAdapter } from '../helpers/fake-adapter.js';

const JOB_TOKEN = 'job_token_fake_0123456789abcdef0123456789';
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
  it('401 without a bearer and with a wrong bearer, nothing audited (unauthenticated: zero DB writes)', async () => {
    app = await make();
    expect((await post(app, 'tick', {}, 'k-none')).statusCode).toBe(401);
    const wrong = await post(app, 'tick', { authorization: 'Bearer wrong_token' }, 'k-wrong');
    expect(wrong.statusCode).toBe(401);
    expect(wrong.json().error.code).toBe('UNAUTHORIZED');
    const rows = await testDb.selectFrom('audit_log').selectAll().where('path', '=', '/jobs/run').orderBy('at').execute();
    expect(rows).toHaveLength(0);
    expect(await testDb.selectFrom('idempotency_keys').selectAll().execute()).toHaveLength(0);
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

  it('503 JOBS_DISABLED when JOB_TRIGGER_TOKEN is not configured (no audit row)', async () => {
    app = await makeApp({ testRoutes: false });
    const res = await post(app, 'tick');
    expect(res.statusCode).toBe(503);
    expect(res.json().error.code).toBe('JOBS_DISABLED');
    expect(await testDb.selectFrom('audit_log').selectAll().where('path', '=', '/jobs/run').execute()).toHaveLength(0);
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

describe('encoded paths cannot bypass the job route', () => {
  const enc = (app: FastifyInstance, url: string, headers: Record<string, string>) =>
    app.inject({ method: 'POST', url, headers: { ...headers, 'idempotency-key': `enc-${++n}` }, payload: { job: 'tick' } });

  it.each(['/jobs/%72un', '/%6Aobs/run'])('WRITE token on %s → 401; the job token → 200', async (url) => {
    app = await make();
    const write = await issueToken('write');
    expect((await enc(app, url, write.auth)).statusCode).toBe(401);
    expect((await enc(app, url, bearer)).statusCode).toBe(200);
  });

  it('with no JOB_TRIGGER_TOKEN a WRITE token on the encoded path is never 200', async () => {
    app = await makeApp({ testRoutes: false });
    const write = await issueToken('write');
    const res = await enc(app, '/jobs/%72un', write.auth);
    expect([401, 503]).toContain(res.statusCode);
  });

  it('is rate limited under its own key', async () => {
    app = await make();
    const codes: number[] = [];
    for (let i = 0; i < 11; i++) codes.push((await post(app, 'tick')).statusCode);
    expect(codes.slice(0, 10).every((c) => c === 200)).toBe(true);
    expect(codes[10]).toBe(429);
  });
});

describe('step errors', () => {
  it('are redacted of secret values and truncated to 200 chars', async () => {
    app = await make({ env: { JOB_TRIGGER_TOKEN: JOB_TOKEN, PORKBUN_API_KEY: 'pk1_fake_leaky_0000000000' } });
    vi.spyOn(app.reconciler, 'runOnce').mockRejectedValue(new Error(`bad key pk1_fake_leaky_0000000000 ${'x'.repeat(500)}`));
    const err = (await post(app, 'tick')).json().steps.reconciler.error as string;
    expect(err).not.toContain('pk1_fake_leaky');
    expect(err).toContain('[REDACTED]');
    expect(err.length).toBeLessThanOrEqual(203);
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

describe('tick: reconciler cutoffs through the production path (buy.md §6, B-20)', () => {
  const NOW = Date.parse('2026-10-05T12:00:00Z');
  const ago = (m: number) => new Date(NOW - m * 60_000);
  async function seedPurchase(state: 'created' | 'register_sent', ageMin: number, domain = DOMAIN) {
    await testDb.insertInto('quotes').values({
      check_id: `chk_${domain}`, domain, registrar: 'porkbun', available: true, premium: false, first_year_cents: 1108, renewal_cents: 1108,
      privacy_cents_per_year: 0, two_year_cents: 2216, eligible: true, exclusion_reason: null, raw: null,
    }).execute();
    await testDb.insertInto('purchases').values({
      idempotency_key: `k-${domain}`, request_hash: 'h', domain, state, registrar: 'porkbun', check_id: `chk_${domain}`,
      max_price_cents: 1150, approval_text: `buy ${domain}`, approval_at: ago(ageMin + 5), expected_cents: 1108,
      request: JSON.stringify({ domain, category: 'geo', deal_id: 'D-003' }), audit_id: `aud_${'a'.repeat(32)}`,
      created_at: ago(ageMin), updated_at: ago(ageMin),
    }).execute();
    await testDb.insertInto('domains').values({ domain, status: 'pending_purchase', registrar: 'porkbun', category: 'geo', deal_id: 'D-003' }).execute();
  }
  const tick = async (adapters: FakeAdapter[] = [new FakeAdapter('porkbun')]) => {
    await app?.close();
    app = await make({ now: () => NOW, adapters, rdap: async () => 'not_registered' });
    const res = await post(app, 'tick');
    expect(res.statusCode).toBe(200);
    return res.json();
  };

  it('(a) B-20: register_sent with the registrar showing it present is completed by a tick; 1 registration row; a second tick still 1', async () => {
    await seedPurchase('register_sent', 5);
    const body = await tick([new FakeAdapter('porkbun', { alreadyOwned: true })]);
    expect(body.steps.reconciler).toMatchObject({ ok: true, summary: { booked: 1 } });
    expect(await testDb.selectFrom('ledger_entries').selectAll().where('type', '=', 'registration').execute()).toHaveLength(1);
    expect((await testDb.selectFrom('purchases').selectAll().executeTakeFirstOrThrow()).state).toBe('succeeded');
    await tick([new FakeAdapter('porkbun', { alreadyOwned: true })]);
    expect(await testDb.selectFrom('ledger_entries').selectAll().where('type', '=', 'registration').execute()).toHaveLength(1);
  });

  it('(b) a created purchase 11 min old is failed and its pending domain removed; one 5 min old is untouched', async () => {
    await seedPurchase('created', 11);
    await seedPurchase('created', 5, 'fresh.com');
    const body = await tick();
    expect(body.steps.reconciler.summary).toMatchObject({ abandoned: 1 });
    const states = await testDb.selectFrom('purchases').select(['domain', 'state']).orderBy('domain').execute();
    expect(states).toEqual([{ domain: DOMAIN, state: 'failed' }, { domain: 'fresh.com', state: 'created' }].sort((x, y) => x.domain.localeCompare(y.domain)));
    expect((await testDb.selectFrom('domains').select('domain').execute()).map((r) => r.domain)).toEqual(['fresh.com']);
  });

  it('(c) a register_sent purchase 1 min old is untouched', async () => {
    await seedPurchase('register_sent', 1);
    const body = await tick([new FakeAdapter('porkbun', { alreadyOwned: true })]);
    expect(body.steps.reconciler.summary).toMatchObject({ booked: 0, failed: 0, abandoned: 0 });
    expect((await testDb.selectFrom('purchases').selectAll().executeTakeFirstOrThrow()).state).toBe('register_sent');
    expect(await testDb.selectFrom('ledger_entries').selectAll().execute()).toHaveLength(0);
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
