// v2.3.0 (CR-007 G-5): the daily portfolioCheck step (registry, lander, blocklist) and the /report warnings built from it.
// RDAP answers, the site fetch and DNS are injected recordings; Web Risk is MSW with a fake key. Nothing here touches the network.
import { afterEach, describe, expect, it } from 'vitest';
import { http, HttpResponse } from 'msw';
import type { FastifyInstance } from 'fastify';
import { PortfolioCheckJob } from '../../../src/modules/ops/jobs/portfolio-check.js';
import type { RdapLookup } from '../../../src/core/rdap.js';
import type { ScreeningDeps } from '../../../src/modules/selection/types.js';
import { WEB_RISK_MONTHLY_CAP } from '../../../src/modules/selection/web-risk.js';
import { makeApp, runJobToEnd } from '../../helpers/app.js';
import { insertOwnedDomain, testDb as db } from '../../helpers/db.js';
import { FakeAdapter } from '../../helpers/fake-adapter.js';
import { listedDomain } from '../../helpers/listing.js';
import { issueToken } from '../../helpers/tokens.js';
import { mswServer } from '../../setup/network.js';

const DAY = 86_400_000;
const clock = { t: Date.parse('2026-10-20T09:00:00Z') };
const apps: FastifyInstance[] = [];
afterEach(async () => { await Promise.all(apps.splice(0).map((a) => a.close())); });

const D001 = 'promptinjectionaudit.com';
const registered = (o: Partial<RdapLookup['facts'] & object> = {}): RdapLookup => ({
  outcome: 'registered', reasonCode: null, httpStatus: 200, url: 'https://rdap.example/x', retrievedAt: new Date(clock.t), body: '{}',
  facts: { registrar: 'GoDaddy.com, LLC', created_at: '2026-10-04T09:12:00.000Z', expires_at: '2027-10-04T09:12:00.000Z', updated_at: null, statuses: ['client transfer prohibited'], nameservers: [], ...o },
});
const notRegistered: RdapLookup = { outcome: 'not_registered', reasonCode: null, httpStatus: 404, url: 'https://rdap.example/x', retrievedAt: new Date(), body: null, facts: null };
const rdapDown: RdapLookup = { outcome: 'unknown', reasonCode: 'TIMEOUT', httpStatus: null, url: 'https://rdap.example/x', retrievedAt: new Date(), body: null, facts: null };

const state = { rdap: registered() as RdapLookup, page: { status: 200, body: '<a href="/lander/D001">buy</a>', location: null as string | null } as { status: number; body: string; location: string | null } | 'down', surbl: null as number | null };
const sites: string[] = [];
const listedAnswer = (last: number) => ({ rcode: 0, answers: [{ type: 1, data: `127.0.0.${last}` }] });
const screening = (extra: Partial<ScreeningDeps> = {}): ScreeningDeps => ({
  fetch: globalThis.fetch, sleep: async () => {}, checkService: undefined as never,
  rdapLookup: async () => state.rdap,
  dnsQuery: async (name) => (name.startsWith('test.surbl.org.') ? listedAnswer(254) : state.surbl !== null && !name.startsWith('test.') ? listedAnswer(state.surbl) : { rcode: 3, answers: [] }),
  resolveNs: async () => ['a.surbl.org'], resolve4: async () => ['192.0.2.1'],
  lookupHost: async () => [{ address: '93.184.216.34', family: 4 }],
  siteFetch: (async (input: unknown) => {
    sites.push(String(input));
    if (state.page === 'down') throw new TypeError('fetch failed');
    const h: Record<string, string> = state.page.location ? { location: state.page.location } : {};
    return new Response(state.page.body, { status: state.page.status, headers: h });
  }) as typeof fetch,
  ...extra,
});
const job = (extra: Partial<ScreeningDeps> = {}) => new PortfolioCheckJob({ db, rdapLookup: async () => state.rdap, screening: screening(extra), now: () => clock.t });
const rows = (kind: string) => db.selectFrom('portfolio_checks').select(['status', 'details', 'at']).where('kind', '=', kind as 'web').orderBy('id').execute();

