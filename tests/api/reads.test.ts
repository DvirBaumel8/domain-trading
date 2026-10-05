import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { revokeApiToken } from '../../src/admin/tokens.js';
import { importDomain, type ImportInput } from '../../src/admin/import-domain.js';
import { makeApp } from '../helpers/app.js';
import { T0, buyBody, postBuy } from '../helpers/buy.js';
import { insertOwnedDomain, testDb as db } from '../helpers/db.js';
import { FakeAdapter } from '../helpers/fake-adapter.js';
import { listedDomain } from '../helpers/listing.js';
import { issueToken } from '../helpers/tokens.js';

let app: FastifyInstance;
afterEach(async () => app?.close());
const NOW = Date.parse('2026-10-06T09:00:00Z');
const D = 'promptinjectionaudit.com';
async function boot(now = NOW) {
  app = await makeApp({ adapters: [new FakeAdapter('porkbun')], now: () => now, rdap: async () => 'not_registered' });
  const read = await issueToken('read');
  const write = await issueToken('write');
  const get = (url: string, auth: Record<string, string> = read.auth) => app.inject({ method: 'GET', url, headers: auth });
  return { get, read, write };
}

const D001: ImportInput = {
  domain: D, registrar: 'godaddy', buyDate: '2026-10-04', cost: '13.73', costNote: '42 ILS @0.3269', order: 'none', deal: 'D-001', category: 'trend',
  listingMode: 'hybrid', bin: '1995', floor: '1295', walkaway: '950', pricingException: 'Dvir approved 2026-10-05 00:39 IDT',
  legacyNoComps: 'bought before the comps rule; card found no comps', approvalText: 'Approve the prices, but wait for the software to list it',
  approvalAt: '2026-10-05T00:39:00+03:00', manual: true, expiry: '2027-10-04',
};

describe('read endpoints: auth', () => {
  it('R-8: READ and WRITE tokens pass, none and revoked are 401, on each GET', async () => {
    const t = await boot();
    const urls = ['/portfolio', `/portfolio/${D}`, '/ledger', '/deals/D-001', '/audit', '/report/pricing-review'];
    const revoked = await issueToken('read');
    await revokeApiToken(db, revoked.id);
    for (const u of urls) {
      expect((await t.get(u, t.read.auth)).statusCode, `read ${u}`).not.toBe(401);
      expect((await t.get(u, t.write.auth)).statusCode, `write ${u}`).not.toBe(401);
      expect((await t.get(u, {})).statusCode, `none ${u}`).toBe(401);
      expect((await t.get(u, revoked.auth)).statusCode, `revoked ${u}`).toBe(401);
    }
  });

  it('R-11: /health needs a token (401 without) and carries no business data', async () => {
    const t = await boot();
    expect((await t.get('/health', {})).statusCode).toBe(401);
    const r = await t.get('/health');
    expect(r.statusCode).toBe(200);
    for (const k of ['domain', 'domains', 'ledger', 'per_domain', 'budget', 'sales']) expect(Object.keys(r.json())).not.toContain(k);
  });
});

