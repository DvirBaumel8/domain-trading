import { describe, expect, it } from 'vitest';
import { failPurchase } from '../../../src/modules/buying/bookkeeping.js';
import { RegistrarError } from '../../../src/modules/registrars/index.js';
import { Reconciler } from '../../../src/modules/buying/reconciler.js';
import { DOMAIN } from '../../helpers/buy.js';
import { testDb as db } from '../../helpers/db.js';
import { FakeAdapter } from '../../helpers/fake-adapter.js';

const NOW = Date.parse('2026-10-05T12:00:00Z');
const minutesAgo = (m: number) => new Date(NOW - m * 60_000);

async function seedPurchase(state: 'created' | 'register_sent' | 'unknown', ageMin: number, domain = DOMAIN) {
  await db.insertInto('quotes').values({
    check_id: 'chk_1', domain, registrar: 'porkbun', available: true, premium: false, first_year_cents: 1108, renewal_cents: 1108,
    privacy_cents_per_year: 0, two_year_cents: 2216, eligible: true, exclusion_reason: null, raw: null,
  }).execute();
  const { id } = await db.insertInto('purchases').values({
    idempotency_key: `k-${domain}`, request_hash: 'h', domain, state, registrar: 'porkbun', check_id: 'chk_1',
    max_price_cents: 1150, approval_text: `buy ${domain}`, approval_at: minutesAgo(ageMin + 5), expected_cents: 1108,
    request: JSON.stringify({ domain, category: 'geo', deal_id: 'D-003' }), audit_id: 'aud_' + 'a'.repeat(32),
    created_at: minutesAgo(ageMin), updated_at: minutesAgo(ageMin),
  }).returning('id').executeTakeFirstOrThrow();
  await db.insertInto('domains').values({ domain, status: 'pending_purchase', registrar: 'porkbun', category: 'geo', deal_id: 'D-003' }).execute();
  return id;
}
const rec = (pb: FakeAdapter) => new Reconciler({ db, adapters: [pb], now: () => NOW });

