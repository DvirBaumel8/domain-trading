// v3.4.1 (CR-028): `force` on POST /candidates/screen {domains} (A) and seller fetch misses (B): http_status, unknown for 401/403/429/timeout,
// large pages judged on their first max_bytes, the tier input sellers_unknown_n. Pages are MSW handlers; no test touches the network.
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { http, HttpResponse } from 'msw';
import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { DEFAULT_SELECTION_VALUES } from '../../../src/modules/selection/settings.js';
import { tierUsesSellers } from '../../../src/modules/selection/sellers.js';
import { testDb as db } from '../../helpers/db.js';
import { patchActiveSettings, screeningHarness, type ScreeningHarness } from '../../helpers/screening.js';
import { fixture, respond } from '../../helpers/screening-fixtures.js';
import { issueToken } from '../../helpers/tokens.js';
import type { RdapLookup } from '../../../src/core/rdap.js';
import { mswServer } from '../../setup/network.js';

let app: FastifyInstance | undefined;
afterEach(async () => app?.close());
const HOUR = 3_600_000;
const T_FREE = (): RdapLookup => ({ outcome: 'not_registered', reasonCode: null, httpStatus: 404, url: 'https://rdap.example/domain/x', retrievedAt: new Date(), body: null, facts: null });
const approval = (x: ScreeningHarness, text: string) => ({ text, approved_at: new Date(x.clock.t - HOUR).toISOString() });
async function draftAndActivate(x: ScreeningHarness, label: string, set: object): Promise<void> {
  const d = await x.post('/selection/settings', { label, set });
  expect(d.statusCode, d.body).toBe(201);
  const a = await x.post(`/selection/settings/${label}/activate`, { approval_ref: approval(x, `Dvir: activate ${label}`) });
  expect(a.statusCode, a.body).toBe(200);
}
const settle = async (x: ScreeningHarness) => { await x.app.jobQueue.idle(); await x.app.screeningWorker.idle(); await x.app.jobQueue.idle(); };
async function writer(x: ScreeningHarness, name = 'gavriel-screen') {
  const w = await issueToken('write', name);
  return (url: string, payload?: object, key: string = randomUUID()) => (x.clock.t += 7_000, x.app.inject({ method: 'POST', url, headers: { ...w.auth, 'idempotency-key': key }, ...(payload !== undefined && { payload }) }));
}
const scoutTokens = new WeakMap<ScreeningHarness, Awaited<ReturnType<typeof issueToken>>>();
async function scout(x: ScreeningHarness) {
  const t = scoutTokens.get(x) ?? scoutTokens.set(x, await issueToken('intake', 'scout-1')).get(x)!;
  return { intake: (names: object[]) => (x.clock.t += 7_000, x.app.inject({ method: 'POST', url: '/candidates/intake', headers: { ...t.auth, 'idempotency-key': randomUUID() }, payload: { names } })) };
}
const tierOf = (body: any, i = 0) => body.names[i].results.find((r: any) => r.check === 'tier'); // eslint-disable-line @typescript-eslint/no-explicit-any

// ---------- A: force ----------
async function h(): Promise<ScreeningHarness> {
  mswServer.use(http.get('https://data.iana.org/rdap/dns.json', () => respond(fixture('iana-dns.json'))));
  const x = await screeningHarness({ adapters: [], screening: { rdapLookup: async () => T_FREE(), sleep: async () => {} } });
  app = x.app;
  return x;
}
const NAMES = ['superpro.com', 'megabox.com'];
async function screenedOnce(x: ScreeningHarness, names = NAMES) {
  await (await scout(x)).intake(names.map((domain) => ({ domain, lane: 'S3', source: 'scout' })));
  const post = await writer(x);
  expect((await post('/candidates/screen', {})).statusCode).toBe(202);
  await settle(x);
  return post;
}
const screenings = async () => (await db.selectFrom('candidate_screenings').select(['domain']).orderBy('id').execute()).map((c) => c.domain);

