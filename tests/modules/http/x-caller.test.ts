// v5.63.0 (CR-084 R-8): the optional X-Caller header. IDs XC-1..XC-4, CR084-AT7.
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { logCapture, makeApp } from '../../helpers/app.js';
import { testDb } from '../../helpers/db.js';
import { FakeAdapter } from '../../helpers/fake-adapter.js';
import { issueToken } from '../../helpers/tokens.js';

let app: FastifyInstance;
afterEach(async () => app?.close());
type H = Record<string, string>;
const call = (method: 'GET' | 'POST', url: string, h: H, payload?: unknown) =>
  app.inject({ method, url, headers: { ...h, ...(method === 'POST' ? { 'idempotency-key': randomUUID() } : {}) }, ...(payload !== undefined ? { payload: payload as object } : {}) });
const rows = { rows: [{ domain: 'septicdrone.com', price_usd: 1500, sale_date: '2026-09-01', venue: 'namebio', source: 'unreported-sales' }] };

describe('X-Caller (CR-084 R-8)', () => {
  it('XC-1 (CR084-AT7) a shared-token write with X-Caller is accepted and the audit row stores the caller next to the token name; GET /audit shows it', async () => {
    app = await makeApp({ adapters: [new FakeAdapter('porkbun')] });
    const bots = (await issueToken('bots', 'bots-shared')).auth;
    const write = (await issueToken('write', 'gavriel')).auth;
    const r = await call('POST', '/engine/sales', { ...bots, 'x-caller': 'data-engineer' }, rows);
    expect(r.statusCode, r.body).toBe(201);
    const audit = await testDb.selectFrom('audit_log').select(['caller', 'bot_name', 'scope', 'token_id']).where('path', '=', '/engine/sales').executeTakeFirstOrThrow();
    expect(audit).toMatchObject({ caller: 'data-engineer', bot_name: null, scope: 'bots' });
    expect(audit.token_id).not.toBeNull();
    const api = (await call('GET', '/audit?limit=20', write)).json().rows as { path: string; caller: string | null }[];
    expect(api.find((x) => x.path === '/engine/sales')?.caller).toBe('data-engineer');
  });

  it('XC-2 a missing header never breaks a READ or a write: the caller is null; X-Caller on a READ call is accepted', async () => {
    app = await makeApp({ adapters: [new FakeAdapter('porkbun')] });
    const read = (await issueToken('read', 'reader')).auth;
    const bots = (await issueToken('bots', 'bots-shared')).auth;
    expect((await call('GET', '/portfolio', read)).statusCode).toBe(200);
    expect((await call('GET', '/portfolio', { ...read, 'x-caller': 'gavriel' })).statusCode).toBe(200);
    expect((await call('POST', '/engine/sales', bots, rows)).statusCode).toBe(201);
    expect((await testDb.selectFrom('audit_log').select('caller').where('path', '=', '/engine/sales').executeTakeFirstOrThrow()).caller).toBeNull();
  });

  it('XC-3 an invalid X-Caller (a space, a symbol, over 40 characters, empty) is ignored, never an error; upper case is stored lower-case', async () => {
    app = await makeApp({ adapters: [new FakeAdapter('porkbun')] });
    const bots = (await issueToken('bots', 'bots-shared')).auth;
    const bad = ['data engineer', 'bad<script>', 'a'.repeat(41), '', ' '];
    for (const [i, v] of bad.entries()) {
      const r = await call('POST', '/engine/sales', { ...bots, 'x-caller': v }, { rows: [{ ...rows.rows[0]!, domain: `name${'abcdefgh'[i]}.com` }] });
      expect(r.statusCode, v).toBe(201);
    }
    const got = await testDb.selectFrom('audit_log').select('caller').where('path', '=', '/engine/sales').execute();
    expect(got).toHaveLength(5);
    expect(got.every((g) => g.caller === null)).toBe(true);
    const edge = await call('POST', '/engine/sales', { ...bots, 'x-caller': 'a'.repeat(40) }, { rows: [{ ...rows.rows[0]!, domain: 'edgecase.com' }] });
    expect(edge.statusCode).toBe(201);
    expect((await testDb.selectFrom('audit_log').select('caller').where('caller', 'is not', null).execute())).toEqual([{ caller: 'a'.repeat(40) }]);
    const upper = await call('POST', '/engine/sales', { ...bots, 'x-caller': 'Gavriel' }, { rows: [{ ...rows.rows[0]!, domain: 'uppercase.com' }] });
    expect(upper.statusCode).toBe(201);
    expect((await testDb.selectFrom('audit_log').select('caller').where('caller', '=', 'gavriel').execute())).toHaveLength(1);
  });

  it('XC-4 the caller is in the request log line; a request without the header has no caller field', async () => {
    const logs = logCapture();
    app = await makeApp({ adapters: [new FakeAdapter('porkbun')], logStream: logs.stream });
    const read = (await issueToken('read', 'reader')).auth;
    await call('GET', '/portfolio', { ...read, 'x-caller': 'gavriel' });
    await call('GET', '/health', read);
    const lines = logs.text().split('\n').filter(Boolean).map((l) => JSON.parse(l) as { caller?: string; req?: { url?: string }; msg?: string });
    const withCaller = lines.filter((l) => l.caller === 'gavriel');
    expect(withCaller.length).toBeGreaterThan(0);
    expect(lines.some((l) => l.req?.url === '/health' && l.caller !== undefined)).toBe(false);
  });
});
