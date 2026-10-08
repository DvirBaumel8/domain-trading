// v2.1.0 (CR-005 N-1, N-2, N-4, N-5, N-8a): GET /jobs/runs, JOB_OVERDUE and /health jobs, POST /jobs/preview, rate-limit headers.
import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { makeApp, runJobToEnd } from '../helpers/app.js';
import { insertOwnedDomain, testDb as db } from '../helpers/db.js';
import { issueToken } from '../helpers/tokens.js';

const JOB_TOKEN = 'job_token_fake_0123456789abcdef0123456789';
const jobAuth = { authorization: `Bearer ${JOB_TOKEN}` };
let app: FastifyInstance;
let clock = Date.parse('2027-04-12T09:00:00Z');
afterEach(async () => app?.close());
const make = async () => {
  clock = Date.parse('2027-04-12T09:00:00Z');
  app = await makeApp({ testRoutes: false, now: () => clock, env: { JOB_TRIGGER_TOKEN: JOB_TOKEN } });
};
// v3.0.0: enqueue (202), then wait for the worker; the result has the pre-3.0.0 shape.
const runJob = (job: 'tick' | 'daily', key: string) => runJobToEnd(app, job, { headers: jobAuth, key });
const get = async (url: string, auth?: Record<string, string>) => app.inject({ method: 'GET', url, headers: auth ?? (await issueToken('read')).auth });
const warnings = async () => ((await get('/report')).json().warnings as { code: string; level: string; details: Record<string, unknown> }[]);

