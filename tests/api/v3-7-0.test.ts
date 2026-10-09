// v3.7.0: CR-031 B (offer dry run), CR-031 C (hand listings per venue), CR-033 G-1, G-2, G-3, G-6, G-8, G-9.
import { http, HttpResponse } from 'msw';
import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { newAuditId } from '../../src/http/audit.js';
import { RegistrarCheckJob } from '../../src/modules/ops/jobs/registrar-check.js';
import { PorkbunAdapter } from '../../src/modules/registrars/porkbun.js';
import { makeApp, runJobToEnd } from '../helpers/app.js';
import { buyBody, postBuy } from '../helpers/buy.js';
import { insertOwnedDomain, testDb as db } from '../helpers/db.js';
import { FakeAdapter } from '../helpers/fake-adapter.js';
import { listedDomain } from '../helpers/listing.js';
import { FAKE_KEYS, PORKBUN_BASE } from '../helpers/porkbun-msw.js';
import { issueToken } from '../helpers/tokens.js';
import { mswServer } from '../setup/network.js';

let app: FastifyInstance;
afterEach(async () => app?.close());

const AFN = ['ns1.afternic.com', 'ns2.afternic.com'];
const key = () => randomUUID();
const get = (url: string, auth: Record<string, string>) => app.inject({ method: 'GET', url, headers: auth });
const post = (url: string, auth: Record<string, string>, payload: object) =>
  app.inject({ method: 'POST', url, headers: { ...auth, 'idempotency-key': key() }, payload });
const reportWarnings = async (auth: Record<string, string>) =>
  (await get('/report', auth)).json().warnings as { code: string; level: string; domain?: string; details: Record<string, any> }[]; // eslint-disable-line @typescript-eslint/no-explicit-any

describe('v3.7.0 CR-033 G-1: nsVerifier always checks names never verified', () => {
  it('T33-G1: a manual tick after the day\'s NS check verifies a new name whose NS are public; verified names are not re-checked', async () => {
    const NOW = Date.parse('2026-10-09T12:00:00Z');
    const seen: string[] = [];
    app = await makeApp({ now: () => NOW, adapters: [new FakeAdapter('porkbun')], env: { JOB_TRIGGER_TOKEN: 'job_token_fake_0123456789abcdef0123456789' }, nsLookup: async (d) => { seen.push(d); return AFN; } });
    await insertOwnedDomain(db, { domain: 'oldone.com', lander: 'afternic', lander_ns: AFN, ns_verified_at: new Date(NOW - 86_400_000) });
    await insertOwnedDomain(db, { domain: 'newone.com', lander: 'afternic', lander_ns: AFN, ns_verified_at: null });
    await db.insertInto('audit_log').values({ id: newAuditId(), at: new Date(NOW - 3_600_000), scope: 'job', method: 'JOB', path: 'ns-verify', status_code: 200, result_summary: 'earlier today' }).execute();
    const read = (await issueToken('read')).auth;
    expect((await reportWarnings(read)).filter((w) => w.code === 'NS_UNVERIFIED').map((w) => w.domain)).toEqual(['newone.com']);

    const run = await runJobToEnd(app, 'tick');
    expect(run.json().steps.nsVerifier).toMatchObject({ ok: true });
    expect(run.json().steps.nsVerifier.skipped).toBeUndefined();
    expect(seen).toEqual(['newone.com']);
    expect((await db.selectFrom('domains').select('ns_verified_at').where('domain', '=', 'newone.com').executeTakeFirstOrThrow()).ns_verified_at).not.toBeNull();
    expect((await reportWarnings(read)).filter((w) => w.code === 'NS_UNVERIFIED')).toEqual([]);
    // the daily marker is untouched, so the next tick has nothing unverified and is skipped
    expect((await runJobToEnd(app, 'tick')).json().steps.nsVerifier).toMatchObject({ ok: true, skipped: true });
  });
});

