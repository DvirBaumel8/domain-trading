import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { makeApp } from '../../helpers/app.js';
import { COMPS, buyBody, postBuy } from '../../helpers/buy.js';
import { testDb as db } from '../../helpers/db.js';
import { FakeAdapter } from '../../helpers/fake-adapter.js';
import { issueToken } from '../../helpers/tokens.js';

let app: FastifyInstance;
afterEach(async () => app?.close());

// v2 takes effect 2026-10-05 09:17 IDT, so the fixed clock is one day later than B-28's 4 Oct (dates shift by one day).
const NOW = Date.parse('2026-10-05T10:00:00Z');
const D = 'promptinjectionaudit.com';
const trend = (over: Record<string, unknown> = {}) => {
  const { price_grade: _g, ...b } = buyBody({
    domain: D, category: 'trend', approval_ref: { text: `yes buy ${D}`, approved_at: new Date(NOW - 3_600_000).toISOString() },
  });
  return { ...b, ...over };
};
const geo = (grade: 'strong' | 'weaker', over: Record<string, unknown> = {}) =>
  buyBody({ domain: D, price_grade: grade, approval_ref: { text: `yes buy ${D}`, approved_at: new Date(NOW - 3_600_000).toISOString() }, ...over });

async function setup(pb = new FakeAdapter('porkbun', { domainInfo: { expiryDate: '2027-10-05' } })) {
  app = await makeApp({ adapters: [pb], rdap: async () => 'not_registered', now: () => NOW });
  return { pb, auth: (await issueToken('write')).auth };
}
const registers = (pb: FakeAdapter) => pb.calls.filter((c) => c.startsWith('register'));
const HYBRID = { mode: 'hybrid', bin: 1995 };
const one = <T>(xs: T[]) => {
  expect(xs).toHaveLength(1);
  return xs[0]!;
};
const sched = async () => (await db.selectFrom('price_schedule').selectAll().orderBy('due_on').execute())
  .map((r) => ({ event: r.event, due_on: String(r.due_on).slice(0, 10), bin: r.bin_cents, floor: r.floor_cents, walk: r.walkaway_cents }));

