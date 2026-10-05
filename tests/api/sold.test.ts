import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { buyBody, postBuy } from '../helpers/buy.js';
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
const approval = (domain = D) => ({ text: `it sold on afternic for 1995 (${domain})`, approved_at: new Date(NOW - 30_000).toISOString() });
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
      domain: D, status: 'sold', sale_price_cents: 199500, commission_cents: 29925, fees_cents: 0,
      sale_costs_cents: 29925, net_proceeds_cents: 169575, acquisition_costs_cents: 1108, acquisition_costs: '$11.08', profit_cents: 168467, profit: '$1,684.67', warnings: [],
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
    const res = await sold(good({ other_fees: 5.5, payout_fee: 15 }), auth);
    expect(res.statusCode).toBe(200);
    expect((await ledger()).map((r) => [r.type, r.amount_cents])).toEqual([
      ['registration', -1108], ['sale', 199500], ['commission', -29925], ['fee', -550], ['payout_fee', -1500]]);
    expect(res.json().fees_cents).toBe(2050);
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
      const r = await sold(good({ venue, commission, approval_ref: approval(d), transaction_ref: `REF-${i}` }), auth, d);
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
    const r = await sold(good({ transaction_ref: 'AFN-9' }), auth);
    expect(r.statusCode).toBe(409);
    expect(r.json().error.code).toBe('NOT_SELLABLE_STATE');
    expect(await ledger()).toHaveLength(n);
  });

  const noApproval = () => { const { approval_ref: _a, ...rest } = good(); return rest; };
  const ev = (over: Record<string, unknown> = {}) => ({ source: 'afternic_email', ref: '<x@mail.afternic.com>', ...over });

  it('SL-1 (supersedes S-4): no evidence → EVIDENCE_REQUIRED; evidence without transaction_ref → EVIDENCE_REQUIRED; bad source → VALIDATION_ERROR; nothing written', async () => {
    await setup();
    await afternicListed();
    const t = async (body: object) => { const r = await sold(body, (await issueToken('write')).auth); return [r.statusCode, r.json().error.code]; };
    const { transaction_ref: _t, ...noRef } = noApproval();
    expect(await t(noApproval())).toEqual([422, 'EVIDENCE_REQUIRED']);
    expect(await t({ ...noRef, evidence: ev() })).toEqual([422, 'EVIDENCE_REQUIRED']);
    expect(await t({ ...noApproval(), evidence: ev({ source: 'carrier_pigeon' }) })).toEqual([422, 'VALIDATION_ERROR']);
    expect(await t({ ...noApproval(), evidence: ev({ ref: ' ' }) })).toEqual([422, 'VALIDATION_ERROR']);
    expect(await t({ ...noApproval(), evidence: ev({ ref: `<${'a'.repeat(200)}@x.com>` }) })).toEqual([422, 'VALIDATION_ERROR']);
    expect(await dom()).toMatchObject({ status: 'listed' });
    expect(await db.selectFrom('sales').selectAll().execute()).toHaveLength(0);
    expect(await ledger()).toHaveLength(1);
  });

  it('evidence.ref: email sources need Message-ID form (jane@gmail.com → NO_PII); other sources must not contain @', async () => {
    await setup();
    await afternicListed();
    const t = async (e: object) => { const r = await sold({ ...noApproval(), evidence: e }, (await issueToken('write')).auth); return [r.statusCode, r.json().error?.code]; };
    expect(await t(ev({ ref: 'jane@gmail.com' }))).toEqual([422, 'NO_PII']);
    expect(await t(ev({ ref: '<a b@x.com>' }))).toEqual([422, 'NO_PII']);
    expect(await t({ source: 'afternic_dashboard', ref: 'order@123' })).toEqual([422, 'NO_PII']);
    expect(await t(ev({ ref: '<a1@mail.afternic.com>' }))).toEqual([200, undefined]);
  });

  it('SL-2: evidence-only sale → 200, sale.confirmed false; sales row with recorded_by = token name, evidence, sale_ledger_id, amounts', async () => {
    await setup();
    await afternicListed();
    const { auth } = await issueToken('write', 'gavriel');
    const r = await sold({ ...noApproval(), evidence: ev({ ref: '<abc123@mail.afternic.com>' }) }, auth);
    expect(r.statusCode).toBe(200);
    const sales = await db.selectFrom('sales').selectAll().execute();
    expect(sales).toHaveLength(1);
    expect(r.json().sale).toEqual({ id: sales[0]!.id, confirmed: false, recorded_by: 'gavriel', evidence_source: 'afternic_email', evidence_ref: '<abc123@mail.afternic.com>' });
    expect(r.json().profit_cents).toBe(168467);
    expect(sales[0]).toMatchObject({
      recorded_by: 'gavriel', confirmed: false, venue: 'afternic', transaction_ref: 'AFN-1', evidence_source: 'afternic_email',
      evidence_ref: '<abc123@mail.afternic.com>', approval_text: null, approval_at: null,
      sale_price_cents: 199500, commission_cents: 29925, other_fees_cents: 0, offer_id: null,
    });
    expect(sales[0]!.sold_at.toISOString()).toBe('2026-10-12T09:00:00.000Z');
    expect(sales[0]!.sale_ledger_id).toBe((await db.selectFrom('ledger_entries').select('id').where('type', '=', 'sale').executeTakeFirstOrThrow()).id);
  });

  it('SL-3: with approval (no evidence) → confirmed true, approval stored; the predates rule still applies', async () => {
    const auth = await setup();
    await afternicListed();
    const stale = await sold(good({ approval_ref: { text: `sold ${D}`, approved_at: new Date(NOW - 600_000).toISOString() } }), auth);
    expect([stale.statusCode, stale.json().error.code]).toEqual([422, 'APPROVAL_INVALID']);
    const r = await sold(good(), (await issueToken('write')).auth);
    expect(r.json().sale).toMatchObject({ confirmed: true, evidence_source: null, evidence_ref: null });
    expect(await db.selectFrom('sales').selectAll().execute()).toMatchObject([{ confirmed: true, approval_text: approval().text, evidence_source: null }]);
  });

  it('SL-4: same venue+ref with a NEW key → 409 SALE_ALREADY_RECORDED on the same domain and on another; same key → replay', async () => {
    const auth = await setup();
    await afternicListed();
    const key = randomUUID();
    const first = await sold(good(), auth, D, key);
    expect(first.statusCode).toBe(200);
    expect((await sold(good(), auth, D, key)).json()).toEqual(first.json());
    const n = (await ledger()).length;
    const same = await sold(good(), (await issueToken('write')).auth);
    expect([same.statusCode, same.json().error.code]).toEqual([409, 'SALE_ALREADY_RECORDED']);
    const E = 'othercityplumbing.com';
    await listedDomain({ domain: E });
    const r = await sold(good({ approval_ref: approval(E) }), (await issueToken('write')).auth, E);
    expect([r.statusCode, r.json().error.code]).toEqual([409, 'SALE_ALREADY_RECORDED']);
    expect(await ledger()).toHaveLength(n);
    expect(await dom(E)).toMatchObject({ status: 'listed' });
    expect(await db.selectFrom('sales').selectAll().execute()).toHaveLength(1);
    const ok = await sold(good({ venue: 'sedo', commission: 199.5, approval_ref: approval(E) }), (await issueToken('write')).auth, E);
    expect(ok.statusCode).toBe(200);
  });

  it('SL-7 (SQL): UPDATE, DELETE, TRUNCATE on sales fail; duplicate (venue, ref) fails; unconfirmed without evidence fails the CHECK', async () => {
    const auth = await setup();
    const id = await afternicListed();
    await sold(good(), auth);
    const s = await db.selectFrom('sales').selectAll().executeTakeFirstOrThrow();
    await expect(db.updateTable('sales').set({ confirmed: false }).execute()).rejects.toThrow(/append-only/i);
    await expect(db.updateTable('sales').set({ sale_price_cents: 1 }).execute()).rejects.toThrow(/append-only/i);
    await expect(db.deleteFrom('sales').execute()).rejects.toThrow(/append-only/i);
    await expect(sql`TRUNCATE sales`.execute(db)).rejects.toThrow(/append-only/i);
    const l2 = await db.insertInto('ledger_entries').values({ occurred_on: '2026-10-12', domain_id: id, type: 'sale', amount_cents: 1 }).returning('id').executeTakeFirstOrThrow();
    const { id: _i, created_at: _c, ...row } = s;
    await expect(db.insertInto('sales').values({ ...row, sale_ledger_id: l2.id }).execute()).rejects.toThrow(/sales_venue_transaction_ref_key/);
    await expect(db.insertInto('sales').values({ ...row, sale_ledger_id: l2.id, transaction_ref: 'Z1', confirmed: false, evidence_source: null, evidence_ref: null }).execute())
      .rejects.toThrow(/sales_evidence_or_approval/);
    await expect(db.insertInto('sales').values({ ...row, sale_ledger_id: l2.id, transaction_ref: 'a@b' }).execute()).rejects.toThrow(/transaction_ref/);
  });

  it('AU-10: the same WRITE token: /sold with evidence and no approval → 200 unconfirmed; /buy without approval_ref → 422, zero registrar calls', async () => {
    const pb = new FakeAdapter('porkbun');
    app = await makeApp({ adapters: [pb], now: () => NOW });
    await afternicListed();
    const { auth } = await issueToken('write');
    const r = await sold({ ...noApproval(), evidence: ev() }, auth);
    expect([r.statusCode, r.json().sale.confirmed]).toEqual([200, false]);
    const { approval_ref: _a, ...buy } = buyBody();
    const b = await postBuy(app, buy, auth);
    expect(b.statusCode).toBe(422);
    expect(pb.calls).toEqual([]);
  });

  it('offer note: unconfirmed → "system: <source> <ref>", approval text null; confirmed → "via /sold" with the approval text', async () => {
    await setup();
    const id = await afternicListed();
    const E = 'othercityplumbing.com';
    const eid = await listedDomain({ domain: E });
    const mk = async (domain_id: number) => (await db.insertInto('offers').values({
      domain_id, amount_cents: 150000, source: 'afternic', received_at: '2026-10-10T10:00:00Z', band: 'mid_range', routing: 'dvir', outcome: 'open', recorded_by: 'test',
    }).returning('id').executeTakeFirstOrThrow()).id;
    const o1 = await mk(id);
    const o2 = await mk(eid);
    const rr = await sold({ ...noApproval(), evidence: ev(), offer_id: o1 }, (await issueToken('write')).auth);
    expect(rr.statusCode).toBe(200);
    expect((await sold(good({ transaction_ref: 'AFN-2', approval_ref: approval(E), offer_id: o2 }), (await issueToken('write')).auth, E)).statusCode).toBe(200);
    const get = (i: number) => db.selectFrom('offers').select(['outcome', 'outcome_note', 'outcome_approval_text']).where('id', '=', i).executeTakeFirstOrThrow();
    expect(await get(o1)).toEqual({ outcome: 'sold', outcome_note: 'system: afternic_email <x at mail.afternic.com>', outcome_approval_text: null });
    expect(await get(o2)).toEqual({ outcome: 'sold', outcome_note: 'via /sold', outcome_approval_text: approval(E).text });
    expect((await db.selectFrom('sales').select('offer_id').orderBy('id').execute()).map((r) => r.offer_id)).toEqual([o1, o2]);
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
    await listedDomain({ domain: E, first_listed_at: new Date(NOW - 3_600_000) });
    await db.insertInto('export_runs').values({ marketplace: 'afternic', at: new Date(NOW - 1_800_000), domains: [E], export_id: 'e1' }).execute();
    await db.insertInto('export_uploads').values({ venue: 'afternic', export_id: 'e1', domains: [E], uploaded_at: new Date(NOW - 1_700_000), approval_text: 'uploaded' }).execute();
    const r2 = (await sold(good({ approval_ref: approval(E), transaction_ref: 'AFN-E' }), auth, E)).json();
    expect(r2.checklist).toHaveLength(4);
    expect(r2.checklist[3]).toBe('Remove the listing at Afternic (see X-Manual-Delist)');
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

  it('S-9 / D1: delisted can be sold; dropped → 409', async () => {
    const auth = await setup();
    await afternicListed({ status: 'delisted' });
    expect((await sold(good(), auth)).statusCode).toBe(200);
    const E = 'othercityplumbing.com';
    await insertOwnedDomain(db, { domain: E, status: 'dropped' });
    const r = await sold(good({ approval_ref: approval(E), transaction_ref: 'AFN-E' }), auth, E);
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
    await sold(good({ approval_ref: approval(E), transaction_ref: 'AFN-E' }), auth, E);
    expect((await dom(E)).delisted_at!.toISOString()).toBe(was.toISOString());
  });

  it('S-10 / S-11 / D3: offer_id of this domain → outcome sold; another domain → 422 OFFER_MISMATCH, nothing written', async () => {
    const auth = await setup();
    const id = await afternicListed();
    const E = 'othercityplumbing.com';
    const eid = await listedDomain({ domain: E });
    const offer = (domain_id: number, amount_cents: number, outcome: 'open' | 'declined_auto' | 'declined' | 'expired' | 'withdrawn' | 'sold' = 'open') => db.insertInto('offers').values({
      domain_id, amount_cents, source: 'afternic', received_at: '2026-10-10T10:00:00Z', band: 'mid_range', routing: 'dvir', outcome, recorded_by: 'test',
    }).returning('id').executeTakeFirstOrThrow();
    const mine = await offer(id, 150000);
    const other = await offer(eid, 90000);
    const bad = await sold(good({ offer_id: other.id }), auth);
    expect(bad.statusCode).toBe(422);
    expect(bad.json().error.code).toBe('OFFER_MISMATCH');
    expect(await dom()).toMatchObject({ status: 'listed' });
    expect(await ledger()).toHaveLength(1);
    expect((await sold(good({ offer_id: 999999 }), auth)).json().error.code).toBe('OFFER_MISMATCH');
    for (const outcome of ['declined_auto', 'declined', 'expired', 'withdrawn', 'sold'] as const) {
      const o = await offer(id, 100000 + Math.floor(Math.random() * 1000), outcome);
      const r = await sold(good({ offer_id: o.id }), (await issueToken('write')).auth);
      expect([outcome, r.statusCode, r.json().error.code]).toEqual([outcome, 422, 'OFFER_MISMATCH']);
      expect(await ledger()).toHaveLength(1);
      expect(await dom()).toMatchObject({ status: 'listed' });
    }
    expect((await sold(good({ offer_id: mine.id }), auth)).statusCode).toBe(200);
    const o = await db.selectFrom('offers').selectAll().where('id', '=', mine.id).executeTakeFirstOrThrow();
    expect(o).toMatchObject({ outcome: 'sold', outcome_note: 'via /sold', outcome_approval_text: approval().text });
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
    for (let n = 0; n < 200; n++) { // wait until /sold is blocked on the advisory lock
      const w = await sql<{ c: string }>`select count(*)::text as c from pg_locks where locktype = 'advisory' and not granted`.execute(db);
      if (Number(w.rows[0]!.c) > 0) break;
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(done).toBe(false);
    expect(await dom()).toMatchObject({ status: 'listed' });
    release();
    await holder;
    expect((await p).statusCode).toBe(200);
  });

  it('commission: owned never-listed domain (null lander) at Afternic expects 25%; Afternic-NS at 25% warns expected 15%', async () => {
    const auth = await setup();
    await insertOwnedDomain(db, { domain: D });
    const r = await sold(good({ commission: 299.25 }), auth);
    expect(r.json().warnings).toEqual(['COMMISSION_UNEXPECTED: expected 25% ($498.75), got $299.25']);
    const E = 'othercityplumbing.com';
    await listedDomain({ domain: E, lander: 'afternic', lander_set_at: new Date('2026-10-10T00:00:00Z') });
    const r2 = await sold(good({ commission: 498.75, approval_ref: approval(E), transaction_ref: 'AFN-E' }), auth, E);
    expect(r2.json().warnings).toEqual(['COMMISSION_UNEXPECTED: expected 15% ($299.25), got $498.75']);
  });

  it('S-8b: a domain first listed after the last confirmed file gets no manual-delist line', async () => {
    const auth = await setup();
    await listedDomain({ domain: D });
    expect((await sold(good(), auth)).json().checklist).toHaveLength(3);
    const E = 'othercityplumbing.com';
    await listedDomain({ domain: E, first_listed_at: new Date(NOW - 600_000) });
    await db.insertInto('export_runs').values({ marketplace: 'afternic', at: new Date(NOW - 1_800_000), domains: [], export_id: 'e1' }).execute();
    await db.insertInto('export_uploads').values({ venue: 'afternic', export_id: 'e1', domains: [], uploaded_at: new Date(NOW - 1_700_000), approval_text: 'uploaded' }).execute();
    expect((await sold(good({ approval_ref: approval(E), transaction_ref: 'AFN-E' }), auth, E)).json().checklist).toHaveLength(3);
  });

  it('payout_fee note is fixed text', async () => {
    const auth = await setup();
    await afternicListed();
    await sold(good({ payout_fee: 15 }), auth);
    const n = await db.selectFrom('ledger_entries').select('note').where('type', '=', 'payout_fee').executeTakeFirstOrThrow();
    expect(n.note).toBe('payout fee');
  });

  it('validation: > $10M, costs > sale, sold_at before buy_date → 422 VALIDATION_ERROR; stale approval → APPROVAL_INVALID', async () => {
    await setup();
    await afternicListed({ buy_date: '2026-10-11' });
    const t = async (over: Record<string, unknown>) => sold(good(over), (await issueToken('write')).auth);
    for (const over of [
      { sale_price: 10_000_000.01 }, { commission: 10_000_001 }, { sale_price: 100, commission: 90, other_fees: 10.01 },
      { sale_price: 100, commission: 50, other_fees: 20, payout_fee: 30.01 },
      { sold_at: '2026-10-10T11:00:00+02:00' },
    ]) {
      const r = await t(over);
      if (r.statusCode === 200) throw new Error(JSON.stringify(over));
      expect([over, r.statusCode, r.json().error.code]).toEqual([over, 422, 'VALIDATION_ERROR']);
    }
    const r = await t({ approval_ref: { text: `sold ${D}`, approved_at: '2026-10-12T08:50:00Z' } }); // sold_at 09:00Z; 10 min earlier
    expect([r.statusCode, r.json().error.code]).toEqual([422, 'APPROVAL_INVALID']);
    expect(r.json().error.message).toMatch(/predates the sale/);
    expect((await t({ sale_price: 100, commission: 50, other_fees: 20, payout_fee: 30 })).statusCode).toBe(200);
    expect(await ledger()).toHaveLength(5);
  });

  it('validation: money, sold_at, PII, strict body', async () => {
    const auth = await setup();
    await afternicListed();
    for (const over of [
      { sale_price: 0 }, { sale_price: -5 }, { sale_price: 10.123 }, { commission: -1 }, { other_fees: -1 }, { commission: 1.005 },
      { payout_fee: -1 }, { payout: { amount: 5, method: 'wire', fee: 1 } }, { venue: 'ebay' }, { extra: 1 }, { sold_at: '2026-10-12 11:00' },
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
