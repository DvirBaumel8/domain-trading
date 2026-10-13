// v4.0.0: CR-049 items 1, 4: the Spaceship SellerHub listing sync (MSW only; fake keys). binPrice = the plan's BIN, minPrice = the PUBLIC min offer,
// never the floor or the walk-away; delete when a name is delisted, dropped or sold; a SellerHub sale raises DELIST_NEEDED.
import { randomUUID } from 'node:crypto';
import { http, HttpResponse } from 'msw';
import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { ListingSyncJob } from '../../../src/modules/ops/jobs/listing-sync.js';
import { amountOf, centsOfAmount, SellerHubClient } from '../../../src/modules/ops/sellerhub.js';
import { makeApp, runJobToEnd } from '../../helpers/app.js';
import { insertOwnedDomain, testDb as db } from '../../helpers/db.js';
import { FakeAdapter } from '../../helpers/fake-adapter.js';
import { listedDomain } from '../../helpers/listing.js';
import { issueToken } from '../../helpers/tokens.js';
import { mswServer } from '../../setup/network.js';

const BASE = 'https://spaceship.dev/api';
const KEY = 'fake-sellerhub-key-0001';
const SECRET = 'fake-sellerhub-secret-0001';
const NOW = Date.parse('2027-03-10T09:00:00Z');
const D = 'examplecityroofing.com';
let app: FastifyInstance | undefined;
afterEach(async () => { await app?.close(); app = undefined; });

interface Call { method: string; path: string; body: any; key: string | null; secret: string | null } // eslint-disable-line @typescript-eslint/no-explicit-any
function sellerhub(state: { list?: unknown[]; sold?: unknown[]; fail?: Record<string, number> } = {}) {
  const calls: Call[] = [];
  const rec = async (request: Request, path: string) => {
    const text = await request.text();
    calls.push({ method: request.method, path, body: text ? JSON.parse(text) : null, key: request.headers.get('x-api-key'), secret: request.headers.get('x-api-secret') });
  };
  mswServer.use(
    http.get(`${BASE}/v1/sellerhub/domains`, async ({ request }) => { await rec(request, 'list'); return state.fail?.list ? new HttpResponse('boom', { status: state.fail.list }) : HttpResponse.json({ items: state.list ?? [], total: (state.list ?? []).length }); }),
    http.get(`${BASE}/v1/sellerhub/domains/reports/sold`, async ({ request }) => { await rec(request, 'sold'); return HttpResponse.json({ items: state.sold ?? [], cursor: '' }); }),
    http.post(`${BASE}/v1/sellerhub/domains`, async ({ request }) => { await rec(request, 'create'); return state.fail?.create ? new HttpResponse('boom', { status: state.fail.create }) : HttpResponse.json({}, { status: 200 }); }),
    http.patch(`${BASE}/v1/sellerhub/domains`, async ({ request }) => { await rec(request, 'update'); return HttpResponse.json({}); }),
    http.delete(`${BASE}/v1/sellerhub/domains/:name`, async ({ request, params }) => { await rec(request, `delete ${String(params.name)}`); return state.fail?.delete ? new HttpResponse('boom', { status: state.fail.delete }) : new HttpResponse(null, { status: 204 }); }),
  );
  return calls;
}
const job = (withKeys = true) => new ListingSyncJob({
  db, now: () => NOW, secretValues: [KEY, SECRET],
  client: withKeys ? new SellerHubClient({ fetch: globalThis.fetch, baseUrl: BASE, apiKey: KEY, apiSecret: SECRET }) : null,
});
const remote = (name: string, bin: string | null, min: string | null) => ({
  name, unicodeName: name, status: 'onSale', binPriceEnabled: bin !== null, minPriceEnabled: min !== null,
  binPrice: bin ? { amount: bin, currency: 'USD' } : null, minPrice: min ? { amount: min, currency: 'USD' } : null,
});
const log = () => db.selectFrom('listing_sync_log').selectAll().orderBy('id').execute();

describe('SellerHub client helpers', () => {
  it('SH-0: cents and amounts convert without floats', () => {
    expect(amountOf(148800)).toBe('1488.00');
    expect(amountOf(10005)).toBe('100.05');
    expect(centsOfAmount('1488.00')).toBe(148800);
    expect(centsOfAmount('100')).toBe(10000);
    expect(centsOfAmount('9.5')).toBe(950);
    expect(centsOfAmount('abc')).toBeNull();
  });
});

