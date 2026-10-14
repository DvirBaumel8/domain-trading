// v3.2.0 part A (CR-017): triggered_by and the manual tick. MSW only; fake keys.
import { randomUUID } from 'node:crypto';
import { http, HttpResponse } from 'msw';
import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { makeApp, runJobToEnd } from '../../helpers/app.js';
import { testDb as db } from '../../helpers/db.js';
import { issueToken } from '../../helpers/tokens.js';
import { mswServer } from '../../setup/network.js';

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

describe('T17-8 a manual tick runs reviewRetry when one is pending', () => {
  it('T17-8 POST /jobs/run tick (WRITE) retries the pending review once (one Google call); with nothing pending it does not call Google', async () => {
    const GKEY = 'test-gemini-key';
    let g = 0;
    let mode: 'busy' | 'ok' = 'busy';
    mswServer.use(http.post(/generativelanguage\.googleapis\.com\/v1beta\/models\/[^/]+:generateContent/, async () => {
      g++;
      return mode === 'busy'
        ? HttpResponse.json({ error: { code: 429, status: 'RESOURCE_EXHAUSTED', message: 'Quota' } }, { status: 429 })
        : HttpResponse.json({ candidates: [{ finishReason: 'STOP', content: { parts: [{ text: JSON.stringify({ items: [{ category: 'pricing', severity: 'low', text: 'Keep the plan.' }] }) }] } }], usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 20 } });
    }));
    const t = await boot({ GEMINI_API_KEY: GKEY });
    expect((await t.post('/company/document', { text: 'We buy short .com names and sell them at a fixed price.' })).statusCode).toBeLessThan(300);
    await t.app.jobRunner.run('daily');
    expect(await db.selectFrom('review_retries').selectAll().execute()).toHaveLength(1);
    const callsBefore = g;
    mode = 'ok';
    const tick = await runJobToEnd(t.app, 'tick', { headers: t.w });
    expect(tick.json().steps.reviewRetry.summary).toMatchObject({ status: 'ok' });
    expect(g).toBe(callsBefore + 1);
    const again = await runJobToEnd(t.app, 'tick', { headers: t.w });
    expect(again.json().steps.reviewRetry.summary).toMatchObject({ skipped: true, reason: 'NOTHING_PENDING' });
    expect(g).toBe(callsBefore + 1);
  });
});
