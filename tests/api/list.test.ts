import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { RegistrarError } from '../../src/registrars/types.js';
import { makeApp } from '../helpers/app.js';
import { insertOwnedDomain, testDb as db } from '../helpers/db.js';
import { FakeAdapter } from '../helpers/fake-adapter.js';
import { issueToken } from '../helpers/tokens.js';

let app: FastifyInstance;
afterEach(async () => app?.close());
const D = 'examplecityroofing.com';
const approval = (domain = D) => ({ text: `yes list ${domain}`, approved_at: new Date(Date.now() - 3_600_000).toISOString() });

async function setup(pb = new FakeAdapter('porkbun'), nsLookup = async () => null as string[] | null) {
  app = await makeApp({ adapters: [pb], nsLookup });
  return { auth: (await issueToken('write')).auth, pb };
}
const list = (body: object, auth: Record<string, string>, domain = D, key: string = randomUUID()) =>
  app.inject({ method: 'POST', url: `/list/${domain}`, headers: { ...auth, 'idempotency-key': key }, payload: body });
const history = () => db.selectFrom('listing_history').selectAll().orderBy('id').execute();
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
    const res = await list({ mode: 'hybrid', bin: 1995, floor: 950, min_offer: 950, approval_ref: approval() }, auth);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ns_status: 'manual', manual_steps: expect.arrayContaining([expect.stringMatching(/ns1\.afternic\.com.*ns2\.afternic\.com/)]) });
    expect(pb.calls).toEqual([]);
    expect(await dom()).toMatchObject({ status: 'listed', listing_mode: 'hybrid', bin_cents: 199500, lander: 'afternic' });
  });

  it('LH-1: hybrid → raise BIN → offer = 3 history rows in order, each with audit_id; status listed', async () => {
    const { auth } = await setup();
    await insertOwnedDomain(db, { domain: D, category: 'trend' });
    await list({ mode: 'hybrid', bin: 1995, floor: 950, min_offer: 950, approval_ref: approval() }, auth);
    await list({ mode: 'hybrid', bin: 2495, floor: 950, min_offer: 950, approval_ref: approval() }, auth);
    await list({ mode: 'offer', min_offer: 500, approval_ref: approval() }, auth);
    const h = await history();
    expect(h.map((r) => [r.source, r.mode, r.bin_cents])).toEqual([['list', 'hybrid', 199500], ['list', 'hybrid', 249500], ['list', 'offer', null]]);
    expect(h.every((r) => /^aud_/.test(r.audit_id ?? ''))).toBe(true);
    expect(await dom()).toMatchObject({ status: 'listed', listing_mode: 'offer', bin_cents: null, min_offer_cents: 50000 });
  });

  it('LH-4: dry_run → 0 history rows, no NS call, response previews the Afternic (and Sedo if configured) rows', async () => {
    const { auth, pb } = await setup();
    await insertOwnedDomain(db, { domain: D });
    const res = await list({ mode: 'bin', bin: 399, dry_run: true, approval_ref: approval() }, auth);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ dry_run: true, valid: true, preview: { afternic: `${D},399,399,399,N,,Buy It Now,Y,N,N,N`, sedo: null } });
    expect(await history()).toHaveLength(0);
    expect(pb.calls).toEqual([]);
    expect((await dom()).listing_mode).toBeNull();
  });

  it('LG-13: a price change without approval_ref → 422 APPROVAL_REQUIRED', async () => {
    const { auth } = await setup();
    await insertOwnedDomain(db, { domain: D });
    expect((await list({ mode: 'bin', bin: 399 }, auth)).json().error.code).toBe('APPROVAL_REQUIRED');
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
    const res = await list({ category: 'geo', mode: 'bin', bin: 399, override: true, override_reason: 'really a city name', approval_ref: approval() }, auth);
    expect(res.statusCode).toBe(200);
    const [h] = await history();
    expect(h).toMatchObject({ category: 'geo', override: true, override_reason: 'really a city name' });
    expect((await dom()).category).toBe('geo');
  });

  it('L3 / Review Focus 2: a category change alone re-validates the existing listing (geo bin 399 → trend fails the high-value guard)', async () => {
    const { auth } = await setup();
    await insertOwnedDomain(db, { domain: D, category: 'geo', status: 'listed', listing_mode: 'bin', bin_cents: 39900, floor_cents: 39900, min_offer_cents: 39900 });
    expect((await list({ category: 'trend', approval_ref: approval() }, auth)).json().error.code).toBe('HIGH_VALUE_LOW_BIN');
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
    expect((await list({ geo_bin_max: 999, approval_ref: approval() }, auth)).statusCode).toBe(422);
    expect((await db.selectFrom('settings').select('geo_bin_max_cents').executeTakeFirstOrThrow()).geo_bin_max_cents).toBe(49900);
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

  it('cents in a geo BIN are kept but warned about for Afternic', async () => {
    const { auth } = await setup();
    await insertOwnedDomain(db, { domain: D });
    const res = await list({ mode: 'bin', bin: 399.5, approval_ref: approval() }, auth);
    expect(res.json().warnings).toContain('AFTERNIC_ROUNDS_DOWN');
    expect((await dom()).bin_cents).toBe(39950);
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
});