describe('listingSync', () => {
  it('SH-1: without keys the step is skipped (no call), cleanly', async () => {
    const calls = sellerhub();
    await listedDomain({ domain: D, bin_cents: 148800, floor_cents: 96700, walkaway_cents: 71400, min_offer_cents: 10000 });
    expect(await job(false).runOnce()).toMatchObject({ skipped: true, reason: 'SellerHub keys not configured' });
    expect(calls).toEqual([]);
  });

  it('SH-2: a listed name that SellerHub lacks is created with binPrice = BIN and minPrice = the public min offer; the floor and the walk-away are never sent', async () => {
    const calls = sellerhub();
    await listedDomain({ domain: D, bin_cents: 148800, floor_cents: 96700, walkaway_cents: 71400, min_offer_cents: 10000 });
    const r = await job().runOnce();
    expect(r).toMatchObject({ skipped: false, created: [D], updated: [], deleted: [], failed: [] });
    const create = calls.find((c) => c.path === 'create')!;
    expect(create.body).toEqual({ name: D, binPriceEnabled: true, binPrice: { amount: '1488.00', currency: 'USD' }, minPriceEnabled: true, minPrice: { amount: '100.00', currency: 'USD' } });
    expect(create.key).toBe(KEY);
    expect(create.secret).toBe(SECRET);
    const all = JSON.stringify(calls.map((c) => c.body));
    expect(all).not.toMatch(/967|714|96700|71400|walkaway|floor/);
    expect(await log()).toMatchObject([{ domain: D, venue: 'sellerhub', action: 'create', bin_cents: 148800, min_offer_cents: 10000 }]);
  });

  it('SH-3: a different remote price is PATCHed (a scheduled drop); an equal one makes no write; modes bin and offer drop the other price', async () => {
    const calls = sellerhub({ list: [remote(D, '1488.00', '100.00')] });
    await listedDomain({ domain: D, bin_cents: 148800, floor_cents: 96700, walkaway_cents: 71400, min_offer_cents: 10000 });
    expect(await job().runOnce()).toMatchObject({ created: [], updated: [] });
    expect(calls.map((c) => c.path)).toEqual(['list', 'sold']);
    await db.updateTable('domains').set({ bin_cents: 108800, floor_cents: 70700, walkaway_cents: 52200 }).where('domain', '=', D).execute();
    expect(await job().runOnce()).toMatchObject({ updated: [D] });
    expect(calls.find((c) => c.path === 'update')!.body).toMatchObject({ name: D, binPrice: { amount: '1088.00' }, minPrice: { amount: '100.00' } });
    // bin mode: no offers; offer mode: no Buy Now
    await db.updateTable('domains').set({ listing_mode: 'bin' }).where('domain', '=', D).execute();
    await job().runOnce();
    expect(calls.filter((c) => c.path === 'update').at(-1)!.body).toEqual({ name: D, binPriceEnabled: true, binPrice: { amount: '1088.00', currency: 'USD' }, minPriceEnabled: false });
  });

  it('SH-4: a delisted, dropped or sold name that SellerHub still shows is deleted; a name that is not ours is never touched', async () => {
    const calls = sellerhub({ list: [remote('gonea.com', '100.00', null), remote('goneb.com', '100.00', null), remote('gonec.com', '100.00', null), remote('notours.com', '100.00', null), remote('already.com', '100.00', null)] });
    for (const [d, status] of [['gonea.com', 'delisted'], ['goneb.com', 'dropped'], ['gonec.com', 'sold']] as const) await insertOwnedDomain(db, { domain: d, status, category: 'trend', price_grade: null });
    const r = await job().runOnce();
    expect(r.deleted.sort()).toEqual(['gonea.com', 'goneb.com', 'gonec.com']);
    expect(calls.filter((c) => c.method === 'DELETE').map((c) => c.path).sort()).toEqual(['delete gonea.com', 'delete goneb.com', 'delete gonec.com']);
    expect((await log()).map((l) => [l.domain, l.action])).toEqual([['gonea.com', 'delete'], ['goneb.com', 'delete'], ['gonec.com', 'delete']]);
  });

  it('SH-5: a SellerHub sale of a name we have not recorded is logged once, the listing is deleted, and /report raises the urgent DELIST_NEEDED for afternic and sedo', async () => {
    const calls = sellerhub({ list: [remote(D, '1488.00', '100.00')], sold: [{ name: D, unicodeName: D, saleDateTime: '2027-03-09T10:00:00.000Z', salePrice: { amount: '1488.00', currency: 'USD' } }] });
    await listedDomain({ domain: D, bin_cents: 148800, floor_cents: 96700, walkaway_cents: 71400, min_offer_cents: 10000 });
    const r = await job().runOnce();
    expect(r.sold_seen).toEqual([D]);
    expect(r.deleted).toEqual([D]);
    expect(calls.some((c) => c.method === 'DELETE')).toBe(true);
    expect((await job().runOnce()).sold_seen).toEqual([]); // the same sale is not logged twice
    app = await makeApp({ now: () => NOW, adapters: [new FakeAdapter('porkbun')] });
    const read = (await issueToken('read')).auth;
    await db.insertInto('job_runs').values({ job: 'daily', trigger: 'scheduled', started_at: new Date(NOW - 3_660_000), finished_at: new Date(NOW - 3_600_000), skipped: false, ok: true, steps: '{}' }).execute();
    const w = (await app.inject({ method: 'GET', url: '/report', headers: read })).json().warnings as { code: string; level: string; details: Record<string, any> }[]; // eslint-disable-line @typescript-eslint/no-explicit-any
    expect(w.filter((x) => x.code === 'DELIST_NEEDED')).toMatchObject([{ level: 'error', details: { venues: ['afternic', 'sedo'], reason: 'sellerhub_sold_report' } }]);
  });

  it('SH-6: errors are logged and listed as failed, the step is not ok, and no key or secret reaches the log or the summary', async () => {
    sellerhub({ fail: { create: 500 } });
    await listedDomain({ domain: D, bin_cents: 148800, floor_cents: 96700, walkaway_cents: 71400, min_offer_cents: 10000 });
    const r = await job().runOnce();
    expect(r.failed).toHaveLength(1);
    expect(r.failed[0]!.domain).toBe(D);
    const rows = await log();
    expect(rows[0]).toMatchObject({ action: 'error', http_status: 500 });
    expect(JSON.stringify([r, rows])).not.toContain(KEY);
    expect(JSON.stringify([r, rows])).not.toContain(SECRET);
    sellerhub({ fail: { list: 503 } });
    expect((await job().runOnce()).failed[0]).toMatchObject({ domain: '*' });
  });

  it('SH-7: the daily run has the step after dropJob; with no keys it is skipped and the run is ok', async () => {
    app = await makeApp({ testRoutes: false, env: { JOB_TRIGGER_TOKEN: 'job_token_fake_0123456789abcdef0123456789' }, adapters: [new FakeAdapter('porkbun')], now: () => NOW });
    const res = await runJobToEnd(app, 'daily', { key: 'ls-1' });
    const steps = Object.keys(res.json().steps);
    expect(steps.indexOf('listingSync')).toBe(steps.indexOf('dropJob') + 1);
    expect(res.json().steps.listingSync).toMatchObject({ ok: true, skipped: true });
  });
});

