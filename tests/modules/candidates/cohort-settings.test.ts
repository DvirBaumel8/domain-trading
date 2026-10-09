// v2.15.0 (CR-013 acceptance findings F-1..F-11, Q1): the weekly rule, bot names out of the packet, the term retire route, 503 retry, key shapes,
// plural/possessive matching, public /media/*, the review run limiter, review settings history, removed drop-list rows, an empty cohort window.
import { randomBytes, randomUUID } from 'node:crypto';
import { http, HttpResponse } from 'msw';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { checkText, termMatches } from '../../../src/modules/outreach/blocklist.js';
import { makeApp } from '../../helpers/app.js';
import { testDb as db } from '../../helpers/db.js';
import { screeningHarness } from '../../helpers/screening.js';
import { issueToken } from '../../helpers/tokens.js';
import { mswServer } from '../../setup/network.js';

vi.mock('../../../src/modules/selection/test-sets.js', async (orig) => {
  const real = await orig<typeof import('../../../src/modules/selection/test-sets.js')>();
  return { ...real, featuresOfRun: async (...a: Parameters<typeof real.featuresOfRun>) => (globalThis as { __featuresOverride?: unknown }).__featuresOverride ?? real.featuresOfRun(...a) };
});

const KEY = 'test-gemini-key';
const URL_RE = /generativelanguage\.googleapis\.com\/v1beta\/models\/[^/]+:generateContent/;
const T0 = Date.parse('2026-10-20T00:05:00Z'); // 03:05 IDT, a Tuesday
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const SUNDAY = Date.parse('2026-10-25T00:05:00Z'); // 03:05 IDT, a Sunday
const apps: FastifyInstance[] = [];
afterEach(async () => { delete (globalThis as { __featuresOverride?: unknown }).__featuresOverride; await Promise.all(apps.splice(0).map((a) => a.close())); });

