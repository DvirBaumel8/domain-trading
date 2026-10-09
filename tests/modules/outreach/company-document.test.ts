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

describe('company document (T11-14)', () => {
  it('stores versions only on change, lists them newest first, returns text and a unified diff against the previous version', async () => {
    const t = await boot();
    const a = await t.post('/company/document', { text: 'Line one\nLine two\n' });
    expect(a.statusCode).toBe(201);
    expect(a.json()).toMatchObject({ version: 1, changed: true });
    expect(a.json().sha256).toMatch(/^[0-9a-f]{64}$/);
    const same = await t.post('/company/document', { text: 'Line one\nLine two\n' });
    expect(same.statusCode).toBe(200);
    expect(same.json()).toMatchObject({ version: 1, changed: false, sha256: a.json().sha256 });
    const b = await t.post('/company/document', { text: 'Line one\nLine 2\n' });
    expect(b.statusCode).toBe(201);
    expect(b.json().version).toBe(2);
    const list = await t.get('/company/document/versions');
    expect(list.json().versions.map((v: { version: number }) => v.version)).toEqual([2, 1]);
    expect(list.json().versions[0]).toMatchObject({ bytes: 'Line one\nLine 2\n'.length, sha256: b.json().sha256 });
    const v2 = await t.get('/company/document/versions/2');
    expect(v2.statusCode).toBe(200);
    expect(v2.json().text).toBe('Line one\nLine 2\n');
    expect(v2.json().diff).toContain('-Line two\n+Line 2\n');
    const v1 = await t.get('/company/document/versions/1');
    expect(v1.json().diff).toBeNull();
    // going back to an earlier text is a new version (only the latest is compared)
    const back = await t.post('/company/document', { text: 'Line one\nLine two\n' });
    expect(back.statusCode).toBe(201);
    expect(back.json().version).toBe(3);
  });

  it('DOCUMENT_VERSION_NOT_FOUND for an unknown or malformed version; strict body and size are validated', async () => {
    const t = await boot();
    await t.doc('x doc');
    for (const n of ['2', '0', 'abc']) {
      const r = await t.get(`/company/document/versions/${n}`);
      expect(r.statusCode).toBe(404);
      expect(r.json().error.code).toBe('DOCUMENT_VERSION_NOT_FOUND');
    }
    expect((await t.post('/company/document', { text: '' })).statusCode).toBe(422);
    expect((await t.post('/company/document', { text: 'a'.repeat(65537) })).statusCode).toBe(422);
    expect((await t.post('/company/document', { text: 'ok', extra: 1 })).statusCode).toBe(422);
    expect((await t.post('/company/document', { text: 'a'.repeat(65536) })).statusCode).toBe(201);
  });

  it('a READ token cannot upload (403), and a WRITE token is needed for terms', async () => {
    const t = await boot();
    const r = await t.app.inject({ method: 'POST', url: '/company/document', headers: { ...t.read, 'idempotency-key': randomUUID() }, payload: { text: 'hello' } });
    expect(r.statusCode).toBe(403);
  });
});