describe('GET /portfolio', () => {
  it('lists per_domain rows, filters by status, and 400 on a bad status', async () => {
    const t = await boot();
    await insertOwnedDomain(db, { domain: 'alpha-one.com' });
    await listedDomain({ domain: 'beta-two.com' });
    expect((await t.get('/portfolio')).json().domains.map((d: { domain: string }) => d.domain)).toEqual(['alpha-one.com', 'beta-two.com']);
    const l = (await t.get('/portfolio?status=listed')).json().domains;
    expect(l).toHaveLength(1);
    expect(l[0]).toMatchObject({ domain: 'beta-two.com', bin_cents: 199500, walkaway: '$960 (private)' });
    expect((await t.get('/portfolio?status=bogus')).statusCode).toBe(400);
    const pp = await t.get('/portfolio?status=pending_purchase');
    expect(pp.statusCode).toBe(400);
    expect(pp.json().error.code).toBe('VALIDATION_ERROR');
    expect((await t.get('/portfolio?x=1')).statusCode).toBe(400);
  });

  it('IM-4 (mock): an import with D-001 flags shows up in /portfolio/{domain}', async () => {
    const t = await boot();
    await importDomain(db, D001, { adapters: [], now: new Date(NOW) });
    const r = await t.get(`/portfolio/${D}`);
    expect(r.statusCode, r.body).toBe(200);
    const b = r.json();
    expect(b).toMatchObject({
      domain: D, registrar: 'godaddy', cost_cents: 1373, cost: '$13.73', expiry_date: '2027-10-04', drop_date: '2028-10-04', category: 'trend',
      listing_mode: 'hybrid', bin_cents: 199500, floor_cents: 129500, walkaway_cents: 95000, walkaway: '$950 (private)', min_offer_cents: 10000,
      pricing_source: 'approved_exception',
    });
    expect(b.schedule).toHaveLength(4);
    expect(b.schedule.map((s: { event: string }) => s.event)).toEqual(['drop1_m6', 'drop2_m18', 'final_push', 'delist']);
    expect(b.listing_history).toHaveLength(1);
    expect(b.listing_history[0]).toMatchObject({ source: 'import', walkaway: '$950 (private)' });
    expect(b.ledger).toHaveLength(1);
    expect(b.ledger[0]).toMatchObject({ type: 'registration', amount_usd: '-13.73', deal_id: 'D-001' });
    expect(b.sale).toBeNull();
  });

  it('404 DOMAIN_NOT_FOUND', async () => {
    const t = await boot();
    const r = await t.get('/portfolio/nope.com');
    expect(r.statusCode).toBe(404);
    expect(r.json().error.code).toBe('DOMAIN_NOT_FOUND');
  });

  it('export block (lander check, §10.7): last_uploaded is the uploaded values, not the current ones; pending after a later drop; no walk-away', async () => {
    const t = await boot();
    const id = await listedDomain({ domain: 'beta-two.com', lander: 'afternic' });
    const T = (m: number) => new Date(Date.UTC(2026, 9, 5, 10, m));
    const hist = (at: Date, bin: number, floor: number, walkaway: number) => db.insertInto('listing_history').values({
      domain_id: id, at, source: 'list', category: 'trend', mode: 'hybrid', bin_cents: bin, floor_cents: floor, walkaway_cents: walkaway, min_offer_cents: 10000, pricing_settings_version: 2,
    }).execute();
    await hist(T(0), 199500, 129500, 96000);
    await hist(T(3), 179500, 116500, 86000); // changed after the file snapshot (run at T(2))
    await db.insertInto('export_runs').values({ marketplace: 'afternic', at: T(2), domains: ['beta-two.com'], export_id: 'exp_a1' }).execute();
    await db.insertInto('export_uploads').values({ venue: 'afternic', export_id: 'exp_a1', domains: ['beta-two.com'], uploaded_at: T(8), approval_text: 'uploaded', audit_id: null }).execute();
    await db.updateTable('domains').set({ listing_changed_at: T(0) }).where('id', '=', id).execute();
    let b = (await t.get('/portfolio/beta-two.com')).json();
    expect(b.export.afternic.pending).toBe(false);
    // a later drop
    await hist(T(20), 159500, 103500, 77000);
    await db.updateTable('domains').set({ bin_cents: 159500, floor_cents: 103500, walkaway_cents: 77000, listing_changed_at: T(20) }).where('id', '=', id).execute();
    b = (await t.get('/portfolio/beta-two.com')).json();
    expect(b.export.afternic.pending).toBe(true);
    expect(b.export.afternic.last_confirmed_upload_at).toBe('2026-10-05T13:08:00+03:00');
    expect(b.export.afternic.last_uploaded).toEqual({
      bin_cents: 199500, bin: '$1,995.00', floor_cents: 129500, floor: '$1,295.00', min_offer_cents: 10000, min_offer: '$100.00',
    });
    expect(b.bin_cents).toBe(159500); // the current row differs from what is on the marketplace
    expect(b.export.sedo).toEqual({ pending: true, last_confirmed_upload_at: null, last_uploaded: null });
    const ex = JSON.stringify(b.export);
    for (const s of ['walkaway', 'private', '96000', '77000', '$960', '$770']) expect(ex, s).not.toContain(s);
  });
});

describe('GET /ledger', () => {
  async function seed() {
    const a = await insertOwnedDomain(db, { domain: 'alpha-one.com', deal_id: 'D-009' });
    await db.insertInto('ledger_entries').values([
      { occurred_on: '2026-10-04', domain_id: a, deal_id: 'D-009', type: 'registration', amount_cents: -1108, counterparty: 'porkbun', receipt_ref: 'porkbun:ord-1', note: null },
      { occurred_on: '2026-10-12', domain_id: a, deal_id: 'D-009', type: 'sale', amount_cents: 199500, counterparty: 'afternic', receipt_ref: null, note: 'a, "quoted" note' },
      { occurred_on: '2026-10-12', domain_id: null, deal_id: null, type: 'tool', amount_cents: -500, counterparty: null, receipt_ref: null, note: null },
    ]).execute();
  }

  it('R-12: CSV header is byte-exact, amounts signed with 2 decimals, RFC 4180 quoting, CRLF', async () => {
    const t = await boot();
    await seed();
    const r = await t.get('/ledger?format=csv');
    expect(r.statusCode).toBe(200);
    expect(r.headers['content-type']).toMatch(/^text\/csv/);
    expect(r.body).toBe([
      'date,type,domain,deal_id,amount_usd,counterparty,receipt_ref,note',
      '2026-10-04,registration,alpha-one.com,D-009,-11.08,porkbun,porkbun:ord-1,',
      '2026-10-12,sale,alpha-one.com,D-009,1995.00,afternic,,"a, ""quoted"" note"',
      '2026-10-12,tool,,,-5.00,,,',
    ].join('\r\n') + '\r\n');
  });

  it('json rows and filters (type, domain, from, to)', async () => {
    const t = await boot();
    await seed();
    const all = (await t.get('/ledger')).json();
    expect(all.count).toBe(3);
    expect(all.rows[0]).toMatchObject({ date: '2026-10-04', amount_cents: -1108, amount: '-$11.08', amount_usd: '-11.08' });
    expect((await t.get('/ledger?type=sale')).json().count).toBe(1);
    expect((await t.get('/ledger?domain=Alpha-One.com')).json().count).toBe(2);
    expect((await t.get('/ledger?from=2026-10-12')).json().count).toBe(2);
    expect((await t.get('/ledger?to=2026-10-04')).json().count).toBe(1);
    expect((await t.get('/ledger?format=csv&type=tool')).body.split('\r\n')).toHaveLength(3);
  });

  it('400 on bad input', async () => {
    const t = await boot();
    for (const q of ['type=nope', 'from=2026-02-30', 'to=yesterday', 'format=xml', 'domain=not a domain', 'from=2026-10-12&to=2026-10-01', 'x=1']) {
      expect((await t.get(`/ledger?${q}`)).statusCode, q).toBe(400);
    }
  });
});