const answer = () => HttpResponse.json({
  candidates: [{ finishReason: 'STOP', content: { parts: [{ text: JSON.stringify({ items: [{ category: 'pricing', severity: 'low', text: 'Keep the plan.' }] }) }] } }],
  usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 20 },
});
const busy = () => HttpResponse.json({ error: { code: 503, status: 'UNAVAILABLE', message: 'This model is currently experiencing high demand.' } }, { status: 503 });
const seen: string[] = [];
function serve(resp: () => Response) {
  seen.length = 0;
  mswServer.use(http.post(URL_RE, async ({ request }) => { seen.push(request.url); return resp(); }));
}
async function boot(env: Record<string, string> = { GEMINI_API_KEY: KEY }, start = T0) {
  const clock = { t: start };
  const app = await makeApp({ now: () => clock.t, env });
  apps.push(app);
  const w = (await issueToken('write', 'gavriel')).auth;
  const r = (await issueToken('read')).auth;
  const post = (url: string, payload?: object) => app.inject({ method: 'POST', url, headers: { ...w, 'idempotency-key': randomUUID() }, ...(payload === undefined ? {} : { payload }) });
  const get = (url: string) => app.inject({ method: 'GET', url, headers: r });
  const doc = async () => { expect((await post('/company/document', { text: 'We buy short .com names and sell them at a fixed price.' })).statusCode).toBeLessThan(300); };
  return { app, clock, post, get, doc };
}
const step = (r: { steps: Record<string, { summary: unknown }> }, name: string) => r.steps[name]!.summary;
const unknownFb = { status: 'unknown', provider: 'acme', reason: 'Google said 503' };
const okFb = { status: 'ok', provider: 'acme', model: 'm-1', cost_usd: 0, items: [] };
const rnd = (n: number, alphabet = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789') => Array.from(randomBytes(n), (b) => alphabet[b % alphabet.length]).join('');

describe('F-11 drop lists and cohorts (T13-17, T13-18)', () => {
  it('V215-14 T13-17: a legacy removed row without tokens shows the split on read; new rows store it', async () => {
    const x = await screeningHarness();
    try {
      expect((await x.post('/selection/drop-lists', { name: 'dl-1', list_date: '2026-10-06', domains: ['thebestcoffeeshop.com', 'mountain.com', 'zzqxjkvv.com'] })).statusCode).toBe(201);
      const rows = (await db.selectFrom('drop_list_rows').select(['domain', 'tokens']).where('list_name', '=', 'dl-1').orderBy('id').execute());
      expect(rows.map((r) => r.tokens)).toEqual([['the', 'best', 'coffee', 'shop'], ['mountain'], null]);
      await db.connection().execute(async (c) => {
        const { sql } = await import('kysely');
        await sql`SET session_replication_role = replica`.execute(c);
        await sql`UPDATE drop_list_rows SET tokens = NULL WHERE list_name = 'dl-1'`.execute(c);
        await sql`SET session_replication_role = origin`.execute(c);
      });
      const g = (await x.get('/selection/drop-lists/dl-1')).json();
      expect(g.rows.map((r: { tokens: unknown }) => r.tokens)).toEqual([['the', 'best', 'coffee', 'shop'], ['mountain'], null]);
    } finally { await x.app.close(); }
  });

  it('V215-15 T13-18: a from_drop_lists cohort with no pending names in the window is COHORT_EMPTY with the reason and the window', async () => {
    const x = await screeningHarness();
    try {
      const r = await x.post('/selection/cohorts', { name: 'co-none', settings: ['v1'], from_drop_lists: { drop_from: '2026-10-07', drop_to: '2026-10-20', sample_n: 3, seed: 'a' } });
      expect(r.statusCode).toBe(422);
      expect(r.json().error).toMatchObject({ code: 'COHORT_EMPTY', details: { reason: 'NO_PENDING_NAMES_IN_WINDOW', drop_from: '2026-10-07', drop_to: '2026-10-20' } });
    } finally { await x.app.close(); }
  });
});

describe('Q1 cohort decisions use each label\'s own settings', () => {
  it('V215-16 two labels with different tier rules freeze different decisions for the same features', async () => {
    const x = await screeningHarness();
    try {
      // Same features, two labels whose tier thresholds differ: each label's own values must decide.
      const strict = await x.post('/selection/settings', {
        label: 'strict-like', note: 'accepts only on a share of at least 0.99',
        set: { 'thresholds.registered_share_min': 0.99, 'thresholds.registered_share_min_B': 0.99, 'thresholds.alt_tld_before_min': 99 },
      });
      expect(strict.statusCode, strict.body).toBe(201);
      const lax = await x.post('/selection/settings', {
        label: 'lax-like', note: 'accepts on a share of at least 0.1',
        set: { 'thresholds.registered_share_min': 0.1, 'thresholds.registered_share_min_B': 0.1, 'thresholds.alt_tld_before_min': 99 },
      });
      expect(lax.statusCode, lax.body).toBe(201);
      const r = await x.post('/selection/cohorts', { name: 'co-q1', settings: ['strict-like', 'lax-like'], names: [{ domain: 'superpro.com', expected_drop_date: '2026-10-20', source: 'a' }, { domain: 'superbox.com', expected_drop_date: '2026-10-20', source: 'a' }] });
      expect(r.statusCode, r.body).toBe(202);
      await x.app.screeningWorker.runToEnd(r.json().run_id);
      (globalThis as { __featuresOverride?: unknown }).__featuresOverride = {
        byDomain: new Map([
          ['superpro.com', { registered_share: 0.6, alt_tld_before_n: 0, n_words: 2, sld_chars: 8, is_geo: 0 }],
          ['superbox.com', { registered_share: 0.05, alt_tld_before_n: 0, n_words: 2, sld_chars: 8, is_geo: 0 }],
        ]),
      };
      const g = (await x.get('/selection/cohorts/co-q1')).json();
      expect(g.status).toBe('frozen');
      const by = (d: string, l: string) => g.names.find((n: { domain: string }) => n.domain === d).decisions[l].decision;
      expect(by('superpro.com', 'lax-like')).toBe('accept');
      expect(by('superpro.com', 'strict-like')).toBe('reject');
      expect(by('superbox.com', 'lax-like')).toBe('reject');
      expect(by('superbox.com', 'strict-like')).toBe('reject');
    } finally { await x.app.close(); }
  });
});
