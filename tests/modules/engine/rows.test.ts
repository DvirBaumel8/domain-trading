// v5.50.0 (P6): GET /engine/rows (EN-100..) and the middle label class engine_auction_ends (EN-110.. in tests/modules/ops/engine-feed.test.ts).
import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { makeApp } from '../../helpers/app.js';
import { testDb as db } from '../../helpers/db.js';
import { FakeAdapter } from '../../helpers/fake-adapter.js';
import { issueToken } from '../../helpers/tokens.js';

let app: FastifyInstance;
afterEach(async () => app?.close());
const NOW = Date.parse('2026-10-14T09:00:00Z');
const get = (url: string, h: Record<string, string>) => app.inject({ method: 'GET', url, headers: h });

async function seed() {
  app = await makeApp({ adapters: [new FakeAdapter('porkbun')], now: () => NOW });
  const up = await db.insertInto('engine_uploads').values({ kind: 'sales', received_n: 3, accepted_n: 3, duplicate_n: 0, rejected_n: 0, rejects: '[]', by: 'gavriel', audit_id: null, created_at: new Date(NOW) }).returning('id').executeTakeFirstOrThrow();
  await db.insertInto('engine_sales').values([
    { domain: 'aaa.com', price_cents: 15_000, sale_date: '2026-09-01', venue: 'sedo', source: 'x', source_url: 'https://secret.example/1', upload_id: up.id },
    { domain: 'bbb.com', price_cents: 25_000, sale_date: '2026-09-02', venue: 'sedo', source: 'x', source_url: null, upload_id: up.id },
    { domain: 'ccc.com', price_cents: 35_000, sale_date: '2026-09-03', venue: 'sedo', source: 'x', source_url: null, upload_id: up.id },
  ]).execute();
  await db.insertInto('engine_unsold').values({ domain: 'ddd.com', type: 'dropped_after_held', observation_date: '2026-10-01', caught_by_catcher: true, upload_id: up.id }).execute();
  await db.insertInto('engine_auction_ends').values([
    { domain: 'eee.com', end_date: '2026-10-10', final_price_cents: 100, bids: 1, band: 'opening' },
    { domain: 'fff.com', end_date: '2026-10-11', final_price_cents: 4_000, bids: 5, band: 'mid' },
  ]).execute();
  return { r: (await issueToken('read')).auth, bots: (await issueToken('bots')).auth, data: (await issueToken('data')).auth };
}

describe('GET /engine/rows', () => {
  it('EN-100: sales rows come in id order with the label date, price, source, venue and upload; source_url is not returned; total counts the table', async () => {
    const { r } = await seed();
    const res = await get('/engine/rows?kind=sales', r);
    expect(res.statusCode, res.body).toBe(200);
    const b = res.json();
    expect(b).toMatchObject({ kind: 'sales', total: 3, next_after_id: null });
    expect(b.rows.map((x: { domain: string }) => x.domain)).toEqual(['aaa.com', 'bbb.com', 'ccc.com']);
    expect(b.rows[0]).toEqual({ id: expect.any(Number), domain: 'aaa.com', label_date: '2026-09-01', price_cents: 15_000, source: 'x', venue: 'sedo', upload_id: expect.any(Number) });
    expect(res.body).not.toContain('secret.example');
  });

  it('EN-101: limit and after_id page through the rows; next_after_id is the last id of a page that has a successor, null on the last page', async () => {
    const { r } = await seed();
    const p1 = (await get('/engine/rows?kind=sales&limit=2', r)).json();
    expect(p1.rows).toHaveLength(2);
    expect(p1.next_after_id).toBe(p1.rows[1].id);
    const p2 = (await get(`/engine/rows?kind=sales&limit=2&after_id=${p1.next_after_id}`, r)).json();
    expect(p2.rows.map((x: { domain: string }) => x.domain)).toEqual(['ccc.com']);
    expect(p2.next_after_id).toBeNull();
    const exact = (await get('/engine/rows?kind=sales&limit=3', r)).json();
    expect(exact.next_after_id).toBeNull();
  });

  it('EN-102: unsold rows carry type and the catcher flag, no price', async () => {
    const { r } = await seed();
    const b = (await get('/engine/rows?kind=unsold', r)).json();
    expect(b).toMatchObject({ kind: 'unsold', total: 1 });
    expect(b.rows[0]).toEqual({ id: expect.any(Number), domain: 'ddd.com', label_date: '2026-10-01', type: 'dropped_after_held', caught_by_catcher: true, upload_id: expect.any(Number) });
  });

  it('EN-103: auction_ends rows carry the last price, bids and band; a bots token reads too', async () => {
    const { bots } = await seed();
    const b = (await get('/engine/rows?kind=auction_ends', bots)).json();
    expect(b).toMatchObject({ kind: 'auction_ends', total: 2 });
    expect(b.rows.map((x: { domain: string; price_cents: number; bids: number; band: string; label_date: string }) => [x.domain, x.label_date, x.price_cents, x.bids, x.band])).toEqual([
      ['eee.com', '2026-10-10', 100, 1, 'opening'], ['fff.com', '2026-10-11', 4_000, 5, 'mid'],
    ]);
  });

  it('EN-104: a data token is 403; kind is required; an unknown kind, key or a limit outside 1..5000 is 400 VALIDATION_ERROR', async () => {
    const { r, data } = await seed();
    expect((await get('/engine/rows?kind=sales', data)).statusCode).toBe(403);
    for (const q of ['', 'kind=other', 'kind=sales&x=1', 'kind=sales&limit=0', 'kind=sales&limit=5001', 'kind=sales&after_id=-1', 'kind=sales&limit=abc']) {
      const res = await get(`/engine/rows?${q}`, r);
      expect(res.statusCode, q).toBe(400);
      expect(res.json().error.code, q).toBe('VALIDATION_ERROR');
    }
    expect((await get('/engine/rows?kind=sales&limit=5000', r)).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/engine/rows?kind=sales' })).statusCode).toBe(401);
  });

  it('EN-105: GET /engine/health data counts the middle class by band', async () => {
    const { r } = await seed();
    const d = (await get('/engine/health', r)).json().data;
    expect(d.auction_ends_n).toEqual({ opening: 1, low: 0, mid: 1, total: 2 });
    expect(d.auction_ends_newest).toBe('2026-10-11');
  });
});
