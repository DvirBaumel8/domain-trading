// v2.1.0 part 1: daily-only runner, BUG-2 timestamps, CR-004 §10.3 (lander none, forecast fixes, legacy comps).
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { makeApp, runJobToEnd } from '../../helpers/app.js';
import { insertOwnedDomain, testDb as db } from '../../helpers/db.js';
import { FakeAdapter } from '../../helpers/fake-adapter.js';
import { listedDomain } from '../../helpers/listing.js';
import { issueToken } from '../../helpers/tokens.js';

let app: FastifyInstance;
afterEach(async () => app?.close());
const NOW = Date.parse('2026-10-12T09:00:00Z');
const D = 'examplecityroofing.com';
const JOB = 'job_token_fake_0123456789abcdef0123456789';
const OFFSET = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\+0[23]:00$/;

async function boot(pb = new FakeAdapter('porkbun')) {
  app = await makeApp({ adapters: [pb], nsLookup: async () => null, now: () => NOW });
  const w = (await issueToken('write')).auth;
  const r = (await issueToken('read')).auth;
  const post = (url: string, payload: object) => app.inject({ method: 'POST', url, headers: { ...w, 'idempotency-key': randomUUID() }, payload });
  const get = (url: string) => app.inject({ method: 'GET', url, headers: r });
  return { pb, post, get };
}

describe('daily-only schedule: the daily job runs the former tick steps first', () => {
  it('POST /jobs/run daily returns reconciler, nsVerifier and screeningResume, then the daily steps; tick still works by hand', async () => {
    app = await makeApp({ testRoutes: false, env: { JOB_TRIGGER_TOKEN: JOB } });
    const run = (job: string) => runJobToEnd(app, job, { headers: { authorization: `Bearer ${JOB}` }, key: randomUUID() });
    const daily = await run('daily');
    expect(Object.keys(daily.json().steps)).toEqual(['reconciler', 'nsVerifier', 'screeningResume', 'priceJob', 'dropJob', 'registrarCheck', 'portfolioCheck', 'dropWatch', 'intakeScreening', 'buildDailyList', 'cohortOutcomes', 'referenceRefresh', 'outsideReview', 'postsRefresh', 'backupExport']);
    expect(daily.json().steps.reconciler.ok).toBe(true);
    const tick = await run('tick');
    expect(Object.keys(tick.json().steps)).toEqual(['reconciler', 'nsVerifier', 'screeningResume', 'reviewRetry']);
  });
});
