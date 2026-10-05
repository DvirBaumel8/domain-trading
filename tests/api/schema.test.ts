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

describe('schema: export_uploads and job scope (migration 6)', () => {
  const seedUpload = async () => {
    await db.insertInto('export_runs').values({ marketplace: 'afternic', domains: ['a.com'], export_id: 'exp_1' }).execute();
    await db.insertInto('export_uploads').values({
      venue: 'afternic', export_id: 'exp_1', domains: ['a.com'], uploaded_at: new Date('2026-10-05T10:00:00Z'), approval_text: 'uploaded', audit_id: null,
    }).execute();
  };
  it('UPDATE, DELETE and TRUNCATE on export_uploads raise', async () => {
    await seedUpload();
    await expect(db.updateTable('export_uploads').set({ approval_text: 'x' }).execute()).rejects.toThrow(/append-only/);
    await expect(db.deleteFrom('export_uploads').execute()).rejects.toThrow(/append-only/);
    await expect(sql`TRUNCATE export_uploads`.execute(db)).rejects.toThrow(/append-only/);
  });
  it('a duplicate export_id raises', async () => {
    await seedUpload();
    await expect(db.insertInto('export_runs').values({ marketplace: 'sedo', domains: [], export_id: 'exp_1' }).execute()).rejects.toThrow(/export_runs_export_id_key/);
    await expect(db.insertInto('export_uploads').values({
      venue: 'afternic', export_id: 'exp_1', domains: [], uploaded_at: new Date(), approval_text: 'again', audit_id: null,
    }).execute()).rejects.toThrow(/export_uploads_export_id_key/);
  });
  it('audit scope job is accepted', async () => {
    await db.insertInto('audit_log').values({ id: 'aud_' + '1'.repeat(32), method: 'JOB', path: '/job/price', status_code: 200, scope: 'job' }).execute();
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

  it('cloudflare guard is case-insensitive (domains.registrar)', async () => {
    await expect(insertOwnedDomain(db, { registrar: 'Cloudflare' })).rejects.toThrow(/registrar/);
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
      poc_cap_cents: 150000,
      max_domains: 50,
      approval_max_age_hours: 72,
      lander_target: 'afternic',
      allowed_registrars: ['porkbun'],
      high_value_min_bin_cents: 250000,
      sedo_hybrid_as: 'make_offer',
    });
    for (const k of ['geo_bin_min_cents', 'geo_bin_max_cents', 'high_value_categories', 'high_value_guard_modes']) expect(rows[0]).not.toHaveProperty(k);
  });

  it('a second settings row is impossible', async () => {
    await expect(sql`INSERT INTO settings DEFAULT VALUES`.execute(db)).rejects.toThrow(/settings_pkey/);
  });

  it('cloudflare cannot be allowed in any casing', async () => {
    await expect(
      db.updateTable('settings').set({ allowed_registrars: ['porkbun', 'Cloudflare'] }).execute(),
    ).rejects.toThrow(/allowed_registrars/);
  });

  it('cloudflare cannot be allowed', async () => {
    await expect(
      db.updateTable('settings').set({ allowed_registrars: ['porkbun', 'cloudflare'] }).execute(),
    ).rejects.toThrow(/allowed_registrars/);
  });
});

describe('schema: pricing (PR-30, migration 4)', () => {
  it('PR-30: UPDATE and DELETE pricing_settings raise', async () => {
    await expect(db.updateTable('pricing_settings').set({ note: 'x' }).execute()).rejects.toThrow(/append-only/);
    await expect(db.deleteFrom('pricing_settings').execute()).rejects.toThrow(/append-only/);
  });

  it('TRUNCATE pricing_settings CASCADE raises in normal session mode', async () => {
    await expect(sql`TRUNCATE pricing_settings CASCADE`.execute(db)).rejects.toThrow(/append-only/);
  });

  it('seeds exactly one pricing_settings row: v2', async () => {
    const rows = await db.selectFrom('pricing_settings').selectAll().execute();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ version: 2, floor_bps: 6500, walkaway_min_cents: 50000 });
    expect(rows[0]!.geo_drops).toEqual([{ after_months: 12, from_cents: 49900, to_cents: 39900 }]);
    expect(rows[0]!.drops).toEqual([{ after_months: 6, pct_bps: 2000 }, { after_months: 18, pct_bps: 2000 }]);
  });

  it('price_schedule rejects a duplicate (domain_id, event, plan_id)', async () => {
    const id = await insertOwnedDomain(db);
    const row = { domain_id: id, plan_id: 'plan_1', event: 'drop1_m6' as const, due_on: '2027-04-04', settings_version: 2, status: 'planned' as const, bin_cents: 79500, floor_cents: 75000, walkaway_cents: 50000 };
    await db.insertInto('price_schedule').values(row).execute();
    await expect(db.insertInto('price_schedule').values(row).execute()).rejects.toThrow(/price_schedule_domain_id_event_plan_id_key/);
  });

  it('domains_price_order rejects walkaway > floor and floor > bin', async () => {
    await expect(insertOwnedDomain(db, { domain: 'a.com', bin_cents: 100000, floor_cents: 80000, walkaway_cents: 90000 }))
      .rejects.toThrow(/domains_price_order/);
    await expect(insertOwnedDomain(db, { domain: 'b.com', bin_cents: 100000, floor_cents: 110000 }))
      .rejects.toThrow(/domains_price_order/);
  });

  it('price_schedule_planned_shape: planned rows need prices (except delist); other statuses are free', async () => {
    const id = await insertOwnedDomain(db);
    const base = { domain_id: id, plan_id: 'p1', due_on: '2027-04-04', settings_version: 2 };
    await expect(db.insertInto('price_schedule').values({ ...base, event: 'drop1_m6', status: 'planned' }).execute())
      .rejects.toThrow(/price_schedule_planned_shape/);
    await expect(db.insertInto('price_schedule').values({ ...base, event: 'delist', status: 'planned', bin_cents: 79500, floor_cents: 75000, walkaway_cents: 50000 }).execute())
      .rejects.toThrow(/price_schedule_planned_shape/);
    await db.insertInto('price_schedule').values({ ...base, event: 'drop2_m18', status: 'skipped_at_minimum' }).execute();
    await db.insertInto('price_schedule').values({ ...base, event: 'delist', status: 'planned' }).execute();
    await db.insertInto('price_schedule').values({ ...base, event: 'drop1_m6', status: 'planned', bin_cents: 79500, floor_cents: 75000, walkaway_cents: 50000 }).execute();
  });

  it('pricing_evidence is append-only', async () => {
    const id = await insertOwnedDomain(db);
    await db.insertInto('pricing_evidence').values({ domain_id: id, comps: JSON.stringify([]), rationale: 'x' } as never).execute();
    await expect(sql`UPDATE pricing_evidence SET rationale = 'y'`.execute(db)).rejects.toThrow(/append-only/);
    await expect(sql`DELETE FROM pricing_evidence`.execute(db)).rejects.toThrow(/append-only/);
    await expect(sql`TRUNCATE pricing_evidence CASCADE`.execute(db)).rejects.toThrow(/append-only/);
  });

  it('status delisted is accepted', async () => {
    const id = await insertOwnedDomain(db, { status: 'delisted' });
    expect((await db.selectFrom('domains').select('status').where('id', '=', id).executeTakeFirstOrThrow()).status).toBe('delisted');
  });
});
