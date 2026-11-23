import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp, type AppDeps } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { hashToken } from '../src/http/auth.js';
import type { RegistrarAdapter } from '../src/registrars/index.js';
import type { Quote } from '../src/registrars/types.js';
import { parseState } from '../src/state.js';

const TOKEN = 'dt_fake-test-token';
const auth = { authorization: `Bearer ${TOKEN}` };
const approval = { approved_on: '2026-10-04', ref: 'r' };
const state = parseState(JSON.stringify({
  domains: [
    { domain: 'sold.com', display_name: 'Sold.com', deal_id: 'D-001', registrar: 'porkbun', expiry_date: '2027-10-04', status: 'sold' },
    { domain: 'kept.com', display_name: 'Kept.com', deal_id: 'D-002', registrar: 'godaddy', expiry_date: '2027-10-04', status: 'owned' },
  ],
  ledger: [
    { id: 1, date: '2026-10-04', type: 'purchase', domain: 'sold.com', amount_cents: -1108, note: 'n', approval },
    { id: 2, date: '2026-10-05', type: 'purchase', domain: 'kept.com', amount_cents: -2419, note: 'n', approval },
    { id: 3, date: '2026-10-06', type: 'cost', domain: null, amount_cents: -499, note: 'n', approval: null },
    { id: 4, date: '2026-11-01', type: 'sale', domain: 'sold.com', amount_cents: 148_800, note: 'n', approval },
    { id: 5, date: '2026-11-02', type: 'adjustment', domain: 'kept.com', amount_cents: 19, note: 'n', approval: null },
  ],
}));

const adapter = (q: Partial<Quote> | Error = {}): RegistrarAdapter & { calls: number } => ({
  name: 'porkbun', calls: 0,
  capabilities: { canQuote: true, canRegister: true, canManageNs: true, customNs: true, prepaid: true, freePrivacy: true, afternicFastTransfer: true, sandbox: false },
  async quote() {
    this.calls++;
    if (q instanceof Error) throw q;
    return { available: true, premium: false, firstYearCents: 1108, renewalCents: 1108, privacyCentsPerYear: 0, currency: 'USD', minDurationYears: 1, raw: {}, ...q };
  },
});

let app: FastifyInstance;
afterEach(() => app.close());
const make = (o: Partial<AppDeps> = {}) => (app = buildApp({
  config: loadConfig({ RENDER_GIT_COMMIT: 'abc' }, JSON.stringify({ tester: hashToken(TOKEN) })), state, logger: false, rdap: async () => 'not_registered', adapters: [adapter()], ...o,
}));
const get = (url: string, headers: Record<string, string> = auth) => app.inject({ method: 'GET', url, headers });

describe('health and access', () => {
  it('/health/ping is open and names the version and commit', async () => {
    make();
    const r = await get('/health/ping', {});
    expect([r.statusCode, r.json()]).toEqual([200, { status: 'ok', version: expect.stringMatching(/^\d+\./), commit: 'abc' }]);
  });
  it('every other route, and an unknown one, needs a token', async () => {
    make();
    for (const url of ['/health', '/check?domain=x.com', '/portfolio', '/portfolio/kept.com', '/ledger', '/report', '/nope']) {
      for (const h of [{}, { authorization: 'Bearer wrong' }, { authorization: TOKEN }] as Record<string, string>[]) {
        const r = await get(url, h);
        expect([url, r.statusCode, r.json().error.code]).toEqual([url, 401, 'UNAUTHORIZED']);
      }
      await app.close(); make(); // a fresh failure counter
    }
  });
  it('no tokens configured: refused', async () => {
    make({ config: loadConfig({}) });
    expect((await get('/portfolio')).statusCode).toBe(401);
  });
  it('a trailing slash, an encoded path or a query cannot open a private route', async () => {
    make();
    for (const url of ['/portfolio/', '/%70ortfolio', '/portfolio?x=/health/ping', '/health/ping/../../portfolio', '/health/ping/x']) expect((await get(url, {})).statusCode, url).toBe(401);
  });
  it('21 wrong tokens: 429 with Retry-After; a good token still works; the block ends', async () => {
    let t = 0;
    make({ now: () => t });
    for (let i = 0; i < 20; i++) expect((await get('/report', {})).statusCode).toBe(401);
    const r = await get('/report', {});
    expect([r.statusCode, r.json().error.code, r.headers['retry-after']]).toEqual([429, 'RATE_LIMITED', '600']);
    expect((await get('/report')).statusCode).toBe(200);
    t += 600_001;
    expect((await get('/report', {})).statusCode).toBe(401);
  });
  it('61 calls in a minute with one token: 429', async () => {
    let t = 0;
    make({ now: () => t });
    for (let i = 0; i < 60; i++) expect((await get('/report')).statusCode).toBe(200);
    expect((await get('/report')).statusCode).toBe(429);
    t += 60_001;
    expect((await get('/report')).statusCode).toBe(200);
  });
  it('nothing can be written: no POST, PUT, PATCH or DELETE route', async () => {
    make();
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE'] as const) {
      for (const url of ['/buy', '/portfolio', '/portfolio/kept.com', '/ledger', '/jobs/run', '/sold/kept.com']) {
        const r = await app.inject({ method, url, headers: auth });
        expect([method, url, r.statusCode, r.json().error.code]).toEqual([method, url, 404, 'NOT_FOUND']);
      }
    }
  });
});

