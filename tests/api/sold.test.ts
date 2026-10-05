import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { makeApp } from '../helpers/app.js';
import { insertOwnedDomain, testDb as db } from '../helpers/db.js';
import { FakeAdapter } from '../helpers/fake-adapter.js';
import { listedDomain } from '../helpers/listing.js';
import { issueToken } from '../helpers/tokens.js';
import { withDomainLock } from '../../src/services/plan-store.js';
import { PriceScheduleJob } from '../../src/jobs/price-schedule.js';

let app: FastifyInstance;
afterEach(async () => app?.close());
const D = 'examplecityroofing.com';
const NOW = Date.parse('2026-10-12T09:00:00Z');
const SOLD_AT = '2026-10-12T11:00:00+02:00';
const approval = (domain = D) => ({ text: `it sold on afternic for 1995 (${domain})`, approved_at: new Date(NOW - 3_600_000).toISOString() });
const good = (over: Record<string, unknown> = {}) => ({
  venue: 'afternic', sale_price: 1995, commission: 299.25, sold_at: SOLD_AT, transaction_ref: 'AFN-1', approval_ref: approval(), ...over,
});

async function setup() {
  app = await makeApp({ adapters: [new FakeAdapter('porkbun')], now: () => NOW });
  return (await issueToken('write')).auth;
}
const sold = (body: object, auth: Record<string, string>, domain = D, key: string = randomUUID()) =>
  app.inject({ method: 'POST', url: `/sold/${domain}`, headers: { ...auth, 'idempotency-key': key }, payload: body });
const ledger = () => db.selectFrom('ledger_entries').select(['type', 'amount_cents', 'occurred_on', 'counterparty', 'receipt_ref', 'domain_id']).orderBy('id').execute();
const dom = (d = D) => db.selectFrom('domains').selectAll().where('domain', '=', d).executeTakeFirstOrThrow();
const withReg = async (id: number) => {
  await db.insertInto('ledger_entries').values({ occurred_on: '2026-10-04', domain_id: id, type: 'registration', amount_cents: -1108 }).execute();
};
const afternicListed = async (over: Record<string, unknown> = {}) => {
  const id = await listedDomain({ domain: D, lander: 'afternic', lander_set_at: new Date('2026-10-10T00:00:00Z'), ...over });
  await withReg(id);
  return id;
};

