import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { makeApp } from '../helpers/app.js';
import { parseCsvStrict } from '../helpers/csv.js';
import { testDb as db } from '../helpers/db.js';
import { listedDomain } from '../helpers/listing.js';
import { issueToken } from '../helpers/tokens.js';

let app: FastifyInstance;
afterEach(async () => app?.close());

async function fixture4() {
  await listedDomain({ domain: 'austinroofrepair.com', display_name: 'AustinRoofRepair.com', category: 'geo' });
  await listedDomain({ domain: 'trendname.com', category: 'trend', listing_mode: 'hybrid', bin_cents: 499900, floor_cents: 250000, min_offer_cents: 100000, lto_max_months: 24 });
  await listedDomain({ domain: 'buzz.com', category: 'buzzword', listing_mode: 'offer', bin_cents: null, floor_cents: null, min_offer_cents: 50000 });
  await listedDomain({ domain: 'gone.com', status: 'sold', sold_at: new Date(), delisted_at: new Date() });
}

describe('GET /export/afternic.csv', () => {
  it('E-2/E-5: 3 rows exactly (LX-1/LX-4/LX-2), sorted by domain, sold excluded + in X-Manual-Delist; strict parse 11 columns', async () => {
    app = await makeApp();
    const { auth } = await issueToken('read');
    await fixture4();
    const res = await app.inject({ method: 'GET', url: '/export/afternic.csv', headers: auth });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/^text\/csv; charset=utf-8/);
    expect(res.headers['content-disposition']).toMatch(/^attachment; filename="afternic-\d{4}-\d{2}-\d{2}\.csv"$/);
    expect(res.headers['x-manual-delist'] ?? '').toBe('');
    const rows = parseCsvStrict(res.body);
    expect(rows.every((r) => r.length === 11)).toBe(true);
    expect(rows.map((r) => r.join(','))).toEqual([
      'Domain,Buy Now Price,Floor Price,Min Offer,Lease to Own,Max Lease Period,Sale Lander,Show Buy Now Option,Show Lease to Own Option,Show Make Offer Option,Hidden',
      'AustinRoofRepair.com,399,399,399,N,,Buy It Now,Y,N,N,N',
      'buzz.com,0,,500,N,,Custom Lander,N,N,Y,N',
      'trendname.com,4999,2500,1000,Y,24,Custom Lander,Y,Y,Y,N',
    ]);
    expect(res.body.endsWith('\r\n')).toBe(true);
  });

  it('X-Manual-Delist: a sold domain that was never exported is not listed', async () => {
    app = await makeApp();
    const { auth } = await issueToken('read');
    await listedDomain({ domain: 'never.com', status: 'sold', sold_at: new Date() });
    const res = await app.inject({ method: 'GET', url: '/export/afternic.csv', headers: auth });
    expect(res.headers['x-manual-delist'] ?? '').toBe('');
  });

  it('X-Manual-Delist: sold after being exported is listed, and keeps being listed', async () => {
    app = await makeApp();
    const { auth } = await issueToken('read');
    await listedDomain({ domain: 'x.com' });
    await app.inject({ method: 'GET', url: '/export/afternic.csv', headers: auth });
    await db.updateTable('domains').set({ status: 'sold', sold_at: new Date() }).where('domain', '=', 'x.com').execute();
    for (let i = 0; i < 2; i++) {
      const res = await app.inject({ method: 'GET', url: '/export/afternic.csv', headers: auth });
      expect(res.headers['x-manual-delist']).toBe('x.com');
      expect(parseCsvStrict(res.body)).toHaveLength(1);
    }
  });

  it('a non-ASCII domain is skipped with an index-only warning, no 500', async () => {
    app = await makeApp();
    const { auth } = await issueToken('read');
    await listedDomain({ domain: 'bücher.com' });
    const res = await app.inject({ method: 'GET', url: '/export/afternic.csv', headers: auth });
    expect(res.statusCode).toBe(200);
    expect(parseCsvStrict(res.body)).toHaveLength(1);
    expect(res.headers['x-export-warnings']).toBe('0:DOMAIN_NOT_ASCII');
  });

  it('cents are rounded down with an AFTERNIC_ROUNDS_DOWN warning in the header', async () => {
    app = await makeApp();
    const { auth } = await issueToken('read');
    await listedDomain({ domain: 'cents.com', bin_cents: 39950, floor_cents: 39950, min_offer_cents: 39950 });
    const res = await app.inject({ method: 'GET', url: '/export/afternic.csv', headers: auth });
    expect(res.headers['x-export-warnings']).toContain('cents.com:AFTERNIC_ROUNDS_DOWN');
  });

  it('E-3: a Min Offer < 20 row is skipped and reported in X-Export-Warnings', async () => {
    app = await makeApp();
    const { auth } = await issueToken('read');
    // The DB CHECK forbids min_offer < 2000, so the skip path is proven in export-rows.test.ts (E-3/LX-6);
    // here: valid rows produce no warnings.
    await listedDomain({ domain: 'ok.com' });
    const res = await app.inject({ method: 'GET', url: '/export/afternic.csv', headers: auth });
    expect(res.headers['x-export-warnings'] ?? '').toBe('');
  });

  it('Review Focus 4: a display name with a comma is quoted and still parses to 11 columns', async () => {
    app = await makeApp();
    const { auth } = await issueToken('read');
    await listedDomain({ domain: 'example.com', display_name: 'Ex,ample.com' });
    const rows = parseCsvStrict((await app.inject({ method: 'GET', url: '/export/afternic.csv', headers: auth })).body);
    expect(rows[1]![0]).toBe('Ex,ample.com');
    expect(rows[1]).toHaveLength(11);
  });

  it('E-8: READ ok; no token 401', async () => {
    app = await makeApp();
    expect((await app.inject({ method: 'GET', url: '/export/afternic.csv' })).statusCode).toBe(401);
  });
});