describe('v3.7.0 CR-033 G-2 / G-9: /buy display_name and drop_policy', () => {
  const NOW = Date.parse('2026-10-05T10:00:00Z');
  const D = 'ukcbamcompliance.com';
  const body = (over: Record<string, unknown> = {}) => {
    const { price_grade: _g, ...b } = buyBody({ domain: D, category: 'trend', approval_ref: { text: `yes buy ${D}`, approved_at: new Date(NOW - 3_600_000).toISOString() } });
    return { ...b, ...over };
  };
  const HYBRID = { mode: 'hybrid', bin: 1995 };
  async function setup() {
    const pb = new FakeAdapter('porkbun', { domainInfo: { expiryDate: '2027-10-05' } });
    app = await makeApp({ adapters: [pb], rdap: async () => 'not_registered', now: () => NOW });
    return (await issueToken('write')).auth;
  }
  const intake = (words: string[], domain = D) => db.insertInto('candidate_intake').values({ domain, lane: 'S3', source: 'test', token_name: 'scout', status: 'queued', words }).execute();

  it('T33-G2a: the dry run shows a display_name built from the newest intake words, in proposed_listing too', async () => {
    const auth = await setup();
    await intake(['uk', 'cbam', 'compliance']);
    const res = await post('/buy', auth, body({ dry_run: true, proposed_listing: HYBRID }));
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({ display_name: 'UkCbamCompliance.com', proposed_listing: { display_name: 'UkCbamCompliance.com' } });
  });

  it('T33-G2b: an explicit display_name wins; one that is not the domain is DISPLAY_NAME_MISMATCH; without words or a name it is null', async () => {
    const auth = await setup();
    await intake(['uk', 'cbam', 'compliance']);
    expect((await post('/buy', auth, body({ dry_run: true, display_name: 'UKCBAMCompliance.com' }))).json().display_name).toBe('UKCBAMCompliance.com');
    const bad = await post('/buy', auth, body({ dry_run: true, display_name: 'Other.com' }));
    expect([bad.statusCode, bad.json().error.code]).toEqual([422, 'DISPLAY_NAME_MISMATCH']);
    const other = 'nowordsname.com';
    const none = await post('/buy', auth, body({ dry_run: true, domain: other, approval_ref: { text: `yes buy ${other}`, approved_at: new Date(NOW - 3_600_000).toISOString() } }));
    expect(none.json().display_name).toBeNull();
  });

  it('T33-G2c: a real buy stores the display_name and the next Afternic export uses it', async () => {
    const auth = await setup();
    await intake(['uk', 'cbam', 'compliance']);
    const res = await postBuy(app, body({ proposed_listing: HYBRID, expected_settings_version: 2 }), auth);
    expect(res.statusCode, res.body).toBe(201);
    expect(res.json().display_name).toBe('UkCbamCompliance.com');
    expect((await db.selectFrom('domains').select('display_name').where('domain', '=', D).executeTakeFirstOrThrow()).display_name).toBe('UkCbamCompliance.com');
    const csv = await get('/export/afternic.csv', (await issueToken('read')).auth);
    expect(csv.body).toContain('UkCbamCompliance.com');
  });

  it('T33-G9a: the dry run and the 201 carry drop_policy and renewal_committed_cents (default after_one_renewal) and drop_policy_line', async () => {
    const auth = await setup();
    const dry = (await post('/buy', auth, body({ dry_run: true, proposed_listing: HYBRID }))).json();
    expect(dry).toMatchObject({ drop_policy: 'after_one_renewal', renewal_committed_cents: 1108 });
    expect(dry.drop_policy_line).toContain('after one renewal ($11.08');
    const res = await postBuy(app, body({ proposed_listing: HYBRID, expected_settings_version: 2 }), auth);
    expect(res.json()).toMatchObject({ drop_policy: 'after_one_renewal', renewal_committed_cents: 1108, expiry_date: '2027-10-05', drop_date: '2028-10-05' });
    expect(res.json().drop_policy_line).toContain('after one renewal');
  });

  it('T33-G9b: drop_policy at_first_expiry: no renewal committed, drop_date = expiry, schedule ends before the first expiry', async () => {
    const auth = await setup();
    const dry = (await post('/buy', auth, body({ dry_run: true, drop_policy: 'at_first_expiry', proposed_listing: HYBRID }))).json();
    expect(dry).toMatchObject({ drop_policy: 'at_first_expiry', renewal_committed_cents: 0 });
    expect(dry.proposed_listing.sell_plan_line).toContain('at first expiry');
    const res = await postBuy(app, body({ drop_policy: 'at_first_expiry', proposed_listing: HYBRID, expected_settings_version: 2 }), auth);
    expect(res.statusCode, res.body).toBe(201);
    expect(res.json()).toMatchObject({ drop_policy: 'at_first_expiry', renewal_committed_cents: 0, expiry_date: '2027-10-05', drop_date: '2027-10-05' });
    const dom = await db.selectFrom('domains').selectAll().where('domain', '=', D).executeTakeFirstOrThrow();
    expect([dom.status, dom.drop_date, dom.expiry_date]).toEqual(['listed', '2027-10-05', '2027-10-05']);
    const events = await db.selectFrom('price_schedule').select(['event', 'due_on', 'status']).orderBy('due_on').execute();
    expect(events.filter((e) => e.status === 'planned').map((e) => e.event)).toEqual(['drop1_m6', 'final_push', 'delist']);
    expect(events.find((e) => e.event === 'drop2_m18')?.status).toBe('superseded_by_final_push');
    expect(events.filter((e) => e.status === 'planned').every((e) => String(e.due_on).slice(0, 10) < '2027-10-05')).toBe(true);
    const bad = await post('/buy', auth, body({ dry_run: true, drop_policy: 'never' }));
    expect(bad.statusCode).toBe(422);
  });
});

