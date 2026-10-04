import { sql } from 'kysely';
import { describe, expect, it } from 'vitest';
import { insertOwnedDomain, testDb as db } from '../helpers/db.js';

const ledgerRow = (domainId: number) => ({
  occurred_on: '2026-10-04',
  domain_id: domainId,
  deal_id: 'D-002',
  type: 'registration' as const,
  amount_cents: -1108,
  counterparty: 'porkbun',
  receipt_ref: 'porkbun:123',
  note: 'test',
  audit_id: null,
});

describe('schema: append-only (AL-2, B-23, LH-3)', () => {
  it('AL-2/B-23: UPDATE ledger_entries raises', async () => {
    const id = await insertOwnedDomain(db);
    await db.insertInto('ledger_entries').values(ledgerRow(id)).execute();
    await expect(db.updateTable('ledger_entries').set({ note: 'x' }).execute()).rejects.toThrow(/append-only/);
  });

  it('AL-2: DELETE ledger_entries raises', async () => {
    const id = await insertOwnedDomain(db);
    await db.insertInto('ledger_entries').values(ledgerRow(id)).execute();
    await expect(db.deleteFrom('ledger_entries').execute()).rejects.toThrow(/append-only/);
  });

  it('AL-2: UPDATE and DELETE audit_log raise', async () => {
    await db
      .insertInto('audit_log')
      .values({ id: 'aud_' + '0'.repeat(32), method: 'POST', path: '/x', status_code: 200 })
      .execute();
    await expect(db.updateTable('audit_log').set({ status_code: 500 }).execute()).rejects.toThrow(/append-only/);
    await expect(db.deleteFrom('audit_log').execute()).rejects.toThrow(/append-only/);
  });

  it('LH-3: UPDATE and DELETE listing_history raise', async () => {
    const id = await insertOwnedDomain(db);
    await db
      .insertInto('listing_history')
      .values({ domain_id: id, source: 'list', category: 'geo', mode: 'bin', bin_cents: 39900 })
      .execute();
    await expect(db.updateTable('listing_history').set({ bin_cents: 1 }).execute()).rejects.toThrow(/append-only/);
    await expect(db.deleteFrom('listing_history').execute()).rejects.toThrow(/append-only/);
  });

  it('TRUNCATE on append-only tables raises (outside the test reset)', async () => {
    await expect(sql`TRUNCATE ledger_entries`.execute(db)).rejects.toThrow(/append-only/);
    await expect(sql`TRUNCATE audit_log CASCADE`.execute(db)).rejects.toThrow(/append-only/);
  });
});

describe('schema: domains CHECKs', () => {
  it('RN-3: renewals_used = 2 fails', async () => {
    await expect(insertOwnedDomain(db, { renewals_used: 2 })).rejects.toThrow(/renewals_used/);
  });

  it('rejects an uppercase domain', async () => {
    await expect(insertOwnedDomain(db, { domain: 'Example.com' })).rejects.toThrow(/domains_domain_check/);
  });

  it('rejects min_offer below $20', async () => {
    await expect(insertOwnedDomain(db, { min_offer_cents: 1999 })).rejects.toThrow(/min_offer/);
  });

  it('drop_date must equal expiry + 1 year while renewals_used = 0', async () => {
    await expect(insertOwnedDomain(db, { drop_date: '2029-10-04' })).rejects.toThrow(/domains_drop_date_rule/);
  });

  it('29 Feb expiry → 28 Feb drop_date is accepted', async () => {
    await expect(
      insertOwnedDomain(db, { expiry_date: '2028-02-29', drop_date: '2029-02-28' }),
    ).resolves.toBeTypeOf('number');
  });

  it('an owned domain needs a category', async () => {
    await expect(insertOwnedDomain(db, { category: null })).rejects.toThrow(/domains_category_once_owned/);
  });

  it('an owned domain needs registrar, cost and dates', async () => {
    await expect(insertOwnedDomain(db, { cost_cents: null })).rejects.toThrow(/domains_owned_fields/);
  });

  it('a pending_purchase row may have no dates yet', async () => {
    await expect(
      insertOwnedDomain(db, {
        status: 'pending_purchase', registrar: null, registrar_api: null, buy_date: null,
        cost_cents: null, expiry_date: null, drop_date: null, renewal_price_cents: null,
      }),
    ).resolves.toBeTypeOf('number');
  });

  it('cloudflare is never a registrar', async () => {
    await expect(insertOwnedDomain(db, { registrar: 'cloudflare' })).rejects.toThrow(/registrar/);
  });

  it('dates come back as YYYY-MM-DD strings', async () => {
    const id = await insertOwnedDomain(db);
    const row = await db.selectFrom('domains').selectAll().where('id', '=', id).executeTakeFirstOrThrow();
    expect(row.expiry_date).toBe('2027-10-04');
    expect(typeof row.id).toBe('number');
  });
});

describe('schema: purchases', () => {
  const purchase = (key: string, state: 'created' | 'succeeded' | 'failed') => ({
    idempotency_key: key,
    request_hash: 'h',
    domain: 'examplecityroofing.com',
    state,
    max_price_cents: 1150,
    approval_text: 'yes buy examplecityroofing.com',
    approval_at: new Date(),
  });

  it('an unknown purchase also blocks a new one (D4)', async () => {
    await db.insertInto('purchases').values({ ...purchase('k1', 'failed'), state: 'unknown' }).execute();
    await expect(db.insertInto('purchases').values(purchase('k2', 'created')).execute()).rejects.toThrow(
      /purchases_one_open_per_domain/,
    );
  });

  it('only one open (created/register_sent/succeeded/unknown) purchase per domain', async () => {
    await db.insertInto('purchases').values(purchase('k1', 'created')).execute();
    await expect(db.insertInto('purchases').values(purchase('k2', 'succeeded')).execute()).rejects.toThrow(
      /purchases_one_open_per_domain/,
    );
  });

  it('failed purchases do not block a new one', async () => {
    await db.insertInto('purchases').values(purchase('k1', 'failed')).execute();
    await expect(db.insertInto('purchases').values(purchase('k2', 'created')).execute()).resolves.toBeDefined();
  });
});

describe('schema: settings', () => {
  it('has exactly one row with the spec defaults', async () => {
    const rows = await db.selectFrom('settings').selectAll().execute();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      poc_cap_cents: 50000,
      max_domains: 10,
      approval_max_age_hours: 72,
      lander_target: 'afternic',
      allowed_registrars: ['porkbun'],
      geo_bin_min_cents: 29900,
      geo_bin_max_cents: 49900,
      high_value_categories: ['trend', 'b2b', 'collision', 'regulation', 'buzzword'],
      high_value_min_bin_cents: 250000,
      high_value_guard_modes: ['bin'],
      sedo_hybrid_as: 'buy_now',
    });
  });

  it('a second settings row is impossible', async () => {
    await expect(sql`INSERT INTO settings DEFAULT VALUES`.execute(db)).rejects.toThrow(/settings_pkey/);
  });

  it('cloudflare cannot be allowed', async () => {
    await expect(
      db.updateTable('settings').set({ allowed_registrars: ['porkbun', 'cloudflare'] }).execute(),
    ).rejects.toThrow(/allowed_registrars/);
  });
});
