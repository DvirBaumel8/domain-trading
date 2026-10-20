// v5.25.0 (CR-070): POST /ledger/costs, PUT /portfolio/{domain}/forward-costs, GET /costs/forward, GET /books.csv. IDs BK525-1..BK525-14.
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { makeApp } from '../../helpers/app.js';
import { insertOwnedDomain, testDb as db } from '../../helpers/db.js';
import { FakeAdapter } from '../../helpers/fake-adapter.js';
import { V3 } from '../../helpers/pricing.js';
import { issueToken } from '../../helpers/tokens.js';
import { priceFormula } from '../../../src/modules/listing/pricing/plan.js';

let app: FastifyInstance;
afterEach(async () => app?.close());
let clock = Date.parse('2026-10-21T09:00:00Z');

type H = Record<string, string>;
const call = (method: 'GET' | 'POST' | 'PUT', url: string, h: H, payload?: unknown) => {
  clock += 10_000; // stay under the general write limit
  return app.inject({ method, url, headers: { ...h, ...(method !== 'GET' ? { 'idempotency-key': randomUUID() } : {}) }, ...(payload !== undefined ? { payload: payload as object } : {}) });
};
async function setup() {
  clock = Date.parse('2026-10-21T09:00:00Z');
  app = await makeApp({ adapters: [new FakeAdapter('porkbun')], now: () => clock });
  return { bots: (await issueToken('bots', 'bots-shared')).auth, write: (await issueToken('write', 'gavriel')).auth, read: (await issueToken('read', 'reader')).auth };
}
const cost = (o: object = {}) => ({ date: '2026-10-20', type: 'ai', amount_usd: '-1.20', note: 'cost-log', ...o });
const ledger = async (h: H, q = '') => (await call('GET', `/ledger${q}`, h)).json();
const mine = (extra: object = {}) => insertOwnedDomain(db, { domain: 'mineunited.com', display_name: 'MineUnited.com', category: 'other', lane: 'S8', status: 'listed', listing_mode: 'hybrid', bin_cents: 148800, floor_cents: 96700, walkaway_cents: 71500, min_offer_cents: 10000, price_grade: 'weaker', ...extra });