describe('/sold delists at SellerHub right away (CR-049 item 4)', () => {
  const sold = (auth: Record<string, string>) => app!.inject({
    method: 'POST', url: `/sold/${D}`, headers: { ...auth, 'idempotency-key': randomUUID() },
    payload: { venue: 'afternic', sale_price: 1488, commission: 223.2, sold_at: '2027-03-10T10:00:00+01:00', transaction_ref: 'AFN-9', approval_ref: { text: `it sold for 1488 (${D})`, approved_at: new Date(NOW - 30_000).toISOString() } },
  });

  it('SH-8: after the sale commits a DELETE goes to SellerHub; a failing DELETE never fails the sale', async () => {
    const calls = sellerhub();
    app = await makeApp({ now: () => NOW, adapters: [new FakeAdapter('porkbun')], env: { SPACESHIP_SELLERHUB_API_KEY: KEY, SPACESHIP_SELLERHUB_API_SECRET: SECRET } });
    const auth = (await issueToken('write')).auth;
    const id = await listedDomain({ domain: D, bin_cents: 148800, floor_cents: 96700, walkaway_cents: 71400, min_offer_cents: 10000, lander: 'afternic', lander_set_at: new Date('2027-01-01T00:00:00Z') });
    await db.insertInto('ledger_entries').values({ occurred_on: '2026-10-04', domain_id: id, type: 'registration', amount_cents: -1108 }).execute();
    const res = await sold(auth);
    expect(res.statusCode, res.body).toBe(200);
    expect(calls.filter((c) => c.method === 'DELETE').map((c) => c.path)).toEqual([`delete ${D}`]);
    expect(await log()).toMatchObject([{ domain: D, action: 'delete' }]);
  });

  it('SH-9: a SellerHub error on that DELETE leaves the sale recorded', async () => {
    sellerhub({ fail: { delete: 500 } });
    app = await makeApp({ now: () => NOW, adapters: [new FakeAdapter('porkbun')], env: { SPACESHIP_SELLERHUB_API_KEY: KEY, SPACESHIP_SELLERHUB_API_SECRET: SECRET } });
    const auth = (await issueToken('write')).auth;
    const id = await listedDomain({ domain: D, bin_cents: 148800, floor_cents: 96700, walkaway_cents: 71400, min_offer_cents: 10000, lander: 'afternic', lander_set_at: new Date('2027-01-01T00:00:00Z') });
    await db.insertInto('ledger_entries').values({ occurred_on: '2026-10-04', domain_id: id, type: 'registration', amount_cents: -1108 }).execute();
    const res = await sold(auth);
    expect(res.statusCode, res.body).toBe(200);
    expect((await db.selectFrom('domains').select('status').where('domain', '=', D).executeTakeFirstOrThrow()).status).toBe('sold');
    expect(await log()).toMatchObject([{ action: 'error', http_status: 500 }]);
  });
});
