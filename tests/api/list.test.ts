import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { RegistrarError } from '../../src/registrars/types.js';
import { makeApp } from '../helpers/app.js';
import { newPricingSettings } from '../../src/admin/pricing-settings.js';
import { insertOwnedDomain, testDb as db } from '../helpers/db.js';
import { FakeAdapter } from '../helpers/fake-adapter.js';
import { listedDomain } from '../helpers/listing.js';
import { issueToken } from '../helpers/tokens.js';

let app: FastifyInstance;
afterEach(async () => app?.close());
const D = 'examplecityroofing.com';
const NOW = Date.parse('2026-10-12T09:00:00Z');
const approval = (domain = D, at = NOW) => ({ text: `yes list ${domain}`, approved_at: new Date(at - 3_600_000).toISOString() });

async function setup(pb = new FakeAdapter('porkbun'), nsLookup = async () => null as string[] | null, now = NOW) {
  app = await makeApp({ adapters: [pb], nsLookup, now: () => now });
  return { auth: (await issueToken('write')).auth, pb };
}
const list = (body: object, auth: Record<string, string>, domain = D, key: string = randomUUID()) =>
  app.inject({ method: 'POST', url: `/list/${domain}`, headers: { ...auth, 'idempotency-key': key }, payload: body });
const history = () => db.selectFrom('listing_history').selectAll().orderBy('id').execute();
const schedule = (domain = D) => db.selectFrom('price_schedule').innerJoin('domains', 'domains.id', 'price_schedule.domain_id').selectAll('price_schedule')
  .where('domains.domain', '=', domain).orderBy('price_schedule.id').execute();
const rowsOf = (r: Awaited<ReturnType<typeof schedule>>) => r.map((e) => [e.event, e.due_on, e.bin_cents, e.floor_cents, e.walkaway_cents, e.status]);
const dom = () => db.selectFrom('domains').selectAll().where('domain', '=', D).executeTakeFirstOrThrow();