describe('CR-070 ledger costs, forward costs, books', () => {
  it('BK525-1 (AT-1) POST /ledger/costs dry_run answers 200 with counts and stores nothing; without dry_run it answers 201 and GET /ledger?type=ai shows the row', async () => {
    const { bots } = await setup();
    const dry = await call('POST', '/ledger/costs', bots, { rows: [cost()], dry_run: true });
    expect(dry.statusCode).toBe(200);
    expect(dry.json()).toMatchObject({ dry_run: true, received_n: 1, accepted_n: 1, rejected_n: 0, total_cents: -120 });
    expect((await ledger(bots, '?type=ai')).count).toBe(0);
    const real = await call('POST', '/ledger/costs', bots, { rows: [cost(), cost({ type: 'tool', amount_usd: '-5', note: 'hosting' })] });
    expect(real.statusCode).toBe(201);
    expect(real.json()).toMatchObject({ dry_run: false, accepted_n: 2, total_cents: -620 });
    const ai = await ledger(bots, '?type=ai');
    expect(ai.count).toBe(1);
    expect(ai.rows[0]).toMatchObject({ date: '2026-10-20', type: 'ai', amount_cents: -120, amount_usd: '-1.20', note: 'cost-log' });
    expect((await ledger(bots, '?type=tool')).count).toBe(1);
    const audit = await db.selectFrom('audit_log').select('path').where('path', '=', '/ledger/costs').execute();
    expect(audit.length).toBe(2);
  });

  it('BK525-2 (AT-2) a registration, renewal, sale, commission or refund row is 422 VALIDATION_ERROR and nothing is stored (also a bad amount, date or an unknown domain)', async () => {
    const { bots } = await setup();
    for (const type of ['registration', 'renewal', 'sale', 'commission', 'refund', 'fee', 'payout_fee']) {
      const r = await call('POST', '/ledger/costs', bots, { rows: [cost(), cost({ type })] });
      expect(r.statusCode, type).toBe(422);
      expect(r.json().error.code, type).toBe('VALIDATION_ERROR');
    }
    for (const bad of [cost({ amount_usd: '-1.234' }), cost({ amount_usd: '0' }), cost({ amount_usd: 1.2 }), cost({ date: '2026-02-30' }), cost({ note: 'x'.repeat(201) }), cost({ domain: 'nobody.com' }), cost({ extra: 1 })]) {
      const r = await call('POST', '/ledger/costs', bots, { rows: [bad] });
      expect(r.statusCode).toBe(422);
      expect(r.json().error.code).toBe('VALIDATION_ERROR');
    }
    expect((await ledger(bots)).count).toBe(0);
  });

  it('BK525-3 (AT-3) PUT forward-costs with a derived field (top level or in a line) is 422 DERIVED_FIELD and stores nothing; an unknown domain is 404', async () => {
    const { bots } = await setup();
    await mine();
    const line = { month: '2027-10', item: 'renewal', planned_usd: '11.08', basis: 'porkbun list', cost_type: 'renewal' };
    for (const body of [{ walkaway: '715', lines: [line] }, { floor: 967, lines: [] }, { lines: [{ ...line, walkaway_cents: 71500 }] }, { lines: [{ ...line, renewal_due: '2027-10-04' }] }, { forward_total: '10', lines: [] }, { lines: [{ ...line, min_offer: '100' }] }]) {
      const r = await call('PUT', '/portfolio/mineunited.com/forward-costs', bots, body);
      expect(r.statusCode, JSON.stringify(body)).toBe(422);
      expect(r.json().error.code, JSON.stringify(body)).toBe('DERIVED_FIELD');
    }
    expect((await db.selectFrom('forward_cost_plans').selectAll().execute())).toHaveLength(0);
    const unk = await call('PUT', '/portfolio/nobody.com/forward-costs', bots, { lines: [line] });
    expect(unk.statusCode).toBe(404);
    expect(unk.json().error.code).toBe('DOMAIN_NOT_FOUND');
    const generic = await call('PUT', '/portfolio/mineunited.com/forward-costs', bots, { lines: [{ ...line, surprise: 1 }] });
    expect(generic.statusCode).toBe(422);
    expect(generic.json().error.code).toBe('VALIDATION_ERROR');
  });

  it('BK525-4 (AT-4) the existing formula: BIN 148800 gives walk-away 71500 and floor 96700 (mineunited.com), BIN 90000 gives walk-away 50000; GET /portfolio and /books.csv carry the same walk-away', async () => {
    expect(priceFormula(148800, V3)).toMatchObject({ walkawayCents: 71500, floorCents: 96700 });
    expect(priceFormula(90000, V3).walkawayCents).toBe(50000);
    const { read } = await setup();
    await mine();
    const p = (await call('GET', '/portfolio/mineunited.com', read)).json();
    expect(p).toMatchObject({ walkaway_cents: 71500, floor_cents: 96700 });
    const csv = (await call('GET', '/books.csv', read)).body.split('\r\n');
    const head = csv[0]!.split(',');
    const row = csv[1]!.split(',');
    expect(row[head.indexOf('walkaway_usd')]).toBe('715.00');
  });

  it('BK525-5 (AT-5) GET /costs/forward: a name that drops at its first expiry counts 0 renewal, the planned lines appear with their basis, a renewing name counts its renewal price', async () => {
    const { bots, read } = await setup();
    await insertOwnedDomain(db, { domain: 'dtwo.com', expiry_date: '2027-10-04', drop_date: '2027-10-04', renewal_price_cents: 1108 });
    await insertOwnedDomain(db, { domain: 'dthree.com', expiry_date: '2027-10-09', drop_date: '2028-10-09', renewal_price_cents: 1500 });
    const put = await call('PUT', '/portfolio/dtwo.com/forward-costs', bots, { lines: [{ month: '2027-10', item: 'lander hosting', planned_usd: '3.50', basis: 'plan sheet row 4', cost_type: 'tool' }] });
    expect(put.statusCode).toBe(200);
    const r = (await call('GET', '/costs/forward?from=2027-10&to=2027-10', read)).json();
    expect(r.months).toHaveLength(1);
    const m = r.months[0];
    expect(m.planned).toEqual([expect.objectContaining({ domain: 'dtwo.com', item: 'lander hosting', planned_cents: 350, planned: '$3.50', basis: 'plan sheet row 4', cost_type: 'tool' })]);
    const d2 = m.renewals.find((x: { domain: string }) => x.domain === 'dtwo.com');
    expect(d2).toMatchObject({ renewal_cents: 0, counted: false, reason: 'DROPS_AT_FIRST_EXPIRY' });
    expect(m.renewals.find((x: { domain: string }) => x.domain === 'dthree.com')).toMatchObject({ renewal_cents: 1500, counted: true });
    expect(m).toMatchObject({ planned_total_cents: 350, renewals_total_cents: 1500, total_cents: 1850, incomplete: false });
    expect(r.totals).toMatchObject({ total_cents: 1850, total: '$18.50', incomplete: false });
    expect(r.warnings).toEqual([]);
  });

  it('BK525-6 (AT-6) a name with no renewal price is renewal null with warning RENEWAL_PRICE_UNKNOWN and the totals are incomplete: true, never summed as 0', async () => {
    const { read } = await setup();
    await insertOwnedDomain(db, { domain: 'noprice.com', expiry_date: '2027-03-15', drop_date: '2028-03-15', renewal_price_cents: null });
    await insertOwnedDomain(db, { domain: 'haspric.com', expiry_date: '2027-03-20', drop_date: '2028-03-20', renewal_price_cents: 1200 });
    const r = (await call('GET', '/costs/forward?from=2027-03&to=2027-04', read)).json();
    const m = r.months[0];
    expect(m.renewals.find((x: { domain: string }) => x.domain === 'noprice.com')).toMatchObject({ renewal: null, renewal_cents: null, counted: false });
    expect(m).toMatchObject({ renewals_total_cents: 1200, incomplete: true });
    expect(r.months[1]).toMatchObject({ incomplete: false, total_cents: 0 });
    expect(r.warnings).toEqual([expect.objectContaining({ code: 'RENEWAL_PRICE_UNKNOWN', domain: 'noprice.com', month: '2027-03' })]);
    expect(r.totals).toMatchObject({ total_cents: 1200, incomplete: true });
    // a bare call defaults to 12 months from the current month and answers
    const bare = await call('GET', '/costs/forward', read);
    expect(bare.statusCode).toBe(200);
    expect(bare.json()).toMatchObject({ from: '2026-10', to: '2027-09' });
    expect((await call('GET', '/costs/forward?from=2027-05&to=2027-01', read)).statusCode).toBe(400);
  });

  it('BK525-7 (AT-7) GET /books.csv has one row per live name, the documented header, and values equal to GET /portfolio (sold and dropped names are left out)', async () => {
    const { read, bots } = await setup();
    await mine();
    await insertOwnedDomain(db, { domain: 'plainone.com', category: 'other', status: 'owned', renewal_price_cents: null });
    await insertOwnedDomain(db, { domain: 'soldone.com', status: 'sold', sold_at: new Date('2026-10-10T00:00:00Z') });
    await insertOwnedDomain(db, { domain: 'gonedrop.com', status: 'dropped' });
    await call('POST', '/ledger/costs', bots, { rows: [cost({ domain: 'plainone.com', type: 'tool' })] });
    const res = await call('GET', '/books.csv', read);
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/csv');
    const lines = res.body.trimEnd().split('\r\n');
    expect(lines[0]).toBe('domain,display_name,line,category,status,buy_date,cost_usd,expiry_date,renewal_price_usd,renewal_price_source,drop_date,bin_usd,floor_usd,walkaway_usd,min_offer_usd,next_event,next_event_date,listed_venues,observed_venues');
    expect(lines).toHaveLength(3);
    const head = lines[0]!.split(',');
    const portfolio = (await call('GET', '/portfolio', read)).json().domains as Record<string, unknown>[];
    for (const line of lines.slice(1)) {
      const c = line.split(',');
      const get = (k: string) => c[head.indexOf(k)]!;
      const p = portfolio.find((x) => x.domain === get('domain'))!;
      const usd = (cents: unknown) => (cents === null ? '' : (Number(cents) / 100).toFixed(2));
      expect(['owned', 'listed', 'delisted']).toContain(p.status);
      expect(get('status')).toBe(p.status);
      expect(get('line')).toBe(String(p.line));
      expect(get('category')).toBe(p.category);
      expect(get('cost_usd')).toBe(usd(p.cost_cents));
      expect(get('expiry_date')).toBe(p.expiry_date);
      expect(get('drop_date')).toBe(p.drop_date);
      expect(get('renewal_price_usd')).toBe(usd(p.renewal_price_cents));
      for (const k of ['bin', 'floor', 'walkaway', 'min_offer']) expect(get(`${k}_usd`), k).toBe(usd(p[`${k}_cents`]));
    }
    expect(lines.slice(1).map((l) => l.split(',')[0])).toEqual(['mineunited.com', 'plainone.com']);
  });

  it('BK525-8 a READ token cannot POST /ledger/costs or PUT forward-costs (403); a bots token and a WRITE token can; books.csv needs a token', async () => {
    const { bots, write, read } = await setup();
    await mine();
    const line = { month: '2027-10', item: 'x', planned_usd: '1', basis: 'b', cost_type: 't' };
    const r1 = await call('POST', '/ledger/costs', read, { rows: [cost()] });
    expect(r1.statusCode).toBe(403);
    expect(r1.json().error.code).toBe('SCOPE_FORBIDDEN');
    expect((await call('PUT', '/portfolio/mineunited.com/forward-costs', read, { lines: [line] })).statusCode).toBe(403);
    expect((await call('POST', '/ledger/costs', bots, { rows: [cost()] })).statusCode).toBe(201);
    expect((await call('POST', '/ledger/costs', write, { rows: [cost()] })).statusCode).toBe(201);
    expect((await call('PUT', '/portfolio/mineunited.com/forward-costs', bots, { lines: [line] })).statusCode).toBe(200);
    expect((await call('GET', '/books.csv', bots)).statusCode).toBe(200);
    expect((await call('GET', '/books.csv', {})).statusCode).toBe(401);
  });

  it('BK525-9 a correction is a reversing row: the wrong row stays, a +1.20 row cancels it, the ledger cannot be updated or deleted', async () => {
    const { bots } = await setup();
    await call('POST', '/ledger/costs', bots, { rows: [cost({ amount_usd: '-1.20' })] });
    await call('POST', '/ledger/costs', bots, { rows: [cost({ amount_usd: '1.20', note: 'reverses cost-log' })] });
    const l = await ledger(bots, '?type=ai');
    expect(l.count).toBe(2);
    expect(l.rows.reduce((s: number, r: { amount_cents: number }) => s + r.amount_cents, 0)).toBe(0);
    await expect(db.updateTable('ledger_entries').set({ amount_cents: -999 }).execute()).rejects.toThrow(/append-only|not allowed/i);
    await expect(db.deleteFrom('ledger_entries').execute()).rejects.toThrow(/append-only|not allowed/i);
  });

  it('BK525-10 PUT forward-costs replaces the planned set of the name and keeps the old plan as history; an empty set clears the plan; the tables are append-only', async () => {
    const { bots, read } = await setup();
    await mine();
    const l = (month: string, item: string, usd: string) => ({ month, item, planned_usd: usd, basis: 'sheet', cost_type: 'tool' });
    const a = await call('PUT', '/portfolio/mineunited.com/forward-costs', bots, { lines: [l('2027-01', 'a', '1.00'), l('2027-02', 'b', '2.00')] });
    expect(a.json()).toMatchObject({ domain: 'mineunited.com', version: 1, previous_version: null, lines_n: 2, planned_total_cents: 300 });
    const b = await call('PUT', '/portfolio/mineunited.com/forward-costs', bots, { lines: [l('2027-01', 'c', '5.00')] });
    expect(b.json()).toMatchObject({ version: 2, previous_version: 1, lines_n: 1 });
    const fwd = (await call('GET', '/costs/forward?from=2027-01&to=2027-02', read)).json();
    expect(fwd.months[0].planned.map((x: { item: string }) => x.item)).toEqual(['c']);
    expect(fwd.months[1].planned).toEqual([]);
    const hist = (await call('GET', '/portfolio/mineunited.com/forward-costs', read)).json();
    expect(hist.current.version).toBe(2);
    expect(hist.versions.map((v: { version: number; lines: unknown[] }) => [v.version, v.lines.length])).toEqual([[2, 1], [1, 2]]);
    const c = await call('PUT', '/portfolio/mineunited.com/forward-costs', bots, { lines: [] });
    expect(c.json()).toMatchObject({ version: 3, lines_n: 0 });
    expect((await call('GET', '/costs/forward?from=2027-01&to=2027-02', read)).json().totals.total_cents).toBe(0);
    expect((await db.selectFrom('forward_cost_lines').selectAll().execute())).toHaveLength(3);
    await expect(db.deleteFrom('forward_cost_lines').execute()).rejects.toThrow(/append-only|not allowed/i);
    await expect(db.updateTable('forward_cost_plans').set({ line_count: 9 }).execute()).rejects.toThrow(/append-only|not allowed/i);
  });

  it('BK525-11 GET /books.csv prefixes a formula-looking display name and renewal source with an apostrophe (v5.16.0 csvSafeText)', async () => {
    const { read } = await setup();
    await insertOwnedDomain(db, { domain: 'evil-one.com', display_name: '=HYPERLINK("http://x","y")', status: 'listed', renewal_price_source: '@porkbun' });
    const r = await call('GET', '/books.csv', read);
    expect(r.body).toContain(`"'=HYPERLINK(""http://x"",""y"")"`);
    expect(r.body).toContain(",'@porkbun,");
  });

  it('BK525-12 /export/afternic.csv and /export/sedo.csv still carry no walk-away while /books.csv does', async () => {
    const { read } = await setup();
    await mine();
    const af = await call('GET', '/export/afternic.csv', read);
    expect(af.statusCode).toBe(200);
    expect(af.body.toLowerCase()).not.toContain('walk');
    expect(af.body).not.toContain('715');
    const sedo = await call('GET', '/export/sedo.csv', read);
    expect(sedo.body.toLowerCase()).not.toContain('walk');
    expect((await call('GET', '/books.csv', read)).body).toContain('715.00');
  });

  it('BK525-13 a planned line needs a real month, a USD string and bounded text; a bad line stores nothing', async () => {
    const { bots } = await setup();
    await mine();
    const ok = { month: '2027-10', item: 'x', planned_usd: '1', basis: 'b', cost_type: 't' };
    for (const bad of [{ ...ok, month: '2027-13' }, { ...ok, planned_usd: 'abc' }, { ...ok, planned_usd: 1 }, { ...ok, item: '' }, { ...ok, basis: undefined }]) {
      const r = await call('PUT', '/portfolio/mineunited.com/forward-costs', bots, { lines: [ok, bad] });
      expect(r.statusCode).toBe(422);
      expect(r.json().error.code).toBe('VALIDATION_ERROR');
    }
    expect((await db.selectFrom('forward_cost_plans').selectAll().execute())).toHaveLength(0);
  });
});