describe('books', () => {
  it('/portfolio: each domain with what it cost and sold for', async () => {
    make();
    expect((await get('/portfolio')).json().domains).toMatchObject([
      { domain: 'sold.com', status: 'sold', buy_date: '2026-10-04', renewals_used: 0, cost_cents: 1108, cost: '$11.08', sold_for_cents: 148_800, sold_for: '$1,488.00' },
      { domain: 'kept.com', status: 'owned', registrar: 'godaddy', cost_cents: 2400, cost: '$24.00', sold_for_cents: null, sold_for: null },
    ]);
  });
  it('/portfolio/{domain}: with its ledger rows; any letter case; 404 and 422', async () => {
    make();
    expect((await get('/portfolio/Kept.com')).json()).toMatchObject({ domain: 'kept.com', ledger: [{ id: 2, amount: '-$24.19' }, { id: 5 }] });
    expect((await get('/portfolio/other.com')).json().error.code).toBe('DOMAIN_NOT_FOUND');
    expect((await get('/portfolio/other.net')).json().error.code).toBe('TLD_NOT_SUPPORTED');
  });
  it('/ledger and /report add up', async () => {
    make();
    const ledger = (await get('/ledger')).json();
    expect([ledger.entries.length, ledger.total_cents, ledger.total]).toEqual([5, 144_793, '$1,447.93']);
    expect((await get('/report')).json()).toEqual({
      domains_owned: 1, domains_sold: 1, max_domains: 40, spent_cents: 4007, spent: '$40.07', sales_cents: 148_800, sales: '$1,488.00', net_cents: 144_793, net: '$1,447.93',
    });
  });
});

describe('/check', () => {
  it('a free name: the price now, the renewal and the two-year total', async () => {
    make();
    const r = (await get('/check?domain=New.com')).json();
    expect(r).toMatchObject({ domain: 'new.com', availability: 'available', winner: { registrar: 'porkbun', first_year: '$11.08', two_year_cents: 2216 }, warnings: [] });
    expect(r.checked_at).toMatch(/\+0[23]:00$/);
  });
  it('a taken name, a premium name and a failing registrar have no winner', async () => {
    make({ rdap: async () => 'registered', adapters: [adapter({ available: false })] });
    expect((await get('/check?domain=a.com')).json()).toMatchObject({ availability: 'taken', winner: null });
    await app.close();
    make({ adapters: [adapter({ premium: true })] });
    expect((await get('/check?domain=a.com')).json()).toMatchObject({ winner: null, quotes: [{ exclusion_reason: 'PREMIUM' }] });
    await app.close();
    make({ adapters: [adapter(new Error('boom'))] });
    expect((await get('/check?domain=a.com')).json()).toMatchObject({ availability: 'unknown', winner: null, quotes: [{ error_code: 'ADAPTER_FAILED' }] });
  });
  it('no registrar keys: answers "unknown", no quotes', async () => {
    make({ adapters: [] });
    expect((await get('/check?domain=a.com')).json()).toMatchObject({ availability: 'unknown', quotes: [], winner: null });
  });
  it('asks the registrar once a minute per name', async () => {
    let t = 0;
    const a = adapter();
    make({ adapters: [a], now: () => t });
    await get('/check?domain=a.com'); await get('/check?domain=a.com');
    expect(a.calls).toBe(1);
    t += 60_001;
    await get('/check?domain=a.com');
    expect(a.calls).toBe(2);
  });
  it('bad input', async () => {
    make();
    expect((await get('/check')).statusCode).toBe(400);
    expect((await get('/check?domain=a.b.com')).json().error.code).toBe('DOMAIN_INVALID');
    expect((await get('/check?domain=a.net')).json().error.code).toBe('TLD_NOT_SUPPORTED');
  });
});
