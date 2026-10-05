import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { makeApp } from '../helpers/app.js';
import { insertOwnedDomain, testDb as db } from '../helpers/db.js';
import { FakeAdapter } from '../helpers/fake-adapter.js';
import { listedDomain } from '../helpers/listing.js';
import { issueToken } from '../helpers/tokens.js';

let app: FastifyInstance;
afterEach(async () => app?.close());
const D = 'examplecityroofing.com';
const NOW = Date.parse('2026-10-12T09:00:00Z');
const approval = { text: `it sold on afternic for 1995 (${D})`, approved_at: new Date(NOW - 30_000).toISOString() };
const good = (over: Record<string, unknown> = {}) => ({
  venue: 'afternic', sale_price: 1995, commission: 299.25, sold_at: '2026-10-12T11:00:00+02:00', transaction_ref: 'AFN-1', approval_ref: approval,
  payout: { amount: 1680.75, method: 'wire', fee: 15, received_on: null }, ...over,
});
async function setup() {
  app = await makeApp({ adapters: [new FakeAdapter('porkbun')], now: () => NOW });
  const id = await listedDomain({ domain: D, lander: 'afternic', lander_set_at: new Date('2026-10-10T00:00:00Z') });
  await db.insertInto('ledger_entries').values({ occurred_on: '2026-10-04', domain_id: id, type: 'registration', amount_cents: -1108 }).execute();
  return (await issueToken('write')).auth;
}
const sold = (body: object, auth: Record<string, string>, key: string = randomUUID()) =>
  app.inject({ method: 'POST', url: `/sold/${D}`, headers: { ...auth, 'idempotency-key': key }, payload: body });
const payouts = () => db.selectFrom('payouts').selectAll().execute();
const ledger = () => db.selectFrom('ledger_entries').selectAll().orderBy('id').execute();

describe('payouts persisted by /sold', () => {
  it('S-12 / PO-1: payout with fee → one payouts row linked to the sale and payout_fee rows; pending; no mismatch', async () => {
    const auth = await setup();
    const r = await sold(good(), auth);
    expect(r.statusCode).toBe(200);
    const b = r.json();
    expect(b.warnings).toEqual([]);
    expect(b.payout).toMatchObject({ amount_cents: 168075, amount: '$1,680.75', fee_cents: 1500, fee: '$15.00', method: 'wire', received_on: null, status: 'pending' });
    const l = await ledger();
    const sale = l.find((x) => x.type === 'sale')!;
    const fee = l.find((x) => x.type === 'payout_fee')!;
    expect(fee.amount_cents).toBe(-1500);
    expect(l.filter((x) => Math.abs(x.amount_cents) === 168075)).toHaveLength(0); // no ledger row for the payout amount
    const p = await payouts();
    expect(p).toHaveLength(1);
    expect(p[0]).toMatchObject({ sale_ledger_id: sale.id, fee_ledger_id: fee.id, venue: 'afternic', amount_cents: 168075, fee_cents: 1500, method: 'wire', received_on: null, transaction_ref: 'AFN-1' });
    expect(p[0]!.audit_id).toBe(sale.audit_id);
  });

  it('received_on set → status received; no fee → fee_ledger_id null', async () => {
    const auth = await setup();
    const r = await sold(good({ payout: { amount: 1695.75, method: 'wire', received_on: '2026-10-12' } }), auth);
    expect(r.json().payout).toMatchObject({ status: 'received', received_on: '2026-10-12' });
    expect((await payouts())[0]).toMatchObject({ fee_ledger_id: null, fee_cents: 0, received_on: '2026-10-12' });
  });

  it('S-13 / PO-2: amount 1500 → PAYOUT_MISMATCH warning, sale still recorded', async () => {
    const auth = await setup();
    const r = await sold(good({ payout: { amount: 1500, method: 'wire', fee: 15 } }), auth);
    expect(r.statusCode).toBe(200);
    expect(r.json().warnings).toEqual(['PAYOUT_MISMATCH: expected $1,695.75 before the payout fee, got $1,500.00 + fee $15.00']);
    expect(await payouts()).toHaveLength(1);
    expect((await ledger()).some((x) => x.type === 'sale')).toBe(true);
  });

  it('no payout → no payouts row', async () => {
    const auth = await setup();
    const { payout: _p, ...rest } = good();
    const r = await sold(rest, auth);
    expect(r.statusCode).toBe(200);
    expect(r.json().payout).toBeUndefined();
    expect(await payouts()).toHaveLength(0);
  });

  it('S-15: received_on in the future or before sold_at → 422, nothing written; @ in method → NO_PII; amount 0 → 422', async () => {
    const auth = await setup();
    for (const [payout, code] of [
      [{ amount: 1695, method: 'wire', received_on: '2026-10-13' }, 'VALIDATION_ERROR'],
      [{ amount: 1695, method: 'wire', received_on: '2026-10-11' }, 'VALIDATION_ERROR'],
      [{ amount: 1695, method: 'wire', received_on: '2026-02-30' }, 'VALIDATION_ERROR'],
      [{ amount: 1695, method: 'wire a@b.com' }, 'NO_PII'],
      [{ amount: 0, method: 'wire' }, 'VALIDATION_ERROR'],
    ] as const) {
      const r = await sold(good({ payout }), (await issueToken('write')).auth);
      expect([payout, r.statusCode, r.json().error.code]).toEqual([payout, 422, code]);
    }
    expect(await payouts()).toHaveLength(0);
    expect(await ledger()).toHaveLength(1);
    expect((await db.selectFrom('domains').select('status').executeTakeFirstOrThrow()).status).toBe('listed');
  });

  it('S-14: replay (same key) → one payouts row', async () => {
    const auth = await setup();
    const key = randomUUID();
    await sold(good(), auth, key);
    expect((await sold(good(), auth, key)).statusCode).toBe(200);
    expect(await payouts()).toHaveLength(1);
  });
});

