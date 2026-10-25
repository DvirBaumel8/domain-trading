// v5.37.0: GET /auctions/live (rows come from godaddy_auctions_live, written by the datasave step; here they are inserted straight).
import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { makeApp } from '../../helpers/app.js';
import { testDb as db } from '../../helpers/db.js';
import { issueToken } from '../../helpers/tokens.js';

const NOW = Date.parse('2026-10-20T16:00:00Z');
const H = 3_600_000;
let app: FastifyInstance | undefined;
afterEach(async () => { await app?.close(); app = undefined; });

const boot = async () => {
  app = await makeApp({ testRoutes: false, now: () => NOW });
  const read = await issueToken('read');
  const bots = await issueToken('bots');
  const get = (url: string, auth = read.auth) => app!.inject({ method: 'GET', url, headers: auth });
  return { read, bots, get };
};
const row = (domain: string, hoursFromNow: number, price_cents: number, bid_count: number, extra: object = {}) =>
  ({ data_date: '2026-10-20', domain, end_time: new Date(NOW + hoursFromNow * H), price_cents, bid_count, auction_type: 'Bid', ...extra });
const seed = async () => {
  await db.insertInto('godaddy_auctions_live').values([
    row('late.com', 30, 5000, 2, { domain_age: 4, valuation_cents: 90000, pageviews: 12 }),
    row('soon.com', 2, 20000, 9),
    row('mid.com', 10, 1200, 1, { auction_type: 'Offer' }),
    row('gone.com', -3, 3000, 4),
    row('older.com', 5, 7000, 3, { data_date: '2026-10-19' }),
  ]).execute();
};
const domains = (r: { json: () => { rows: Array<{ domain: string }> } }) => r.json().rows.map((x) => x.domain);

describe('MK537 GET /auctions/live', () => {
  it('MK537-1 the default call returns the latest day, only future end times, sorted by end_time, with display prices and the band', async () => {
    const { get } = await boot();
    await seed();
    const r = await get('/auctions/live');
    expect(r.statusCode).toBe(200);
    const b = r.json();
    expect(b).toMatchObject({ data_date: '2026-10-20', total: 3, band: { max_price_cents: 25000, min_bids: 1 } });
    expect(Date.parse(b.as_of)).toBe(NOW);
    expect(domains(r)).toEqual(['soon.com', 'mid.com', 'late.com']);
    expect(b.rows[2]).toEqual({ domain: 'late.com', end_time: expect.stringMatching(/[+-]\d{2}:\d{2}$/) as unknown, auction_type: 'Bid', price_cents: 5000, price: '$50.00', bid_count: 2, domain_age: 4, valuation_cents: 90000, pageviews: 12 });
    expect(Date.parse(b.rows[2].end_time)).toBe(NOW + 30 * H);
    expect(b.rows[0]).toMatchObject({ domain_age: null, valuation_cents: null, pageviews: null });
  });

  it('MK537-2 filters: max_price, min_bids, ends_within_hours, type, sort, limit, offset, include_ended, date', async () => {
    const { get } = await boot();
    await seed();
    expect(domains(await get('/auctions/live?max_price=50'))).toEqual(['mid.com', 'late.com']);
    expect(domains(await get('/auctions/live?min_bids=2'))).toEqual(['soon.com', 'late.com']);
    expect(domains(await get('/auctions/live?ends_within_hours=12'))).toEqual(['soon.com', 'mid.com']);
    expect(domains(await get('/auctions/live?type=offer'))).toEqual(['mid.com']);
    expect(domains(await get('/auctions/live?sort=bids'))).toEqual(['soon.com', 'late.com', 'mid.com']);
    expect(domains(await get('/auctions/live?sort=price'))).toEqual(['mid.com', 'late.com', 'soon.com']);
    const page = await get('/auctions/live?limit=1&offset=1');
    expect(domains(page)).toEqual(['mid.com']);
    expect(page.json().total).toBe(3);
    const ended = await get('/auctions/live?include_ended=true');
    expect(domains(ended)).toEqual(['gone.com', 'soon.com', 'mid.com', 'late.com']);
    expect(ended.json().total).toBe(4);
    const old = await get('/auctions/live?date=2026-10-19');
    expect(old.json().data_date).toBe('2026-10-19');
    expect(domains(old)).toEqual(['older.com']);
  });

  it('MK537-3 unknown parameters and bad values are 400 VALIDATION_ERROR; an empty table answers data_date null; READ and bots tokens read, no token is rejected', async () => {
    const { get, bots } = await boot();
    for (const q of ['foo=1', 'max_price=0', 'max_price=abc', 'min_bids=-1', 'ends_within_hours=0', 'ends_within_hours=241', 'sort=name', 'limit=501', 'offset=-1', 'include_ended=yes', 'date=2026-02-30', 'date=tomorrow']) {
      const r = await get(`/auctions/live?${q}`);
      expect(r.statusCode, q).toBe(400);
      expect(r.json().error.code, q).toBe('VALIDATION_ERROR');
    }
    const empty = await get('/auctions/live');
    expect(empty.statusCode).toBe(200);
    expect(empty.json()).toMatchObject({ data_date: null, total: 0, rows: [], band: { max_price_cents: 25000, min_bids: 1 } });
    expect((await get('/auctions/live', bots.auth)).statusCode).toBe(200);
    expect((await app!.inject({ method: 'GET', url: '/auctions/live' })).statusCode).toBe(401);
  });
});