async function warnings() {
  const app = await makeApp({ now: () => clock.t, adapters: [new FakeAdapter('porkbun')] });
  apps.push(app);
  const read = (await issueToken('read')).auth;
  const r = await app.inject({ method: 'GET', url: '/report', headers: read });
  expect(r.statusCode, r.body).toBe(200);
  return (r.json().warnings as { code: string; level: string; domain?: string; details: Record<string, any> }[]).filter((w) => ['REGISTRY_MISMATCH', 'LANDER_DOWN', 'OWNED_NAME_BLOCKLISTED'].includes(w.code));
}
/** v3.7.0 (CR-033 G-8): LANDER_DOWN counts from the first confirmed Afternic upload of the name. */
const confirmedUpload = async (domain: string) => {
  await db.insertInto('export_runs').values({ marketplace: 'afternic', domains: [domain], export_id: `e_${domain}` }).execute();
  await db.insertInto('export_uploads').values({ venue: 'afternic', export_id: `e_${domain}`, domains: [domain], uploaded_at: new Date(clock.t - 3_600_000), approval_text: 'uploaded' }).execute();
};
const d001 = () => insertOwnedDomain(db, { domain: D001, registrar: 'godaddy', registrar_api: 'manage', expiry_date: '2027-10-04', drop_date: '2027-10-04' });

describe('portfolioCheck: registry', () => {
  it('a D-001-like godaddy name that matches the registry: ok row, no warning', async () => {
    await d001();
    const r = await job().runOnce();
    expect(r).toMatchObject({ checked: 1, registry: { ok: 1, fail: 0, unknown: 0 }, web: { skipped: 1 }, blocklist: { ok: 1 } });
    expect(r.names[0]).toMatchObject({ domain: D001, registry: 'ok', web: 'skipped', blocklist: 'ok' });
    expect((await rows('registry'))[0]!.details).toMatchObject({ registrar: 'GoDaddy.com, LLC', expiry_date: '2027-10-04' });
    expect(await warnings()).toEqual([]);
  });

  it.each([
    ['registrar differs', registered({ registrar: 'Namecheap, Inc.' }), { field: 'registrar', ours: 'godaddy', registry: 'Namecheap, Inc.' }],
    ['expiry differs', registered({ expires_at: '2027-10-05T09:12:00.000Z' }), { field: 'expiry_date', ours: '2027-10-04', registry: '2027-10-05' }],
    ['pendingDelete', registered({ statuses: ['pendingDelete'] }), { field: 'status', registry: 'pendingDelete' }],
    ['clientHold', registered({ statuses: ['clientHold'] }), { field: 'status', registry: 'clientHold' }],
    ['not registered', notRegistered, { field: 'registered', ours: true, registry: false }],
  ])('%s: a fail row and REGISTRY_MISMATCH (warn for a hold status, error otherwise) with the differences; the next passing check clears it', async (_n, rdap, diff) => {
    await d001();
    state.rdap = rdap;
    await job().runOnce();
    const w = await warnings();
    expect(w).toHaveLength(1);
    expect(w[0]).toMatchObject({ code: 'REGISTRY_MISMATCH', level: diff.field === 'status' ? 'warn' : 'error', domain: D001 });
    expect(w[0]!.details.differences).toEqual([expect.objectContaining(diff)]);
    expect(w[0]!.details.checked_at).toContain('+03:00');
    clock.t += DAY;
    state.rdap = registered();
    await job().runOnce();
    expect(await warnings()).toEqual([]);
  });

  it('an RDAP error is an unknown row: it raises nothing and does not clear the previous fail', async () => {
    await d001();
    state.rdap = registered({ registrar: 'Namecheap, Inc.' });
    await job().runOnce();
    clock.t += DAY;
    state.rdap = rdapDown;
    const r = await job().runOnce();
    expect(r.registry).toEqual({ ok: 0, fail: 0, unknown: 1 });
    expect((await rows('registry')).map((x) => x.status)).toEqual(['fail', 'unknown']);
    expect((await warnings()).map((x) => x.code)).toEqual(['REGISTRY_MISMATCH']);
  });

  it('a sold name is not checked; a dry run writes no row and no audit row', async () => {
    await insertOwnedDomain(db, { domain: 'sold-one.com', status: 'sold' });
    await d001();
    const r = await job().runOnce({ dryRun: true });
    expect(r).toMatchObject({ dryRun: true, checked: 1 });
    expect(await db.selectFrom('portfolio_checks').selectAll().execute()).toHaveLength(0);
    expect(await db.selectFrom('audit_log').selectAll().where('path', '=', 'portfolio-check').execute()).toHaveLength(0);
  });
});