describe('Reconciler', () => {
  it('B-20: crash after register_sent (registrar did register) → completes rows within one run; exactly 1 ledger row', async () => {
    const pb = new FakeAdapter('porkbun', { alreadyOwned: true });
    await seedPurchase('register_sent', 5);
    expect(await rec(pb).runOnce()).toMatchObject({ booked: 1 });
    const ledger = await db.selectFrom('ledger_entries').selectAll().execute();
    expect(ledger).toHaveLength(1);
    expect(ledger[0]).toMatchObject({ amount_cents: -1108, receipt_ref: 'porkbun:ord-prior', deal_id: 'D-003' });
    expect((await db.selectFrom('purchases').selectAll().executeTakeFirstOrThrow()).state).toBe('succeeded');
    expect((await db.selectFrom('domains').selectAll().executeTakeFirstOrThrow())).toMatchObject({ status: 'owned', renewal_price_cents: 1108, drop_date: '2028-10-05' });
    await rec(pb).runOnce();
    expect(await db.selectFrom('ledger_entries').selectAll().execute()).toHaveLength(1);
  });

  it('unknown purchases are resolved the same way', async () => {
    await seedPurchase('unknown', 5);
    expect(await rec(new FakeAdapter('porkbun', { alreadyOwned: true })).runOnce()).toMatchObject({ booked: 1 });
  });

  it('younger than 2 minutes → untouched', async () => {
    await seedPurchase('register_sent', 1);
    expect(await rec(new FakeAdapter('porkbun', { alreadyOwned: true })).runOnce()).toMatchObject({ booked: 0 });
  });

  it('present but no invoice yet → untouched (never a guessed charge)', async () => {
    await seedPurchase('register_sent', 5);
    expect(await rec(new FakeAdapter('porkbun', { alreadyOwned: true, findRegistration: null })).runOnce()).toMatchObject({ booked: 0 });
    expect(await db.selectFrom('ledger_entries').selectAll().execute()).toHaveLength(0);
  });

  it('v3.9.0: absent at the registrar, even after 30 min and with RDAP unregistered → NEVER auto-failed (stays open for /report PURCHASE_UNRESOLVED + resolve-purchase)', async () => {
    await seedPurchase('unknown', 31);
    await seedPurchase('register_sent', 600, 'older.com');
    expect(await rec(new FakeAdapter('porkbun')).runOnce()).toMatchObject({ failed: 0, booked: 0 });
    expect((await db.selectFrom('purchases').select('state').orderBy('id').execute()).map((r) => r.state)).toEqual(['unknown', 'register_sent']);
    expect(await db.selectFrom('domains').selectAll().execute()).toHaveLength(2);
  });

  it('v3.9.0: booking turns auto-renew off at the registrar; a setAutoRenew error is only logged and the booking stands', async () => {
    await seedPurchase('register_sent', 5);
    const pb = new FakeAdapter('porkbun', { alreadyOwned: true });
    expect(await rec(pb).runOnce()).toMatchObject({ booked: 1 });
    expect(pb.calls.some((c) => c.startsWith('setAutoRenew'))).toBe(true);
    const warns: string[] = [];
    const pb2 = new FakeAdapter('porkbun', { alreadyOwned: true, setAutoRenew: new RegistrarError('porkbun', 'REGISTRAR_ERROR', 'nope') });
    await seedPurchase('register_sent', 5, 'second.com');
    const r = await new Reconciler({ db, adapters: [pb2], now: () => NOW, log: { warn: (_o, m) => { warns.push(m); }, error: () => {} } }).runOnce();
    expect(r).toMatchObject({ booked: 1 });
    expect(warns.some((m) => m.includes('setAutoRenew'))).toBe(true);
  });

  it('v3.9.0: a stored request with drop_policy at_first_expiry books drop_date = expiry in the booking transaction', async () => {
    const id = await seedPurchase('register_sent', 5);
    await db.updateTable('purchases').set({ request: JSON.stringify({ domain: DOMAIN, category: 'geo', deal_id: 'D-003', drop_policy: 'at_first_expiry' }) }).where('id', '=', id).execute();
    expect(await rec(new FakeAdapter('porkbun', { alreadyOwned: true })).runOnce()).toMatchObject({ booked: 1 });
    expect(await db.selectFrom('domains').selectAll().executeTakeFirstOrThrow()).toMatchObject({ status: 'owned', drop_date: '2027-10-05', expiry_date: '2027-10-05' });
  });

  it('findDomain error → untouched', async () => {
    await seedPurchase('register_sent', 40);
    expect(await rec(new FakeAdapter('porkbun', { findDomain: () => new Error('down') })).runOnce()).toMatchObject({ booked: 0, failed: 0 });
  });

  it('B13: created (never sent) older than 10 min → failed + pending row deleted; younger → untouched; never calls the registrar', async () => {
    await seedPurchase('created', 11);
    await seedPurchase('created', 2, 'fresh.com');
    const pb = new FakeAdapter('porkbun');
    expect(await rec(pb).runOnce()).toMatchObject({ abandoned: 1 });
    expect(pb.calls).toEqual([]);
    expect((await db.selectFrom('domains').select('domain').execute()).map((r) => r.domain)).toEqual(['fresh.com']);
  });

  it('fetches missing receipts for succeeded purchases', async () => {
    const id = await seedPurchase('register_sent', 5);
    await db.updateTable('purchases').set({ state: 'succeeded', order_id: 'ord-9' }).where('id', '=', id).execute();
    const pb = new FakeAdapter('porkbun');
    expect(await rec(pb).runOnce()).toMatchObject({ receipts: 1 });
    expect(pb.calls).toContain('getReceipt ord-9');
    expect(await db.selectFrom('receipts').selectAll().execute()).toHaveLength(1);
  });

  it('never registers anything', async () => {
    await seedPurchase('unknown', 40);
    const pb = new FakeAdapter('porkbun');
    await rec(pb).runOnce();
    expect(pb.calls.some((c) => c.startsWith('register'))).toBe(false);
  });

  it('overlapping runs: the second is skipped', async () => {
    await seedPurchase('register_sent', 5);
    const r = rec(new FakeAdapter('porkbun', { alreadyOwned: true }));
    const [a, b] = await Promise.all([r.runOnce(), r.runOnce()]);
    expect([a.skipped, b.skipped].sort()).toEqual([false, true]);
  });

  it('failPurchase guard: a created-purchase fail does not touch a row that moved to register_sent', async () => {
    const id = await seedPurchase('register_sent', 20);
    await failPurchase(db, id, DOMAIN, { status: 409, body: {} }, { fromStates: ['created'], updatedBefore: minutesAgo(10) });
    expect((await db.selectFrom('purchases').selectAll().executeTakeFirstOrThrow()).state).toBe('register_sent');
    expect(await db.selectFrom('domains').selectAll().execute()).toHaveLength(1);
  });

  it('failPurchase guard: a 30-min fail does not touch a row that became succeeded', async () => {
    const id = await seedPurchase('register_sent', 40);
    await db.updateTable('purchases').set({ state: 'succeeded' }).where('id', '=', id).execute();
    await failPurchase(db, id, DOMAIN, { status: 409, body: {} }, { fromStates: ['register_sent', 'unknown'] });
    expect((await db.selectFrom('purchases').selectAll().executeTakeFirstOrThrow()).state).toBe('succeeded');
    expect(await db.selectFrom('domains').selectAll().execute()).toHaveLength(1);
  });

  it('one bad row does not stop the run: the second purchase is still booked', async () => {
    const bad = await seedPurchase('register_sent', 5, 'bad.com');
    await db.updateTable('purchases').set({ request: JSON.stringify({ domain: 'bad.com', category: 'nonsense' }) }).where('id', '=', bad).execute();
    await db.insertInto('quotes').values({
      check_id: 'chk_2', domain: DOMAIN, registrar: 'porkbun', available: true, premium: false, first_year_cents: 1108, renewal_cents: 1108,
      privacy_cents_per_year: 0, two_year_cents: 2216, eligible: true, exclusion_reason: null, raw: null,
    }).execute();
    await db.insertInto('purchases').values({
      idempotency_key: 'k2', request_hash: 'h', domain: DOMAIN, state: 'register_sent', registrar: 'porkbun', check_id: 'chk_2',
      max_price_cents: 1150, approval_text: DOMAIN, approval_at: minutesAgo(10), expected_cents: 1108,
      request: JSON.stringify({ domain: DOMAIN, category: 'geo' }), audit_id: 'aud_' + 'b'.repeat(32), created_at: minutesAgo(5), updated_at: minutesAgo(5),
    }).execute();
    await db.insertInto('domains').values({ domain: DOMAIN, status: 'pending_purchase', registrar: 'porkbun', category: 'geo' }).execute();
    const errors: object[] = [];
    const r = new Reconciler({ db, adapters: [new FakeAdapter('porkbun', { alreadyOwned: true })], now: () => NOW,
      log: { warn: () => {}, error: (o) => { errors.push(o); } } });
    expect(await r.runOnce()).toMatchObject({ booked: 1 });
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ purchaseId: bad });
  });

  it('warns when a booked purchase had a proposed listing', async () => {
    const id = await seedPurchase('register_sent', 5);
    await db.updateTable('purchases').set({ request: JSON.stringify({ domain: DOMAIN, category: 'geo', proposed_listing: { mode: 'bin' } }) }).where('id', '=', id).execute();
    const warns: object[] = [];
    const r = new Reconciler({ db, adapters: [new FakeAdapter('porkbun', { alreadyOwned: true })], now: () => NOW,
      log: { warn: (o) => { warns.push(o); }, error: () => {} } });
    await r.runOnce();
    expect(warns).toContainEqual({ purchaseId: id, domain: DOMAIN });
  });
});
