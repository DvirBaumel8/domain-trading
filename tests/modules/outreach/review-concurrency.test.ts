// v2.16.0 tech-debt part C: review concurrency, idempotency hygiene, block-list ReDoS, F9/F24.
import { randomUUID } from 'node:crypto';
import { delay, http, HttpResponse } from 'msw';
import { sql } from 'kysely';
import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { logCapture, makeApp } from '../../helpers/app.js';
import { testDb as db } from '../../helpers/db.js';
import { issueToken } from '../../helpers/tokens.js';
import { mswServer } from '../../setup/network.js';
import { checkText } from '../../../src/modules/outreach/blocklist.js';
import { requestHash, pruneIdempotencyKeys, STALE_IN_PROGRESS_MS } from '../../../src/http/idempotency.js';

const T0 = Date.parse('2026-10-20T10:00:00Z');
const apps: FastifyInstance[] = [];
afterEach(async () => { await Promise.all(apps.splice(0).map((a) => a.close())); });

// ---------------------------------------------------------------- reviews
const GEMINI = /generativelanguage\.googleapis\.com\/v1beta\/models\/[^/]+:generateContent/;
const ok = () => HttpResponse.json({ candidates: [{ finishReason: 'STOP', content: { parts: [{ text: JSON.stringify({ items: [{ category: 'risk', severity: 'low', text: 'fine' }] }) }] } }], usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 } });

async function bootReview() {
  const clock = { t: Date.parse('2026-10-20T09:00:00Z') };
  const app = await makeApp({ now: () => clock.t, env: { GEMINI_API_KEY: 'test-gemini-key' }, logStream: logCapture().stream });
  apps.push(app);
  const w = (await issueToken('write')).auth;
  const post = (url: string, payload?: object) => app.inject({ method: 'POST', url, headers: { ...w, 'idempotency-key': randomUUID() }, ...(payload === undefined ? {} : { payload }) });
  expect((await post('/company/document', { text: 'We buy short .com names and sell them at a fixed price.' })).statusCode).toBe(201);
  return { app, clock, post };
}

describe('review concurrency and cost (v2.16.0)', () => {
  it('a second concurrent run is 409 REVIEW_IN_PROGRESS and a scheduled run skips IN_PROGRESS; Google is called once', async () => {
    let calls = 0;
    mswServer.use(http.post(GEMINI, async () => { calls++; await delay(300); return ok(); }));
    const t = await bootReview();
    const first = t.post('/reviews/run');
    await delay(100);
    const second = await t.post('/reviews/run');
    expect(second.statusCode).toBe(409);
    expect(second.json().error.code).toBe('REVIEW_IN_PROGRESS');
    const daily = await t.app.jobRunner.run('daily');
    expect(daily.steps.outsideReview).toMatchObject({ summary: { skipped: true, reason: 'IN_PROGRESS' } });
    expect((await first).statusCode).toBe(200);
    expect(calls).toBe(1);
    // free again afterwards
    expect((await t.post('/reviews/run')).statusCode).toBe(200);
  });

  it('F9: feedback a bot posts never counts toward the monthly cap (cost_usd above 5 is refused); the service\'s own gemini feedback does', async () => {
    const t = await bootReview();
    const packet = (await t.post('/reviews/packet')).json().packet_id as string;
    const over = await t.post(`/reviews/${packet}/feedback`, { status: 'ok', provider: 'bot', model: 'm', cost_usd: 6, items: [] });
    expect(over.statusCode).toBe(422);
    const fb = await t.post(`/reviews/${packet}/feedback`, { status: 'ok', provider: 'bot', model: 'm', cost_usd: 5, items: [] });
    expect(fb.statusCode, fb.body).toBe(201);
    const { monthSpend } = await import('../../../src/modules/outreach/review/packet.js');
    expect((await monthSpend(db, t.clock.t)).spentUsd).toBe(0);
    mswServer.use(http.post(GEMINI, () => ok()));
    expect((await t.post('/reviews/run')).statusCode).toBe(200);
    const second = (await t.post('/reviews/packet')).json().packet_id as string;
    await db.insertInto('review_feedback').values({ packet_id: second, created_by: 'dom-review', status: 'ok', provider: 'gemini', model: 'm', cost_usd: 5 }).execute();
    const capped = await t.post('/reviews/run');
    expect(capped.json().error.code).toBe('REVIEW_COST_CAP');
  });

  it('F24: "changes since" starts at the latest packet that has ok feedback, not at a later packet nobody answered', async () => {
    const t = await bootReview();
    const a = (await t.post('/reviews/packet')).json().packet_id as string;
    const fb = await t.post(`/reviews/${a}/feedback`, { status: 'ok', provider: 'bot', model: 'm', cost_usd: 0, items: [] });
    expect(fb.statusCode).toBe(201);
    const aAt = (await db.selectFrom('review_packets').select('created_at').where('id', '=', a).executeTakeFirstOrThrow()).created_at;
    t.clock.t += 3_600_000;
    expect((await t.post('/reviews/packet')).statusCode).toBe(201); // B: no feedback
    t.clock.t += 3_600_000;
    const preview = await t.post('/reviews/packet', { preview: true });
    const { toJerusalemIso } = await import('../../../src/core/dates.js');
    expect(preview.json().content.dom_changes.since).toBe(toJerusalemIso(aAt));
  });
});