const verifiedLander = (over: object = {}) => listedDomain({ domain: 'lander-one.com', registrar: 'godaddy', registrar_api: 'manage', lander: 'afternic', lander_ns: ['ns1.afternic.com', 'ns2.afternic.com'], ns_verified_at: new Date(clock.t), expiry_date: '2027-10-04', ...over });

describe('portfolioCheck: lander (web)', () => {
  it('a listed name with verified afternic NS and a body containing /lander: ok, fetched over https (v4.0.0)', async () => {
    sites.length = 0;
    state.page = { status: 200, body: '<a href="/lander/lander-one.com">', location: null };
    await verifiedLander();
    const r = await job().runOnce();
    expect(r.web).toEqual({ ok: 1, fail: 0, unknown: 0, skipped: 0 });
    expect(sites[0]).toBe('https://lander-one.com/');
    expect((await rows('web'))[0]).toMatchObject({ status: 'ok' });
    expect(await warnings()).toEqual([]);
  });

  it('a Location header with a signature is ok too (redirects are followed up to 3 hops)', async () => {
    state.page = { status: 301, body: '', location: 'https://www.afternic.com/forsale/lander-one.com' };
    await verifiedLander();
    expect((await job().runOnce()).web.ok).toBe(1);
  });

  it('a parking page: LANDER_DOWN warn; the next IDT day it is an error; then ok clears it', async () => {
    state.page = { status: 200, body: 'This domain is parked. Sponsored listings.', location: null };
    await verifiedLander();
    await confirmedUpload('lander-one.com');
    await job().runOnce();
    let w = await warnings();
    expect(w).toHaveLength(1);
    expect(w[0]).toMatchObject({ code: 'LANDER_DOWN', level: 'warn', domain: 'lander-one.com', details: { status_code: 200, reason: 'no_lander_signature' } });
    const since = w[0]!.details.since;
    clock.t += DAY;
    await job().runOnce();
    w = await warnings();
    expect(w[0]).toMatchObject({ code: 'LANDER_DOWN', level: 'error', details: { since } });
    clock.t += DAY;
    state.page = { status: 200, body: '/lander', location: null };
    await job().runOnce();
    expect(await warnings()).toEqual([]);
  });

  it('two fails on the same IDT day stay a warning; a network error is unknown and changes nothing', async () => {
    state.page = { status: 503, body: 'down', location: null };
    await verifiedLander();
    await confirmedUpload('lander-one.com');
    await job().runOnce();
    clock.t += 3_600_000;
    await job().runOnce();
    expect((await warnings())[0]).toMatchObject({ code: 'LANDER_DOWN', level: 'warn', details: { reason: 'http_status', status_code: 503 } });
    clock.t += 3_600_000;
    state.page = 'down';
    const r = await job().runOnce();
    expect(r.web.unknown).toBe(1);
    expect((await warnings()).map((x) => x.code)).toEqual(['LANDER_DOWN']);
  });

  it('a lander_pending name, an unverified name and an owned (not listed) name are skipped', async () => {
    state.page = { status: 200, body: 'x', location: null };
    sites.length = 0;
    await verifiedLander({ domain: 'pending-one.com', lander_pending: true });
    await verifiedLander({ domain: 'unverified-one.com', ns_verified_at: null });
    await insertOwnedDomain(db, { domain: 'owned-one.com', lander: 'afternic', lander_ns: ['ns1.afternic.com', 'ns2.afternic.com'], ns_verified_at: new Date(clock.t) });
    const r = await job().runOnce();
    expect(r.web).toEqual({ ok: 0, fail: 0, unknown: 0, skipped: 3 });
    expect(sites).toEqual([]);
    expect(await rows('web')).toHaveLength(0);
  });
});

