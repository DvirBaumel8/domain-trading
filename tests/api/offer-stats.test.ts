import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { PriceScheduleJob } from '../../src/jobs/price-schedule.js';
import { offersByStrategy, perDomainOffers, reportOffers } from '../../src/modules/selling/offer-stats.js';
import { makeApp } from '../helpers/app.js';
import { parseCsvStrict } from '../helpers/csv.js';
import { insertOwnedDomain, testDb as db } from '../helpers/db.js';
import { FakeAdapter } from '../helpers/fake-adapter.js';
import { issueToken } from '../helpers/tokens.js';

const HOUR = 3_600_000;
const apps: FastifyInstance[] = [];
afterEach(async () => { await Promise.all(apps.splice(0).map((a) => a.close())); });

const sedoTemplate = (() => {
  const path = join(mkdtempSync(join(tmpdir(), 'sedo-')), 'sedo_template.json');
  writeFileSync(path, JSON.stringify({
    headers: ['Domain Name', 'Option', 'Sale', 'Price', 'Min', 'Cur', 'Action'],
    map: { domain: 'Domain Name', selling_option: 'Option', for_sale: 'Sale', price: 'Price', min_price: 'Min', currency: 'Cur', action: 'Action' },
    values: { buy_now: 'FIXED', make_offer: 'OFFER', for_sale_yes: 'yes', usd: 'USD', action_add: 'ADD' },
  }));
  return path;
})();

let clock = 0;
async function boot(start: string) {
  clock = Date.parse(start);
  const app = await makeApp({ adapters: [new FakeAdapter('porkbun')], now: () => clock, env: { SEDO_TEMPLATE_PATH: sedoTemplate } });
  apps.push(app);
  const w = (await issueToken('write', 'gavriel')).auth;
  const r = (await issueToken('read')).auth;
  const post = (url: string, payload: object) => app.inject({ method: 'POST', url, headers: { ...w, 'idempotency-key': randomUUID() }, payload });
  const get = (url: string, auth: Record<string, string> = r) => app.inject({ method: 'GET', url, headers: auth });
  const approval = (d: string) => ({ text: `yes ${d}`, approved_at: new Date(clock - HOUR).toISOString() });
  const list = async (domain: string, body: object, dom0: Record<string, unknown> = { category: 'trend', price_grade: null }) => {
    await insertOwnedDomain(db, { domain, ...dom0 });
    const res = await post(`/list/${domain}`, { approval_ref: approval(domain), ...body });
    expect(res.statusCode, res.body).toBe(200);
  };
  const offer = async (domain: string, amount: string, receivedAt: string, source = 'afternic') => {
    const res = await post('/offers', { domain, amount_usd: amount, source, received_at: receivedAt });
    expect(res.statusCode, res.body).toBe(201);
    return res.json();
  };
  return { app, w, r, post, get, list, offer };
}
const D1 = 'promptinjectionaudit.com';
const d1Plan = { mode: 'hybrid', bin: 1995, floor: 1295, walkaway: 950, pricing_exception: true, pricing_exception_reason: 'D-001 approved plan' };
const id = async (d: string) => (await db.selectFrom('domains').select('id').where('domain', '=', d).executeTakeFirstOrThrow()).id;

