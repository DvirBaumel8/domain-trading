import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { newPricingSettings } from '../../src/modules/ops/admin/pricing-settings.js';
import { PriceScheduleJob } from '../../src/modules/ops/jobs/price-schedule.js';
import { currentSettings } from '../../src/modules/listing/pricing/settings.js';
import { makeApp } from '../helpers/app.js';
import { insertOwnedDomain, testDb as db } from '../helpers/db.js';
import { FakeAdapter } from '../helpers/fake-adapter.js';
import { createV3, V3_SET } from '../helpers/pricing.js';
import { issueToken } from '../helpers/tokens.js';

let app: FastifyInstance;
afterEach(async () => app?.close());
const D = 'examplecityroofing.com';
const NOW = Date.parse('2026-10-12T09:00:00Z');
const approval = () => ({ text: `yes list ${D}`, approved_at: new Date(NOW - 3_600_000).toISOString() });
const preview = (qs: string, auth: Record<string, string>) => app.inject({ method: 'GET', url: `/pricing/preview?${qs}`, headers: auth });

describe('pricing_settings v3 via the admin command (§10.13)', () => {
  it('creates v3 with the full --set list; v2 is intact; the DB shape is stored', async () => {
    expect(await createV3(db)).toBe(3);
    const rows = await db.selectFrom('pricing_settings').selectAll().orderBy('version').execute();
    expect(rows.map((r) => [r.version, r.drop_mode, r.floor_rounding, r.allowed_bins_cents])).toEqual([
      [2, 'pct', 'round5', null],
      [3, 'ladder', 'dollar', [29900, 39900, 49900, 78800, 108800, 148800, 198800, 248800]],
    ]);
    const s = await currentSettings(db, new Date());
    expect(s).toMatchObject({ version: 3, dropMode: 'ladder', floorRounding: 'dollar', nongeoBinMinCents: 78800, nongeoDefaultBinCents: 148800, landerExceptionBinsCents: [198800, 248800], finalPushMode: 'bin_to_lowest_listed_ge_floor' });
    expect(s.drops).toEqual([{ afterMonths: 6, steps: 1 }, { afterMonths: 18, steps: 1 }]);
  });

  it('refuses a v3 set that breaks an invariant, writing nothing', async () => {
    const bad = (over: Record<string, string>) => newPricingSettings(db, {
      set: { ...V3_SET, ...over }, approvalText: 'Dvir: test', approvalAt: new Date(Date.now() - 3_600_000).toISOString(), now: new Date(Date.now() - 60_000),
    });
    await expect(bad({ allowed_bins_cents: '[39900,29900,49900,78800,108800,148800,198800,248800]' })).rejects.toThrow(/ascending/);
    await expect(bad({ nongeo_default_bin_cents: '99900' })).rejects.toThrow(/on allowed_bins_cents/);
    await expect(bad({ lander_exception_bins_cents: '[99900]' })).rejects.toThrow(/lander_exception/);
    await expect(bad({ allowed_bins_cents: '"x"' })).rejects.toThrow(/array/);
    await expect(bad({ geo_drops: '[{"after_months":12,"steps":1},{"after_months":13,"steps":1}]' })).rejects.toThrow(/at most 1/);
    await expect(newPricingSettings(db, { set: { final_push_mode: 'bin_to_lowest_listed_ge_floor' }, approvalText: 'x', approvalAt: new Date(Date.now() - 3_600_000).toISOString(), now: new Date(Date.now() - 60_000) }))
      .rejects.toThrow(/requires drop_mode ladder|check constraint/);
    expect(await db.selectFrom('pricing_settings').select('version').execute()).toHaveLength(1);
  });

  it('GET /pricing/preview under v3: 1488 → $967 / $715 (private), schedule per the vectors, settings_version 3', async () => {
    await createV3(db);
    app = await makeApp();
    const { auth } = await issueToken('read');
    const res = await preview('category=trend&bin=1488&listed_on=2026-10-12&drop_date=2028-10-04', auth);
    expect(res.statusCode).toBe(200);
    const b = res.json();
    expect(b).toMatchObject({
      settings_version: 3, bin_cents: 148800, floor_cents: 96700, walkaway_cents: 71500, min_offer_cents: 10000,
      display: { bin: '$1,488', floor: '$967', walkaway: '$715 (private)', min_offer: '$100' },
    });
    expect(b.schedule).toEqual([
      { event: 'drop1_m6', due_on: '2027-04-12', bin: '$1,088', floor: '$750', walkaway: '$520', status: 'planned' },
      { event: 'drop2_m18', due_on: '2028-04-12', bin: '$788', floor: '$750', walkaway: '$500', status: 'planned' },
      { event: 'final_push', due_on: '2028-07-06', bin: '$788', floor: '$750', walkaway: '$500', status: 'skipped_no_change' },
      { event: 'delist', due_on: '2028-09-27', status: 'planned' },
    ]);
  });

  it('preview: off-list BIN → 422 BIN_NOT_IN_PRICE_LIST; lander-exception BIN → 422 LANDER_EXCEPTION_REQUIRED', async () => {
    await createV3(db);
    app = await makeApp();
    const { auth } = await issueToken('read');
    const a = await preview('category=trend&bin=1495', auth);
    expect(a.statusCode).toBe(422);
    expect(a.json().error.code).toBe('BIN_NOT_IN_PRICE_LIST');
    expect(a.json().error.details).toMatchObject({ min_bin_cents: 78800 });
    const b = await preview('category=trend&bin=1988', auth);
    expect(b.statusCode).toBe(422);
    expect(b.json().error.code).toBe('LANDER_EXCEPTION_REQUIRED');
  });

  it('preview geo under v3: weaker 399 → M12 299, then delist only', async () => {
    await createV3(db);
    app = await makeApp();
    const { auth } = await issueToken('read');
    const b = (await preview('category=geo&grade=weaker&listed_on=2026-11-01&drop_date=2028-11-01', auth)).json();
    expect(b.schedule.map((e: { event: string; bin?: string }) => [e.event, e.bin])).toEqual([['geo_drop_m12', '$299'], ['delist', undefined]]);
  });
});