describe('portfolioCheck: blocklist (weekly)', () => {
  it('runs once a week per name: skipped within 7 days, due again after 7', async () => {
    await d001();
    expect((await job().runOnce()).blocklist).toMatchObject({ ok: 1, skipped: 0 });
    clock.t += 6 * DAY;
    expect((await job().runOnce()).blocklist).toMatchObject({ ok: 0, skipped: 1 });
    clock.t += DAY;
    expect((await job().runOnce()).blocklist).toMatchObject({ ok: 1, skipped: 0 });
    expect(await rows('blocklist')).toHaveLength(2);
    expect(await rows('registry')).toHaveLength(3); // registry is daily
  });

  it('weekly by IDT day: a check late on day X is due at 00:05 IDT on day X+7, though under 7 days passed', async () => {
    await d001();
    clock.t = Date.parse('2026-10-20T20:00:00Z'); // 23:00 IDT on the 20th
    expect((await job().runOnce()).blocklist).toMatchObject({ ok: 1 });
    clock.t = Date.parse('2026-10-26T22:30:00Z'); // 00:30 on the 27th (Israel winter time): 6 days and a bit, but 7 IDT days later
    expect((await job().runOnce()).blocklist).toMatchObject({ ok: 1, skipped: 0 });
    clock.t = Date.parse('2026-11-02T12:00:00Z'); // 6 days after the 27th: not due
    expect((await job().runOnce()).blocklist).toMatchObject({ skipped: 1 });
  });

  it('SURBL lists the name: fail, OWNED_NAME_BLOCKLISTED (error) with the source; it clears when a later weekly run is clean', async () => {
    await d001();
    state.surbl = 80;
    await job().runOnce();
    const w = await warnings();
    expect(w).toHaveLength(1);
    expect(w[0]).toMatchObject({ code: 'OWNED_NAME_BLOCKLISTED', level: 'error', domain: D001 });
    expect((w[0]!.details.sources as string[])[0]).toMatch(/^surbl:/);
    clock.t += 8 * DAY;
    state.surbl = null;
    await job().runOnce();
    expect(await warnings()).toEqual([]);
  });

  it('Web Risk (key set) counts in too: a match is web_risk:<types>; at the cap it is QUOTA_CAP, never a call', async () => {
    await d001();
    let calls = 0;
    mswServer.use(http.get('https://webrisk.googleapis.com/v1/uris:search', () => { calls++; return HttpResponse.json({ threat: { threatTypes: ['MALWARE'], expireTime: '2026-10-21T00:00:00Z' } }); }));
    await job({ webRiskApiKey: 'wr_fake_key_0000000000000000' }).runOnce();
    expect(calls).toBe(1);
    expect((await warnings())[0]).toMatchObject({ code: 'OWNED_NAME_BLOCKLISTED', details: { sources: ['web_risk:MALWARE'] } });
    clock.t += 8 * DAY;
    await db.updateTable('api_usage').set({ calls: WEB_RISK_MONTHLY_CAP }).execute();
    await job({ webRiskApiKey: 'wr_fake_key_0000000000000000' }).runOnce();
    expect(calls).toBe(1);
    const last = (await rows('blocklist')).at(-1)!;
    expect(last).toMatchObject({ status: 'unknown' }); // v2.6.0 (N-3): SURBL clean but Web Risk (asked) unknown: not ok; it never clears nor raises by itself
    expect(last.details).toMatchObject({ unknown: { web_risk: 'QUOTA_CAP' } });
    // the newest non-unknown blocklist row is still the Web Risk match: an unknown source never clears a warning
    expect((await warnings())[0]).toMatchObject({ code: 'OWNED_NAME_BLOCKLISTED' });
  });

  it('N-3 (v2.6.0): SURBL unknown while Web Risk answered clean is unknown, not ok; both clean is ok', async () => {
    await d001();
    mswServer.use(http.get('https://webrisk.googleapis.com/v1/uris:search', () => HttpResponse.json({})));
    const r = await job({ webRiskApiKey: 'wr_fake_key_0000000000000000', resolveNs: async () => { throw new Error('dns'); }, resolve4: async () => { throw new Error('dns'); } }).runOnce();
    expect(r.blocklist).toMatchObject({ unknown: 1, ok: 0 });
    expect((await rows('blocklist')).at(-1)!.details).toMatchObject({ clean: ['web_risk'], unknown: { surbl: expect.any(String) } });
    clock.t += 8 * DAY;
    expect((await job({ webRiskApiKey: 'wr_fake_key_0000000000000000' }).runOnce()).blocklist).toMatchObject({ ok: 1, unknown: 0 });
  });

  it('every source unknown: an unknown row, no warning', async () => {
    await d001();
    const r = await job({ resolveNs: async () => { throw new Error('dns'); }, resolve4: async () => { throw new Error('dns'); } }).runOnce();
    expect(r.blocklist).toMatchObject({ unknown: 1 });
    expect(await warnings()).toEqual([]);
  });
});