describe('POST /sold/{domain}', () => {
  it('S-1: ledger rows with right signs, status sold, profit', async () => {
    const auth = await setup();
    await afternicListed();
    const res = await sold(good(), auth);
    expect(res.statusCode).toBe(200);
    const b = res.json();
    expect(b).toMatchObject({
      domain: D, status: 'sold', sale: { cents: 199500 }, commission: { cents: 29925 }, fees: { cents: 0 },
      net_proceeds: { cents: 169575 }, total_costs: { cents: 31033 }, profit: { cents: 168467, display: '$1,684.67' }, warnings: [],
    });
    expect((await ledger()).map((r) => [r.type, r.amount_cents])).toEqual([['registration', -1108], ['sale', 199500], ['commission', -29925]]);
    const l = (await ledger())[1]!;
    expect(l).toMatchObject({ occurred_on: '2026-10-12', counterparty: 'afternic', receipt_ref: 'AFN-1' });
    expect(await dom()).toMatchObject({ status: 'sold' });
    expect((await dom()).sold_at!.toISOString()).toBe('2026-10-12T09:00:00.000Z');
  });

  it('fees and payout fee become rows', async () => {
    const auth = await setup();
    await afternicListed();
    const res = await sold(good({ other_fees: 5.5, payout: { amount: 1600, method: 'wire', fee: 15, received_on: null } }), auth);
    expect(res.statusCode).toBe(200);
    expect((await ledger()).map((r) => [r.type, r.amount_cents])).toEqual([
      ['registration', -1108], ['sale', 199500], ['commission', -29925], ['fee', -550], ['payout_fee', -1500]]);
    expect(res.json().fees.cents).toBe(2050);
  });

  it('S-2: wrong commission on an Afternic-NS domain warns, does not block', async () => {
    const auth = await setup();
    await afternicListed();
    const res = await sold(good({ commission: 199.5 }), auth);
    expect(res.statusCode).toBe(200);
    expect(res.json().warnings).toEqual(['COMMISSION_UNEXPECTED: expected 15% ($299.25), got $199.50']);
  });

  it('commission check: Afternic without afternic lander expects 25%; Sedo/checkout/escrow', async () => {
    const auth = await setup();
    await afternicListed({ lander: 'sedo' });
    expect((await sold(good({ commission: 498.75 }), auth)).json().warnings).toEqual([]);
  });

  it('commission check: Sedo accepts 10/15/20 within $1; checkout 5%; escrow none', async () => {
    const auth = await setup();
    const cases = [
      ['sedo', 199.5, null], ['sedo', 250, /^COMMISSION_UNEXPECTED: expected 10% \(\$199\.50\), 15% \(\$299\.25\), 20% \(\$399\.00\), got \$250\.00$/],
      ['afternic_checkout', 99.75, null], ['afternic_checkout', 300, /expected 5%/], ['escrow', 1, null], ['other', 1, null],
    ] as const;
    for (const [i, [venue, commission, warn]] of cases.entries()) {
      const d = `commissioncase${'abcdef'[i]}.com`;
      await listedDomain({ domain: d });
      const r = await sold(good({ venue, commission, approval_ref: approval(d) }), auth, d);
      expect(r.statusCode).toBe(200);
      const w = r.json().warnings as string[];
      if (warn === null) expect(w).toEqual([]); else expect(w[0]).toMatch(warn);
    }
  });

  it('S-3: second /sold → 409 NOT_SELLABLE_STATE, no new rows', async () => {
    const auth = await setup();
    await afternicListed();
    expect((await sold(good(), auth)).statusCode).toBe(200);
    const n = (await ledger()).length;
    const r = await sold(good(), auth);
    expect(r.statusCode).toBe(409);
    expect(r.json().error.code).toBe('NOT_SELLABLE_STATE');
    expect(await ledger()).toHaveLength(n);
  });

  it('S-4: missing approval_ref → 422 APPROVAL_REQUIRED', async () => {
    const auth = await setup();
    await afternicListed();
    const { approval_ref: _a, ...rest } = good();
    const r = await sold(rest, auth);
    expect(r.statusCode).toBe(422);
    expect(r.json().error.code).toBe('APPROVAL_REQUIRED');
    expect(await dom()).toMatchObject({ status: 'listed' });
  });

  it('approval that does not name the domain → 422 APPROVAL_INVALID', async () => {
    const auth = await setup();
    await afternicListed();
    const r = await sold(good({ approval_ref: { text: 'it sold', approved_at: new Date(NOW - 1000).toISOString() } }), auth);
    expect(r.statusCode).toBe(422);
    expect(r.json().error.code).toBe('APPROVAL_INVALID');
  });

  it('S-5: same key twice → one set of rows (replayed)', async () => {
    const auth = await setup();
    await afternicListed();
    const key = randomUUID();
    const a = await sold(good(), auth, D, key);
    const b = await sold(good(), auth, D, key);
    expect(b.statusCode).toBe(200);
    expect(b.json()).toEqual(a.json());
    expect(await ledger()).toHaveLength(3);
  });

  it('S-6: READ token → 403', async () => {
    await setup();
    await afternicListed();
    const { auth } = await issueToken('read');
    expect((await sold(good(), auth)).statusCode).toBe(403);
    expect(await dom()).toMatchObject({ status: 'listed' });
  });

  it('S-8: checklist has the other-marketplace line; the manual-delist line only after a confirmed upload', async () => {
    const auth = await setup();
    await afternicListed();
    const r1 = (await sold(good(), auth)).json();
    expect(r1.checklist).toEqual([
      'Remove the listing on the *other* marketplace now (double-sale risk)',
      'Do not send an auth code outside the marketplace flow',
      'Auto-renew stays off',
    ]);
    const E = 'othercityplumbing.com';
    await listedDomain({ domain: E });
    await db.insertInto('export_runs').values({ marketplace: 'afternic', domains: [E], export_id: 'e1' }).execute();
    await db.insertInto('export_uploads').values({ venue: 'afternic', export_id: 'e1', domains: [E], uploaded_at: new Date(NOW), approval_text: 'uploaded' }).execute();
    const r2 = (await sold(good({ approval_ref: approval(E) }), auth, E)).json();
    expect(r2.checklist).toHaveLength(4);
    expect(r2.checklist[3]).toMatch(/X-Manual-Delist/);
  });

  it('PR-26: sold cancels the planned schedule; the price job then changes nothing', async () => {
    const auth = await setup();
    await insertOwnedDomain(db, { domain: D, category: 'trend', price_grade: null });
    const l = await app.inject({ method: 'POST', url: `/list/${D}`, headers: { ...auth, 'idempotency-key': randomUUID() },
      payload: { mode: 'hybrid', bin: 1995, approval_ref: { text: `yes list ${D}`, approved_at: new Date(NOW - 3_600_000).toISOString() } } });
    expect(l.statusCode).toBe(200);
    const sched = () => db.selectFrom('price_schedule').select(['status', 'note']).orderBy('id').execute();
    expect((await sched()).map((s) => s.status)).toEqual(['planned', 'planned', 'planned', 'planned']);
    const histBefore = (await db.selectFrom('listing_history').selectAll().execute()).length;
    const before = await dom();
    expect((await sold(good(), auth)).statusCode).toBe(200);
    expect(await sched()).toEqual(Array(4).fill({ status: 'cancelled', note: 'sold' }));
    const r = await new PriceScheduleJob({ db, now: () => Date.parse('2027-04-12T00:30:00Z') }).runOnce({ today: '2027-04-12' });
    expect(r.applied).toEqual([]);
    expect((await db.selectFrom('listing_history').selectAll().execute()).length).toBe(histBefore);
    const after = await dom();
    expect([after.bin_cents, after.floor_cents, after.walkaway_cents]).toEqual([before.bin_cents, before.floor_cents, before.walkaway_cents]);
  });

  it('D1: delisted can be sold; dropped → 409', async () => {
    const auth = await setup();
    await afternicListed({ status: 'delisted' });
    expect((await sold(good(), auth)).statusCode).toBe(200);
    const E = 'othercityplumbing.com';
    await insertOwnedDomain(db, { domain: E, status: 'dropped' });
    const r = await sold(good({ approval_ref: approval(E) }), auth, E);
    expect(r.statusCode).toBe(409);
    expect(r.json().error.code).toBe('NOT_SELLABLE_STATE');
  });

  it('D2: delisted_at = sold_at when null (kept when set); export_pending_since unchanged', async () => {
    const auth = await setup();
    const pending = new Date('2026-10-11T00:00:00Z');
    await afternicListed({ export_pending_since: pending });
    await sold(good(), auth);
    const d = await dom();
    expect(d.delisted_at!.toISOString()).toBe(d.sold_at!.toISOString());
    expect(d.export_pending_since!.toISOString()).toBe(pending.toISOString());
    const E = 'othercityplumbing.com';
    const was = new Date('2026-10-11T12:00:00Z');
    await listedDomain({ domain: E, delisted_at: was });
    await sold(good({ approval_ref: approval(E) }), auth, E);
    expect((await dom(E)).delisted_at!.toISOString()).toBe(was.toISOString());
  });

  it('D3: offer_id of this domain → outcome sold; another domain → 422 OFFER_MISMATCH, nothing written', async () => {
    const auth = await setup();
    const id = await afternicListed();
    const E = 'othercityplumbing.com';
    const eid = await listedDomain({ domain: E });
    const offer = (domain_id: number, amount_cents: number) => db.insertInto('offers').values({
      domain_id, amount_cents, source: 'afternic', received_at: '2026-10-10T10:00:00Z', band: 'mid_range', routing: 'dvir', outcome: 'open', recorded_by: 'test',
    }).returning('id').executeTakeFirstOrThrow();
    const mine = await offer(id, 150000);
    const other = await offer(eid, 90000);
    const bad = await sold(good({ offer_id: other.id }), auth);
    expect(bad.statusCode).toBe(422);
    expect(bad.json().error.code).toBe('OFFER_MISMATCH');
    expect(await dom()).toMatchObject({ status: 'listed' });
    expect(await ledger()).toHaveLength(1);
    expect((await sold(good({ offer_id: 999999 }), auth)).json().error.code).toBe('OFFER_MISMATCH');
    expect((await sold(good({ offer_id: mine.id }), auth)).statusCode).toBe(200);
    const o = await db.selectFrom('offers').selectAll().where('id', '=', mine.id).executeTakeFirstOrThrow();
    expect(o).toMatchObject({ outcome: 'sold', outcome_note: 'via /sold' });
    expect(o.outcome_at).not.toBeNull();
    expect((await db.selectFrom('offers').select('outcome').where('id', '=', other.id).executeTakeFirstOrThrow()).outcome).toBe('open');
  });

  it('Lock: /sold waits for the per-domain lock', async () => {
    const auth = await setup();
    await afternicListed();
    let release!: () => void;
    const held = new Promise<void>((r) => { release = r; });
    let locked!: () => void;
    const lockedP = new Promise<void>((r) => { locked = r; });
    const holder = withDomainLock(db, D, async () => { locked(); await held; });
    await lockedP;
    let done = false;
    const p = sold(good(), auth).then((r) => { done = true; return r; });
    await new Promise((r) => setTimeout(r, 400));
    expect(done).toBe(false);
    expect(await dom()).toMatchObject({ status: 'listed' });
    release();
    await holder;
    expect((await p).statusCode).toBe(200);
  });

  it('validation: money, sold_at, PII, strict body', async () => {
    const auth = await setup();
    await afternicListed();
    for (const over of [
      { sale_price: 0 }, { sale_price: -5 }, { sale_price: 10.123 }, { commission: -1 }, { other_fees: -1 }, { commission: 1.005 },
      { payout: { amount: 5, method: 'wire', fee: -1 } }, { venue: 'ebay' }, { extra: 1 }, { sold_at: '2026-10-12 11:00' },
    ]) {
      const r = await sold(good(over), (await issueToken('write')).auth); // fresh token: the write rate limit is 10/min
      expect([over, r.statusCode, r.json().error.code]).toEqual([over, 422, 'VALIDATION_ERROR']);
    }
    const f = await sold(good({ sold_at: '2026-10-12T12:30:00+02:00' }), (await issueToken('write')).auth);
    expect([f.statusCode, f.json().error.code]).toEqual([422, 'SOLD_AT_IN_FUTURE']);
    const p = await sold(good({ transaction_ref: 'a@b.com' }), (await issueToken('write')).auth);
    expect([p.statusCode, p.json().error.code]).toEqual([422, 'NO_PII']);
    expect(await ledger()).toHaveLength(1);
    expect(await dom()).toMatchObject({ status: 'listed' });
  });

  it('unknown domain → 404 NOT_IN_PORTFOLIO, nothing written', async () => {
    const auth = await setup();
    await afternicListed();
    const r = await sold(good({ approval_ref: approval('nosuchdomain.com') }), auth, 'nosuchdomain.com');
    expect(r.statusCode).toBe(404);
    expect(await ledger()).toHaveLength(1);
  });

  it('ledger rows are never updated (append-only trigger)', async () => {
    const auth = await setup();
    await afternicListed();
    await sold(good(), auth);
    await expect(db.updateTable('ledger_entries').set({ amount_cents: 1 }).execute()).rejects.toThrow(/append-only|not allowed/i);
  });
});