describe('offer aggregates', () => {
  it('OF-18: per-domain counts, highest, pct of bin, empty domain has zeros and nulls', async () => {
    const t = await boot('2026-10-06T09:00:00Z');
    await t.list(D1, d1Plan);
    await t.list('kelvinaudit.com', { mode: 'hybrid', bin: 1995 });
    clock = Date.parse('2027-04-28T09:00:00Z');
    await t.offer(D1, '450', '2027-04-23T12:00:00+03:00');
    await t.offer(D1, '1000', '2027-03-19T12:00:00+02:00');
    await t.offer(D1, '1500', '2026-10-10T12:00:00+03:00');
    const m = await perDomainOffers(db, new Date(clock));
    expect(m.get(await id(D1))).toEqual({
      count_30d: 1, highest_30d: { cents: 45000, display: '$450.00' }, count_90d: 2, highest_90d: { cents: 100000, display: '$1,000.00' },
      count_all: 3, highest_all: { cents: 150000, display: '$1,500.00' }, highest_all_pct_of_bin: 0.7519,
      last_offer_at: '2027-04-23T12:00:00+03:00', open_for_dvir: 1,
    });
    expect(m.get(await id('kelvinaudit.com'))).toEqual({
      count_30d: 0, highest_30d: null, count_90d: 0, highest_90d: null, count_all: 0, highest_all: null,
      highest_all_pct_of_bin: null, last_offer_at: null, open_for_dvir: 0,
    });
  });

  it('IDT day boundary: 23:30 IDT on day -30 is outside 30d, 00:10 IDT on day -29 is inside', async () => {
    const t = await boot('2026-10-12T09:00:00Z');
    await t.list(D1, d1Plan);
    clock = Date.parse('2026-12-02T09:00:00Z');
    await t.offer(D1, '450', '2026-11-02T23:30:00+02:00');
    await t.offer(D1, '460', '2026-11-03T00:10:00+02:00');
    const p = (await perDomainOffers(db, new Date(clock))).get(await id(D1))!;
    expect(p.count_30d).toBe(1);
    expect(p.highest_30d?.cents).toBe(46000);
    expect(p.count_90d).toBe(2);
  });

  it('OF-18: BIN changes between offers; highest_all_pct_of_bin uses the highest offer own bin_cents_at', async () => {
    const t = await boot('2026-10-12T09:00:00Z');
    await t.list(D1, { ...d1Plan, display_name: 'PromptInjectionAudit.com' });
    clock = Date.parse('2027-04-10T09:00:00Z');
    await t.offer(D1, '1000', '2027-04-09T12:00:00+03:00'); // BIN 1995 at receipt
    clock = Date.parse('2027-04-12T00:30:00Z');
    const r = await new PriceScheduleJob({ db, now: () => clock }).runOnce({ today: '2027-04-12' });
    expect(r.applied).toHaveLength(1);
    const bin2 = (await db.selectFrom('domains').select('bin_cents').where('domain', '=', D1).executeTakeFirstOrThrow()).bin_cents!;
    expect(bin2).toBeLessThan(199500);
    clock = Date.parse('2027-04-20T09:00:00Z');
    await t.offer(D1, '900', '2027-04-19T12:00:00+03:00'); // lower amount, new BIN
    const m = await perDomainOffers(db, new Date(clock));
    expect(m.get(await id(D1))).toMatchObject({ highest_all: { cents: 100000 }, highest_all_pct_of_bin: 0.5013 });
  });

  it('offers_90d ignores offers on names no longer listed (consistent per-listed-name rate)', async () => {
    const t = await boot('2026-10-12T09:00:00Z');
    await t.list(D1, d1Plan);
    await t.list('kelvinaudit.com', { mode: 'hybrid', bin: 1995 });
    clock = Date.parse('2026-12-02T09:00:00Z');
    await t.offer(D1, '450', '2026-11-20T12:00:00+02:00');
    await t.offer('kelvinaudit.com', '450', '2026-11-20T12:00:00+02:00');
    await db.updateTable('domains').set({ status: 'delisted', delisted_at: new Date(clock) }).where('domain', '=', 'kelvinaudit.com').execute();
    const trend = (await offersByStrategy(db, new Date(clock))).find((r) => r.category === 'trend')!;
    expect(trend).toMatchObject({ names_listed: 1, names_with_offers: 1, offers_90d: 1, offers_per_listed_name_per_month: 0.33 });
    expect(trend.band_shares.below_walkaway).toBe(1);
  });

  it('OF-19: strategy rows, shares sum to 1, geo separate, group_by=source totals match', async () => {
    const t = await boot('2026-10-12T09:00:00Z');
    await t.list(D1, d1Plan);
    await t.list('kelvinaudit.com', { mode: 'hybrid', bin: 1995 });
    await t.list('examplecityroofing.com', { mode: 'bin', bin: 399 }, { category: 'geo', price_grade: 'weaker' });
    clock = Date.parse('2026-12-02T09:00:00Z');
    await t.offer(D1, '450', '2026-11-20T12:00:00+02:00', 'afternic');
    await t.offer(D1, '1000', '2026-11-21T12:00:00+02:00', 'sedo');
    await t.offer(D1, '1295', '2026-11-22T12:00:00+02:00', 'afternic');
    await t.offer('examplecityroofing.com', '350', '2026-11-23T12:00:00+02:00', 'godaddy');
    const rows = await offersByStrategy(db, new Date(clock));
    expect(rows.map((r) => [r.category, r.strategy])).toEqual([['geo', 'S2'], ['trend', 'S3']]);
    const trend = rows.find((r) => r.category === 'trend')!;
    expect(trend).toMatchObject({ names_listed: 2, names_with_offers: 1, offers_90d: 3, offers_per_listed_name_per_month: 0.5, median_offer_pct_of_bin: 0.5013, max_offer_pct_of_bin: 0.6491 });
    const sum = (r: typeof trend) => Object.values(r.band_shares).reduce((a, b) => a + b, 0);
    expect(Math.abs(sum(trend) - 1)).toBeLessThan(0.0001);
    expect(trend.band_shares).toMatchObject({ below_walkaway: 0.3334, mid_range: 0.3333, at_or_above_floor: 0.3333 });
    const geo = rows.find((r) => r.category === 'geo')!;
    expect(geo).toMatchObject({ names_listed: 1, names_with_offers: 1, offers_90d: 1, offers_per_listed_name_per_month: 0.33, median_offer_pct_of_bin: 0.8772, max_offer_pct_of_bin: 0.8772 });
    expect(geo.band_shares.geo_below_bin).toBe(1);

    const res = await t.get('/report/offers?group_by=source');
    expect(res.statusCode).toBe(200);
    const j = res.json();
    expect(j).toMatchObject({ from: '2026-09-04', to: '2026-12-02', group_by: 'source' });
    expect(j.rows.map((r: { key: string; count: number }) => [r.key, r.count])).toEqual([['afternic', 2], ['godaddy', 1], ['sedo', 1]]);
    expect(j.rows.reduce((a: number, r: { count: number }) => a + r.count, 0)).toBe(rows.reduce((a, r) => a + r.offers_90d, 0));
    expect(j.rows[0].highest).toEqual({ cents: 129500, display: '$1,295.00' });
  });

  it('GET /report/offers: default group_by=domain, month, category, ranges, bad parameters, READ scope', async () => {
    const t = await boot('2026-10-12T09:00:00Z');
    await t.list(D1, d1Plan);
    clock = Date.parse('2026-12-02T09:00:00Z');
    await t.offer(D1, '450', '2026-10-30T12:00:00+02:00');
    await t.offer(D1, '1000', '2026-11-21T12:00:00+02:00');
    const d = (await t.get('/report/offers')).json();
    expect(d.group_by).toBe('domain');
    expect(d.rows).toMatchObject([{ key: D1, count: 2, highest: { cents: 100000 } }]);
    expect((await t.get('/report/offers?group_by=month')).json().rows.map((r: { key: string; count: number }) => [r.key, r.count])).toEqual([['2026-10', 1], ['2026-11', 1]]);
    expect((await t.get('/report/offers?group_by=category')).json().rows[0]).toMatchObject({ key: 'trend', count: 2 });
    expect((await t.get('/report/offers?from=2026-11-01&to=2026-11-30')).json().rows[0].count).toBe(1);
    expect((await t.get('/report/offers?from=2026-11-21&to=2026-11-21')).json().rows[0].count).toBe(1);
    for (const q of ['from=2026-02-30', 'from=2026-13-01', 'from=2026-01-32', 'to=2026-00-10', 'to=2026-02-30', 'to=yesterday', 'group_by=nope', 'x=1', 'from=2026-12-01&to=2026-11-01']) {
      const r = await t.get(`/report/offers?${q}`);
      expect(r.statusCode, q).toBe(400);
    }
    expect((await t.get('/report/offers', {})).statusCode).toBe(401);
    expect((await reportOffers(db, { from: new Date(0), to: new Date(clock), groupBy: 'domain' })).length).toBe(1);
  });
});

