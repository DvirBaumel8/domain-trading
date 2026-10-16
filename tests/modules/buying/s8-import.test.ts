// v5.8.0 (CR-059): the S8 (Line 2) aftermarket import lane. POST /portfolio/import, the S8 slot reservation on /buy, the BIN rung from the comps value, /report lines.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import type { RdapFn } from '../../../src/core/rdap.js';
import { makeApp } from '../../helpers/app.js';
import { DOMAIN, T0, buyBody, postBuy, readyToBuy } from '../../helpers/buy.js';
import { insertOwnedDomain, testDb as db } from '../../helpers/db.js';
import { FakeAdapter } from '../../helpers/fake-adapter.js';
import { V3_SET } from '../../helpers/pricing.js';
import { newPricingSettings } from '../../../src/modules/ops/admin/pricing-settings.js';
import { issueToken } from '../../helpers/tokens.js';

let app: FastifyInstance;
let auth: Record<string, string>;
afterEach(async () => app?.close());
const rdapFree: RdapFn = async () => 'not_registered';
const D = 'aftermarketwidget.com';

const useV3 = () =>
  // production's current pricing settings: v3 with comps_min 0 (comps optional)
  newPricingSettings(db, { set: { ...V3_SET, comps_min: '0' }, approvalText: 'Dvir 7 Oct 2026: pricing v3, comps optional', approvalAt: new Date(T0 - 3_600_000).toISOString(), now: new Date(T0 - 60_000) });

async function boot(adapters: FakeAdapter[] = [new FakeAdapter('porkbun')], at = T0) {
  app = await makeApp({ adapters, rdap: rdapFree, now: () => at });
  auth = (await issueToken('write')).auth;
}

beforeEach(async () => {
  await useV3();
  await boot();
});

const approval = (domain = D) => ({ text: `yes import ${domain} on S8, closeout from GoDaddy`, approved_at: new Date(T0 - 3_600_000).toISOString() });
const body = (over: Record<string, unknown> = {}) => ({
  domain: D, approval_ref: approval((over.domain as string | undefined) ?? D), lane: 'S8', registrar: 'dynadot', source: 'closeout', price_paid: 12.5,
  buy_date: '2026-10-05', expiry_date: '2027-10-05', category: 'trend', comps_value: 1200, ...over,
});
// a fresh WRITE token per call: the per-token rate limit is not what these tests are about
const post = async (b: unknown, key: string = randomUUID(), headers?: Record<string, string>) =>
  app.inject({ method: 'POST', url: '/portfolio/import', headers: { ...(headers ?? (await issueToken('write')).auth), 'idempotency-key': key }, payload: b as object });
const count = async (t: 'domains' | 'ledger_entries' | 'pricing_evidence' | 'listing_history' | 'price_schedule') => (await db.selectFrom(t).selectAll().execute()).length;
const dom = (d = D) => db.selectFrom('domains').selectAll().where('domain', '=', d).executeTakeFirstOrThrow();
const seedLine = async (n: number, lane: 'S8' | null, prefix: string) => {
  for (let i = 0; i < n; i++) await insertOwnedDomain(db, { domain: `${prefix}${i}.com`, lane });
};