// ---------- B: sellers ----------
const page = (n: string) => readFileSync(new URL(`../../fixtures/screening/sites/${n}`, import.meta.url), 'utf8');
const html = (body: string, status = 200) => new HttpResponse(body, { status, headers: { 'content-type': 'text/html; charset=utf-8' } });
const LIVE = page('synthetic-service.html');
const PARKED = '<!doctype html><html><head><title>acme.example</title></head><body><h1>This domain is for sale</h1><p>Buy now on afternic.com. Make an offer today.</p></body></html>';
const robots404 = (host: string) => http.get(`https://${host}/robots.txt`, () => new HttpResponse(null, { status: 404 }));
const site = (host: string, body: string, status = 200) => [robots404(host), http.get(`https://${host}/`, () => html(body, status))];
const PAD = (n: number) => `<!-- ${'x'.repeat(n)} -->`;

const share = (extra: object[]) => [{ f: 'registered_share', op: '>=', v: '$registered_share_min_v11' }, ...extra];
const form = [{ f: 'n_words', op: '>=', v: '$v11_min_words' }, { f: 'n_words', op: '<=', v: '$v11_max_words' }, { f: 'sld_chars', op: '<=', v: '$v11_max_chars' }, { f: 'is_geo', op: '==', v: 0 }];
const SET = {
  'thresholds.registered_share_min_v11': 0.55, 'thresholds.v11_min_words': 2, 'thresholds.v11_max_words': 3, 'thresholds.v11_max_chars': 25,
  'tier.clauses': {
    A: { all: share(form) },
    I: { all: [{ f: 'alt_tld_before_n', op: '>=', v: '$alt_tld_before_min' }, ...form] },
    G: DEFAULT_SELECTION_VALUES.tier.clauses.G,
    L: { all: [{ f: 'lane', op: 'in', v: ['S3', 'S4', 'S6'] }, { f: 'sellers_verified_n', op: '>=', v: '$lane_sellers_min' }, ...form] },
  },
  'tier.order': ['A', 'I', 'G', 'L'], 'tier.demand2_pass_tiers': ['A', 'I', 'G', 'L'],
  'freshness_hours.census': 168, 'ext.alt_list': ['net', 'org', 'biz', 'ca'],
  'thresholds.lane_sellers_min': { S3: 5, S4: 2, S6: 3 }, 'tier.p_passive.L': 0.01,
};
const SLD = 'roofingdroneinspection';
async function hs(): Promise<ScreeningHarness> {
  const x = await screeningHarness({
    screening: {
      sleep: async () => {},
      siteFetch: ((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
        const u = new URL(String(input instanceof Request ? input.url : input));
        if (u.hostname === 'slow-firm.example' && u.pathname === '/') return Promise.reject(new DOMException('timed out', 'TimeoutError'));
        return globalThis.fetch(input, init);
      }) as typeof fetch,
    },
  });
  app = x.app;
  await draftAndActivate(x, 'v1131', SET);
  return x;
}
async function verify(x: ScreeningHarness, list: { name: string; url: string }[]) {
  const r = await x.post(`/candidates/${SLD}.com/records`, { kind: 'sellers', record: list, checked_by: 'shomer' });
  expect(r.statusCode, r.body).toBe(201);
  const { body } = await x.runDone({ mode: 'full', checks: ['form', 'tier'], names: [{ domain: `${SLD}.com`, lane: 'S4' }] });
  return tierOf(body);
}
const E = (name: string, host: string) => ({ name, url: `https://${host}/` });