describe('portfolioCheck: in the daily run', () => {
  it('is a daily step after registrarCheck (before referenceRefresh) and never calls a registrar adapter', async () => {
    const adapter = new FakeAdapter('porkbun');
    await insertOwnedDomain(db, { domain: 'porkbun-name.com', registrar: 'porkbun', registrar_api: 'full', expiry_date: '2027-10-04' });
    const app = await makeApp({
      testRoutes: false, env: { JOB_TRIGGER_TOKEN: 'job_token_fake_0123456789abcdef0123456789' }, adapters: [adapter], now: () => clock.t,
      screening: { rdapLookup: async () => registered({ registrar: 'Porkbun LLC' }), resolveNs: async () => { throw new Error('dns'); } },
    });
    apps.push(app);
    const read = (await issueToken('read')).auth;
    const before = adapter.calls.length;
    const res = await runJobToEnd(app, 'daily', { key: 'pc-1' });
    expect(res.statusCode, res.body).toBe(202);
    const steps = Object.keys(res.json().steps);
    expect(steps.indexOf('portfolioCheck')).toBe(steps.indexOf('registrarCheck') + 1);
    expect(steps.indexOf('dropWatch')).toBe(steps.indexOf('portfolioCheck') + 1);
    expect(steps.indexOf('intakeScreening')).toBe(steps.indexOf('dropWatch') + 1);
    expect(steps.indexOf('buildDailyList')).toBe(steps.indexOf('intakeScreening') + 1);
    expect(steps.indexOf('cohortOutcomes')).toBe(steps.indexOf('buildDailyList') + 1);
    expect(steps.indexOf('referenceRefresh')).toBe(steps.indexOf('cohortOutcomes') + 1);
    expect(res.json().steps.portfolioCheck).toMatchObject({ ok: true, summary: { checked: 1, registry: { ok: 1 } } });
    const runs = (await app.inject({ method: 'GET', url: '/jobs/runs?job=daily', headers: read })).json().runs;
    expect(Object.keys(runs[0].steps)).toContain('portfolioCheck');
    // the registrar check step asks the adapter (findDomain); the portfolio step adds nothing of its own
    const during = adapter.calls.slice(before);
    expect(during.every((c) => c.startsWith('findDomain'))).toBe(true);
    const direct = new FakeAdapter('porkbun');
    await job().runOnce();
    expect(direct.calls).toEqual([]);
  });
});