describe('S8 import lane (CR-059)', () => {
  it('S8-1: an import without a valid approval_ref is refused and writes nothing', async () => {
    const none = await post(body({ approval_ref: undefined }));
    expect(none.statusCode, none.body).toBe(422);
    expect(none.json().error.code).toBe('APPROVAL_INVALID');
    const other = await post(body({ approval_ref: approval('another.com') }));
    expect(other.json().error.code).toBe('APPROVAL_INVALID');
    const old = await post(body({ approval_ref: { text: approval().text, approved_at: new Date(T0 - 100 * 3_600_000).toISOString() } }));
    expect(old.json().error.code).toBe('APPROVAL_EXPIRED');
    const future = await post(body({ approval_ref: { text: approval().text, approved_at: new Date(T0 + 3_600_000).toISOString() } }));
    expect(future.json().error.code).toBe('APPROVAL_INVALID');
    const lane = await post(body({ lane: 'S9' }));
    expect(lane.statusCode).toBe(422);
    expect(lane.json().error.code).toBe('VALIDATION_ERROR');
    expect(await count('domains')).toBe(0);
    expect(await count('ledger_entries')).toBe(0);
  });

  it('S8-2: a source other than closeout|fixed|auction is refused; NameJet, SnapNames and DropCatch are refused as source or registrar', async () => {
    const bad = await post(body({ source: 'private-sale' }));
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error.code).toBe('S8_SOURCE_INVALID');
    for (const v of ['namejet', 'SnapNames', 'Drop Catch', 'dropcatch']) {
      const asSource = await post(body({ source: v }));
      expect(asSource.statusCode, v).toBe(400);
      expect(asSource.json().error.code, v).toBe('BACKORDER_SOURCE_REFUSED');
      const asRegistrar = await post(body({ registrar: v }));
      expect(asRegistrar.json().error.code, v).toBe('BACKORDER_SOURCE_REFUSED');
    }
    for (const source of ['closeout', 'fixed', 'auction']) {
      const ok = await post(body({ domain: `${source}name.com`, source, dry_run: true }));
      expect(ok.statusCode, ok.body).toBe(200);
    }
    expect(await count('domains')).toBe(0);
  });

  it('S8-3: the S8 per-name cap is $50: $50.01 is 400 S8_PRICE_CAP, $50.00 is accepted; the cap is in settings, not in the API', async () => {
    const over = await post(body({ price_paid: 50.01 }));
    expect(over.statusCode, over.body).toBe(400);
    expect(over.json().error).toMatchObject({ code: 'S8_PRICE_CAP', details: { price_paid_cents: 5001, s8_max_price_cents: 5000 } });
    expect(await count('domains')).toBe(0);
    const ok = await post(body({ price_paid: 50 }));
    expect(ok.statusCode, ok.body).toBe(201);
    const cfg = await db.selectFrom('settings').select(['s8_max_price_cents', 's8_reserved_slots', 'max_domains']).executeTakeFirstOrThrow();
    expect(cfg).toEqual({ s8_max_price_cents: 5000, s8_reserved_slots: 10, max_domains: 40 });
    const attempt = await post(body({ domain: 'capchange.com', s8_max_price_cents: 99999 }));
    expect(attempt.statusCode).toBe(422);
  });

  it('S8-4: an import books lane S8, one purchase ledger row of the price paid, the evidence, and a hybrid plan with the BIN rung from the comps value', async () => {
    const r = await post(body({ deal_id: 'D-020', pricing_evidence: { comps: [], rationale: 'closeout comps' } }));
    expect(r.statusCode, r.body).toBe(201);
    expect(r.json()).toMatchObject({ domain: D, lane: 'S8', status: 'listed', registrar_api: 'none', expiry_date: '2027-10-05', drop_date: '2028-10-05' });
    const d = await dom();
    expect(d).toMatchObject({ lane: 'S8', registrar: 'dynadot', cost_cents: 1250, category: 'trend', listing_mode: 'hybrid', bin_cents: 148800, floor_cents: 96700, deal_id: 'D-020', renewals_used: 0 });
    expect(d.walkaway_cents).toBe(71500);
    expect(d.min_offer_cents).toBe(10000);
    const led = await db.selectFrom('ledger_entries').selectAll().executeTakeFirstOrThrow();
    expect(led).toMatchObject({ type: 'registration', amount_cents: -1250, counterparty: 'dynadot', domain_id: d.id, audit_id: r.json().audit_id });
    expect(led.note).toContain('S8 closeout');
    expect(await count('pricing_evidence')).toBe(1);
    expect(await count('listing_history')).toBe(1);
    expect(await db.selectFrom('deals').selectAll().where('id', '=', 'D-020').executeTakeFirst()).toMatchObject({ domain: D });
    expect((await db.selectFrom('audit_log').selectAll().where('id', '=', r.json().audit_id).executeTakeFirstOrThrow()).path).toBe('/portfolio/import');
    // the rung: lowest price-list price >= comps_value; above the open top of the list = the top; below the minimum = the minimum
    const rung = async (domain: string, comps: number) => {
      const res = await post(body({ domain, comps_value: comps, dry_run: true }));
      expect(res.statusCode, res.body).toBe(200);
      return res.json().s8.bin_cents;
    };
    expect(await rung('rungone.com', 100)).toBe(78800);
    expect(await rung('rungtwo.com', 788)).toBe(78800);
    expect(await rung('rungthree.com', 789)).toBe(108800);
    expect(await rung('rungfour.com', 1489)).toBe(148800);
    expect(await rung('rungfive.com', 9999)).toBe(148800);
    const noComps = await post(body({ domain: 'nocomps.com', comps_value: undefined, dry_run: true }));
    expect(noComps.statusCode).toBe(422);
    const geo = await post(body({ domain: 'berlinplumbers.com', category: 'geo', price_grade: 'weaker', comps_value: undefined, dry_run: true }));
    expect(geo.statusCode, geo.body).toBe(200);
    expect(geo.json().s8.bin_cents).toBe(39900);
    const manual = await post(body({ domain: 'noexpiry.com', expiry_date: undefined }));
    expect(manual.statusCode).toBe(422);
    expect(manual.json().error.code).toBe('VALIDATION_ERROR');
  });

  it('S8-5: S8 slots: Line 1 /buy is refused at 30 non-S8 names (dry run reports it), an S8 import is refused when the 10 slots are full, and the total cap of 40 still holds', async () => {
    await seedLine(30, null, 'lineone');
    await readyToBuy(DOMAIN);
    const dry = await postBuy(app, buyBody({ dry_run: true }), auth);
    expect(dry.statusCode, dry.body).toBe(200);
    expect(dry.json().would_be_blocked).toBe('DOMAIN_CAP_REACHED');
    const real = await postBuy(app, buyBody(), auth);
    expect(real.statusCode).toBe(409);
    expect(real.json().error).toMatchObject({ code: 'DOMAIN_CAP_REACHED', details: { domains: 30, max_domains: 40, line1_max: 30, s8_reserved_slots: 10 } });
    // S8 can still take a slot with Line 1 at 30
    const imp = await post(body());
    expect(imp.statusCode, imp.body).toBe(201);
    // 29 Line 1 names leave a Line 1 slot
    await db.deleteFrom('domains').where('domain', '=', 'lineone0.com').execute();
    const dry2 = await postBuy(app, buyBody({ dry_run: true }), auth);
    expect(dry2.json().would_be_blocked ?? null).toBeNull();
    // fill the S8 slots
    await seedLine(9, 'S8', 'eight');
    const full = await post(body({ domain: 'eleventh.com' }));
    expect(full.statusCode, full.body).toBe(409);
    expect(full.json().error).toMatchObject({ code: 'S8_SLOTS_FULL', details: { s8_names: 10, s8_reserved_slots: 10 } });
    const fullDry = await post(body({ domain: 'eleventh.com', dry_run: true }));
    expect(fullDry.statusCode).toBe(200);
    expect(fullDry.json().would_be_blocked).toBe('S8_SLOTS_FULL');
    expect(await db.selectFrom('domains').selectAll().where('domain', '=', 'eleventh.com').execute()).toHaveLength(0);
  });

  it('S8-6: the total cap holds for an S8 import (35 Line 1 names + 5 S8 names = 40)', async () => {
    await seedLine(35, null, 'lineone');
    await seedLine(5, 'S8', 'eight');
    const res = await post(body());
    expect(res.statusCode, res.body).toBe(409);
    expect(res.json().error).toMatchObject({ code: 'DOMAIN_CAP_REACHED', details: { domains: 40, max_domains: 40 } });
  });

  it('S8-7: GET /report carries lines: names, spend, sales, P&L and committed renewals per line', async () => {
    const l1 = await insertOwnedDomain(db, { domain: 'handreg.com', cost_cents: 1108, renewal_price_cents: 1108 });
    await db.insertInto('ledger_entries').values({ occurred_on: '2026-10-04', type: 'registration', amount_cents: -1108, domain_id: l1, counterparty: 'porkbun', receipt_ref: 'x', note: 'fixture', audit_id: null, deal_id: null }).execute();
    const r = await post(body({ renewal_price: 9.99 }));
    expect(r.statusCode, r.body).toBe(201);
    const rep = await app.inject({ method: 'GET', url: '/report', headers: (await issueToken('read')).auth });
    expect(rep.statusCode, rep.body).toBe(200);
    const lines = rep.json().lines;
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({ line: 1, name: 'hand registration', names: 1, max_names: 30, spend: { spent_cents: 1108 }, sales: { count: 0 }, pnl_cents: -1108, committed_forward: { total_cents: 1108, complete: true } });
    expect(lines[1]).toMatchObject({
      line: 2, name: 'S8 aftermarket', names: 1, max_names: 10, spend: { spent_cents: 1250, spent: '$12.50' }, sales: { count: 0, gross_cents: 0 },
      pnl_cents: -1250, pnl: expect.any(String), committed_forward: { total_cents: 999, total: '$9.99', complete: true },
    });
    const pd = rep.json().per_domain as { domain: string; line: number }[];
    expect(pd.find((x) => x.domain === D)?.line).toBe(2);
    expect(pd.find((x) => x.domain === 'handreg.com')?.line).toBe(1);
    const md = await app.inject({ method: 'GET', url: '/report?format=md', headers: (await issueToken('read')).auth });
    expect(md.statusCode).toBe(200);
  });

  it('S8-8: the same Idempotency-Key replays the same answer with one set of rows; a dry run writes nothing; an owned name and a READ token are refused', async () => {
    const dry = await post(body({ dry_run: true }));
    expect(dry.statusCode, dry.body).toBe(200);
    expect(dry.json()).toMatchObject({ dry_run: true, lane: 'S8', would_be_blocked: null, s8: { bin_cents: 148800, comps_value_cents: 120000 } });
    for (const t of ['domains', 'ledger_entries', 'pricing_evidence', 'listing_history', 'price_schedule'] as const) expect(await count(t), t).toBe(0);
    const key = randomUUID();
    const a = await post(body(), key);
    const b = await post(body(), key);
    expect(a.statusCode).toBe(201);
    expect(b.statusCode).toBe(201);
    expect(b.json()).toEqual(a.json());
    expect(await count('domains')).toBe(1);
    expect(await count('ledger_entries')).toBe(1);
    const again = await post(body());
    expect(again.statusCode).toBe(409);
    expect(again.json().error.code).toBe('ALREADY_IN_PORTFOLIO');
    const read = await post(body({ domain: 'readtoken.com' }), randomUUID(), (await issueToken('read')).auth);
    expect(read.statusCode).toBe(403);
    expect(await count('ledger_entries')).toBe(1);
  });
});