describe('GET /export/sedo.csv', () => {
  it('E-6: template missing → 501 SEDO_TEMPLATE_MISSING, never a guessed file', async () => {
    app = await makeApp({ env: { SEDO_TEMPLATE_PATH: join(tmpdir(), 'definitely-missing-sedo.json') } });
    const { auth } = await issueToken('read');
    const res = await app.inject({ method: 'GET', url: '/export/sedo.csv', headers: auth });
    expect(res.statusCode).toBe(501);
    expect(res.json().error.code).toBe('SEDO_TEMPLATE_MISSING');
  });

  it('E-7: headers and values exactly as configured; no minimum on fixed-price rows', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sedo-'));
    const path = join(dir, 'sedo_template.json');
    writeFileSync(path, JSON.stringify({
      headers: ['Domain Name', 'Option', 'Sale', 'Price', 'Min', 'Cur', 'Action'],
      map: { domain: 'Domain Name', selling_option: 'Option', for_sale: 'Sale', price: 'Price', min_price: 'Min', currency: 'Cur', action: 'Action' },
      values: { buy_now: 'FIXED', make_offer: 'OFFER', for_sale_yes: 'yes', usd: 'USD', action_add: 'ADD' },
    }));
    app = await makeApp({ env: { SEDO_TEMPLATE_PATH: path } });
    const { auth } = await issueToken('read');
    await fixture4();
    const res = await app.inject({ method: 'GET', url: '/export/sedo.csv', headers: auth });
    expect(res.statusCode).toBe(200);
    expect(parseCsvStrict(res.body).map((r) => r.join(','))).toEqual([
      'Domain Name,Option,Sale,Price,Min,Cur,Action',
      'austinroofrepair.com,FIXED,yes,399,,USD,ADD',
      'buzz.com,OFFER,yes,,500,USD,ADD',
      'trendname.com,FIXED,yes,4999,,USD,ADD',
    ]);
  });

  it('an invalid template file → 501 SEDO_TEMPLATE_INVALID, never a guessed file', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sedo-'));
    const path = join(dir, 'sedo_template.json');
    writeFileSync(path, '{"headers": []}');
    app = await makeApp({ env: { SEDO_TEMPLATE_PATH: path } });
    const { auth } = await issueToken('read');
    const res = await app.inject({ method: 'GET', url: '/export/sedo.csv', headers: auth });
    expect(res.statusCode).toBe(501);
    expect(res.json().error.code).toBe('SEDO_TEMPLATE_INVALID');
  });

  async function badTemplate(content: string) {
    const dir = mkdtempSync(join(tmpdir(), 'sedo-'));
    const path = join(dir, 'sedo_template.json');
    writeFileSync(path, content);
    app = await makeApp({ env: { SEDO_TEMPLATE_PATH: path } });
    const { auth } = await issueToken('read');
    return app.inject({ method: 'GET', url: '/export/sedo.csv', headers: auth });
  }
  const good = {
    headers: ['Domain Name', 'Option', 'Sale', 'Price', 'Min', 'Cur', 'Action'],
    map: { domain: 'Domain Name', selling_option: 'Option', for_sale: 'Sale', price: 'Price', min_price: 'Min', currency: 'Cur', action: 'Action' },
    values: { buy_now: 'FIXED', make_offer: 'OFFER', for_sale_yes: 'yes', usd: 'USD', action_add: 'ADD' },
  };

  it('invalid JSON → 501 SEDO_TEMPLATE_INVALID', async () => {
    const res = await badTemplate('{not json');
    expect(res.statusCode).toBe(501);
    expect(res.json().error.code).toBe('SEDO_TEMPLATE_INVALID');
  });

  it('duplicate headers → 501 SEDO_TEMPLATE_INVALID', async () => {
    const res = await badTemplate(JSON.stringify({ ...good, headers: [...good.headers, 'Price'] }));
    expect(res.statusCode).toBe(501);
    expect(res.json().error.code).toBe('SEDO_TEMPLATE_INVALID');
  });

  it('spec placeholder values → 501 SEDO_TEMPLATE_INVALID', async () => {
    const res = await badTemplate(JSON.stringify({ ...good, values: { ...good.values, buy_now: '<exact value>' } }));
    expect(res.statusCode).toBe(501);
    expect(res.json().error.code).toBe('SEDO_TEMPLATE_INVALID');
  });

  it('Sedo rounding warning goes to X-Export-Warnings', async () => {
    const res0 = await badTemplate(JSON.stringify(good));
    expect(res0.statusCode).toBe(200);
    const { auth } = await issueToken('read');
    await listedDomain({ domain: 'cents.com', bin_cents: 39950, floor_cents: 39950, min_offer_cents: 39950 });
    const res = await app.inject({ method: 'GET', url: '/export/sedo.csv', headers: auth });
    expect(res.headers['x-export-warnings']).toBe('cents.com:SEDO_ROUNDS_DOWN');
  });
});