describe('CR-028 B: seller fetch misses', () => {
  it('T28-5 401, 403 and 429 are unknown (verified null) with the status named; 404 and 500 stay not verified; http_status on every fetched entry', async () => {
    const x = await hs();
    mswServer.use(...site('a401.example', 'x', 401), ...site('a403.example', 'x', 403), ...site('a429.example', 'x', 429), ...site('a404.example', 'x', 404), ...site('a500.example', 'x', 500), ...site('live.example', LIVE));
    const t = await verify(x, [E('A', 'a401.example'), E('B', 'a403.example'), E('C', 'a429.example'), E('D', 'a404.example'), E('E', 'a500.example'), E('F', 'live.example')]);
    expect(t.fields.sellers.entries.map((e: any) => [e.verified, e.reason, e.http_status, e.truncated])).toEqual([ // eslint-disable-line @typescript-eslint/no-explicit-any
      [null, 'HTTP_401', 401, false], [null, 'HTTP_403', 403, false], [null, 'HTTP_429', 429, false],
      [false, 'HTTP_4XX', 404, false], [false, 'HTTP_5XX', 500, false], [true, 'OK', 200, false],
    ]);
    expect(t.fields.sellers).toMatchObject({ verified_n: 1, unknown_n: 3 });
    expect(t.fields.inputs).toMatchObject({ sellers_verified_n: 1, sellers_unknown_n: 3 });
  }, 60_000);

  it('T28-6 a timeout is unknown (reason TIMEOUT, http_status null)', async () => {
    const x = await hs();
    mswServer.use(...site('slow-firm.example', LIVE));
    const t = await verify(x, [E('Slow', 'slow-firm.example')]);
    expect(t.fields.sellers.entries[0]).toMatchObject({ verified: null, reason: 'TIMEOUT', http_status: null, truncated: false });
    expect(t.fields.inputs.sellers_unknown_n).toBe(1);
  }, 60_000);

  it('T28-7 a 2xx page larger than max_bytes with no parked text is verified, truncated true; a large page whose head is parked is not verified', async () => {
    const x = await hs();
    mswServer.use(...site('big.example', LIVE + PAD(600_000)), ...site('bigparked.example', PARKED + PAD(600_000)));
    const t = await verify(x, [E('Big', 'big.example'), E('BigParked', 'bigparked.example')]);
    expect(t.fields.sellers.entries).toEqual([
      { name: 'Big', url: 'https://big.example/', verified: true, reason: 'OK', http_status: 200, truncated: true },
      { name: 'BigParked', url: 'https://bigparked.example/', verified: false, reason: 'PARKED_OR_FOR_SALE', http_status: 200, truncated: true },
    ]);
    expect(t.fields.inputs.sellers_verified_n).toBe(1);
  }, 60_000);

  it('T28-8 sellers_unknown_n counts once per registrable domain, 0 with no list, null with a stale record; a verified domain is not also unknown', async () => {
    const x = await hs();
    mswServer.use(...site('www.dup.example', 'x', 403), ...site('shop.dup.example', 'x', 403), ...site('other.example', 'x', 403));
    const t = await verify(x, [E('A', 'www.dup.example'), E('B', 'shop.dup.example'), E('C', 'other.example')]);
    expect(t.fields.inputs.sellers_unknown_n).toBe(2);
    expect(t.fields.sellers.unknown_n).toBe(2);
    const none = await x.runDone({ mode: 'full', checks: ['form', 'tier'], names: [{ domain: 'plainroofdrone.com', lane: 'S4' }] });
    expect(tierOf(none.body).fields.inputs.sellers_unknown_n).toBe(0);
    expect(tierOf(none.body).fields.sellers).toEqual({ source: null, verified_n: 0, unknown_n: 0, entries: [] });
    x.clock.t += 31 * 24 * HOUR;
    const stale = await x.runDone({ mode: 'full', checks: ['form', 'tier'], names: [{ domain: `${SLD}.com`, lane: 'S4' }] });
    expect(tierOf(stale.body).fields.inputs.sellers_unknown_n).toBeNull();
    expect(tierOf(stale.body).fields.sellers).toMatchObject({ verified_n: null, unknown_n: null, reason_code: 'SELLERS_STALE' });
  }, 60_000);

  it('T28-9 sellers_unknown_n is a tier feature clauses can read (a clause on it validates and is evaluated); the active seed settings do not read it', async () => {
    const x = await hs();
    const ok = await x.post('/selection/settings', { label: 'unk', set: { 'tier.clauses.L': { all: [{ f: 'lane', op: 'in', v: ['S4'] }, { f: 'sellers_unknown_n', op: '>=', v: 1 }] } } });
    expect(ok.statusCode, ok.body).toBe(201);
    const ev = await x.post('/selection/evaluate', { lane: 'S4', settings: 'unk', leads_ab: 0, bin_usd: 1488, features: { registered_share: 0, n_words: 3, sld_chars: 20, is_geo: 0, sellers_unknown_n: 2 } });
    expect(ev.statusCode, ev.body).toBe(200);
    expect(ev.json().tier.inputs.sellers_unknown_n).toBe(2);
    expect(ev.json().tier.clauses.L).toBe('true');
    const json = JSON.stringify(DEFAULT_SELECTION_VALUES.tier);
    expect(json).not.toContain('sellers_unknown_n');
    expect(tierUsesSellers(DEFAULT_SELECTION_VALUES.tier)).toBe(false);
  }, 60_000);
});