describe('v3.7.0 CR-033 G-3: small_buy in GET /selection/buy-hold', () => {
  it('T33-G3: spent, remaining, next_freed_at and the purchases', async () => {
    app = await makeApp({ adapters: [new FakeAdapter('porkbun')] });
    const read = (await issueToken('read')).auth;
    const empty = (await get('/selection/buy-hold', read)).json().small_buy;
    expect(empty).toMatchObject({ cap_cents: 5000, spent_7d_cents: 0, remaining_cents: 5000, next_freed_at: null, purchases: [] });
    const first = new Date(Date.now() - 2 * 3_600_000);
    const second = new Date(Date.now() - 3_600_000);
    for (const [domain, at] of [['one.com', first], ['two.com', second]] as const) {
      await db.insertInto('purchases').values({
        idempotency_key: randomUUID(), request_hash: 'h', domain, state: 'succeeded', dry_run: false, registrar: 'porkbun', max_price_cents: 1108,
        approval_text: 'small buy', approval_at: at, expected_cents: 1108, charged_cents: 1108, small_buy_exception: true, created_at: at, updated_at: at,
      }).execute();
    }
    const sb = (await get('/selection/buy-hold', read)).json().small_buy;
    expect(sb).toMatchObject({ cap_cents: 5000, spent_7d_cents: 2216, remaining_cents: 2784 });
    expect(new Date(sb.next_freed_at).getTime()).toBe(first.getTime() + 7 * 86_400_000 - (first.getTime() % 1000));
    expect(sb.purchases.map((p: { domain: string; cost_cents: number }) => [p.domain, p.cost_cents])).toEqual([['one.com', 1108], ['two.com', 1108]]);
  });
});

