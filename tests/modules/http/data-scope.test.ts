// v5.10.0 (CR-061): the `data` token scope, named READ tokens in /audit, READ on POST writes.
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { makeApp } from '../../helpers/app.js';
import { FakeAdapter } from '../../helpers/fake-adapter.js';
import { issueToken } from '../../helpers/tokens.js';

let app: FastifyInstance;
afterEach(async () => app?.close());
const NOW = Date.parse('2026-10-17T09:00:00Z');
async function setup() {
  app = await makeApp({ adapters: [new FakeAdapter('porkbun')], now: () => NOW, extraRoutes: (a) => { a.post('/data/x', async (_req, reply) => reply.code(201).send({ ok: true })); } });
  return { d: (await issueToken('data', 'data-engineer-upload')).auth, r: (await issueToken('read', 'scoring-scientist')).auth, w: (await issueToken('write', 'gavriel')).auth };
}
const call = (method: 'GET' | 'POST', url: string, h: Record<string, string>, payload?: unknown) =>
  app.inject({ method, url, headers: { ...h, ...(method === 'POST' ? { 'idempotency-key': randomUUID() } : {}) }, ...(payload !== undefined ? { payload: payload as object } : {}) });
const sale = { domain: 'septicdrone.com', price_usd: 1500, sale_date: '2026-09-01', venue: 'namebio', source: 'unreported-sales' };

describe('data token scope', () => {
  it('DS-1: a data token may call POST /engine/sales (201), /engine/unsold (201) and POST /candidates/intake (not SCOPE_FORBIDDEN); the audit row says scope data and the token name', async () => {
    const { d, w } = await setup();
    expect((await call('POST', '/engine/sales', d, { rows: [sale] })).statusCode).toBe(201);
    expect((await call('POST', '/engine/unsold', d, { rows: [{ domain: 'septicdrone.com', type: 'dropped_after_held', observation_date: '2026-10-08' }] })).statusCode).toBe(201);
    const intake = await call('POST', '/candidates/intake', d, { names: [] });
    expect(intake.json().error?.code).not.toBe('SCOPE_FORBIDDEN');
    const rows = (await call('GET', '/audit?limit=50', w)).json().rows as { path: string; scope: string; token_name: string }[];
    const mine = rows.filter((r) => r.path === '/engine/sales' || r.path === '/engine/unsold');
    expect(mine.length).toBe(2);
    expect(mine.every((r) => r.scope === 'data' && r.token_name === 'data-engineer-upload')).toBe(true);
  });

  it('DS-2: a WRITE token may still call the same routes', async () => {
    const { w } = await setup();
    expect((await call('POST', '/engine/sales', w, { rows: [sale] })).statusCode).toBe(201);
  });

  it('DS-3: a data token is 403 SCOPE_FORBIDDEN on /buy (dry run), /list, /sold, /offers, /portfolio/import, /jobs/run, /engine/train, /engine/holdout-date', async () => {
    const { d } = await setup();
    for (const url of ['/buy', '/list/x.com', '/sold/x.com', '/offers', '/portfolio/import', '/engine/train', '/engine/holdout-date', '/selection/drop-lists', '/export/afternic/uploaded', '/jobs/run']) {
      const res = await call('POST', url, d, url === '/buy' ? { domain: 'x.com', dry_run: true, max_price: 1000 } : {});
      expect(res.statusCode, url).toBe(403);
      expect(res.json().error.code, url).toBe('SCOPE_FORBIDDEN');
    }
    expect((await call('POST', '/jobs/run', d, { job: 'tick' })).statusCode).toBe(403);
  });

  it('DS-4: a data token is 403 on GETs (health, audit, report, engine health)', async () => {
    const { d } = await setup();
    for (const url of ['/engine/health', '/audit', '/report', '/engine/holdout-date', '/health']) {
      const res = await call('GET', url, d);
      expect(res.statusCode, url).toBe(403);
      expect(res.json().error.code).toBe('SCOPE_FORBIDDEN');
    }
  });

  it('DS-5: every POST under /data/ is open to a data token (prefix rule), a look-alike prefix is not', async () => {
    const { d } = await setup();
    expect((await call('POST', '/data/x', d, {})).statusCode).toBe(201);
    expect((await call('POST', '/database/x', d, {})).statusCode).toBe(403);
    expect((await call('POST', '/datax', d, {})).statusCode).toBe(403);
  });

  it('DS-6: AC-1/AC-2: a READ token is 403 on a POST write, the audit row names the token and scope read; /score and GETs still work', async () => {
    const { r, w } = await setup();
    const res = await call('POST', '/engine/sales', r, { rows: [sale] });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('SCOPE_FORBIDDEN');
    const audit = (await call('GET', '/audit?limit=20', r)).json().rows as { path: string; scope: string; token_name: string; status_code: number }[];
    const row = audit.find((x) => x.path === '/engine/sales');
    expect(row).toMatchObject({ scope: 'read', token_name: 'scoring-scientist', status_code: 403 });
    expect((await call('POST', '/score', r, { domains: ['septicdrone.com'] })).statusCode).not.toBe(403);
    expect((await call('GET', '/engine/health', r)).statusCode).toBe(200);
    void w;
  });
});
