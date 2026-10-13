// v4.0.0: CR-044 item 4: POST /patterns/sales (CSV) and GET /patterns/latest (clusters, bt1@v3 split, $1k-$5k .com by default).
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { parseSalesCsv } from '../../../src/modules/candidates/patterns.js';
import { makeApp } from '../../helpers/app.js';
import { testDb as db } from '../../helpers/db.js';
import { FakeAdapter } from '../../helpers/fake-adapter.js';
import { issueToken } from '../../helpers/tokens.js';

let app: FastifyInstance;
afterEach(async () => app?.close());
async function setup() {
  app = await makeApp({ adapters: [new FakeAdapter('porkbun')], now: () => Date.parse('2027-03-10T09:00:00Z') });
  return { w: (await issueToken('write', 'gavriel')).auth, r: (await issueToken('read')).auth };
}
const upload = (w: Record<string, string>, csv: string) =>
  app.inject({ method: 'POST', url: '/patterns/sales', headers: { ...w, 'idempotency-key': randomUUID() }, payload: { csv } });
const CSV = [
  'domain,price_usd,date,venue',
  'roofingleads.com,2500,2027-02-01,Afternic', 'plumbingquotes.com,1800,2027-02-03,Sedo', 'solarpanelhub.com,"3,200",2027-02-05,Afternic',
  'roofingapp.com,1200,2027-02-09,', 'cheapname.com,300,2027-02-10,Afternic', 'bigname.com,90000,2027-02-11,Afternic', 'roofingleads.net,2000,2027-02-12,Afternic',
].join('\n');

describe('POST /patterns/sales', () => {
  it('PT-1: stores the rows as one append-only upload', async () => {
    const { w } = await setup();
    const res = await upload(w, CSV);
    expect(res.statusCode, res.body).toBe(201);
    expect(res.json()).toMatchObject({ rows: 7 });
    expect(await db.selectFrom('sales_pattern_rows').select('id').execute()).toHaveLength(7);
    await expect(db.deleteFrom('sales_pattern_rows').execute()).rejects.toThrow();
  });

  it('PT-2: a wrong header, a bad row or no rows is 422 PATTERN_CSV_INVALID and nothing is stored', async () => {
    const { w } = await setup();
    expect((await upload(w, 'domain,price,date,venue\na.com,1,2027-01-01,x')).json().error.code).toBe('PATTERN_CSV_INVALID');
    const bad = await upload(w, 'domain,price_usd,date,venue\nok.com,1500,2027-01-01,x\nnot a domain,1500,2027-01-01,x\nb.com,abc,2027-01-01,x\nc.com,5,2027-02-30,x');
    expect(bad.statusCode).toBe(422);
    expect(bad.json().error).toMatchObject({ code: 'PATTERN_CSV_INVALID', details: { errors: [{ line: 3 }, { line: 4 }, { line: 5 }] } });
    expect((await upload(w, 'domain,price_usd,date,venue')).json().error.code).toBe('PATTERN_CSV_INVALID');
    expect((await upload(w, '')).statusCode).toBe(422);
    expect(await db.selectFrom('sales_pattern_uploads').select('id').execute()).toHaveLength(0);
  });

  it('PT-3: a READ token cannot upload', async () => {
    const { r } = await setup();
    expect((await upload(r, CSV)).statusCode).toBe(403);
  });

  it('PT-4: parseSalesCsv reads quotes, $ signs and thousands separators', () => {
    expect(parseSalesCsv('domain,price_usd,date,venue\nFoo.com,"$2,500.50",2027-01-02,"Sedo, EU"')).toEqual([{ domain: 'foo.com', price_cents: 250050, sold_on: '2027-01-02', venue: 'Sedo, EU' }]);
  });
});

describe('GET /patterns/latest', () => {
  it('PT-5: 404 NO_PATTERN_UPLOAD before the first upload', async () => {
    const { r } = await setup();
    const res = await app.inject({ method: 'GET', url: '/patterns/latest', headers: r });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('NO_PATTERN_UPLOAD');
  });

  it('PT-6: the default filter is $1k-$5k .com; clusters by word count, structure, length band and topic tokens', async () => {
    const { w, r } = await setup();
    await upload(w, CSV);
    const res = await app.inject({ method: 'GET', url: '/patterns/latest', headers: r });
    expect(res.statusCode, res.body).toBe(200);
    const b = res.json();
    expect(b).toMatchObject({ method: 'bt1@v3', filter: { min_price_cents: 100000, max_price_cents: 500000, tld: 'com' }, rows_in_upload: 7, rows_after_filter: 4 });
    expect(b.by_word_count.map((c: { value: string; n: number }) => [c.value, c.n]).sort()).toEqual(expect.arrayContaining([['2', expect.any(Number)]]));
    expect(b.by_word_count.reduce((s: number, c: { n: number }) => s + c.n, 0)).toBe(b.rows_split);
    expect(b.by_length_band.reduce((s: number, c: { n: number }) => s + c.n, 0)).toBe(4);
    const roofing = b.topic_tokens.find((t: { token: string }) => t.token === 'roofing');
    expect(roofing).toMatchObject({ n: 2 });
    expect(b.by_structure.length).toBeGreaterThan(0);
    expect(b.by_word_count[0]).toHaveProperty('median_price');
  });

  it('PT-7: the filter can be changed (min_usd, max_usd, tld); a reversed band is 422; the latest upload is the one clustered', async () => {
    const { w, r } = await setup();
    await upload(w, CSV);
    const wide = (await app.inject({ method: 'GET', url: '/patterns/latest?min_usd=1&max_usd=100000', headers: r })).json();
    expect(wide.rows_after_filter).toBe(6);
    const net = (await app.inject({ method: 'GET', url: '/patterns/latest?tld=net&min_usd=1', headers: r })).json();
    expect(net.rows_after_filter).toBe(1);
    expect((await app.inject({ method: 'GET', url: '/patterns/latest?min_usd=5000&max_usd=10', headers: r })).statusCode).toBe(422);
    await upload(w, 'domain,price_usd,date,venue\nsolo.com,1500,2027-03-01,x');
    expect((await app.inject({ method: 'GET', url: '/patterns/latest', headers: r })).json()).toMatchObject({ rows_in_upload: 1 });
  });
});