describe('POST /buy v2 listing', () => {
  it('B-28: hybrid 1995 + comps → domain, evidence, 4 schedule rows (PR-12 from the buy date), plan_audit_id', async () => {
    const { auth } = await setup();
    const res = await postBuy(app, trend({ proposed_listing: HYBRID, expected_settings_version: 2 }), auth);
    expect(res.statusCode).toBe(201);
    const b = res.json();
    const dom = one(await db.selectFrom('domains').selectAll().execute());
    expect(dom).toMatchObject({
      status: 'listed', listing_mode: 'hybrid', bin_cents: 199500, floor_cents: 129500, walkaway_cents: 96000, min_offer_cents: 10000,
      pricing_source: 'formula', pricing_settings_version: 2, category: 'trend', plan_audit_id: b.audit_id, drop_date: '2028-10-05',
    });
    expect(dom.first_listed_at?.toISOString()).toBe('2026-10-05T10:00:00.000Z');
    expect(dom.listing_changed_at?.getTime()).toBe(NOW);
    expect(dom.export_pending_since?.getTime()).toBe(NOW);
    const ev = one(await db.selectFrom('pricing_evidence').selectAll().execute());
    expect(ev).toMatchObject({ audit_id: b.audit_id, rationale: 'fixture', domain_id: dom.id });
    expect(ev.comps).toHaveLength(2);
    expect(await sched()).toEqual([
      { event: 'drop1_m6', due_on: '2027-04-05', bin: 159500, floor: 103500, walk: 77000 },
      { event: 'drop2_m18', due_on: '2028-04-05', bin: 129500, floor: 83000, walk: 61500 },
      { event: 'final_push', due_on: '2028-07-07', bin: 89500, floor: 83000, walk: 61500 },
      { event: 'delist', due_on: '2028-09-28', bin: null, floor: null, walk: null },
    ]);
    expect(one(await db.selectFrom('listing_history').selectAll().execute())).toMatchObject({ source: 'buy', plan_audit_id: b.audit_id });
    expect(b.post_buy.listing.schedule).toHaveLength(4);
  });

  it('geo weaker 399 → listed, delist-only schedule', async () => {
    const { auth } = await setup();
    const res = await postBuy(app, geo('weaker', { proposed_listing: { mode: 'bin', bin: 399 } }), auth);
    expect(res.statusCode).toBe(201);
    expect(one(await db.selectFrom('domains').selectAll().execute())).toMatchObject({ status: 'listed', bin_cents: 39900, price_grade: 'weaker' });
    expect((await sched()).map((r) => r.event)).toEqual(['delist']);
  });

  it('geo strong 499 → geo_drop_m12 + delist', async () => {
    const { auth } = await setup();
    const res = await postBuy(app, geo('strong', { proposed_listing: { mode: 'bin', bin: 499 } }), auth);
    expect(res.statusCode).toBe(201);
    expect((await sched()).map((r) => r.event)).toEqual(['geo_drop_m12', 'delist']);
  });

  it.each([
    ['LG-16 hybrid 1990', { proposed_listing: { mode: 'hybrid', bin: 1990 } }, 422, 'BIN_NOT_NICE'],
    ['floor 1200 without exception', { proposed_listing: { mode: 'hybrid', bin: 1995, floor: 1200 } }, 422, 'PRICING_FORMULA_MISMATCH'],
    ['trend plain bin without override', { proposed_listing: { mode: 'bin', bin: 999 } }, 422, 'MODE_NOT_ALLOWED_FOR_CATEGORY'],
    ['1 comp', { proposed_listing: HYBRID, pricing_evidence: { comps: [COMPS[0]] } }, 422, 'COMPS_REQUIRED'],
    ['missing evidence', { proposed_listing: HYBRID, pricing_evidence: undefined }, 422, 'COMPS_REQUIRED'],
    ['version 1', { proposed_listing: HYBRID, expected_settings_version: 1 }, 409, 'SETTINGS_VERSION_CHANGED'],
    ['LG-20 http comp', { proposed_listing: HYBRID, pricing_evidence: { comps: [{ ...COMPS[0], source_url: 'http://namebio.com/x' }, COMPS[1]] } }, 422, 'COMPS_INVALID'],
  ])('%s → no registrar call', async (_n, over, status, code) => {
    const { pb, auth } = await setup();
    const res = await postBuy(app, trend(over), auth);
    expect([res.statusCode, res.json().error.code]).toEqual([status, code]);
    expect(registers(pb)).toEqual([]);
    expect(pb.calls).toEqual([]);
  });

  it('LG-17/18/19: no category, geo without grade, geo strong with 399, non-geo with grade', async () => {
    const { pb, auth } = await setup();
    const { category: _c, ...nocat } = trend();
    const { price_grade: _g, ...nograde } = geo('weaker');
    const cases: [object, number, string][] = [
      [nocat, 422, 'CATEGORY_REQUIRED'],
      [nograde, 422, 'GEO_GRADE_REQUIRED'],
      [geo('strong', { proposed_listing: { mode: 'bin', bin: 399 } }), 422, 'GEO_BIN_NOT_GRADE_PRICE'],
      [trend({ price_grade: 'strong' }), 422, 'GRADE_NOT_GEO'],
    ];
    for (const [body, status, code] of cases) {
      const res = await postBuy(app, body, auth);
      expect([res.statusCode, res.json().error?.code ?? res.body]).toEqual([status, code]);
    }
    expect(pb.calls).toEqual([]);
  });

  it('Q3 exception via /buy: stored walk-away 950, approved_exception', async () => {
    const { auth } = await setup();
    const res = await postBuy(app, trend({
      proposed_listing: { mode: 'hybrid', bin: 1995, floor: 1295, walkaway: 950, pricing_exception: true, pricing_exception_reason: 'Dvir 00:39' },
    }), auth);
    expect(res.statusCode).toBe(201);
    expect(one(await db.selectFrom('domains').selectAll().execute())).toMatchObject({ walkaway_cents: 95000, pricing_source: 'approved_exception' });
  });

  it('auto_list:false → evidence saved, no listing or schedule, owned, grade stored', async () => {
    const { auth } = await setup();
    const res = await postBuy(app, geo('strong', { auto_list: false, proposed_listing: { mode: 'bin', bin: 499 } }), auth);
    expect(res.statusCode).toBe(201);
    expect(one(await db.selectFrom('domains').selectAll().execute())).toMatchObject({ status: 'owned', price_grade: 'strong', listing_mode: null });
    expect(await db.selectFrom('pricing_evidence').selectAll().execute()).toHaveLength(1);
    expect(await db.selectFrom('price_schedule').selectAll().execute()).toHaveLength(0);
    expect(await db.selectFrom('listing_history').selectAll().execute()).toHaveLength(0);
  });

  it('dry run → planView with cents and display strings, settings_version 2, no evidence or schedule rows', async () => {
    const { auth } = await setup();
    const res = await postBuy(app, trend({ dry_run: true, proposed_listing: HYBRID }), auth);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      settings_version: 2,
      proposed_listing: { mode: 'hybrid', bin_cents: 199500, bin: '$1,995', floor_cents: 129500, floor: '$1,295', walkaway_cents: 96000, min_offer_cents: 10000 },
    });
    expect(await db.selectFrom('pricing_evidence').selectAll().execute()).toHaveLength(0);
    expect(await db.selectFrom('price_schedule').selectAll().execute()).toHaveLength(0);
  });

  it('PR-17 parity: /buy dry run shows the same plan and schedule as GET /pricing/preview on the same clock', async () => {
    const { auth, pb } = await setup();
    const res = await postBuy(app, trend({ dry_run: true, proposed_listing: HYBRID }), auth);
    expect(res.statusCode).toBe(200);
    const prev = await app.inject({ method: 'GET', url: '/pricing/preview?category=trend&bin=1995', headers: auth });
    expect(prev.statusCode).toBe(200);
    const a = res.json().proposed_listing;
    const b = prev.json();
    expect(a.schedule).toHaveLength(4);
    for (const k of ['bin_cents', 'floor_cents', 'walkaway_cents', 'min_offer_cents', 'schedule', 'sell_plan_line']) expect(a[k]).toEqual(b[k]);
    expect(registers(pb).every((c) => c.includes('dry=true'))).toBe(true);
  });

  it('V1 first: proposed_listing mode auction with no category -> MODE_INVALID and no adapter call', async () => {
    const { auth, pb } = await setup();
    const { category: _c, ...b } = trend({ proposed_listing: { mode: 'auction', bin: 1995 } });
    const res = await postBuy(app, b, auth);
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe('MODE_INVALID');
    expect(pb.calls).toHaveLength(0);
  });
});
