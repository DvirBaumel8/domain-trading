import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { PriceScheduleJob } from '../../src/jobs/price-schedule.js';
import { makeApp } from '../helpers/app.js';
import { insertOwnedDomain, testDb as db } from '../helpers/db.js';
import { FakeAdapter } from '../helpers/fake-adapter.js';
import { issueToken } from '../helpers/tokens.js';

let app: FastifyInstance;
afterEach(async () => app?.close());
const T1 = Date.parse('2026-10-12T09:00:00Z');
const T2 = Date.parse('2027-04-12T09:00:00Z'); // M6 is due 2027-04-12 (first listing 2026-10-12)
let clock = T1;

async function setup() {
  clock = T1;
  app = await makeApp({ adapters: [new FakeAdapter('porkbun')], now: () => clock });
  const write = (await issueToken('write')).auth;
  const read = (await issueToken('read')).auth;
  const post = (url: string, payload: object) => app.inject({ method: 'POST', url, headers: { ...write, 'idempotency-key': randomUUID() }, payload });
  const list = async (domain: string) => {
    const id = await insertOwnedDomain(db, { domain, category: 'trend', price_grade: null });
    await db.insertInto('ledger_entries').values({ occurred_on: '2026-10-04', domain_id: id, type: 'registration', amount_cents: -1108 }).execute();
    const r = await post(`/list/${domain}`, { mode: 'hybrid', bin: 1995, approval_ref: { text: `yes list ${domain}`, approved_at: new Date(clock - 3_600_000).toISOString() } });
    expect(r.statusCode, r.body).toBe(200);
  };
  const sell = async (domain: string, price: number, ref: string, venue = 'afternic') => {
    const r = await post(`/sold/${domain}`, {
      venue, sale_price: price, commission: Math.round(price * 0.15), sold_at: new Date(clock).toISOString(), transaction_ref: ref,
      approval_ref: { text: `it sold on ${venue} for ${price} (${domain})`, approved_at: new Date(clock - 30_000).toISOString() },
    });
    expect(r.statusCode, r.body).toBe(200);
  };
  const review = (q = '') => app.inject({ method: 'GET', url: `/report/pricing-review${q}`, headers: read });
  return { list, sell, review };
}

describe('GET /report/pricing-review', () => {
  it('PR-39: sales at 1995 (M0), 1295 (at the floor) and 1595 (after M6, BIN 1595): ratios, stages, at_floor; 3 sales is enough data', async () => {
    const t = await setup();
    for (const d of ['alpha-one.com', 'beta-two.com', 'gamma-three.com']) await t.list(d);
    await t.sell('alpha-one.com', 1995, 'A1');
    await t.sell('beta-two.com', 1295, 'A2', 'sedo');
    clock = T2;
    const job = await new PriceScheduleJob({ db, now: () => clock }).runOnce({ today: '2027-04-12' });
    expect(job.applied).toHaveLength(1);
    await t.sell('gamma-three.com', 1595, 'A3');
    const r = await t.review('?from=2026-10-01&to=2027-04-30');
    expect(r.statusCode, r.body).toBe(200);
    const b = r.json();
    expect(b).toMatchObject({ from: '2026-10-01', to: '2027-04-30', insufficient_data: false, settings_versions_in_use: [2] });
    expect(b.sales.map((s: { domain: string }) => s.domain)).toEqual(['alpha-one.com', 'beta-two.com', 'gamma-three.com']);
    expect(b.sales.map((s: { ratio: number }) => s.ratio)).toEqual([1, 0.65, 1]);
    expect(b.sales.map((s: { stage: string }) => s.stage)).toEqual(['M0', 'M0', 'M6']);
    expect(b.sales.map((s: { at_floor: boolean }) => s.at_floor)).toEqual([false, true, false]);
    expect(b.sales.map((s: { venue: string }) => s.venue)).toEqual(['afternic', 'sedo', 'afternic']);
    expect(b.sales[0]).toMatchObject({ gross_cents: 199500, gross: '$1,995.00', bin_at_sale_cents: 199500, days_listed: 0 });
    expect(b.sales[2]).toMatchObject({ gross_cents: 159500, bin_at_sale_cents: 159500, days_listed: 182 });
    expect(b.offers).toEqual({ count: 0, by_band: {}, median_pct_of_bin: null });
    expect(JSON.stringify(b)).not.toMatch(/walkaway|private/);
  });

  it('PR-39: with 2 sales insufficient_data is true; the window filters sales', async () => {
    const t = await setup();
    for (const d of ['alpha-one.com', 'beta-two.com']) await t.list(d);
    await t.sell('alpha-one.com', 1995, 'A1');
    await t.sell('beta-two.com', 1295, 'A2');
    const b = (await t.review('?from=2026-10-01&to=2026-10-31')).json();
    expect(b.sales).toHaveLength(2);
    expect(b.insufficient_data).toBe(true);
    const empty = (await t.review('?from=2026-11-01&to=2026-11-30')).json();
    expect(empty.sales).toEqual([]);
    expect(empty.settings_versions_in_use).toEqual([]); // versions of sales in the window only
    expect(empty.held_domains_now).toBe(0);
    expect(empty).not.toHaveProperty('held_events');
  });

  it('counts offers in the window with a median % of BIN', async () => {
    const t = await setup();
    await t.list('alpha-one.com');
    const id = (await db.selectFrom('domains').select('id').executeTakeFirstOrThrow()).id;
    const base = { domain_id: id, source: 'afternic' as const, received_at: new Date('2026-10-20T09:00:00Z'), bin_cents_at: 199500, routing: 'auto_decline' as const, outcome: 'declined_auto' as const, recorded_by: 't' };
    await db.insertInto('offers').values([
      { ...base, amount_cents: 20000, band: 'below_walkaway' }, { ...base, amount_cents: 99750, band: 'below_walkaway' }, { ...base, amount_cents: 150000, band: 'mid_range' },
    ]).execute();
    clock = Date.parse('2026-10-25T09:00:00Z');
    const b = (await t.review()).json();
    expect(b.offers).toMatchObject({ count: 3, by_band: { below_walkaway: 2, mid_range: 1 }, median_pct_of_bin: 0.5 });
  });

  it('400 on bad input', async () => {
    const t = await setup();
    for (const q of ['?from=2026-02-30', '?to=soon', '?from=2026-10-12&to=2026-10-01', '?x=1']) expect((await t.review(q)).statusCode, q).toBe(400);
  });
});