describe('S8 import lane: refusals that need another setup (CR-059)', () => {
  it('S8-9: a registrar adapter that reports no expiry is 422 EXPIRY_UNKNOWN, nothing written', async () => {
    await app.close();
    await boot([new FakeAdapter('godaddy', { findDomain: () => ({ expiryDate: null, whoisPrivacy: true, autoRenew: false, apiAccess: true, ns: null }) })]);
    const r = await post(body({ registrar: 'godaddy', expiry_date: undefined }));
    expect(r.statusCode, r.body).toBe(422);
    expect(r.json().error.code).toBe('EXPIRY_UNKNOWN');
    expect(await count('domains')).toBe(0);
  });

  it('S8-10: pricing settings without a price list (v2) cannot price an S8 name: 409 PRICING_SETTINGS_NO_PRICE_LIST, nothing written', async () => {
    // the app clock is two hours before v3 took effect, so v2 (no price list) is the current version
    await app.close();
    await boot([new FakeAdapter('porkbun')], T0 - 2 * 3_600_000);
    const stale = { text: approval().text, approved_at: new Date(T0 - 3 * 3_600_000).toISOString() };
    const r = await post(body({ approval_ref: stale }));
    expect(r.statusCode, r.body).toBe(409);
    expect(r.json().error.code).toBe('PRICING_SETTINGS_NO_PRICE_LIST');
    expect(await count('domains')).toBe(0);
  });
});