describe('POST /list/{domain}', () => {
  it('L-1: default lander → registrar gets exactly the afternic pair; set compare tolerates order; DB updated', async () => {
    const { auth, pb } = await setup(new FakeAdapter('porkbun', { getNs: ['NS2.AFTERNIC.COM.', 'ns1.afternic.com'] }));
    await insertOwnedDomain(db, { domain: D });
    const res = await list({}, auth);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ns_status: 'set', lander: 'afternic', ns: ['ns1.afternic.com', 'ns2.afternic.com'] });
    expect(pb.calls).toContain(`setNameservers ${D} ns1.afternic.com,ns2.afternic.com`);
    expect(await dom()).toMatchObject({ lander: 'afternic', lander_ns: ['ns1.afternic.com', 'ns2.afternic.com'], ns_verified_at: null });
  });

  it('L-2: lander "dan" → 422 LANDER_RETIRED', async () => {
    const { auth } = await setup();
    await insertOwnedDomain(db, { domain: D });
    expect((await list({ lander: 'dan' }, auth)).json().error.code).toBe('LANDER_RETIRED');
  });

  it('L-3: custom with 1 NS / 5 NS / an invalid hostname → 422', async () => {
    const { auth } = await setup();
    await insertOwnedDomain(db, { domain: D });
    for (const ns of [['ns1.x.com'], ['a.x.com', 'b.x.com', 'c.x.com', 'd.x.com', 'e.x.com'], ['ns1.x.com', 'bad_host!']]) {
      expect((await list({ lander: 'custom', ns }, auth)).statusCode).toBe(422);
    }
  });

  it('custom with 2 valid NS → set', async () => {
    const { auth, pb } = await setup();
    await insertOwnedDomain(db, { domain: D });
    const res = await list({ lander: 'custom', ns: ['NS1.Example.net', 'ns2.example.net'] }, auth);
    expect(res.json()).toMatchObject({ ns_status: 'set', lander: 'custom', ns: ['ns1.example.net', 'ns2.example.net'] });
    expect(pb.calls).toContain(`setNameservers ${D} ns1.example.net,ns2.example.net`);
  });

  it('L-4: not in the portfolio (missing, or sold) → 404 NOT_IN_PORTFOLIO, no registrar call', async () => {
    const { auth, pb } = await setup();
    expect((await list({}, auth)).json().error.code).toBe('NOT_IN_PORTFOLIO');
    await insertOwnedDomain(db, { domain: D, status: 'sold' });
    expect((await list({}, auth)).statusCode).toBe(404);
    expect(pb.calls).toEqual([]);
  });

  it('L-6/L5: API_ACCESS_DISABLED → 409 with the opt-in hint; nothing saved', async () => {
    const { auth } = await setup(new FakeAdapter('porkbun', { setNs: new RegistrarError('porkbun', 'API_ACCESS_DISABLED', 'x') }));
    await insertOwnedDomain(db, { domain: D });
    const res = await list({ mode: 'bin', bin: 399, approval_ref: approval() }, auth);
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toMatchObject({ code: 'API_ACCESS_DISABLED', message: expect.stringMatching(/Opt In All Domains/) });
    expect(await dom()).toMatchObject({ listing_mode: null, status: 'owned' });
    expect(await history()).toHaveLength(0);
  });

  it('L-7: READ token → 403', async () => {
    await setup();
    await insertOwnedDomain(db, { domain: D });
    const { auth } = await issueToken('read');
    expect((await list({}, auth)).statusCode).toBe(403);
  });

  it('L-8: idempotent replay → 1 registrar NS call', async () => {
    const { auth, pb } = await setup();
    await insertOwnedDomain(db, { domain: D });
    await list({}, auth, D, 'k-l8');
    const b = await list({}, auth, D, 'k-l8');
    expect(b.headers['idempotent-replayed']).toBe('true');
    expect(pb.calls.filter((c) => c.startsWith('setNameservers'))).toHaveLength(1);
  });

  it('L-9/LH-2: one audit row per call including refusals; a rejected change writes no history', async () => {
    const { auth } = await setup();
    await insertOwnedDomain(db, { domain: D });
    await list({ mode: 'bin', bin: 650, approval_ref: approval() }, auth); // geo out of range → 422
    await list({}, auth);
    expect(await db.selectFrom('audit_log').selectAll().where('path', 'like', '/list/%').execute()).toHaveLength(2);
    expect(await history()).toHaveLength(0);
  });

  it('L-11 / Review Focus 1: registrar_api none → 200 ns_status manual with steps; 0 registrar calls; prices saved', async () => {
    const { auth, pb } = await setup();
    await insertOwnedDomain(db, { domain: D, registrar: 'godaddy', registrar_api: 'none', category: 'trend' });
    const res = await list({ mode: 'hybrid', bin: 1995, approval_ref: approval() }, auth);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ns_status: 'manual', manual_steps: expect.arrayContaining([expect.stringMatching(/ns1\.afternic\.com.*ns2\.afternic\.com/)]) });
    expect(pb.calls).toEqual([]);
    expect(await dom()).toMatchObject({ status: 'listed', listing_mode: 'hybrid', bin_cents: 199500, lander: 'afternic' });
  });

  it('LH-1: hybrid 1995 -> hybrid 2495 -> hold = 3 history rows in order, each with audit_id; status listed', async () => {
    const { auth } = await setup();
    await insertOwnedDomain(db, { domain: D, category: 'trend', price_grade: null });
    await list({ mode: 'hybrid', bin: 1995, approval_ref: approval() }, auth);
    await list({ mode: 'hybrid', bin: 2495, approval_ref: approval() }, auth);
    await list({ pricing_hold: true, pricing_hold_reason: 'waiting for a buyer', approval_ref: approval() }, auth);
    const h = await history();
    expect(h.map((r) => [r.source, r.mode, r.bin_cents])).toEqual([['list', 'hybrid', 199500], ['list', 'hybrid', 249500], ['list', 'hybrid', 249500]]);
    expect(h.every((r) => /^aud_/.test(r.audit_id ?? ''))).toBe(true);
    expect(await dom()).toMatchObject({ status: 'listed', listing_mode: 'hybrid', bin_cents: 249500, floor_cents: 162000, pricing_hold: true });
  });

  it('LH-4: dry_run -> 4 schedule events previewed, 0 history, 0 schedule rows, first_listed_at still null, no NS call', async () => {
    const { auth, pb } = await setup();
    await insertOwnedDomain(db, { domain: D, category: 'trend', price_grade: null });
    const res = await list({ mode: 'hybrid', bin: 1995, dry_run: true, approval_ref: approval() }, auth);
    expect(res.statusCode).toBe(200);
    const j = res.json();
    expect(j).toMatchObject({ dry_run: true, valid: true, preview: { afternic: `${D},1995,1295,100,N,,Custom Lander,Y,N,Y,N`, sedo: null } });
    expect(j.listing.schedule).toHaveLength(4);
    expect(await history()).toHaveLength(0);
    expect(await schedule()).toHaveLength(0);
    expect(pb.calls).toEqual([]);
    expect(await dom()).toMatchObject({ listing_mode: null, first_listed_at: null, export_pending_since: null });
  });

  it('LG-13: a price change without approval_ref -> 422 APPROVAL_REQUIRED; 0 history, 0 schedule rows, 1 audit row', async () => {
    const { auth } = await setup();
    await insertOwnedDomain(db, { domain: D, category: 'trend', price_grade: null });
    expect((await list({ mode: 'hybrid', bin: 1995 }, auth)).json().error.code).toBe('APPROVAL_REQUIRED');
    expect(await history()).toHaveLength(0);
    expect(await schedule()).toHaveLength(0);
    expect(await db.selectFrom('audit_log').selectAll().where('path', 'like', '/list/%').execute()).toHaveLength(1);
  });

  it('LG-14: NS-only re-point without approval_ref → 200', async () => {
    const { auth } = await setup();
    await insertOwnedDomain(db, { domain: D });
    expect((await list({ lander: 'afternic' }, auth)).statusCode).toBe(200);
  });

  it('an invalid approval_ref (names another domain) → 422 APPROVAL_INVALID', async () => {
    const { auth } = await setup();
    await insertOwnedDomain(db, { domain: D });
    expect((await list({ mode: 'bin', bin: 399, approval_ref: approval('other.com') }, auth)).json().error.code).toBe('APPROVAL_INVALID');
  });

  it('LG-11 / Review Focus 2: trend → geo without override → 422 OVERRIDE_NEEDS_APPROVAL', async () => {
    const { auth } = await setup();
    await insertOwnedDomain(db, { domain: D, category: 'trend' });
    expect((await list({ category: 'geo', mode: 'bin', bin: 399, approval_ref: approval() }, auth)).json().error.code).toBe('OVERRIDE_NEEDS_APPROVAL');
  });

  it('trend → geo WITH override + reason + approval → OK; history records override + reason', async () => {
    const { auth } = await setup();
    await insertOwnedDomain(db, { domain: D, category: 'trend' });
    const res = await list({ category: 'geo', price_grade: 'weaker', mode: 'bin', bin: 399, override: true, override_reason: 'really a city name', approval_ref: approval() }, auth);
    expect(res.statusCode).toBe(200);
    const [h] = await history();
    expect(h).toMatchObject({ category: 'geo', override: true, override_reason: 'really a city name' });
    expect((await dom()).category).toBe('geo');
  });

  it('L3 / Review Focus 2: a category change alone re-validates the existing listing (geo bin 399 -> trend needs an override)', async () => {
    const { auth } = await setup();
    await listedDomain({ domain: D, category: 'geo', price_grade: 'weaker', listing_mode: 'bin', bin_cents: 39900, floor_cents: 39900, walkaway_cents: 39900, min_offer_cents: 39900 });
    expect((await list({ category: 'trend', approval_ref: approval() }, auth)).json().error.code).toBe('MODE_NOT_ALLOWED_FOR_CATEGORY');
  });

  it('a category change without approval → 422 APPROVAL_REQUIRED (V9)', async () => {
    const { auth } = await setup();
    await insertOwnedDomain(db, { domain: D, category: 'geo' });
    expect((await list({ category: 'b2b' }, auth)).json().error.code).toBe('APPROVAL_REQUIRED');
  });

  it('LG-4: geo bin 650 with override + reason + approval → 200; override recorded', async () => {
    const { auth } = await setup();
    await insertOwnedDomain(db, { domain: D });
    const res = await list({ mode: 'bin', bin: 650, override: true, override_reason: 'premium city', approval_ref: approval() }, auth);
    expect(res.statusCode).toBe(200);
    expect((await history())[0]).toMatchObject({ override: true, override_reason: 'premium city', approval_text: expect.stringContaining(D) });
  });

  it('LS-14/LG-12: unknown or settings fields → 422 (strict schema); settings unchanged', async () => {
    const { auth } = await setup();
    await insertOwnedDomain(db, { domain: D });
    expect((await list({ mode: 'bin', bin: 399, offer: true, approval_ref: approval() }, auth)).statusCode).toBe(422);
    expect((await list({ floor_bps: 5000, approval_ref: approval() }, auth)).statusCode).toBe(422);
    expect((await db.selectFrom('pricing_settings').select('floor_bps').where('version', '=', 2).executeTakeFirstOrThrow()).floor_bps).toBe(6500);
  });

  it('prices without mode → 422 MODE_INVALID', async () => {
    const { auth } = await setup();
    await insertOwnedDomain(db, { domain: D });
    expect((await list({ bin: 399, approval_ref: approval() }, auth)).json().error.code).toBe('MODE_INVALID');
  });

  it('L4 / Review Focus 4: display_name must lowercase to the domain', async () => {
    const { auth } = await setup();
    await insertOwnedDomain(db, { domain: D });
    expect((await list({ display_name: 'OtherName.com' }, auth)).json().error.code).toBe('DISPLAY_NAME_MISMATCH');
    expect((await list({ display_name: 'ExampleCityRoofing.com' }, auth)).statusCode).toBe(200);
    expect((await dom()).display_name).toBe('ExampleCityRoofing.com');
  });

  it('prices with cents are refused: LISTING_PRICE_INVALID (whole dollars only)', async () => {
    const { auth } = await setup();
    await insertOwnedDomain(db, { domain: D });
    const res = await list({ mode: 'bin', bin: 399.5, approval_ref: approval() }, auth);
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe('LISTING_PRICE_INVALID');
  });

  it('L6: immediate public-DNS check: match → ns_public match + ns_verified_at set; no answer → pending/unknown', async () => {
    const { auth } = await setup(new FakeAdapter('porkbun'), async () => ['ns2.afternic.com', 'ns1.afternic.com']);
    await insertOwnedDomain(db, { domain: D });
    const res = await list({}, auth);
    expect(res.json().ns_public).toBe('match');
    expect((await dom()).ns_verified_at).not.toBeNull();
  });

  it('returns the manual marketplace checklist incl. the day-60 Fast Transfer date', async () => {
    const { auth } = await setup();
    await insertOwnedDomain(db, { domain: D, buy_date: '2026-10-04' });
    const res = await list({ mode: 'bin', bin: 399, approval_ref: approval() }, auth);
    expect(res.json().checklist).toEqual(expect.arrayContaining([
      expect.stringMatching(/afternic\.csv.*Update/), expect.stringMatching(/sedo\.csv/), expect.stringMatching(/2026-12-03/),
    ]));
  });

  it('relabel guard: any non-geo -> geo needs override + reason + approval', async () => {
    const { auth } = await setup();
    await insertOwnedDomain(db, { domain: D, category: 'trend' });
    expect((await list({ category: 'other', approval_ref: approval() }, auth)).statusCode).toBe(200);
    const res = await list({ category: 'geo', mode: 'bin', bin: 399, approval_ref: approval() }, auth);
    expect(res.json().error.code).toBe('OVERRIDE_NEEDS_APPROVAL');
  });

  it('LG-5: geo bin 650 with override+reason but no / stale / wrong-domain approval -> OVERRIDE_NEEDS_APPROVAL', async () => {
    const { auth } = await setup();
    await insertOwnedDomain(db, { domain: D });
    const base = { mode: 'bin', bin: 650, override: true, override_reason: 'premium city' };
    const stale = { text: `yes list ${D}`, approved_at: new Date(NOW - 73 * 3_600_000).toISOString() };
    for (const approval_ref of [undefined, stale, approval('other.com')]) {
      expect((await list({ ...base, approval_ref }, auth)).json().error.code).toBe('OVERRIDE_NEEDS_APPROVAL');
    }
  });

  it('V1 precedes V9: bad mode without approval -> MODE_INVALID', async () => {
    const { auth } = await setup();
    await insertOwnedDomain(db, { domain: D });
    expect((await list({ mode: 'auction', bin: 399 }, auth)).json().error.code).toBe('MODE_INVALID');
  });

  it('an invalid approval_ref is rejected even for NS-only requests', async () => {
    const { auth } = await setup();
    await insertOwnedDomain(db, { domain: D });
    expect((await list({ approval_ref: approval('other.com') }, auth)).json().error.code).toBe('APPROVAL_INVALID');
  });

  it('sold race: domain sold during the NS call -> 404, stays sold, no history', async () => {
    const pb = new FakeAdapter('porkbun', { onSetNs: async () => { await db.updateTable('domains').set({ status: 'sold' }).execute(); } });
    const { auth } = await setup(pb);
    await insertOwnedDomain(db, { domain: D });
    const res = await list({ mode: 'bin', bin: 399, approval_ref: approval() }, auth);
    expect(res.statusCode).toBe(404);
    expect((await dom()).status).toBe('sold');
    expect(await history()).toHaveLength(0);
  });

  it('listing changed during the NS call -> 409 LISTING_CHANGED_CONCURRENTLY', async () => {
    const pb = new FakeAdapter('porkbun', { onSetNs: async () => { await db.updateTable('domains').set({ bin_cents: 1 }).execute(); } });
    const { auth } = await setup(pb);
    await insertOwnedDomain(db, { domain: D });
    const res = await list({ mode: 'bin', bin: 399, approval_ref: approval() }, auth);
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('LISTING_CHANGED_CONCURRENTLY');
  });

  it('getNameservers failing -> 200 ns_status unverified, lander saved', async () => {
    const { auth } = await setup(new FakeAdapter('porkbun', { getNsError: new RegistrarError('porkbun', 'NETWORK', 'x') }));
    await insertOwnedDomain(db, { domain: D });
    const res = await list({}, auth);
    expect(res.statusCode).toBe(200);
    expect(res.json().ns_status).toBe('unverified');
    expect((await dom()).lander).toBe('afternic');
  });

  it('mismatch: registrar reports other NS -> ns_status mismatch; DNS shows other NS -> ns_public pending', async () => {
    const { auth } = await setup(new FakeAdapter('porkbun', { getNs: ['ns1.other.com', 'ns2.other.com'] }), async () => ['ns1.other.com']);
    await insertOwnedDomain(db, { domain: D });
    const j = (await list({}, auth)).json();
    expect(j.ns_status).toBe('mismatch');
    expect(j.ns_public).toBe('pending');
  });

  it('non-access registrar error on set -> 409 REGISTRAR_REJECTED with registrar_code', async () => {
    const { auth } = await setup(new FakeAdapter('porkbun', { setNs: new RegistrarError('porkbun', 'DOMAIN_LOCKED', 'x') }));
    await insertOwnedDomain(db, { domain: D });
    const res = await list({}, auth);
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toMatchObject({ code: 'REGISTRAR_REJECTED', details: { registrar_code: 'DOMAIN_LOCKED' } });
  });

  it('custom NS duplicates are deduped before the count check', async () => {
    const { auth } = await setup();
    await insertOwnedDomain(db, { domain: D });
    expect((await list({ lander: 'custom', ns: ['ns1.x.com', 'NS1.x.com'] }, auth)).statusCode).toBe(422);
  });

  it('ns_verified_at cleared when the NS target changes, kept when unchanged; target change adds a history row', async () => {
    const { auth } = await setup();
    await insertOwnedDomain(db, { domain: D });
    const verified = new Date('2026-10-01T00:00:00Z');
    await db.updateTable('domains').set({ lander: 'sedo', lander_ns: ['ns1.sedoparking.com', 'ns2.sedoparking.com'], ns_verified_at: verified }).execute();
    await list({ lander: 'sedo' }, auth);
    expect((await dom()).ns_verified_at).not.toBeNull();
    expect(await history()).toHaveLength(0);
    await list({ lander: 'afternic' }, auth);
    expect((await dom()).ns_verified_at).toBeNull();
    expect(await history()).toHaveLength(1);
  });

  // ---- pricing v2 (4b-2 Task 3) ----
  const trendOwned = (over: Record<string, unknown> = {}) => insertOwnedDomain(db, { domain: D, category: 'trend', price_grade: null, ...over });
  const PR12 = [
    ['drop1_m6', '2027-04-12', 159500, 103500, 77000, 'planned'],
    ['drop2_m18', '2028-04-12', 129500, 83000, 61500, 'planned'],
    ['final_push', '2028-07-06', 89500, 83000, 61500, 'planned'],
    ['delist', '2028-09-27', null, null, null, 'planned'],
  ];
  const PR11 = [
    ['drop1_m6', '2027-04-12', 159500, 103500, 76000, 'planned'],
    ['drop2_m18', '2028-04-12', 129500, 83000, 61000, 'planned'],
    ['final_push', '2028-07-06', 89500, 83000, 61000, 'planned'],
    ['delist', '2028-09-27', null, null, null, 'planned'],
  ];

  it('L-14: first /list hybrid 1995 -> computed 1995/1295/960/100, first_listed_at = now, schedule = PR-12, plan_audit_id = this call', async () => {
    const { auth } = await setup();
    await trendOwned();
    const res = await list({ mode: 'hybrid', bin: 1995, approval_ref: approval() }, auth);
    expect(res.statusCode).toBe(200);
    expect(res.json().listing).toMatchObject({ bin_cents: 199500, floor_cents: 129500, walkaway_cents: 96000, min_offer_cents: 10000, pricing_source: 'formula', settings_version: 2 });
    expect(res.json().listing.schedule).toHaveLength(4);
    const d = await dom();
    expect(d.first_listed_at?.getTime()).toBe(NOW);
    expect(d.export_pending_since?.getTime()).toBe(NOW);
    expect(rowsOf(await schedule())).toEqual(PR12);
    const audit = await db.selectFrom('audit_log').select('id').where('path', 'like', '/list/%').executeTakeFirstOrThrow();
    expect(d.plan_audit_id).toBe(audit.id);
  });

  it('LS-18 via /list: exception 1295/950 -> approved_exception, walkaway stored 95000, schedule = PR-11, 950 never exported', async () => {
    const { auth } = await setup();
    await trendOwned();
    const res = await list({ mode: 'hybrid', bin: 1995, floor: 1295, walkaway: 950, pricing_exception: true, pricing_exception_reason: 'D-001 approved plan', approval_ref: approval() }, auth);
    expect(res.statusCode).toBe(200);
    expect(res.json().listing.pricing_source).toBe('approved_exception');
    expect(await dom()).toMatchObject({ pricing_source: 'approved_exception', walkaway_cents: 95000 });
    expect(rowsOf(await schedule())).toEqual(PR11);
    const { auth: ra } = await issueToken('read');
    const csv = (await app.inject({ method: 'GET', url: '/export/afternic.csv', headers: ra })).body;
    expect(csv).toContain(`${D},1995,1295,100,`);
    expect(csv).not.toMatch(/(^|,)950(,|\r|$)/);
  });

  it('a pricing exception without approval -> 422 APPROVAL_REQUIRED; without a reason -> EXCEPTION_REASON_REQUIRED', async () => {
    const { auth } = await setup();
    await trendOwned();
    const base = { mode: 'hybrid', bin: 1995, floor: 1295, walkaway: 950, pricing_exception: true };
    expect((await list({ ...base, pricing_exception_reason: 'x' }, auth)).json().error.code).toBe('APPROVAL_REQUIRED');
    expect((await list({ ...base, approval_ref: approval() }, auth)).json().error.code).toBe('EXCEPTION_REASON_REQUIRED');
  });

  it('L-15 / Review Focus 2: hold needs approval and a reason; schedule rows untouched by hold on and off; each change is a history row', async () => {
    const { auth } = await setup();
    await trendOwned();
    await list({ mode: 'hybrid', bin: 1995, approval_ref: approval() }, auth);
    const before = await schedule();
    expect((await list({ pricing_hold: true, pricing_hold_reason: 'buyer in talks' }, auth)).json().error.code).toBe('APPROVAL_REQUIRED');
    expect((await list({ pricing_hold: true, approval_ref: approval() }, auth)).json().error.code).toBe('HOLD_REASON_REQUIRED');
    expect(await history()).toHaveLength(1);
    const on = await list({ pricing_hold: true, pricing_hold_reason: 'buyer in talks', approval_ref: approval() }, auth);
    expect(on.statusCode).toBe(200);
    expect(on.json().pricing_hold).toBe(true);
    expect(await dom()).toMatchObject({ pricing_hold: true, pricing_hold_reason: 'buyer in talks' });
    let h = await history();
    expect(h).toHaveLength(2);
    expect(h[1]).toMatchObject({ bin_cents: 199500, floor_cents: 129500, walkaway_cents: 96000, mode: 'hybrid' });
    expect(await schedule()).toEqual(before);
    const off = await list({ pricing_hold: false, approval_ref: approval() }, auth);
    expect(off.statusCode).toBe(200);
    expect(await dom()).toMatchObject({ pricing_hold: false, pricing_hold_reason: null });
    h = await history();
    expect(h).toHaveLength(3);
    expect(await schedule()).toEqual(before);
    expect((await schedule()).every((r) => r.status === 'planned')).toBe(true);
  });

  it('Review Focus 1: a manual change after M6 applied supersedes planned rows, keeps applied, chains from startAfter, keeps first_listed_at', async () => {
    const { auth } = await setup();
    await trendOwned();
    await list({ mode: 'hybrid', bin: 1995, approval_ref: approval() }, auth);
    const first = await dom();
    await db.updateTable('price_schedule').set({ status: 'applied', applied_at: new Date(NOW) }).where('event', '=', 'drop1_m6').execute();
    const later = Date.parse('2027-05-01T09:00:00Z');
    await app.close();
    const { auth: auth2 } = await setup(new FakeAdapter('porkbun'), async () => null, later);
    const res = await list({ mode: 'hybrid', bin: 1795, approval_ref: approval(D, later) }, auth2);
    expect(res.statusCode).toBe(200);
    const rows = await schedule();
    expect(rows.filter((r) => r.event === 'drop1_m6').map((r) => r.status)).toEqual(['applied']);
    expect(rows.slice(0, 4).filter((r) => r.event !== 'drop1_m6').every((r) => r.status === 'superseded')).toBe(true);
    const now2 = await dom();
    expect(now2.plan_id).not.toBe(first.plan_id);
    expect(now2.first_listed_at?.getTime()).toBe(NOW);
    const fresh = rows.filter((r) => r.plan_id === now2.plan_id);
    expect(rowsOf(fresh)).toEqual([
      ['drop2_m18', '2028-04-12', 139500, 93000, 69000, 'planned'],
      ['final_push', '2028-07-06', 99500, 93000, 69000, 'planned'],
      ['delist', '2028-09-27', null, null, null, 'planned'],
    ]);
    expect(fresh.map((r) => r.event)).toEqual(['drop2_m18', 'final_push', 'delist']);
    expect(now2).toMatchObject({ bin_cents: 179500, floor_cents: 116500, walkaway_cents: 86000 });
  });

  it('delist is never lost: a price change after the final-push date keeps a planned delist row and no drops', async () => {
    const { auth } = await setup();
    await trendOwned();
    await list({ mode: 'hybrid', bin: 1995, approval_ref: approval() }, auth);
    const first = await dom();
    const later = Date.parse('2028-09-30T09:00:00Z');
    await app.close();
    const { auth: auth2 } = await setup(new FakeAdapter('porkbun'), async () => null, later);
    const res = await list({ mode: 'hybrid', bin: 1795, approval_ref: approval(D, later) }, auth2);
    expect(res.statusCode).toBe(200);
    const now2 = await dom();
    expect(now2.plan_id).not.toBe(first.plan_id);
    const fresh = (await schedule()).filter((r) => r.plan_id === now2.plan_id);
    expect(rowsOf(fresh)).toEqual([['delist', '2028-09-27', null, null, null, 'planned']]);
  });

  it('V1 first: mode auction with category geo on a trend domain -> MODE_INVALID', async () => {
    const { auth } = await setup();
    await trendOwned();
    const res = await list({ mode: 'auction', category: 'geo' }, auth);
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe('MODE_INVALID');
  });

  it('replan: a new settings version applies only with replan:true; a manual BIN change keeps the listed version', async () => {
    const { auth } = await setup();
    await trendOwned();
    await list({ mode: 'hybrid', bin: 1995, approval_ref: approval() }, auth);
    await newPricingSettings(db, { set: { floor_bps: '6000' }, approvalText: 'yes new v3', approvalAt: '2026-09-30T12:00:00Z', now: new Date('2026-10-01T00:00:00Z') });
    const manual = await list({ mode: 'hybrid', bin: 2495, approval_ref: approval() }, auth);
    expect(manual.json().listing).toMatchObject({ floor_cents: 162000, settings_version: 2 });
    const before = await db.selectFrom('domains').select('plan_id').executeTakeFirstOrThrow();
    const res = await list({ replan: true, mode: 'hybrid', bin: 1995, approval_ref: approval() }, auth);
    expect(res.statusCode).toBe(200);
    expect(res.json().listing).toMatchObject({ bin_cents: 199500, floor_cents: 119500, settings_version: 3 });
    expect(await dom()).toMatchObject({ floor_cents: 119500, pricing_settings_version: 3 });
    const d = await db.selectFrom('domains').select('plan_id').executeTakeFirstOrThrow();
    expect(d.plan_id).not.toBe(before.plan_id);
    const fresh = (await schedule()).filter((r) => r.plan_id === d.plan_id);
    expect(fresh.length).toBeGreaterThan(0);
    expect(fresh.every((r) => r.settings_version === 3)).toBe(true);
  });

  it('replan with no price fields re-uses the stored BIN under the current settings', async () => {
    const { auth } = await setup();
    await trendOwned();
    await list({ mode: 'hybrid', bin: 1995, approval_ref: approval() }, auth);
    await newPricingSettings(db, { set: { floor_bps: '6000' }, approvalText: 'yes new v3', approvalAt: '2026-09-30T12:00:00Z', now: new Date('2026-10-01T00:00:00Z') });
    const res = await list({ replan: true, approval_ref: approval() }, auth);
    expect(res.json().listing).toMatchObject({ bin_cents: 199500, floor_cents: 119500, settings_version: 3 });
  });

  it('replan of an exception plan drops the exception: formula, walk-away 960 (Q10)', async () => {
    const { auth } = await setup();
    await trendOwned();
    await list({ mode: 'hybrid', bin: 1995, floor: 1295, walkaway: 950, pricing_exception: true, pricing_exception_reason: 'approved', approval_ref: approval() }, auth);
    const res = await list({ replan: true, approval_ref: approval() }, auth);
    expect(res.statusCode).toBe(200);
    expect(await dom()).toMatchObject({ pricing_source: 'formula', walkaway_cents: 96000, floor_cents: 129500 });
  });

  it('a category change on an exception plan carries the approved exception', async () => {
    const { auth } = await setup();
    await trendOwned();
    await list({ mode: 'hybrid', bin: 1995, floor: 1295, walkaway: 950, pricing_exception: true, pricing_exception_reason: 'approved', approval_ref: approval() }, auth);
    await list({ category: 'b2b', approval_ref: approval() }, auth);
    expect(await dom()).toMatchObject({ category: 'b2b', pricing_source: 'approved_exception', walkaway_cents: 95000 });
  });

  it('REPLAN_NOTHING_LISTED: replan on a domain with no listing -> 422', async () => {
    const { auth } = await setup();
    await trendOwned();
    expect((await list({ replan: true, approval_ref: approval() }, auth)).json().error.code).toBe('REPLAN_NOTHING_LISTED');
  });

  it('category change trend -> b2b: history row, plan regenerated, prices unchanged', async () => {
    const { auth } = await setup();
    await trendOwned();
    await list({ mode: 'hybrid', bin: 1995, approval_ref: approval() }, auth);
    const before = await dom();
    const res = await list({ category: 'b2b', approval_ref: approval() }, auth);
    expect(res.statusCode).toBe(200);
    const d = await dom();
    expect(d).toMatchObject({ category: 'b2b', bin_cents: 199500, floor_cents: 129500, walkaway_cents: 96000 });
    expect(d.plan_id).not.toBe(before.plan_id);
    const h = await history();
    expect(h).toHaveLength(2);
    expect(h[1]).toMatchObject({ category: 'b2b', bin_cents: 199500 });
    expect((await schedule()).filter((r) => r.status === 'superseded')).toHaveLength(4);
  });

  it('geo grade: price_grade on a trend name -> 422 GRADE_NOT_GEO', async () => {
    const { auth } = await setup();
    await trendOwned();
    expect((await list({ price_grade: 'strong', approval_ref: approval() }, auth)).json().error.code).toBe('GRADE_NOT_GEO');
  });

  it('geo manual change: bin 299 -> delist-only schedule; 650 needs override + reason + approval', async () => {
    const { auth } = await setup();
    await insertOwnedDomain(db, { domain: D, category: 'geo', price_grade: 'weaker' });
    await list({ mode: 'bin', bin: 399, approval_ref: approval() }, auth);
    const res = await list({ mode: 'bin', bin: 299, approval_ref: approval() }, auth);
    expect(res.statusCode).toBe(200);
    expect((await schedule()).filter((r) => r.status === 'planned').map((r) => r.event)).toEqual(['delist']);
    expect((await list({ mode: 'bin', bin: 650, approval_ref: approval() }, auth)).json().error.code).toBe('GEO_BIN_OUT_OF_RANGE');
    const ok = await list({ mode: 'bin', bin: 650, override: true, override_reason: 'premium city', approval_ref: approval() }, auth);
    expect(ok.statusCode).toBe(200);
    expect((await history()).at(-1)).toMatchObject({ override: true, bin_cents: 65000 });
  });

  it('geo strong at the grade price keeps its M12 drop; the grade change replans', async () => {
    const { auth } = await setup();
    await insertOwnedDomain(db, { domain: D, category: 'geo', price_grade: 'weaker' });
    await list({ mode: 'bin', bin: 499, price_grade: 'strong', approval_ref: approval() }, auth);
    expect(await dom()).toMatchObject({ price_grade: 'strong', bin_cents: 49900 });
    expect((await schedule()).map((r) => r.event)).toEqual(['geo_drop_m12', 'delist']);
  });

  it('offer override (trend): NO_BIN_LESS_EXPOSURE, delist-only schedule (Q1)', async () => {
    const { auth } = await setup();
    await trendOwned();
    const res = await list({ mode: 'offer', min_offer: 500, override: true, override_reason: 'x', approval_ref: approval() }, auth);
    expect(res.statusCode).toBe(200);
    expect(res.json().warnings).toContain('NO_BIN_LESS_EXPOSURE');
    expect((await schedule()).map((r) => r.event)).toEqual(['delist']);
  });

  it('LH-2: a rejected change writes 0 history rows and exactly 1 audit row', async () => {
    const { auth } = await setup();
    await trendOwned();
    expect((await list({ mode: 'hybrid', bin: 1990, approval_ref: approval() }, auth)).statusCode).toBe(422);
    expect(await history()).toHaveLength(0);
    expect(await db.selectFrom('audit_log').selectAll().where('path', 'like', '/list/%').execute()).toHaveLength(1);
  });

  it('Delisted: status delisted -> 404 NOT_IN_PORTFOLIO', async () => {
    const { auth } = await setup();
    await listedDomain({ domain: D, status: 'delisted', delisted_at: new Date(NOW) });
    const res = await list({ mode: 'hybrid', bin: 1995, approval_ref: approval() }, auth);
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('NOT_IN_PORTFOLIO');
  });

  it('PR-17 parity: the /list listing block equals GET /pricing/preview for the same inputs', async () => {
    const { auth } = await setup();
    await trendOwned();
    const res = await list({ mode: 'hybrid', bin: 1995, approval_ref: approval() }, auth);
    const { auth: ra } = await issueToken('read');
    const pv = (await app.inject({ method: 'GET', url: `/pricing/preview?category=trend&bin=1995&listed_on=2026-10-12&domain=${D}`, headers: ra })).json();
    const l = res.json().listing;
    expect({ bin_cents: l.bin_cents, floor_cents: l.floor_cents, walkaway_cents: l.walkaway_cents, min_offer_cents: l.min_offer_cents, schedule: l.schedule, sell_plan_line: l.sell_plan_line })
      .toEqual({ bin_cents: pv.bin_cents, floor_cents: pv.floor_cents, walkaway_cents: pv.walkaway_cents, min_offer_cents: pv.min_offer_cents, schedule: pv.schedule, sell_plan_line: pv.sell_plan_line });
  });

  it('a display_name change flags the export (export_pending_since) without a history row', async () => {
    const { auth } = await setup();
    await trendOwned();
    await list({ display_name: 'ExampleCityRoofing.com' }, auth);
    expect((await dom()).export_pending_since).not.toBeNull();
    expect(await history()).toHaveLength(0);
  });

  it('carry: a category change keeps the stored final-push values and source (no formula recompute)', async () => {
    const { auth } = await setup();
    await listedDomain({ domain: D, bin_cents: 89500, floor_cents: 83000, walkaway_cents: 61500, min_offer_cents: 10000, pricing_source: 'formula' });
    const res = await list({ category: 'b2b', approval_ref: approval() }, auth);
    expect(res.statusCode).toBe(200);
    expect(await dom()).toMatchObject({ category: 'b2b', bin_cents: 89500, floor_cents: 83000, walkaway_cents: 61500, min_offer_cents: 10000, pricing_source: 'formula' });
    expect(res.json().warnings).not.toContain('PRICING_EXCEPTION');
    expect(rowsOf(await schedule())).toEqual([
      ['drop1_m6', '2027-04-12', 79500, 75000, 50000, 'planned'],
      ['drop2_m18', '2028-04-12', 79500, 75000, 50000, 'skipped_at_minimum'],
      ['final_push', '2028-07-06', 79500, 75000, 50000, 'skipped_no_change'],
      ['delist', '2028-09-27', null, null, null, 'planned'],
    ]);
  });

  it('LTO carry: category change on an LTO listing needs override (LTO_NOT_ALLOWED first); with override + reason + approval LTO stays 12; replan without override -> 422', async () => {
    const { auth } = await setup();
    await listedDomain({ domain: D, lto_max_months: 12 });
    expect((await list({ category: 'b2b', approval_ref: approval() }, auth)).json().error.code).toBe('LTO_NOT_ALLOWED');
    expect((await list({ replan: true, approval_ref: approval() }, auth)).json().error.code).toBe('LTO_NOT_ALLOWED');
    const ok = await list({ category: 'b2b', override: true, override_reason: 'keep LTO', approval_ref: approval() }, auth);
    expect(ok.statusCode).toBe(200);
    expect(await dom()).toMatchObject({ category: 'b2b', lto_max_months: 12, bin_cents: 199500 });
  });

  it('grade-only change on a listed geo domain needs approval and writes a history row', async () => {
    const { auth } = await setup();
    await listedDomain({ domain: D, category: 'geo', price_grade: 'weaker', listing_mode: 'bin', bin_cents: 39900, floor_cents: 39900, walkaway_cents: 39900, min_offer_cents: 39900 });
    expect((await list({ price_grade: 'strong' }, auth)).json().error.code).toBe('APPROVAL_REQUIRED');
    expect((await list({ price_grade: 'strong', approval_ref: approval() }, auth)).statusCode).toBe(200);
    expect(await dom()).toMatchObject({ price_grade: 'strong', bin_cents: 39900 });
    const h = await history();
    expect(h).toHaveLength(1);
    expect(h[0]).toMatchObject({ price_grade: 'strong', bin_cents: 39900 });
  });

  it('a category change to geo without a grade -> 422 GEO_GRADE_REQUIRED; to non-geo stores price_grade null', async () => {
    const { auth } = await setup();
    await trendOwned();
    expect((await list({ category: 'geo', override: true, override_reason: 'city', approval_ref: approval() }, auth)).json().error.code).toBe('GEO_GRADE_REQUIRED');
    await db.updateTable('domains').set({ category: 'geo', price_grade: 'weaker' }).execute();
    expect((await list({ category: 'b2b', approval_ref: approval() }, auth)).statusCode).toBe(200);
    expect(await dom()).toMatchObject({ category: 'b2b', price_grade: null });
  });

  it('lander-only change on a listed domain: history row carries the current prices and the existing plan_audit_id', async () => {
    const { auth } = await setup();
    await listedDomain({ domain: D, lander: 'sedo', lander_ns: ['ns1.sedoparking.com', 'ns2.sedoparking.com'], plan_audit_id: 'aud_old' });
    expect((await list({ lander: 'afternic' }, auth)).statusCode).toBe(200);
    const h = await history();
    expect(h).toHaveLength(1);
    expect(h[0]).toMatchObject({ mode: 'hybrid', bin_cents: 199500, floor_cents: 129500, walkaway_cents: 96000, plan_audit_id: 'aud_old', lander: 'afternic' });
    expect((await dom()).plan_audit_id).toBe('aud_old');
  });

  it('a dry run with no plan change shows the current plan schedule', async () => {
    const { auth } = await setup();
    await trendOwned();
    await list({ mode: 'hybrid', bin: 1995, approval_ref: approval() }, auth);
    const res = await list({ dry_run: true }, auth);
    expect(res.json().listing.schedule).toHaveLength(4);
  });
});