// v4.0.0 (CR-049 item 3): the lander check reads https, a TLS failure is a miss, and the page's Buy Now price is checked against the plan's BIN.
describe('portfolioCheck: lander price and TLS (v4.0.0)', () => {
  const page = (buyNow: string, extra = '') => `<a href="/lander/lander-one.com">Afternic</a><div>Buy Now ${buyNow}</div>${extra}`;
  const price = async () => (await rows('price' as never)).at(-1);
  const reportCodes = async () => {
    const app = await makeApp({ now: () => clock.t, adapters: [new FakeAdapter('porkbun')] });
    apps.push(app);
    const read = (await issueToken('read')).auth;
    return (await app.inject({ method: 'GET', url: '/report', headers: read })).json().warnings as { code: string; level: string; domain?: string; details: Record<string, any> }[];
  };

  it('LP-1: the shown Buy Now equal to the plan BIN is price ok, with the make-offer option seen', async () => {
    state.page = { status: 200, body: page('$1,488', '<button>Make an offer</button>'), location: null };
    await verifiedLander({ bin_cents: 148800 });
    await job().runOnce();
    expect(await price()).toMatchObject({ status: 'ok', details: { expected_cents: 148800, shown_cents: 148800, make_offer_shown: true, make_offer_expected: true } });
    expect((await reportCodes()).filter((w) => w.code.startsWith('LANDER_'))).toEqual([]);
  });

  it('LP-2: a different Buy Now is LANDER_PRICE_MISMATCH with the shown and expected prices; fixing the page clears it', async () => {
    state.page = { status: 200, body: page('$1,988.00', 'Make offer'), location: null };
    await verifiedLander({ bin_cents: 148800 });
    await job().runOnce();
    let w = (await reportCodes()).filter((x) => x.code === 'LANDER_PRICE_MISMATCH');
    expect(w).toHaveLength(1);
    expect(w[0]).toMatchObject({ level: 'warn', domain: 'lander-one.com', details: { shown_cents: 198800, shown: '$1,988.00', expected_cents: 148800, expected: '$1,488.00' } });
    clock.t += 3_600_000;
    state.page = { status: 200, body: page('$1,488', 'Make offer'), location: null };
    await job().runOnce();
    w = (await reportCodes()).filter((x) => x.code === 'LANDER_PRICE_MISMATCH');
    expect(w).toHaveLength(0);
  });

  it('LP-3: a page that shows no price text is unknown (script-rendered pages), never a mismatch; a missing make-offer on a hybrid plan is the info LANDER_OFFER_MISSING', async () => {
    state.page = { status: 200, body: '<a href="/lander/x">Afternic</a>', location: null };
    await verifiedLander({ bin_cents: 148800 });
    await job().runOnce();
    expect(await price()).toMatchObject({ status: 'unknown', details: { reason: 'no_price_text' } });
    expect((await reportCodes()).filter((w) => w.code.startsWith('LANDER_'))).toEqual([]);
    clock.t += 3_600_000;
    state.page = { status: 200, body: page('$1,488'), location: null };
    await job().runOnce();
    expect((await reportCodes()).filter((w) => w.code === 'LANDER_OFFER_MISSING')).toMatchObject([{ level: 'info', domain: 'lander-one.com' }]);
  });

  it('LP-4: a TLS failure is a miss (LANDER_DOWN reason tls_error); a plain network error stays unknown', async () => {
    state.page = 'down';
    await verifiedLander({ bin_cents: 148800 });
    await confirmedUpload('lander-one.com');
    const tls = job({ siteFetch: (async () => { throw Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('certificate has expired'), { code: 'CERT_HAS_EXPIRED' }) }); }) as typeof fetch });
    const r = await tls.runOnce();
    expect(r.web).toEqual({ ok: 0, fail: 1, unknown: 0, skipped: 0 });
    expect((await rows('web'))[0]).toMatchObject({ status: 'fail', details: { reason: 'tls_error', tls_code: 'CERT_HAS_EXPIRED' } });
    expect((await reportCodes()).filter((w) => w.code === 'LANDER_DOWN')).toMatchObject([{ details: { reason: 'tls_error' } }]);
    clock.t += 3_600_000;
    expect((await job().runOnce()).web.unknown).toBe(1);
  });

  it('LP-5: a redirect to the Afternic page is followed (up to 3 hops) and the price is read there; only guarded fetches are made', async () => {
    const seen: string[] = [];
    const fetcher = (async (input: unknown) => {
      seen.push(String(input));
      if (seen.length === 1) return new Response('', { status: 302, headers: { location: 'https://www.afternic.com/forsale/lander-one.com' } });
      return new Response(page('$999', 'Make an offer'), { status: 200 });
    }) as typeof fetch;
    await verifiedLander({ bin_cents: 148800 });
    await job({ siteFetch: fetcher }).runOnce();
    expect(seen).toEqual(['https://lander-one.com/', 'https://www.afternic.com/forsale/lander-one.com']);
    expect(await price()).toMatchObject({ status: 'fail', details: { shown_cents: 99900 } });
  });

  // 5.66.0 (BUG-054): Afternic's page carries the offer-form copy "Offer cannot exceed $49,999,999" next to "Buy it now for $1,488.00".
  const afternic = (bin: string | null) =>
    `<a href="/lander/lander-one.com">Afternic</a><script>{"buyNow":"Buy Now","domain.details.offers.error.limit":"Offer cannot exceed $49,999,999"}</script>` +
    (bin === null ? '' : `<div>Buy it now for ${bin}</div>`) + '<button>Make an offer</button>';

  it('LP-6 (BUG-054 AT-1): the buyer-visible "Buy it now for $1,488.00" beside the $49,999,999 offer limit is price ok, no warning', async () => {
    state.page = { status: 200, body: afternic('$1,488.00'), location: null };
    await verifiedLander({ bin_cents: 148800 });
    await job().runOnce();
    expect(await price()).toMatchObject({ status: 'ok', details: { shown_cents: 148800 } });
    expect((await reportCodes()).filter((w) => w.code === 'LANDER_PRICE_MISMATCH')).toEqual([]);
  });

  it('LP-7 (BUG-054 AT-2): the same page against plan BIN $2,488 is LANDER_PRICE_MISMATCH with shown $1,488, never $49,999,999', async () => {
    state.page = { status: 200, body: afternic('$1,488.00'), location: null };
    await verifiedLander({ bin_cents: 248800 });
    await job().runOnce();
    const w = (await reportCodes()).filter((x) => x.code === 'LANDER_PRICE_MISMATCH');
    expect(w).toMatchObject([{ details: { shown_cents: 148800, expected_cents: 248800 } }]);
  });

  it('LP-8 (BUG-054 AT-3): a page with only the $49,999,999 offer limit is unknown, never a mismatch', async () => {
    state.page = { status: 200, body: afternic(null), location: null };
    await verifiedLander({ bin_cents: 148800 });
    await job().runOnce();
    expect(await price()).toMatchObject({ status: 'unknown', details: { reason: 'no_price_text' } });
    expect((await reportCodes()).filter((w) => w.code === 'LANDER_PRICE_MISMATCH')).toEqual([]);
  });

  // 5.68.0 (BUG-056): a page with "Buy it now for $1,488.00" AND "$100,000" (offer max / lease copy / unrelated) must show $1,488, not $100,000.
  const afternicWith100k = (bin: string | null, extra100k: string) =>
    `<a href="/lander/lander-one.com">Afternic</a>${extra100k}` +
    (bin === null ? '' : `<div>Buy it now for ${bin}</div>`) + '<button>Make an offer</button>';

  it('LP-9 (BUG-056 AT-1): HTML with "Buy it now for $1,488.00" and a $100,000 non-BIN amount → shown $1,488; no mismatch', async () => {
    state.page = { status: 200, body: afternicWith100k('$1,488.00', '<span class="offer-max">Buy Now $100,000</span>'), location: null };
    await verifiedLander({ bin_cents: 148800 });
    await job().runOnce();
    expect(await price()).toMatchObject({ status: 'ok', details: { shown_cents: 148800 } });
    expect((await reportCodes()).filter((w) => w.code === 'LANDER_PRICE_MISMATCH')).toEqual([]);
  });

  it('LP-10 (BUG-056 AT-2): no Buy Now amount, only $100,000 → unknown, not mismatch', async () => {
    state.page = { status: 200, body: afternicWith100k(null, '<span>Domains can sell for $100,000 or more</span>'), location: null };
    await verifiedLander({ bin_cents: 148800 });
    await job().runOnce();
    expect(await price()).toMatchObject({ status: 'unknown', details: { reason: 'no_price_text' } });
    expect((await reportCodes()).filter((w) => w.code === 'LANDER_PRICE_MISMATCH')).toEqual([]);
  });

  // 5.69.0 (BUG-058): LANDER_BODY_BYTES=200k truncated Afternic HTML (~337KB) before the real BIN; "must be below $100,000" matched early.
  const largePadding = 'x'.repeat(220_000);
  const afternicLargeBody = (bin: string | null, limitCopy: string) =>
    `<a href="/lander/lander-one.com">Afternic</a>${limitCopy}${largePadding}` +
    (bin === null ? '' : `<div>Buy it now for ${bin}</div>`) + '<button>Make an offer</button>';

  it('LP-11 (BUG-058 AT-1): BIN past byte 200k with early "must be below $100,000" limit copy → shown $1,488; no mismatch', async () => {
    const body = afternicLargeBody('$1,488.00', '<span>Buy Now price must be below $100,000</span>');
    expect(body.length).toBeGreaterThan(220_000);
    expect(body.indexOf('Buy it now for $1,488.00')).toBeGreaterThan(200_000);
    state.page = { status: 200, body, location: null };
    await verifiedLander({ bin_cents: 148800 });
    await job().runOnce();
    expect(await price()).toMatchObject({ status: 'ok', details: { shown_cents: 148800 } });
    expect((await reportCodes()).filter((w) => w.code === 'LANDER_PRICE_MISMATCH')).toEqual([]);
  });

  it('LP-12 (BUG-058 AT-2): only "must be below $100,000" limit copy, no Buy Now → unknown, not mismatch', async () => {
    const body = afternicLargeBody(null, '<span>Buy Now price must be below $100,000</span>');
    state.page = { status: 200, body, location: null };
    await verifiedLander({ bin_cents: 148800 });
    await job().runOnce();
    expect(await price()).toMatchObject({ status: 'unknown', details: { reason: 'no_price_text' } });
    expect((await reportCodes()).filter((w) => w.code === 'LANDER_PRICE_MISMATCH')).toEqual([]);
  });

  // 5.70.0 (BUG-059): Afternic-NS names whose apex/lander returns 403 — the Afternic listing URL is fetched as a fallback.
  const AFTERNIC_LISTING_BASE = 'https://www.afternic.com/domain/';
  const afternicListingHtml = (bin: string | null, limitCopy = '') =>
    `<html>${limitCopy}` + (bin === null ? '' : `<div>Buy it now for ${bin}</div>`) + '<button>Make an offer</button></html>';

  it('LP-13 (BUG-059 AT-1): primary fetch 403; Afternic listing has Buy it now for $1,488 + limit copy → shown $1,488; stale mismatch cleared', async () => {
    // First run: create a stale LANDER_PRICE_MISMATCH (wrong price $1,988 vs plan $1,488)
    state.page = { status: 200, body: page('$1,988'), location: null };
    await verifiedLander({ bin_cents: 148800 });
    await job().runOnce();
    let w = (await reportCodes()).filter((x) => x.code === 'LANDER_PRICE_MISMATCH');
    expect(w).toHaveLength(1);
    expect(w[0]).toMatchObject({ details: { shown_cents: 198800 } });

    // Second run: primary returns 403 (GoDaddy forsale); Afternic listing HTML has the real BIN
    clock.t += DAY;
    const afternicBody = afternicListingHtml('$1,488.00', '<span>Buy Now price must be below $100,000</span>');
    const fetcher = (async (input: unknown) => {
      const u = String(input);
      if (u.startsWith(AFTERNIC_LISTING_BASE)) return new Response(afternicBody, { status: 200 });
      return new Response('Forbidden', { status: 403 });
    }) as typeof fetch;
    await job({ siteFetch: fetcher }).runOnce();
    const p = await price();
    expect(p).toMatchObject({ status: 'ok', details: { shown_cents: 148800, source: 'afternic_listing' } });
    w = (await reportCodes()).filter((x) => x.code === 'LANDER_PRICE_MISMATCH');
    expect(w).toHaveLength(0);
  });

  it('LP-14 (BUG-059 AT-2): primary fetch 403 and Afternic listing has no usable BIN → no new mismatch', async () => {
    await verifiedLander({ bin_cents: 148800 });
    const fetcher = (async (input: unknown) => {
      const u = String(input);
      if (u.startsWith(AFTERNIC_LISTING_BASE)) return new Response(afternicListingHtml(null), { status: 200 });
      return new Response('Forbidden', { status: 403 });
    }) as typeof fetch;
    await job({ siteFetch: fetcher }).runOnce();
    // Primary is 403 (web fail); Afternic listing has no BIN → no price row written
    expect(await price()).toBeUndefined();
    expect((await reportCodes()).filter((x) => x.code === 'LANDER_PRICE_MISMATCH')).toEqual([]);
  });

  it('LP-15 (BUG-059 R2 AT-1): primary unknown/no_price_text (readable page, lander sig, no Buy Now); Afternic listing has Buy it now $1,488 → ok/afternic_listing, stale mismatch cleared', async () => {
    // First run: create a stale LANDER_PRICE_MISMATCH ($49,999,999 via offer limit only — unknown/no_price_text wouldn't itself create a mismatch, so seed one with a wrong price)
    state.page = { status: 200, body: page('$1,988'), location: null };
    await verifiedLander({ bin_cents: 148800 });
    await job().runOnce();
    let w = (await reportCodes()).filter((x) => x.code === 'LANDER_PRICE_MISMATCH');
    expect(w).toHaveLength(1);

    // Second run: primary page is readable (200, lander signature) but has no Buy Now → unknown/no_price_text
    clock.t += DAY;
    const primaryBody = '<a href="/lander/lander-one.com">Afternic</a><script>{"buyNow":"Buy Now","domain.details.offers.error.limit":"Offer cannot exceed $49,999,999"}</script><button>Make an offer</button>';
    const afternicBody = afternicListingHtml('$1,488.00', '<span>Buy Now price must be below $100,000</span>');
    const fetcher = (async (input: unknown) => {
      const u = String(input);
      if (u.startsWith(AFTERNIC_LISTING_BASE)) return new Response(afternicBody, { status: 200 });
      return new Response(primaryBody, { status: 200 });
    }) as typeof fetch;
    await job({ siteFetch: fetcher }).runOnce();
    const p = await price();
    expect(p).toMatchObject({ status: 'ok', details: { shown_cents: 148800, source: 'afternic_listing' } });
    w = (await reportCodes()).filter((x) => x.code === 'LANDER_PRICE_MISMATCH');
    expect(w).toHaveLength(0);
  });
});
