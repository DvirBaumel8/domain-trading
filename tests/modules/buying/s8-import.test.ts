// v5.8.0 (CR-059) + v5.9.0 (CR-060, S8-11..S8-19): the S8 (Line 2) aftermarket import lane. POST /portfolio/import, the S8 slot reservation on /buy, the BIN rung from the comps value, /report lines.
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
import { ensureBidPlan } from '../../helpers/bid-plans.js';
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
// v5.39.0 (CR-077): an S8 import runs under a bid plan; these tests are about the import rules, so each name gets a plan with a maximum bid at the S8 cap first
const post = async (b: unknown, key: string = randomUUID(), headers?: Record<string, string>) => {
  const d = (b as { domain?: unknown }).domain;
  // a body without approval_ref has no plan either (S8-1: neither an approval nor a plan)
  if (typeof d === 'string' && d.endsWith('.com') && (b as { approval_ref?: unknown }).approval_ref !== undefined) await ensureBidPlan(db, d.toLowerCase());
  return app.inject({ method: 'POST', url: '/portfolio/import', headers: { ...(headers ?? (await issueToken('write')).auth), 'idempotency-key': key }, payload: b as object });
};
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

  it('S8-3: the S8 per-name cap is $250 (5.36.0; was $50): $250.01 is 400 S8_PRICE_CAP, $250.00 is accepted; the cap is in settings, not in the API', async () => {
    const over = await post(body({ price_paid: 250.01 }));
    expect(over.statusCode, over.body).toBe(400);
    expect(over.json().error).toMatchObject({ code: 'S8_PRICE_CAP', details: { price_paid_cents: 25001, s8_max_price_cents: 25000 } });
    expect(await count('domains')).toBe(0);
    const ok = await post(body({ price_paid: 250 }));
    expect(ok.statusCode, ok.body).toBe(201);
    const cfg = await db.selectFrom('settings').select(['s8_max_price_cents', 's8_reserved_slots', 'max_domains']).executeTakeFirstOrThrow();
    expect(cfg).toEqual({ s8_max_price_cents: 25000, s8_reserved_slots: 10, max_domains: 40 });
    const attempt = await post(body({ domain: 'capchange.com', s8_max_price_cents: 99999 }));
    expect(attempt.statusCode).toBe(422);
  });

  it('S8-4: an import books lane S8, one purchase ledger row of the price paid, the evidence, and a hybrid plan with the BIN from the S8 ladder by name length (CR-060)', async () => {
    const r = await post(body({ deal_id: 'D-020', pricing_evidence: { comps: [], rationale: 'closeout comps' } }));
    expect(r.statusCode, r.body).toBe(201);
    expect(r.json()).toMatchObject({ domain: D, lane: 'S8', status: 'listed', registrar_api: 'none', expiry_date: '2027-10-05', drop_date: '2028-10-05' });
    const d = await dom();
    expect(d).toMatchObject({ lane: 'S8', registrar: 'dynadot', cost_cents: 1250, category: 'trend', listing_mode: 'hybrid', bin_cents: 248800, floor_cents: 161700, deal_id: 'D-020', renewals_used: 0 });
    expect(d.walkaway_cents).toBe(119500);
    expect(d.min_offer_cents).toBe(10000);
    const led = await db.selectFrom('ledger_entries').selectAll().executeTakeFirstOrThrow();
    expect(led).toMatchObject({ type: 'registration', amount_cents: -1250, counterparty: 'dynadot', domain_id: d.id, audit_id: r.json().audit_id });
    expect(led.note).toContain('S8 closeout');
    expect(await count('pricing_evidence')).toBe(1);
    expect(await count('listing_history')).toBe(1);
    expect(await db.selectFrom('deals').selectAll().where('id', '=', 'D-020').executeTakeFirst()).toMatchObject({ domain: D });
    expect((await db.selectFrom('audit_log').selectAll().where('id', '=', r.json().audit_id).executeTakeFirstOrThrow()).path).toBe('/portfolio/import');
    // comps_value is optional evidence since CR-060
    const noComps = await post(body({ domain: 'nocomps.com', comps_value: undefined, dry_run: true }));
    expect(noComps.statusCode, noComps.body).toBe(200);
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
    expect(dry.json()).toMatchObject({ dry_run: true, lane: 'S8', would_be_blocked: null, s8: { bin_cents: 248800, comps_value_cents: 120000 } });
    for (const t of ['domains', 'ledger_entries', 'pricing_evidence', 'listing_history', 'price_schedule'] as const) expect(await count(t), t).toBe(0);
    const key = randomUUID();
    const owner = (await issueToken('write')).auth; // 5.13.0: a key belongs to one token, so both calls use the same token
    const a = await post(body(), key, owner);
    const b = await post(body(), key, owner);
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

describe('S8 import: approved price, ladder, expiry window, schedule (CR-060)', () => {
  const M = 'mineunited.com';
  const mineBody = (over: Record<string, unknown> = {}) => body({
    domain: M, source: 'closeout', registrar: 'godaddy', price_paid: 24.19, buy_date: '2026-10-05', expiry_date: '2027-09-07', category: 'b2b', comps_value: undefined,
    approval_ref: { text: 'yes import mineunited.com on S8 at $3,488 BIN and $2,267 floor', approved_at: new Date(T0 - 3_600_000).toISOString() },
    bin_override: 348800, floor_override: 226700, dry_run: true, ...over,
  });

  it('S8-11: a dry run with bin_override 348800 and floor_override 226700 named in the approval echoes them, would_be_blocked null, off-list BIN not rejected', async () => {
    const r = await post(mineBody());
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json()).toMatchObject({ lane: 'S8', would_be_blocked: null, s8: { bin_cents: 348800, floor_cents: 226700, bin_source: 'override', floor_source: 'override' } });
    expect(r.json().listing).toMatchObject({ mode: 'hybrid' });
    const real = await post(mineBody({ dry_run: undefined }));
    expect(real.statusCode, real.body).toBe(201);
    expect(await dom(M)).toMatchObject({ bin_cents: 348800, floor_cents: 226700, min_offer_cents: 10000, lane: 'S8' });
    expect((await dom(M)).walkaway_cents).toBeLessThanOrEqual(226700);
  });

  it('S8-12: an import without approval_ref is still 422 APPROVAL_INVALID, overrides or not', async () => {
    const r = await post(mineBody({ approval_ref: undefined }));
    expect(r.statusCode).toBe(422);
    expect(r.json().error.code).toBe('APPROVAL_INVALID');
  });

  it('S8-13: an override whose price the approval text does not name is 422 APPROVAL_INVALID naming the override; amount forms and exact match', async () => {
    const at = new Date(T0 - 3_600_000).toISOString();
    const ap = (text: string) => ({ text, approved_at: at });
    const noBin = await post(mineBody({ approval_ref: ap('yes import mineunited.com, floor $2,267') }));
    expect(noBin.statusCode).toBe(422);
    expect(noBin.json().error).toMatchObject({ code: 'APPROVAL_INVALID', details: { override: 'bin_override' } });
    const noFloor = await post(mineBody({ approval_ref: ap('yes import mineunited.com at $3,488') }));
    expect(noFloor.json().error).toMatchObject({ code: 'APPROVAL_INVALID', details: { override: 'floor_override' } });
    const larger = await post(mineBody({ approval_ref: ap('yes import mineunited.com at $13,488 floor $2,267') }));
    expect(larger.json().error.code).toBe('APPROVAL_INVALID');
    const larger2 = await post(mineBody({ approval_ref: ap('yes import mineunited.com at $3,4880 floor $2,267') }));
    expect(larger2.json().error.code).toBe('APPROVAL_INVALID');
    for (const text of ['yes mineunited.com $3488 and $2267', 'yes mineunited.com $3,488.00 and $2,267.00.', 'yes mineunited.com ($3488.00, $2267.00)']) {
      const ok = await post(mineBody({ approval_ref: ap(text) }));
      expect(ok.statusCode, `${text}: ${ok.body}`).toBe(200);
    }
    const bad = await post(mineBody({ floor_override: 400000 }));
    expect(bad.statusCode).toBe(422);
    const onlyFloorTooHigh = await post(mineBody({ bin_override: undefined, floor_override: 400000, approval_ref: ap('yes mineunited.com floor $4,000') }));
    expect(onlyFloorTooHigh.statusCode).toBe(422); // ladder BIN for a 10-character name is $3,488
    expect(await count('domains')).toBe(0);
  });

  it('S8-14: without an override the BIN comes from the S8 ladder by name length (<=8 $4,888, 9-12 $3,488, 13+ $2,488) and the floor is 65% to the whole dollar', async () => {
    const one = async (domain: string) => {
      const r = await post(body({ domain, comps_value: undefined, dry_run: true }));
      expect(r.statusCode, r.body).toBe(200);
      return r.json().s8;
    };
    expect(await one('abcdefgh.com')).toMatchObject({ bin_cents: 488800, floor_cents: 317700, bin_source: 'ladder', floor_source: 'formula' }); // 8
    expect((await one('abcdefghi.com')).bin_cents).toBe(348800); // 9
    expect(await one('mineunited.com')).toMatchObject({ bin_cents: 348800, floor_cents: 226700 }); // 10
    expect((await one('abcdefghijkl.com')).bin_cents).toBe(348800); // 12
    expect(await one('abcdefghijklm.com')).toMatchObject({ bin_cents: 248800, floor_cents: 161700 }); // 13
    // only the floor overridden: the BIN stays on the ladder
    const f = await post(mineBody({ bin_override: undefined, approval_ref: { text: 'yes mineunited.com floor $2,267', approved_at: new Date(T0 - 3_600_000).toISOString() } }));
    expect(f.json().s8).toMatchObject({ bin_cents: 348800, floor_cents: 226700, bin_source: 'ladder', floor_source: 'override' });
    // the ladder lives in the settings row
    const row = await db.selectFrom('settings').select('s8_bin_ladder').executeTakeFirstOrThrow();
    expect(row.s8_bin_ladder).toEqual([{ max_len: 8, bin_cents: 488800 }, { max_len: 12, bin_cents: 348800 }, { max_len: null, bin_cents: 248800 }]);
  });

  it('S8-15: S8 expiry up to buy_date + 2 years + 30 days is accepted; one day later is 422 REGISTRATION_TERM_INVALID; Line 1 rule unchanged (/portfolio/import is S8 only)', async () => {
    const ok = await post(body({ buy_date: '2026-10-05', expiry_date: '2028-11-04', dry_run: true }));
    expect(ok.statusCode, ok.body).toBe(200);
    expect(ok.json().drop_date).toBe('2029-11-04');
    const late = await post(body({ buy_date: '2026-10-05', expiry_date: '2028-11-05', dry_run: true }));
    expect(late.statusCode, late.body).toBe(422);
    expect(late.json().error.code).toBe('REGISTRATION_TERM_INVALID');
  });

  it('S8-16: an S8 schedule has no M6/M18 drops; the final push and the delist stay; the price job neither rejects nor rewrites the off-list BIN', async () => {
    const r = await post(mineBody({ dry_run: undefined, buy_date: '2026-10-05', expiry_date: '2027-09-07' }));
    expect(r.statusCode, r.body).toBe(201);
    const d = await dom(M);
    const rows = await db.selectFrom('price_schedule').selectAll().where('domain_id', '=', d.id).orderBy('due_on').execute();
    expect(rows.map((x) => x.event)).toEqual(['final_push', 'delist']);
    expect(rows[0]).toMatchObject({ due_on: '2028-06-09', bin_cents: 248800, floor_cents: 226700, status: 'planned' }); // drop_date 2028-09-07 - 90 days; lowest list price >= floor
    expect(rows[1]!.due_on).toBe('2028-08-31');
    const preview = await app.inject({ method: 'POST', url: '/jobs/preview', headers: { ...(await issueToken('write')).auth, 'idempotency-key': randomUUID() }, payload: { today: '2028-06-10' } });
    expect(preview.statusCode, preview.body).toBe(200);
    expect(preview.json().priceJob.would_fail).toEqual([]);
    expect(preview.json().priceJob.would_apply).toEqual([expect.objectContaining({ domain: M, event: 'final_push', bin_cents: 248800, floor_cents: 226700 })]);
  });

  it('S8-16b: a short S8 name (BIN $4,888, floor $3,177) gets a final push to its floor, an off-list BIN, and the price job still applies it', async () => {
    const r = await post(body({ domain: 'abcdefgh.com', comps_value: undefined }));
    expect(r.statusCode, r.body).toBe(201);
    const d = await dom('abcdefgh.com');
    const fp = await db.selectFrom('price_schedule').selectAll().where('domain_id', '=', d.id).where('event', '=', 'final_push').executeTakeFirstOrThrow();
    expect(fp).toMatchObject({ bin_cents: 317700, status: 'planned' });
    const preview = await app.inject({ method: 'POST', url: '/jobs/preview', headers: { ...(await issueToken('write')).auth, 'idempotency-key': randomUUID() }, payload: { today: '2028-07-20' } });
    expect(preview.json().priceJob.would_fail).toEqual([]);
    expect(preview.json().priceJob.would_apply).toEqual([expect.objectContaining({ domain: 'abcdefgh.com', event: 'final_push', bin_cents: 317700 })]);
  });

  it('S8-17: CR-059 guards stand with overrides: $250.01 is S8_PRICE_CAP, namejet is BACKORDER_SOURCE_REFUSED', async () => {
    const cap = await post(mineBody({ price_paid: 250.01 }));
    expect(cap.statusCode).toBe(400);
    expect(cap.json().error.code).toBe('S8_PRICE_CAP');
    const nj = await post(mineBody({ source: 'namejet' }));
    expect(nj.statusCode).toBe(400);
    expect(nj.json().error.code).toBe('BACKORDER_SOURCE_REFUSED');
  });

  it('S8-18: a geo S8 name keeps the grade-price BIN and refuses overrides', async () => {
    const geo = await post(body({ domain: 'berlinplumbers.com', category: 'geo', price_grade: 'strong', comps_value: undefined, dry_run: true }));
    expect(geo.statusCode, geo.body).toBe(200);
    expect(geo.json().s8).toMatchObject({ bin_cents: 49900, floor_cents: 49900, bin_source: 'grade_price' });
    const ov = await post(body({ domain: 'berlinplumbers.com', category: 'geo', price_grade: 'strong', bin_override: 99900,
      approval_ref: { text: 'yes berlinplumbers.com $999', approved_at: new Date(T0 - 3_600_000).toISOString() }, dry_run: true }));
    expect(ov.statusCode).toBe(422);
  });

  it('S8-19: an S8 name keeps its off-list BIN through a listing PATCH (lander change) and Line 1 still refuses an off-list BIN', async () => {
    const r = await post(mineBody({ dry_run: undefined }));
    expect(r.statusCode, r.body).toBe(201);
    const h = { ...(await issueToken('write')).auth, 'idempotency-key': randomUUID() };
    const rp = await app.inject({ method: 'POST', url: `/list/${M}`, headers: h, payload: { replan: true, dry_run: true } });
    expect(rp.statusCode, rp.body).toBe(200);
    expect(rp.json().listing.bin_cents).toBe(348800);
    // a Line 1 name gets BIN_NOT_IN_PRICE_LIST for the same price
    await insertOwnedDomain(db, { domain: 'handreg.com', category: 'b2b' });
    const l1 = await app.inject({ method: 'POST', url: '/list/handreg.com', headers: { ...(await issueToken('write')).auth, 'idempotency-key': randomUUID() }, payload: { mode: 'hybrid', bin: 3488, dry_run: true } });
    expect(l1.statusCode, l1.body).toBe(422);
    expect(l1.json().error.code).toBe('BIN_NOT_IN_PRICE_LIST');
  });

  it('S8-20: M1 a registrar that contains "cloudflare" is refused however it is spelled; the DB stays empty', async () => {
    for (const registrar of ['cloudflare', 'Cloudflare', 'Cloud-flare', 'cloudflare.com', 'CloudFlare Registrar']) {
      const r = await post(body({ registrar, dry_run: true }));
      expect(r.statusCode, registrar).toBe(422);
      expect(r.json().error.code, registrar).toBe('VALIDATION_ERROR');
      expect(r.json().error.message, registrar).toMatch(/Cloudflare/);
    }
    expect(await count('domains')).toBe(0);
  });
});
