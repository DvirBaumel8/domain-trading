// v2.10.0 (CR-011 part B): block list, company document, forbidden terms, review packets, feedback, items, status, cost, REVIEW_OVERDUE.
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { generateToken } from '../../../src/core/tokens.js';
import { checkText } from '../../../src/modules/outreach/blocklist.js';
import { makeApp } from '../../helpers/app.js';
import { insertOwnedDomain, testDb as db } from '../../helpers/db.js';
import { FakeAdapter } from '../../helpers/fake-adapter.js';
import { issueToken } from '../../helpers/tokens.js';

const apps: FastifyInstance[] = [];
afterEach(async () => { await Promise.all(apps.splice(0).map((a) => a.close())); });

const T0 = Date.parse('2026-10-20T09:00:00Z');
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
async function boot(env?: Record<string, string>) {
  const clock = { t: T0 };
  const app = await makeApp({ adapters: [new FakeAdapter('porkbun')], now: () => clock.t, env });
  apps.push(app);
  const w = (await issueToken('write')).auth;
  const r = (await issueToken('read')).auth;
  const post = (url: string, payload?: object) => app.inject({ method: 'POST', url, headers: { ...w, 'idempotency-key': randomUUID() }, ...(payload === undefined ? {} : { payload }) });
  const get = (url: string) => app.inject({ method: 'GET', url, headers: r });
  const doc = async (text: string) => { const x = await post('/company/document', { text }); expect(x.statusCode, x.body).toBeLessThan(300); return x; };
  return { app, clock, post, get, doc, write: w, read: r };
}
const feedbackOk = (items: object[] = [], extra: object = {}) => ({ status: 'ok', provider: 'acme-ai', model: 'm-1', cost_usd: 0.25, items, ...extra });
const item = (text: string, category = 'pricing', severity = 'medium') => ({ category, severity, text });

describe('block list (T11-3)', () => {
  it('a configured secret value is refused as TEXT_BLOCKED category secret, and the text is never echoed or audited', async () => {
    const t = await boot();
    const text = 'our registrar login is fake_godaddy_pat_0000000000 ok';
    const r = await t.post('/company/document', { text });
    expect(r.statusCode).toBe(422);
    expect(r.json().error.code).toBe('TEXT_BLOCKED');
    expect(r.json().error.details).toEqual({ category: 'secret' });
    expect(r.body).not.toContain('fake_godaddy_pat');
    const audit = await db.selectFrom('audit_log').selectAll().where('path', '=', '/company/document').execute();
    expect(JSON.stringify(audit)).not.toContain('fake_godaddy_pat');
    expect(await db.selectFrom('company_documents').selectAll().execute()).toHaveLength(0);
  });

  it('a DOM bearer token, a key shape, an email, a phone number and a listed term each give their category', async () => {
    const t = await boot();
    await t.post('/company/forbidden-terms', { term: 'Project Falcon' });
    await t.post('/company/forbidden-terms', { term: 'zeta' });
    const cases: [string, string][] = [
      [`token ${generateToken()}`, 'secret'],
      ['key pk1_abcdef123456', 'secret'],
      ['key AIzaSyA1234567890abcdefghijk_lmn', 'secret'],
      ['key ghp_abcdefghij1234', 'secret'],
      ['key github_pat_11ABCDEFG', 'secret'],
      ['write to someone.name+tag@example.co.il please', 'email'],
      ['call +972 54-123-4567 today', 'phone'],
      ['call (03) 123 4567', 'phone'],
      ['call 0541234567', 'phone'],
      ['we are doing PROJECT falcon next', 'listed_term'],
      ['the Zeta name', 'listed_term'],
    ];
    for (const [text, category] of cases) {
      t.clock.t += 120_000; // stay under the write rate limit
      const r = await t.post('/company/document', { text });
      expect(r.statusCode, text).toBe(422);
      expect(r.json().error.code).toBe('TEXT_BLOCKED');
      expect(r.json().error.details, text).toEqual({ category });
      expect(r.body).not.toMatch(/falcon|zeta|example\.co|123 4567|0541234567|pk1_/i);
    }
  });

  it('no false positives on dates, money, hashes, ordinary prose, or a term inside a longer word', async () => {
    await db.insertInto('forbidden_terms').values({ term: 'zeta', created_by: 'test' }).execute();
    const ok = [
      'Bought on 2026-10-07 for $1,488 and listed 2026-10-07 12:30.',
      'Revenue was $1,488,000 in 2026, up 12-15 percent; order 12345678.',
      `sha ${'1234567890'.repeat(6)}ab and ${'a1b2c3d4'.repeat(8)}`,
      'The company buys short .com names, renews once, and sells at a fixed price. Contact: the chief of staff.',
      'We discussed xzetax and zetabyte storage only in the abstract.',
      'Floors at 65% of BIN; min offer $100; 50 names; 2 years.',
    ];
    for (const text of ok) expect(await checkText(db, text, { secretValues: [] }), text).toEqual({ ok: true });
  });

  it('a configured value shorter than 8 characters is not a secret', async () => {
    expect(await checkText(db, 'the word secret1 appears', { secretValues: ['secret1'] })).toEqual({ ok: true });
    expect(await checkText(db, 'the word secret12 appears', { secretValues: ['secret12'] })).toEqual({ ok: false, category: 'secret' });
  });
});

describe('forbidden terms', () => {
  it('a term is stored append-only and no route ever returns it', async () => {
    const t = await boot();
    const r = await t.post('/company/forbidden-terms', { term: 'Secret Codename 77' });
    expect(r.statusCode).toBe(201);
    expect(r.json()).toEqual({ id: 1, category: 'listed_term', created_at: expect.any(String) });
    expect(r.body).not.toMatch(/codename/i);
    const g = await t.get('/company/forbidden-terms');
    expect(g.json()).toEqual({ terms: [{ id: 1, category: 'listed_term', created_at: expect.any(String), retired_at: null }] });
    expect(g.body).not.toMatch(/codename/i);
    const audit = JSON.stringify(await db.selectFrom('audit_log').selectAll().execute());
    expect(audit).not.toMatch(/codename/i);
    expect((await t.post('/company/forbidden-terms', { term: 'x' })).statusCode).toBe(422);
    expect((await t.post('/company/forbidden-terms', { term: 'ab', category: 'email' })).statusCode).toBe(422);
  });
});
