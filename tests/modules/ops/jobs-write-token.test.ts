// v2.3.0 (CR-007 T-2): a WRITE token may start daily/tick; own limit of 4 per hour; the run records who started it.
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { makeApp, runJobToEnd } from '../../helpers/app.js';
import { testDb } from '../../helpers/db.js';
import { issueToken } from '../../helpers/tokens.js';

const JOB_TOKEN = 'job_token_fake_0123456789abcdef0123456789';
const jobBearer = { authorization: `Bearer ${JOB_TOKEN}` };
let n = 0;
// v3.0.0: POST /jobs/run answers 202; `post` waits for the worker and returns the finished run in the old shape.
const post = (app: FastifyInstance, job: unknown, headers: Record<string, string>, key = `wk-${++n}`) =>
  runJobToEnd(app, job as string, { headers, key });

let app: FastifyInstance;
afterEach(async () => app?.close());
const make = async () => (app = await makeApp({ testRoutes: false, env: { JOB_TRIGGER_TOKEN: JOB_TOKEN } }));

describe('POST /jobs/run with a WRITE token', () => {
  it('starts daily: 202, the run is listed with trigger manual and triggered_by = the token name; the audit row carries the token id', async () => {
    await make();
    const write = await issueToken('write', 'gavriel-write');
    const read = await issueToken('read');
    vi.spyOn(app.referenceRefreshJob, 'runOnce').mockResolvedValue({ skipped: true, reason: 'test' }); // no network in tests
    const res = await post(app, 'daily', write.auth, 'daily-1760000000000'); // a Worker-looking key is still manual for a WRITE token
    expect(res.statusCode, res.body).toBe(202);
    expect(res.json().steps.portfolioCheck).toMatchObject({ ok: true });
    const runs = (await app.inject({ method: 'GET', url: '/jobs/runs?job=daily', headers: read.auth })).json().runs;
    expect(runs[0]).toMatchObject({ job: 'daily', trigger: 'manual', scheduled_for: null, triggered_by: 'gavriel-write' });
    const audit = await testDb.selectFrom('audit_log').selectAll().where('path', '=', '/jobs/run').executeTakeFirstOrThrow();
    expect(audit).toMatchObject({ scope: 'write', token_id: write.id, status_code: 202, result_summary: 'daily: queued' });
  });

  it('the job token keeps working (triggered_by job-token, N-3) and still cannot call other routes', async () => {
    await make();
    const read = await issueToken('read');
    expect((await post(app, 'tick', jobBearer)).statusCode).toBe(202);
    const runs = (await app.inject({ method: 'GET', url: '/jobs/runs?job=tick', headers: read.auth })).json().runs;
    expect(runs[0]).toMatchObject({ trigger: 'manual', triggered_by: 'job-token' });
    expect((await app.inject({ method: 'GET', url: '/portfolio', headers: jobBearer })).statusCode).toBe(401);
  });

  it('any other job name is 422; a READ token is refused (401 UNAUTHORIZED)', async () => {
    await make();
    const write = await issueToken('write');
    const read = await issueToken('read');
    expect((await post(app, 'other', write.auth)).statusCode).toBe(422);
    const r = await post(app, 'tick', read.auth);
    expect(r.statusCode).toBe(401);
    expect(r.json().error.code).toBe('UNAUTHORIZED');
  });

  it('the 5th call within the hour is 429 RATE_LIMITED with the RateLimit headers; the job token has its own limit', async () => {
    await make();
    const write = await issueToken('write');
    const codes: number[] = [];
    let last;
    for (let i = 0; i < 5; i++) { last = await post(app, 'tick', write.auth); codes.push(last.statusCode); }
    expect(codes).toEqual([202, 202, 202, 202, 429]);
    expect(last!.json().error.code).toBe('RATE_LIMITED');
    expect(last!.headers['ratelimit-limit']).toBe('4');
    expect(last!.headers['ratelimit-remaining']).toBe('0');
    expect(last!.headers['retry-after']).toBeDefined();
    expect((await post(app, 'tick', jobBearer)).statusCode).toBe(202);
  });
});
