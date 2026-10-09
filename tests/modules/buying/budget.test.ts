import { describe, expect, it } from 'vitest';
import { activeDomainCount, pendingCents, spentCents } from '../../../src/modules/buying/budget.js';
import { insertOwnedDomain, testDb as db } from '../../helpers/db.js';

const ledger = (type: string, amount_cents: number) =>
  db.insertInto('ledger_entries').values({ occurred_on: '2026-10-05', type: type as never, amount_cents, domain_id: null, deal_id: null, counterparty: null, receipt_ref: null, note: null, audit_id: null }).execute();
const purchase = (key: string, state: string, expected: number, domain: string) =>
  db.insertInto('purchases').values({
    idempotency_key: key, request_hash: 'h', domain, state: state as never, max_price_cents: 5000,
    approval_text: domain, approval_at: new Date(), expected_cents: expected,
  }).execute();

describe('budget queries', () => {
  it('spent = −Σ registration+renewal+fee only', async () => {
    expect(await spentCents(db)).toBe(0);
    await ledger('registration', -1108);
    await ledger('renewal', -999);
    await ledger('fee', -100);
    await ledger('sale', 199500);
    await ledger('commission', -29925);
    await ledger('refund', 500);
    expect(await spentCents(db)).toBe(1108 + 999 + 100);
  });
  it('pending = Σ expected_cents of created/register_sent/unknown purchases', async () => {
    await purchase('k1', 'created', 1108, 'a.com');
    await purchase('k2', 'register_sent', 999, 'b.com');
    await purchase('k3', 'unknown', 1000, 'c.com');
    await purchase('k4', 'succeeded', 5000, 'd.com');
    await purchase('k5', 'failed', 5000, 'e.com');
    expect(await pendingCents(db)).toBe(1108 + 999 + 1000);
  });
  it('active domains = owned + listed + delisted + pending_purchase', async () => {
    await insertOwnedDomain(db, { domain: 'a.com' });
    await insertOwnedDomain(db, { domain: 'b.com', status: 'listed' });
    await insertOwnedDomain(db, { domain: 'c.com', status: 'sold' });
    await insertOwnedDomain(db, { domain: 'f.com', status: 'delisted' });
    await insertOwnedDomain(db, { domain: 'd.com', status: 'dropped' });
    await insertOwnedDomain(db, {
      domain: 'e.com', status: 'pending_purchase', registrar: null, registrar_api: null, buy_date: null,
      cost_cents: null, expiry_date: null, drop_date: null, renewal_price_cents: null,
    });
    expect(await activeDomainCount(db)).toBe(4);
  });
  it('migration 2 columns exist; receipts.purchase_id is unique', async () => {
    await purchase('k1', 'succeeded', 1108, 'a.com');
    const p = await db.selectFrom('purchases').select(['id', 'expected_cents', 'request', 'audit_id']).executeTakeFirstOrThrow();
    expect(p).toMatchObject({ expected_cents: 1108, request: null, audit_id: null });
    await db.insertInto('receipts').values({ purchase_id: p.id, registrar: 'porkbun', order_id: '1' }).execute();
    await expect(db.insertInto('receipts').values({ purchase_id: p.id, registrar: 'porkbun', order_id: '1' }).execute())
      .rejects.toThrow(/receipts_one_per_purchase/);
  });
});
