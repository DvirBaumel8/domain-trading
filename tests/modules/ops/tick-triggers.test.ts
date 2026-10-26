// v3.2.0 part A (CR-017): triggered_by and the manual tick. MSW only; fake keys.
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { makeApp, runJobToEnd } from '../../helpers/app.js';
import { testDb as db } from '../../helpers/db.js';
import { issueToken } from '../../helpers/tokens.js';

const T0 = Date.parse('2026-10-20T10:00:00Z');
const apps: FastifyInstance[] = [];
afterEach(async () => { await Promise.all(apps.splice(0).map((a) => a.close())); });

async function boot(env: Record<string, string> = {}) {
  const clock = { t: T0 };
  const app = await makeApp({ now: () => clock.t, env, testRoutes: false });
  apps.push(app);
  const w = (await issueToken('write', 'gavriel-write')).auth;
  const post = (url: string, payload?: object, key = randomUUID()) => app.inject({ method: 'POST', url, headers: { ...w, 'idempotency-key': key }, ...(payload === undefined ? {} : { payload }) });
  return { app, clock, post, w };
}

describe('N-3 triggered_by is never null', () => {
  it('the CLI trigger records `cli`; a queued run and its job_runs row agree', async () => {
    const t = await boot({});
    await t.app.jobRunner.run('tick', { trigger: 'cli' });
    const row = await db.selectFrom('job_runs').selectAll().where('job', '=', 'tick').orderBy('id', 'desc').executeTakeFirstOrThrow();
    expect(row.triggered_by).toBe('cli');
    const viaApi = await runJobToEnd(t.app, 'tick', { headers: t.w });
    expect(viaApi.statusCode).toBe(202);
    const q = await db.selectFrom('job_queue_runs').select('triggered_by').orderBy('created_at', 'desc').executeTakeFirstOrThrow();
    expect(q.triggered_by).toBe('gavriel-write');
    const rows = await db.selectFrom('job_runs').select('triggered_by').execute();
    expect(rows.every((r) => r.triggered_by !== null)).toBe(true);
  });
});

describe('T17-8 a manual tick has the tick steps only', () => {
  it('T17-8 POST /jobs/run tick (WRITE) runs reconciler, nsVerifier and screeningResume; there is no review step', async () => {
    const t = await boot({});
    const tick = await runJobToEnd(t.app, 'tick', { headers: t.w });
    expect(Object.keys(tick.json().steps)).toEqual(['reconciler', 'nsVerifier', 'screeningResume']);
  });
});
