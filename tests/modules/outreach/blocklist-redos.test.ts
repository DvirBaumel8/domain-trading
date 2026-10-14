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

// ---------------------------------------------------------------- block list
describe('block list ReDoS (v2.16.0)', () => {
  it('a 65,000-character run of letters is checked in under 200 ms, with and without an @', async () => {
    for (const text of ['a'.repeat(65_000), `${'a'.repeat(65_000)}@${'b'.repeat(65_000)}`, 'a@'.repeat(32_000), `x@${'a-'.repeat(32_000)}`]) {
      const t0 = performance.now();
      const r = await checkText(db, text);
      expect(performance.now() - t0).toBeLessThan(200);
      expect(r.ok === true || r.category === 'email').toBe(true);
    }
    expect(await checkText(db, 'write to someone@example.com please')).toEqual({ ok: false, category: 'email' });
  });
});

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