describe('v2 plans survive v3 (Review Focus 5)', () => {
  async function setup(body: object, dom0: Record<string, unknown>) {
    app = await makeApp({ adapters: [new FakeAdapter('porkbun')], now: () => NOW });
    const { auth } = await issueToken('write');
    await insertOwnedDomain(db, { domain: D, ...dom0 });
    const list = (b: object) => app.inject({ method: 'POST', url: `/list/${D}`, headers: { ...auth, 'idempotency-key': randomUUID() }, payload: b });
    expect((await list(body)).statusCode).toBe(200);
    return list;
  }

  it('v2 plan keeps v2 drops after v3 exists: the price job applies the v2 M6 numbers, history says v2', async () => {
    await setup({ mode: 'hybrid', bin: 1995, approval_ref: approval() }, { category: 'trend', price_grade: null });
    await createV3(db);
    const r = await new PriceScheduleJob({ db, now: () => NOW }).runOnce({ today: '2027-04-12' });
    expect(r.failed).toEqual([]);
    expect(r.applied).toHaveLength(1);
    const d = await db.selectFrom('domains').selectAll().where('domain', '=', D).executeTakeFirstOrThrow();
    expect([d.bin_cents, d.floor_cents, d.walkaway_cents]).toEqual([159500, 103500, 77000]);
    const h = await db.selectFrom('listing_history').selectAll().where('source', '=', 'schedule').execute();
    expect(h.map((x) => x.pricing_settings_version)).toEqual([2]);
  });

  it('a v3 plan applies ladder drops through the job (M6 1488 → 1088, recomputed floor/walk-away)', async () => {
    await createV3(db);
    await setup({ mode: 'hybrid', bin: 1488, approval_ref: approval() }, { category: 'trend', price_grade: null });
    const r = await new PriceScheduleJob({ db, now: () => NOW }).runOnce({ today: '2027-04-12' });
    expect(r.failed).toEqual([]);
    const d = await db.selectFrom('domains').selectAll().where('domain', '=', D).executeTakeFirstOrThrow();
    expect([d.bin_cents, d.floor_cents, d.walkaway_cents, d.pricing_settings_version]).toEqual([108800, 75000, 52000, 3]);
  });

  it('manual geo /list change under v3: $349 → 422 BIN_NOT_IN_PRICE_LIST, $299 → accepted (off-grade needs approval); v2 plans keep v2 range rules', async () => {
    await createV3(db); // a first listing uses the current version
    const list = await setup({ mode: 'bin', bin: 399 }, { category: 'geo', price_grade: 'weaker' });
    const bad = await list({ mode: 'bin', bin: 349, approval_ref: approval() });
    expect(bad.statusCode).toBe(422);
    expect(bad.json().error.code).toBe('BIN_NOT_IN_PRICE_LIST');
    const ok = await list({ mode: 'bin', bin: 299, approval_ref: approval() });
    expect(ok.statusCode).toBe(200);
    const d = await db.selectFrom('domains').selectAll().where('domain', '=', D).executeTakeFirstOrThrow();
    expect(d.bin_cents).toBe(29900);
  });

  it('a geo domain planned under v2 still accepts $349 after v3 exists (its plan version governs manual changes)', async () => {
    const list = await setup({ mode: 'bin', bin: 399 }, { category: 'geo', price_grade: 'weaker' });
    await createV3(db);
    expect((await list({ mode: 'bin', bin: 349, approval_ref: approval() })).statusCode).toBe(200);
  });

  it('an override never waives the price list: geo $549, non-geo bin $999 / $1,995 refused; a list value with override accepted', async () => {
    await createV3(db);
    const geoList = await setup({ mode: 'bin', bin: 399 }, { category: 'geo', price_grade: 'weaker' });
    const o = { override: true, override_reason: 'test', approval_ref: approval() };
    const g = await geoList({ mode: 'bin', bin: 549, ...o });
    expect([g.statusCode, g.json().error.code]).toEqual([422, 'BIN_NOT_IN_PRICE_LIST']);
  });

  it('non-geo plain bin under v3: off-list BIN refused even with an override; list BIN with an override accepted', async () => {
    await createV3(db);
    const list = await setup({ mode: 'hybrid', bin: 1488, approval_ref: approval() }, { category: 'trend', price_grade: null });
    const o = { override: true, override_reason: 'test', approval_ref: approval() };
    for (const bin of [999, 1995]) {
      const r = await list({ mode: 'bin', bin, ...o });
      expect([r.statusCode, r.json().error.code]).toEqual([422, 'BIN_NOT_IN_PRICE_LIST']);
    }
    const ok = await list({ mode: 'bin', bin: 1488, ...o });
    expect(ok.statusCode).toBe(200);
  });

  it('PR3-9: D-001 reprice via replan with the exception + approval under v3 → 1488 / 967 / 950, approved_exception', async () => {
    const list = await setup({ mode: 'hybrid', bin: 1995, floor: 1295, walkaway: 950, pricing_exception: true, pricing_exception_reason: 'D-001 approved plan', approval_ref: approval() }, { category: 'trend', price_grade: null });
    await createV3(db);
    const r = await list({ replan: true, mode: 'hybrid', bin: 1488, floor: 967, walkaway: 950, pricing_exception: true, pricing_exception_reason: 'D-001 reprice (6 Oct)', approval_ref: approval() });
    expect(r.statusCode).toBe(200);
    const d = await db.selectFrom('domains').selectAll().where('domain', '=', D).executeTakeFirstOrThrow();
    expect([d.bin_cents, d.floor_cents, d.walkaway_cents, d.min_offer_cents, d.pricing_source, d.pricing_settings_version]).toEqual([148800, 96700, 95000, 10000, 'approved_exception', 3]);
  });
});

describe('v3 settings cross-field rules', () => {
  const now = () => new Date(Date.now() - 60_000);
  const at = () => new Date(Date.now() - 3_600_000).toISOString();
  it('floor_rounding=dollar or lander exceptions outside ladder mode are refused', async () => {
    await expect(newPricingSettings(db, { set: { floor_rounding: 'dollar' }, approvalText: 'x', approvalAt: at(), now: now() })).rejects.toThrow(/need drop_mode ladder/);
    await expect(newPricingSettings(db, { set: { lander_exception_bins_cents: '[198800]' }, approvalText: 'x', approvalAt: at(), now: now() })).rejects.toThrow(/need drop_mode ladder|check constraint/);
  });
  it('price-list values must be whole dollars', async () => {
    await expect(newPricingSettings(db, { set: { ...V3_SET, allowed_bins_cents: '[29900,39900,49900,78850,108800,148800,198800,248800]' }, approvalText: 'x', approvalAt: at(), now: now() })).rejects.toThrow(/whole dollars/);
  });
});