describe('GET /jobs/runs', () => {
  it('lists runs newest first with trigger, scheduled_for and the full steps; per-job times', async () => {
    await make();
    clock = Date.parse('2027-04-12T00:05:00Z');
    await runJob('daily', `daily-${clock}`); // the Worker's key: scheduled
    clock += 3_600_000;
    await runJob('tick', 'by-hand-1'); // any other key: manual
    const res = await get('/jobs/runs');
    expect(res.statusCode).toBe(200);
    const b = res.json();
    expect(b.runs.map((r: { job: string }) => r.job)).toEqual(['tick', 'daily']);
    expect(b.runs[0]).toMatchObject({ job: 'tick', trigger: 'manual', scheduled_for: null, skipped: false, ok: true });
    expect(b.runs[1]).toMatchObject({ job: 'daily', trigger: 'scheduled', ok: expect.any(Boolean) }); // the outside reference sources are blocked in tests, so a step may fail
    expect(new Date(b.runs[1].scheduled_for).getTime()).toBe(Date.parse('2027-04-12T00:05:00Z'));
    expect(b.runs[1].scheduled_for).toMatch(/\+03:00$/);
    expect(Object.keys(b.runs[1].steps)).toEqual(['reconciler', 'nsVerifier', 'screeningResume', 'priceJob', 'dropJob', 'registrarCheck', 'portfolioCheck', 'dropWatch', 'intakeScreening', 'buildDailyList', 'cohortOutcomes', 'referenceRefresh', 'outsideReview', 'postsRefresh', 'backupExport']);
    expect(b.runs[1].steps.priceJob).toMatchObject({ ok: true, summary: { dryRun: false } });
    expect(b.jobs.daily).toMatchObject({ next_due_at: expect.stringMatching(/^2027-04-13T03:05:00\+03:00$/) });
    expect(new Date(b.jobs.daily.last_run_at).getTime()).toBe(Date.parse('2027-04-12T00:05:00Z'));
    expect(b.jobs.tick.last_ok_at).not.toBeNull();
    expect(b.jobs.tick.next_due_at).toBeNull();
    expect(b.reference).toMatchObject({ popularity: null, iana: { refreshed_at: null }, namebio: { enabled: false } });
    expect(b.backup).toEqual({ configured: false, last_status: 'skipped' });
    expect(res.body).not.toContain(JOB_TOKEN);
    expect(res.body).not.toMatch(/github\.com\//i);
  });

  it('filters by job, since and limit; a bad filter is 400 VALIDATION_ERROR', async () => {
    await make();
    await runJob('tick', 'k1');
    clock += 3_600_000;
    await runJob('daily', 'k2');
    expect((await get('/jobs/runs?job=daily')).json().runs).toHaveLength(1);
    expect((await get('/jobs/runs?limit=1')).json().runs).toHaveLength(1);
    expect((await get(`/jobs/runs?since=${encodeURIComponent(new Date(clock - 60_000).toISOString())}`)).json().runs).toHaveLength(1);
    for (const q of ['job=hourly', 'limit=0', 'limit=501', 'limit=x', 'since=yesterday', 'since=2027-04-12T00:00:00', 'extra=1']) {
      const r = await get(`/jobs/runs?${q}`);
      expect(r.statusCode, q).toBe(400);
      expect(r.json().error.code).toBe('VALIDATION_ERROR');
    }
  });

  it('is not open to the job token or to no token', async () => {
    await make();
    expect((await get('/jobs/runs', jobAuth)).statusCode).toBe(401);
    expect((await get('/jobs/runs', {})).statusCode).toBe(401);
  });

  it('a replayed POST /jobs/run does not record a second run', async () => {
    await make();
    await runJob('tick', 'same');
    expect((await runJob('tick', 'same')).headers['idempotent-replayed']).toBe('true');
    expect((await get('/jobs/runs')).json().runs).toHaveLength(1);
  });
});

describe('JOB_OVERDUE and /health jobs', () => {
  it('error warning when no daily finished in 26 h; a manual daily clears it; a tick does not', async () => {
    await make();
    const none = (await warnings()).find((w) => w.code === 'JOB_OVERDUE');
    expect(none).toMatchObject({ level: 'error', details: { job: 'daily', last_run_at: null, expected_every: '24h' } });
    expect((await get('/health')).json().jobs).toBe('overdue');
    await runJob('tick', 't1');
    expect((await warnings()).some((w) => w.code === 'JOB_OVERDUE')).toBe(true);
    await runJob('daily', 'manual-daily'); // a manual run counts
    expect((await warnings()).some((w) => w.code === 'JOB_OVERDUE')).toBe(false);
    expect((await get('/health')).json().jobs).toBe('ok');
    clock += 25 * 3_600_000;
    expect((await warnings()).some((w) => w.code === 'JOB_OVERDUE')).toBe(false);
    clock += 2 * 3_600_000; // 27 h since the run
    const late = (await warnings()).find((w) => w.code === 'JOB_OVERDUE');
    expect(late?.details.last_run_at).toMatch(/\+0[23]:00$/);
    expect((await get('/health')).json().jobs).toBe('overdue');
  });

  it('/health/ping stays DB-free and unchanged', async () => {
    await make();
    const r = await app.inject({ method: 'GET', url: '/health/ping' });
    expect(r.json()).toEqual({ status: 'ok' });
  });
});

describe('POST /jobs/preview', () => {
  const D = 'examplecityroofing.com';
  const preview = async (body: unknown, key = `pv-${Math.random()}`) =>
    app.inject({ method: 'POST', url: '/jobs/preview', headers: { ...(await issueToken('write')).auth, 'idempotency-key': key }, payload: body as object });

  async function listedWithDrop() {
    const id = await insertOwnedDomain(db, { domain: D, status: 'listed', category: 'trend', price_grade: null, drop_date: '2028-10-04' });
    await db.updateTable('domains').set({ plan_id: 'pl_x', first_listed_at: new Date('2026-10-12T09:00:00Z') }).where('id', '=', id).execute();
    await db.insertInto('price_schedule').values({ domain_id: id, plan_id: 'pl_x', event: 'delist', due_on: '2028-09-27', bin_cents: null, floor_cents: null, walkaway_cents: null, settings_version: 2, status: 'planned' }).execute();
    return id;
  }

  it('previews the drop and delist on a future day and writes nothing but its audit row; it is not a run', async () => {
    await make();
    const id = await listedWithDrop();
    const preAudit = async () => (await db.selectFrom('audit_log').selectAll().where('path', '=', '/jobs/preview').execute()).length;
    const before = await preAudit();
    const res = await preview({ today: '2028-10-05' });
    expect(res.statusCode).toBe(200);
    const b = res.json();
    expect(b.today).toBe('2028-10-05');
    expect(b.dropJob.would_drop).toEqual([D]);
    expect(Array.isArray(b.priceJob.would_apply)).toBe(true);
    expect(b.priceJob.would_delist).toEqual([D]);
    expect(b.priceJob.would_supersede).toEqual([]);
    expect(b.priceJob.held).toEqual([]);
    expect((await db.selectFrom('domains').select('status').where('id', '=', id).executeTakeFirstOrThrow()).status).toBe('listed');
    expect((await db.selectFrom('price_schedule').select('status').where('domain_id', '=', id).executeTakeFirstOrThrow()).status).toBe('planned');
    expect(await preAudit()).toBe(before + 1);
    expect(await db.selectFrom('audit_log').selectAll().where('path', '=', '/jobs/preview').executeTakeFirstOrThrow()).toMatchObject({ method: 'POST', status_code: 200 });
    expect(await db.selectFrom('audit_log').selectAll().where('path', 'not in', ['/jobs/preview']).where('method', '=', 'POST').execute()).toHaveLength(0);
    expect(await db.selectFrom('job_runs').selectAll().execute()).toHaveLength(0);
    expect((await warnings()).some((w) => w.code === 'JOB_OVERDUE')).toBe(true); // a preview never counts as a run
  });

  it('N-2 (v2.6.0): a due delist lists the name\'s other open rows as would_cancel; a row that fails rowValid is would_fail; nothing is written', async () => {
    await make();
    const id = await listedWithDrop();
    const other = await db.insertInto('price_schedule').values({ domain_id: id, plan_id: 'pl_x', event: 'final_push', due_on: '2028-07-06', bin_cents: 99_500, floor_cents: 96_700, walkaway_cents: 50_000, settings_version: 2, status: 'planned' })
      .returning('id').executeTakeFirstOrThrow();
    const res = await preview({ today: '2028-10-05' });
    expect(res.statusCode).toBe(200);
    const p = res.json().priceJob;
    expect(p.would_delist).toEqual([D]);
    expect(p.would_cancel).toEqual([{ row_id: Number(other.id), domain: D, event: 'final_push' }]);
    expect(p.would_fail).toEqual([]);
    expect(p.would_supersede).toEqual([]);
    expect((await db.selectFrom('price_schedule').select('status').where('id', '=', other.id).executeTakeFirstOrThrow()).status).toBe('planned');
  });

  it('N-2 (v2.6.0): a planned row whose prices are not whole dollars on a listed name is would_fail with its event and reason', async () => {
    await make();
    const id = await insertOwnedDomain(db, { domain: D, status: 'listed', category: 'trend', price_grade: null, drop_date: '2028-10-04' });
    await db.updateTable('domains').set({ plan_id: 'pl_x', first_listed_at: new Date('2026-10-12T09:00:00Z') }).where('id', '=', id).execute();
    const bad = await db.insertInto('price_schedule').values({ domain_id: id, plan_id: 'pl_x', event: 'drop1_m6', due_on: '2027-04-12', bin_cents: 99_550, floor_cents: 96_700, walkaway_cents: 50_000, settings_version: 2, status: 'planned' })
      .returning('id').executeTakeFirstOrThrow();
    const p = (await preview({ today: '2027-04-12' })).json().priceJob;
    expect(p.would_fail).toEqual([{ row_id: Number(bad.id), domain: D, event: 'drop1_m6', reason: 'prices are not whole dollars' }]);
    expect(p.would_apply).toEqual([]);
    expect((await db.selectFrom('price_schedule').select('status').where('id', '=', bad.id).executeTakeFirstOrThrow()).status).toBe('planned');
  });

  it('defaults to today (IDT) and accepts a day up to 3 years ahead', async () => {
    await make();
    expect((await preview({})).json().today).toBe('2027-04-12');
    expect((await preview({ today: '2030-04-12' })).statusCode).toBe(200);
  });

  it('422 VALIDATION_ERROR for a past day, a day over 3 years ahead, a bad date and an unknown field', async () => {
    await make();
    for (const body of [{ today: '2027-04-11' }, { today: '2030-04-13' }, { today: '2027-02-30' }, { today: 'tomorrow' }, { today: 5 }, { when: '2027-04-12' }]) {
      const r = await preview(body);
      expect(r.statusCode, JSON.stringify(body)).toBe(422);
      expect(r.json().error.code).toBe('VALIDATION_ERROR');
    }
  });

  it('needs a WRITE token', async () => {
    await make();
    const r = await app.inject({ method: 'POST', url: '/jobs/preview', headers: { ...(await issueToken('read')).auth, 'idempotency-key': 'x1' }, payload: {} });
    expect(r.statusCode).toBe(403);
    expect(r.json().error.code).toBe('SCOPE_FORBIDDEN');
  });
});

describe('rate-limit headers', () => {
  it('RateLimit-Limit, -Remaining and -Reset per token and method class, on a 429 too', async () => {
    await make();
    const { auth } = await issueToken('write');
    const first = await app.inject({ method: 'GET', url: '/portfolio', headers: auth });
    expect(first.headers['ratelimit-limit']).toBe('60');
    expect(first.headers['ratelimit-remaining']).toBe('59');
    expect(Number(first.headers['ratelimit-reset'])).toBeGreaterThan(0);
    expect(Number(first.headers['ratelimit-reset'])).toBeLessThanOrEqual(60);
    const post = await app.inject({ method: 'POST', url: '/jobs/preview', headers: { ...auth, 'idempotency-key': 'rl-1' }, payload: {} });
    expect(post.headers['ratelimit-limit']).toBe('10');
    expect(post.headers['ratelimit-remaining']).toBe('9');
    const second = await app.inject({ method: 'GET', url: '/portfolio', headers: auth });
    expect(second.headers['ratelimit-remaining']).toBe('58'); // the POST did not use the GET budget
    for (let i = 0; i < 9; i++) await app.inject({ method: 'POST', url: '/jobs/preview', headers: { ...auth, 'idempotency-key': `rl-p${i}` }, payload: {} });
    const over = await app.inject({ method: 'POST', url: '/jobs/preview', headers: { ...auth, 'idempotency-key': 'rl-over' }, payload: {} });
    expect(over.statusCode).toBe(429);
    expect(over.headers['ratelimit-limit']).toBe('10');
    expect(over.headers['ratelimit-remaining']).toBe('0');
    expect(over.headers['ratelimit-reset']).toBe(over.headers['retry-after']);
    const other = await issueToken('read');
    expect((await app.inject({ method: 'GET', url: '/portfolio', headers: other.auth })).headers['ratelimit-remaining']).toBe('59');
  });

  it('no headers on an unauthenticated response or /health/ping', async () => {
    await make();
    expect((await app.inject({ method: 'GET', url: '/portfolio' })).headers['ratelimit-limit']).toBeUndefined();
    expect((await app.inject({ method: 'GET', url: '/health/ping' })).headers['ratelimit-limit']).toBeUndefined();
  });
});

describe('the walk-away stays out of job output (v2.16.0)', () => {
  it('/jobs/run, /jobs/preview and GET /jobs/runs never carry walkaway', async () => {
    await make();
    const id = await insertOwnedDomain(db, { domain: 'examplecityroofing.com', status: 'listed', category: 'trend', price_grade: null, listing_mode: 'hybrid', bin_cents: 199500, floor_cents: 129500, walkaway_cents: 96000, min_offer_cents: 10000, drop_date: '2028-10-04' });
    await db.updateTable('domains').set({ plan_id: 'pl_x', first_listed_at: new Date('2026-10-12T09:00:00Z') }).where('id', '=', id).execute();
    await db.insertInto('price_schedule').values({ domain_id: id, plan_id: 'pl_x', event: 'drop1_m6', due_on: '2027-04-12', bin_cents: 159500, floor_cents: 103500, walkaway_cents: 77000, settings_version: 2, status: 'planned' }).execute();
    const pv = await app.inject({ method: 'POST', url: '/jobs/preview', headers: { ...(await issueToken('write')).auth, 'idempotency-key': 'pv-walk' }, payload: { today: '2027-04-12' } });
    expect(pv.json().priceJob.would_apply).toHaveLength(1);
    expect(pv.body.toLowerCase()).not.toContain('walkaway');
    const run = await runJob('daily', 'daily-walk');
    expect(run.json().steps.priceJob.summary.applied).toHaveLength(1);
    expect(run.body.toLowerCase()).not.toContain('walkaway');
    const runs = await get('/jobs/runs');
    expect(runs.json().runs.length).toBeGreaterThan(0);
    expect(runs.body.toLowerCase()).not.toContain('walkaway');
    expect(JSON.stringify(await db.selectFrom('job_runs').select('steps').execute()).toLowerCase()).not.toContain('walkaway');
    expect((await db.selectFrom('domains').select('walkaway_cents').where('id', '=', id).executeTakeFirstOrThrow()).walkaway_cents).toBe(77000);
  });
});