describe('walk-away and min-offer guards', () => {
  it('OF-14: D-001 Afternic row, Sedo minimum, preview row; 950 appears in no export body or header', async () => {
    const t = await boot('2026-10-12T09:00:00Z');
    await t.list(D1, { ...d1Plan, display_name: 'PromptInjectionAudit.com' });
    const af = await t.get('/export/afternic.csv');
    expect(af.statusCode).toBe(200);
    expect(af.body).toContain('PromptInjectionAudit.com,1995,1295,100,N,,Custom Lander,Y,N,Y,N');
    const sedo = await t.get('/export/sedo.csv');
    expect(sedo.statusCode).toBe(200);
    expect(parseCsvStrict(sedo.body)[1]).toEqual([expect.stringMatching(/promptinjectionaudit/i), 'OFFER', 'yes', '1995', '100', 'USD', 'ADD']);
    const pv = await t.get('/pricing/preview?category=trend&bin=1995&floor=1295&walkaway=950&listed_on=2026-10-12&domain=promptinjectionaudit.com');
    expect(pv.statusCode, pv.body).toBe(200);
    expect(pv.json().afternic_row).toBeTruthy();
    expect(pv.json().afternic_row).not.toContain('950');
    for (const res of [af, sedo]) {
      expect(res.body).not.toContain('950');
      for (const [k, v] of Object.entries(res.headers)) if (k !== 'x-export-id') expect(`${k}: ${String(v)}`).not.toContain('950');
    }
  });

  it('OF-17: price job M6, M18 and final push keep min offer 100 in the domain, history and export', async () => {
    const t = await boot('2026-10-12T09:00:00Z');
    await t.list(D1, { ...d1Plan, display_name: 'PromptInjectionAudit.com' });
    const job = new PriceScheduleJob({ db, now: () => clock });
    for (const today of ['2027-04-12', '2028-04-12', '2028-07-06']) {
      clock = Date.parse(`${today}T00:30:00Z`);
      const before = (await db.selectFrom('listing_history').select('id').where('source', '=', 'schedule').execute()).length;
      const r = await job.runOnce({ today });
      expect(r.applied, today).toHaveLength(1);
      const d = await db.selectFrom('domains').selectAll().where('domain', '=', D1).executeTakeFirstOrThrow();
      expect(d.min_offer_cents, today).toBe(10000);
      const h = await db.selectFrom('listing_history').selectAll().where('source', '=', 'schedule').orderBy('id').execute();
      expect(h).toHaveLength(before + 1);
      expect(h.at(-1)!.min_offer_cents, today).toBe(10000);
      const row = parseCsvStrict((await t.get('/export/afternic.csv')).body)[1]!;
      expect(row[3], today).toBe('100');
      expect(row[1]).toBe(String(d.bin_cents! / 100));
    }
  });

  it('OF-17: geo strong M12 sets the min offer to the new BIN (39900)', async () => {
    const t = await boot('2026-10-12T09:00:00Z');
    await t.list('examplecityroofing.com', { mode: 'bin', bin: 499 }, { category: 'geo', price_grade: 'strong' });
    expect((await db.selectFrom('domains').select('min_offer_cents').executeTakeFirstOrThrow()).min_offer_cents).toBe(49900);
    clock = Date.parse('2027-10-12T00:30:00Z');
    const r = await new PriceScheduleJob({ db, now: () => clock }).runOnce({ today: '2027-10-12' });
    expect(r.applied).toHaveLength(1);
    const d = await db.selectFrom('domains').selectAll().executeTakeFirstOrThrow();
    expect([d.bin_cents, d.min_offer_cents]).toEqual([39900, 39900]);
    const h = await db.selectFrom('listing_history').selectAll().where('source', '=', 'schedule').executeTakeFirstOrThrow();
    expect(h.min_offer_cents).toBe(39900);
    const row = parseCsvStrict((await t.get('/export/afternic.csv')).body)[1]!;
    expect([row[1], row[3]]).toEqual(['399', '399']);
  });
});