describe('schema: payouts', () => {
  async function seed() {
    const domainId = await insertOwnedDomain(db, { domain: D });
    const s = await db.insertInto('ledger_entries').values({ occurred_on: '2026-10-12', domain_id: domainId, type: 'sale', amount_cents: 100000 }).returning('id').executeTakeFirstOrThrow();
    const row = { domain_id: domainId, sale_ledger_id: s.id, venue: 'afternic', amount_cents: 90000, method: 'wire' };
    await db.insertInto('payouts').values(row).execute();
    return row;
  }
  it('PO-3: facts immutable; received_on set once; no delete/truncate; one payout per sale', async () => {
    const row = await seed();
    await expect(db.updateTable('payouts').set({ amount_cents: 1 }).execute()).rejects.toThrow(/immutable/);
    await expect(db.updateTable('payouts').set({ method: 'x' }).execute()).rejects.toThrow(/immutable/);
    await db.updateTable('payouts').set({ received_on: '2026-10-13' }).execute();
    await expect(db.updateTable('payouts').set({ received_on: '2026-10-14' }).execute()).rejects.toThrow(/set once/);
    await expect(db.updateTable('payouts').set({ received_on: null }).execute()).rejects.toThrow(/set once/);
    await expect(db.deleteFrom('payouts').execute()).rejects.toThrow(/DELETE is not allowed/);
    await expect(sql`TRUNCATE payouts`.execute(db)).rejects.toThrow();
    await expect(db.insertInto('payouts').values(row).execute()).rejects.toThrow(/duplicate|unique/i);
  });
  it('checks: amount > 0, method without @, ref without @', async () => {
    const domainId = await insertOwnedDomain(db, { domain: D });
    const s = await db.insertInto('ledger_entries').values({ occurred_on: '2026-10-12', domain_id: domainId, type: 'sale', amount_cents: 100000 }).returning('id').executeTakeFirstOrThrow();
    const base = { domain_id: domainId, sale_ledger_id: s.id, venue: 'afternic', amount_cents: 1, method: 'wire' };
    await expect(db.insertInto('payouts').values({ ...base, amount_cents: 0 }).execute()).rejects.toThrow(/amount_cents/);
    await expect(db.insertInto('payouts').values({ ...base, method: 'a@b' }).execute()).rejects.toThrow(/method/);
    await expect(db.insertInto('payouts').values({ ...base, transaction_ref: 'a@b' }).execute()).rejects.toThrow(/transaction_ref/);
  });
});