describe('v3.7.0 CR-033 G-6: registrarCheck reads auto-renew, privacy and nameservers', () => {
  const D = 'ukcbamcompliance.com';
  const seen: string[] = [];
  const mock = (o: { autoRenew: number; privacy: number; ns: string[] }) => {
    seen.length = 0;
    mswServer.use(
      http.get(`${PORKBUN_BASE}/domain/get/:d`, ({ request }) => {
        seen.push(new URL(request.url).pathname);
        return HttpResponse.json({ status: 'SUCCESS', domain: { domain: D, expireDate: '2027-10-09 09:00:00', whoisPrivacy: o.privacy, autoRenew: o.autoRenew, apiAccess: 1 } });
      }),
      http.post(`${PORKBUN_BASE}/domain/getNs/:d`, ({ request }) => {
        seen.push(new URL(request.url).pathname);
        return HttpResponse.json({ status: 'SUCCESS', ns: o.ns });
      }),
    );
  };
  const NOW = Date.parse('2026-10-10T00:30:00Z');

  it('T33-G6: stored append-only, shown in /portfolio, AUTO_RENEW_ON error and REGISTRAR_DRIFT warn; the latest check decides; read-only calls only', async () => {
    const pb = new PorkbunAdapter({ ...FAKE_KEYS, timeoutMs: 2000 });
    app = await makeApp({ adapters: [pb], now: () => NOW });
    const read = (await issueToken('read')).auth;
    await listedDomain({ domain: D, registrar: 'porkbun', registrar_api: 'full', lander: 'afternic', lander_ns: AFN, ns_verified_at: new Date(NOW) });
    const job = () => new RegistrarCheckJob({ db, adapters: [pb], now: () => NOW });

    mock({ autoRenew: 1, privacy: 0, ns: ['ns1.porkbun.com', 'ns2.porkbun.com'] });
    expect(await job().runOnce()).toMatchObject({ checked: 1, present: 1 });
    expect(seen.every((p) => /\/domain\/(get|getNs)\//.test(p))).toBe(true);
    const detail = (await get(`/portfolio/${D}`, read)).json();
    expect(detail.registrar_state).toMatchObject({ auto_renew: true, privacy: false, ns: ['ns1.porkbun.com', 'ns2.porkbun.com'] });
    expect(detail.registrar_state.checked_at).toMatch(/\+0[23]:00$/);
    const w = await reportWarnings(read);
    expect(w.find((x) => x.code === 'AUTO_RENEW_ON')).toMatchObject({ level: 'error', domain: D });
    expect(w.find((x) => x.code === 'REGISTRAR_DRIFT')).toMatchObject({ level: 'warn', domain: D, details: { drift: ['privacy_off', 'nameservers'] } });
    await expect(db.updateTable('registrar_state_checks').set({ auto_renew: false }).execute()).rejects.toThrow(/append-only/);

    mock({ autoRenew: 0, privacy: 1, ns: ['NS2.Afternic.com.', 'ns1.afternic.com'] });
    await job().runOnce();
    expect((await get(`/portfolio/${D}`, read)).json().registrar_state).toMatchObject({ auto_renew: false, privacy: true, ns: AFN });
    expect((await reportWarnings(read)).filter((x) => ['AUTO_RENEW_ON', 'REGISTRAR_DRIFT'].includes(x.code))).toEqual([]);
    expect(await db.selectFrom('registrar_state_checks').select('id').execute()).toHaveLength(2);
  });

  it('T33-G6b: a name at another registrar, and a name not yet checked, have registrar_state null', async () => {
    app = await makeApp({ now: () => NOW, adapters: [new FakeAdapter('porkbun')] });
    const read = (await issueToken('read')).auth;
    await listedDomain({ domain: D, registrar: 'porkbun', registrar_api: 'full' });
    expect((await get(`/portfolio/${D}`, read)).json().registrar_state).toBeNull();
    await listedDomain({ domain: 'gd-one.com', registrar: 'godaddy', registrar_api: 'manage' });
    const gd = new FakeAdapter('godaddy', { domainInfo: { autoRenew: true } });
    await new RegistrarCheckJob({ db, adapters: [gd], now: () => NOW }).runOnce();
    expect(await db.selectFrom('registrar_state_checks').select('id').execute()).toHaveLength(0);
  });
});

describe('v3.7.0 CR-033 G-8: LANDER_AWAITING_MARKETPLACE before the first confirmed Afternic upload', () => {
  const D = 'aievalsconsulting.com';
  const NOW = Date.parse('2026-10-12T09:00:00Z');
  const fail = async (id: number, at: string) =>
    db.insertInto('portfolio_checks').values({ domain_id: id, kind: 'web', status: 'fail', at: new Date(at), details: JSON.stringify({ status_code: null, reason: 'network_error' }) }).execute();

  it('T33-G8: info while never uploaded; LANDER_DOWN counts only from the first confirmed upload', async () => {
    app = await makeApp({ now: () => NOW, adapters: [new FakeAdapter('porkbun')] });
    const read = (await issueToken('read')).auth;
    const id = await listedDomain({ domain: D, lander: 'afternic', lander_ns: AFN, ns_verified_at: new Date(NOW) });
    await fail(id, '2026-10-08T09:00:00Z');
    await fail(id, '2026-10-09T09:00:00Z');
    let w = await reportWarnings(read);
    expect(w.find((x) => x.code === 'LANDER_AWAITING_MARKETPLACE')).toMatchObject({ level: 'info', domain: D });
    expect(w.find((x) => x.code === 'LANDER_DOWN')).toBeUndefined();

    await db.insertInto('export_runs').values({ marketplace: 'afternic', domains: [D], export_id: 'exp_g8' }).execute();
    await db.insertInto('export_uploads').values({ venue: 'afternic', export_id: 'exp_g8', domains: [D], uploaded_at: new Date('2026-10-10T09:00:00Z'), approval_text: 'uploaded' }).execute();
    w = await reportWarnings(read);
    expect(w.find((x) => x.code === 'LANDER_AWAITING_MARKETPLACE')).toBeUndefined();
    expect(w.find((x) => x.code === 'LANDER_DOWN')).toBeUndefined(); // the old fails predate the upload

    await fail(id, '2026-10-11T09:00:00Z');
    w = await reportWarnings(read);
    expect(w.find((x) => x.code === 'LANDER_DOWN')).toMatchObject({ level: 'warn', domain: D });
    await fail(id, '2026-10-12T01:00:00Z'); // a second IDT day after the upload
    w = await reportWarnings(read);
    expect(w.find((x) => x.code === 'LANDER_DOWN')).toMatchObject({ level: 'error', domain: D });
  });
});

describe('v3.7.0 CR-031 B: POST /offers dry_run', () => {
  const T = 'promptinjectionaudit.com';
  const NOW = Date.parse('2026-10-12T09:00:00Z');
  const offer = (amount: string, over: object = {}) => ({ domain: T, amount_usd: amount, source: 'afternic', received_at: '2026-10-11T12:00:00+02:00', ...over });

  async function setup() {
    app = await makeApp({ now: () => NOW, adapters: [new FakeAdapter('porkbun')] });
    await listedDomain({ domain: T, bin_cents: 148800, floor_cents: 96700, walkaway_cents: 71400, min_offer_cents: 10000, first_listed_at: new Date('2026-10-01T09:00:00Z') });
    return { w: (await issueToken('write', 'gavriel')).auth, r: (await issueToken('read')).auth };
  }

  it('T31-B1: the $500 / $960 / $1,000 / $1,600 bands on a hybrid 1488/967 plan; nothing is written but the audit row', async () => {
    const { w, r } = await setup();
    const expected: [string, string, string][] = [
      ['500.00', 'below_walkaway', 'auto_decline'], ['960.00', 'mid_range', 'dvir'],
      ['1000.00', 'at_or_above_floor', 'auto_accept'], ['1600.00', 'at_or_above_bin', 'auto_accept'],
    ];
    const before = (await get('/offers', r)).json();
    for (const [amount, band, routing] of expected) {
      const res = await post('/offers', w, offer(amount, { dry_run: true }));
      expect(res.statusCode, res.body).toBe(200);
      expect(res.json()).toMatchObject({ dry_run: true, id: null, band, routing, snapshot: { bin_cents: 148800, floor_cents: 96700, walkaway_cents: 71400 } });
      expect(res.json().next_step).toBeTruthy();
    }
    expect(await db.selectFrom('offers').select('id').execute()).toHaveLength(0);
    expect((await get('/offers', r)).json()).toEqual(before);
    const audits = await db.selectFrom('audit_log').select('path').where('path', '=', '/offers').execute();
    expect(audits).toHaveLength(4);
  });

  it('T31-B2: a dry run claims no dedupe key and takes no hold; the same offer then records for real; the real one is a 201', async () => {
    const { w } = await setup();
    const o = offer('1000.00', { external_ref: 'ref-1', pricing_hold: true, pricing_hold_reason: 'looking at it' });
    expect((await post('/offers', w, { ...o, dry_run: true })).statusCode).toBe(200);
    expect((await post('/offers', w, { ...o, dry_run: true })).json().duplicate).toBeUndefined();
    expect((await db.selectFrom('domains').select('pricing_hold').where('domain', '=', T).executeTakeFirstOrThrow()).pricing_hold).toBe(false);
    const real = await post('/offers', w, o);
    expect(real.statusCode).toBe(201);
    expect(real.json().dry_run).toBeUndefined();
    expect(await db.selectFrom('offers').select('id').execute()).toHaveLength(1);
  });

  it('T31-B3: a dry run still validates (bad amount, unknown domain) and shows the private walk-away only in the bot view', async () => {
    const { w } = await setup();
    expect((await post('/offers', w, offer('abc', { dry_run: true }))).statusCode).toBe(422);
    expect((await post('/offers', w, offer('500.00', { dry_run: true, domain: 'nothere.com' }))).statusCode).toBe(404);
    expect((await post('/offers', w, offer('500.00', { dry_run: true }))).json().snapshot.walkaway).toBe('$714 (private)');
  });
});

describe('v3.7.0 CR-031 C: POST /listings/{domain}/venue', () => {
  const T = 'promptinjectionaudit.com';
  const NOW = Date.parse('2026-10-12T09:00:00Z');
  const venue = (w: Record<string, string>, body: object) => post(`/listings/${T}/venue`, w, body);
  const sedo = { venue: 'sedo', listed_at: '2026-10-11T10:00:00+02:00', shown: { mode: 'make_offer', price_usd: null, min_offer_usd: 100 }, evidence: { source: 'sedo_dashboard', ref: 'screenshot-1' }, note: 'listed by Dvir' };
  async function setup() {
    app = await makeApp({ now: () => NOW, adapters: [new FakeAdapter('porkbun')] });
    await listedDomain({ domain: T, bin_cents: 148800, floor_cents: 96700, walkaway_cents: 71400, min_offer_cents: 10000, first_listed_at: new Date('2026-10-01T09:00:00Z'), listing_changed_at: new Date('2026-10-01T09:00:00Z'), lander: 'afternic' });
    return { w: (await issueToken('write', 'gavriel')).auth, r: (await issueToken('read')).auth };
  }
  const exp = async (r: Record<string, string>, v: 'afternic' | 'sedo') => (await get(`/portfolio/${T}`, r)).json().export[v];

  it('T31-C1: a Sedo hand listing (make_offer, no price, min offer $100) shows in /portfolio and clears pending', async () => {
    const { w, r } = await setup();
    expect((await exp(r, 'sedo')).pending).toBe(true);
    const res = await venue(w, sedo);
    expect(res.statusCode, res.body).toBe(201);
    expect(res.json()).toMatchObject({ venue: 'sedo', delisted: false, shown: { mode: 'make_offer', price_cents: null, min_offer_cents: 10000 } });
    const sedoBlock = await exp(r, 'sedo');
    expect(sedoBlock).toMatchObject({ pending: false, shown: { mode: 'make_offer', price_cents: null, min_offer_cents: 10000 } });
    expect(sedoBlock.listed_by_hand_at).toMatch(/^2026-10-11T11:00:00\+03:00$/);
    expect((await exp(r, 'afternic')).listed_by_hand_at).toBeNull();
  });

  it('T31-C2: pending follows the plan: a priced listing matches until a scheduled price change, then pending is true again', async () => {
    const { w, r } = await setup();
    await venue(w, { venue: 'afternic', listed_at: '2026-10-11T10:00:00+02:00', shown: { mode: 'hybrid', price_usd: 1488, min_offer_usd: 100 } });
    expect((await exp(r, 'afternic')).pending).toBe(false);
    await db.updateTable('domains').set({ bin_cents: 108800, floor_cents: 70700, walkaway_cents: 52200 }).where('domain', '=', T).execute(); // a scheduled drop step
    expect((await exp(r, 'afternic')).pending).toBe(true);
    await venue(w, { venue: 'afternic', listed_at: '2026-10-12T10:00:00+02:00', shown: { mode: 'hybrid', price_usd: 1088, min_offer_usd: 100 } });
    expect((await exp(r, 'afternic')).pending).toBe(false);
  });

  it('T31-C3: any walk-away field is refused and nothing is stored', async () => {
    const { w } = await setup();
    for (const body of [
      { ...sedo, walkaway_usd: 714 }, { ...sedo, shown: { ...sedo.shown, walkaway_usd: 714 } }, { ...sedo, shown: { ...sedo.shown, walkaway: 714 } },
    ]) {
      const res = await venue(w, body);
      expect(res.statusCode, res.body).toBe(422);
    }
    expect(await db.selectFrom('venue_listings').select('id').execute()).toHaveLength(0);
  });

  it('T31-C4: delisted: true ends the hand listing; validation of listed_at, venue and shown; the table is append-only', async () => {
    const { w, r } = await setup();
    await venue(w, sedo);
    expect((await venue(w, { venue: 'sedo', listed_at: '2026-10-12T10:00:00+02:00', delisted: true })).statusCode).toBe(201);
    expect(await exp(r, 'sedo')).toMatchObject({ listed_by_hand_at: null, shown: null });
    expect((await venue(w, { ...sedo, listed_at: '2027-01-01T00:00:00+02:00' })).statusCode).toBe(422);
    expect((await venue(w, { ...sedo, venue: 'godaddy' })).statusCode).toBe(422);
    expect((await venue(w, { venue: 'sedo', listed_at: sedo.listed_at })).statusCode).toBe(422);
    expect((await post('/listings/nothere.com/venue', w, sedo)).statusCode).toBe(404);
    await expect(db.deleteFrom('venue_listings').execute()).rejects.toThrow(/append-only/);
    expect((await app.inject({ method: 'POST', url: `/listings/${T}/venue`, headers: { ...r, 'idempotency-key': key() }, payload: sedo })).statusCode).toBe(403);
  });

  it('T31-C5: the /sold checklist names the venue listed by hand', async () => {
    const { w } = await setup();
    await venue(w, sedo);
    const res = await post(`/sold/${T}`, w, {
      venue: 'afternic', sale_price: 1488, commission: 223.2, sold_at: '2026-10-12T11:00:00+02:00', transaction_ref: 'AFN-9',
      approval_ref: { text: `it sold on afternic for 1488 (${T})`, approved_at: new Date(NOW - 30_000).toISOString() },
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().checklist.join('\n')).toMatch(/by hand at Sedo/);
  });
});