describe('GET /deals/{id}', () => {
  it('a buy with deal_id lists its approval; unknown deal is 404', async () => {
    app = await makeApp({ adapters: [new FakeAdapter('porkbun')], now: () => T0, rdap: async () => 'not_registered' });
    const w = await issueToken('write');
    const r = await issueToken('read');
    const buy = await postBuy(app, buyBody({ deal_id: 'D-002' }), w.auth);
    expect(buy.statusCode, buy.body).toBe(201);
    await postBuy(app, buyBody({ domain: 'otherdomain.com', deal_id: 'D-003' }), w.auth);
    const res = await app.inject({ method: 'GET', url: '/deals/D-002', headers: r.auth });
    expect(res.statusCode).toBe(200);
    const b = res.json();
    expect(b).toMatchObject({ id: 'D-002', domain: 'examplecityroofing.com' });
    expect(b.approvals).toHaveLength(1);
    expect(b.approvals[0]).toMatchObject({ method: 'POST', path: '/buy', approval_text: buyBody().approval_ref.text, status_code: 201 });
    expect(await db.selectFrom('deals').select('id').where('id', '=', 'D-002').executeTakeFirst()).toBeDefined(); // the deals row (bookPurchase) backs the view
    // a domain row carrying a deal_id without a deals row is not a deal
    await insertOwnedDomain(db, { domain: 'orphan-deal.com', deal_id: 'D-077' });
    expect((await app.inject({ method: 'GET', url: '/deals/D-077', headers: r.auth })).statusCode).toBe(404);
    const miss = await app.inject({ method: 'GET', url: '/deals/D-404', headers: r.auth });
    expect(miss.statusCode).toBe(404);
    expect(miss.json().error.code).toBe('DEAL_NOT_FOUND');
  });

  it('an imported deal row (D-001) shows its admin approval', async () => {
    const t = await boot();
    await importDomain(db, D001, { adapters: [], now: new Date(NOW) });
    const b = (await t.get('/deals/D-001')).json();
    expect(b).toMatchObject({ id: 'D-001', domain: D });
    expect(b.approvals.map((a: { approval_text: string }) => a.approval_text)).toEqual([D001.approvalText]);
  });
});

describe('GET /audit', () => {
  it('newest first, limit and since filters, request as stored, no secrets; bad input is 400', async () => {
    let t = NOW;
    app = await makeApp({ now: () => t });
    const w = await issueToken('write');
    const r = await issueToken('read');
    for (let i = 0; i < 3; i++) {
      await app.inject({ method: 'POST', url: '/__test/echo', headers: { ...w.auth, 'idempotency-key': randomUUID() }, payload: { value: `v${i}` } });
      await new Promise((res) => setTimeout(res, 15));
    }
    const get = (q: string) => app.inject({ method: 'GET', url: `/audit${q}`, headers: r.auth });
    const all = (await get('')).json().rows;
    expect(all.length).toBeGreaterThanOrEqual(3);
    const posts = all.filter((x: { path: string }) => x.path === '/__test/echo');
    expect(posts.map((x: { request: { value: string } }) => x.request.value)).toEqual(['v2', 'v1', 'v0']);
    expect(all.map((x: { at: string }) => x.at)).toEqual([...all.map((x: { at: string }) => x.at)].sort().reverse());
    expect((await get('?limit=1')).json().rows).toHaveLength(1);
    const second = await db.selectFrom('audit_log').select('at').where('path', '=', '/__test/echo').orderBy('at').execute();
    const since = encodeURIComponent(second[1]!.at.toISOString());
    expect((await get(`?since=${since}`)).json().rows.filter((x: { path: string }) => x.path === '/__test/echo')).toHaveLength(2);
    const haystack = JSON.stringify(all);
    expect(haystack).not.toContain(w.token);
    expect(haystack).not.toContain(r.token);
    for (const q of ['?limit=0', '?limit=501', '?limit=abc', '?since=yesterday', '?since=2026-10-05', '?x=1']) expect((await get(q)).statusCode, q).toBe(400);
    expect((await get('?limit=500')).statusCode).toBe(200);
  });
});
