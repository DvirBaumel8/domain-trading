// v3.3.0 part B (CR-023 A-D): lane as a tier input and clause op "in" (A), the sellers list with verification (B), per-lane minimums (C), tier L as a capability (D).
// Sellers pages are MSW handlers; no test touches the network. Production settings are never changed: the L draft is activated in the test database only.
import { readFileSync } from 'node:fs';
import { http, HttpResponse } from 'msw';
import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { decideReplayRow } from '../../../src/modules/selection/replay.js';
import { DEFAULT_SELECTION_VALUES, SelectionValues, selectionSettingsByLabel } from '../../../src/modules/selection/settings.js';
import { evaluateTier, type TierFeatures } from '../../../src/modules/selection/tier.js';
import { testDb as db } from '../../helpers/db.js';
import { screeningHarness, type ScreeningHarness } from '../../helpers/screening.js';
import { mswServer } from '../../setup/network.js';

let app: FastifyInstance | undefined;
afterEach(async () => app?.close());

// ---------- fixtures ----------

const page = (n: string) => readFileSync(new URL(`../../fixtures/screening/sites/${n}`, import.meta.url), 'utf8');
const html = (body: string, status = 200) => new HttpResponse(body, { status, headers: { 'content-type': 'text/html; charset=utf-8' } });
const LIVE = page('synthetic-service.html');
const PARKED = '<!doctype html><html><head><title>acme.example</title></head><body><h1>This domain is for sale</h1><p>Buy now on afternic.com. Make an offer today.</p></body></html>';
const robots404 = (host: string) => http.get(`https://${host}/robots.txt`, () => new HttpResponse(null, { status: 404 }));
const site = (host: string, body: string, status = 200) => [robots404(host), http.get(`https://${host}/`, () => html(body, status))];

const share = (extra: object[]) => [{ f: 'registered_share', op: '>=', v: '$registered_share_min_v11' }, ...extra];
const form = [
  { f: 'n_words', op: '>=', v: '$v11_min_words' }, { f: 'n_words', op: '<=', v: '$v11_max_words' },
  { f: 'sld_chars', op: '<=', v: '$v11_max_chars' }, { f: 'is_geo', op: '==', v: 0 },
];
const V11_SET = {
  'thresholds.registered_share_min_v11': 0.55, 'thresholds.v11_min_words': 2, 'thresholds.v11_max_words': 3, 'thresholds.v11_max_chars': 25,
  'tier.clauses': {
    A: { all: share(form) },
    I: { all: [{ f: 'alt_tld_before_n', op: '>=', v: '$alt_tld_before_min' }, ...form] },
    G: DEFAULT_SELECTION_VALUES.tier.clauses.G,
  },
  'tier.order': ['A', 'I', 'G'], 'tier.demand2_pass_tiers': ['A', 'I', 'G'],
  'freshness_hours.census': 168, 'ext.alt_list': ['net', 'org', 'biz', 'ca'],
};
/** The R-D2 placeholder v11.2 (CR-023): v11 plus tier L, the per-lane minimums and p_passive.L. */
const L_CLAUSE = {
  all: [
    { f: 'lane', op: 'in', v: ['S3', 'S4', 'S6'] }, { f: 'sellers_verified_n', op: '>=', v: '$lane_sellers_min' },
    { f: 'n_words', op: '>=', v: '$v11_min_words' }, { f: 'n_words', op: '<=', v: '$v11_max_words' },
    { f: 'sld_chars', op: '<=', v: '$v11_max_chars' }, { f: 'is_geo', op: '==', v: 0 },
  ],
};
const V112_SET = {
  ...V11_SET,
  'tier.clauses': { ...(V11_SET['tier.clauses'] as object), L: L_CLAUSE },
  'tier.order': ['A', 'I', 'G', 'L'], 'tier.demand2_pass_tiers': ['A', 'I', 'G', 'L'],
  'thresholds.lane_sellers_min': { S3: 5, S4: 2, S6: 3 },
  'tier.p_passive.L': 0.01,
};

interface X extends ScreeningHarness { sites: Record<string, number> }
async function harness(): Promise<X> {
  const sites: Record<string, number> = {};
  const h = await screeningHarness({
    screening: {
      sleep: async () => {},
      siteFetch: ((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
        const u = new URL(String(input instanceof Request ? input.url : input));
        sites[u.hostname + u.pathname] = (sites[u.hostname + u.pathname] ?? 0) + 1;
        return globalThis.fetch(input, init);
      }) as typeof fetch,
    },
  });
  app = h.app;
  return Object.assign(h, { sites });
}
const approval = (x: ScreeningHarness, text: string) => ({ text, approved_at: new Date(x.clock.t - 3_600_000).toISOString() });
async function draftAndActivate(x: ScreeningHarness, label: string, set: object): Promise<void> {
  const d = await x.post('/selection/settings', { label, set });
  expect(d.statusCode, d.body).toBe(201);
  const a = await x.post(`/selection/settings/${label}/activate`, { approval_ref: approval(x, `Dvir: activate ${label}`) });
  expect(a.statusCode, a.body).toBe(200);
}
const tierOf = (body: any, i = 0) => body.names[i].results.find((r: any) => r.check === 'tier');

const F = (o: Partial<TierFeatures> = {}): TierFeatures => ({
  registered_share: 0, prior_history: 0, alt_tld_before_n: 0, n_words: 3, sld_chars: 22, is_geo: 0, gform1_pass: null, short: null, lane: 'S4', sellers_verified_n: 2, ...o,
});
const sel112 = () => SelectionValues.parse({
  ...DEFAULT_SELECTION_VALUES,
  thresholds: { ...DEFAULT_SELECTION_VALUES.thresholds, registered_share_min_v11: 0.55, v11_min_words: 2, v11_max_words: 3, v11_max_chars: 25, lane_sellers_min: { S3: 5, S4: 2, S6: 3 } },
  tier: {
    order: ['A', 'I', 'G', 'L'],
    clauses: { A: { all: share(form) }, I: V11_SET['tier.clauses'].I, G: DEFAULT_SELECTION_VALUES.tier.clauses.G, L: L_CLAUSE },
    demand2_pass_tiers: ['A', 'I', 'G', 'L'], p_passive: { ...DEFAULT_SELECTION_VALUES.tier.p_passive, L: 0.01 },
  },
});

// ---------- A ----------

// ---------- B: intake and records ----------

const SELLERS3 = [
  { name: 'Acme Roof Drones', url: 'https://acme-roof.example/' },
  { name: 'Beta Aerial', url: 'https://beta-aerial.example/services' },
  { name: 'Gamma Inspect', url: 'http://gamma-inspect.example' },
];

// ---------- AC-7: no change for any other name ----------

const csv = readFileSync(new URL('../../../docs/requests/CR-008-reference/v11_fixtures.csv', import.meta.url), 'utf8').split(/\r?\n/).filter((l) => l.trim() !== '');
const head = csv[0]!.split(',');
const rows = csv.slice(1).map((l) => { const c = l.split(','); return Object.fromEntries(head.map((k, i) => [k, c[i]!])) as Record<string, string>; });

describe('CR-023 B: sellers on intake and as a record', () => {
  it('AC-2 intake with 3 valid sellers is 200 and stored on the intake row', async () => {
    const x = await harness();
    const r = await x.post('/candidates/intake', { names: [{ domain: 'roofingdroneinspection.com', lane: 'S4', source: 'scout', sellers: SELLERS3 }, { domain: 'plainroofdrone.com', lane: 'S4', source: 'scout' }] });
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json().accepted).toHaveLength(2);
    const rows = await db.selectFrom('candidate_intake').select(['domain', 'sellers']).orderBy('id').execute();
    expect(rows.map((q) => [q.domain, q.sellers])).toEqual([['roofingdroneinspection.com', SELLERS3], ['plainroofdrone.com', null]]);
  });

  it('AC-2 an email in a seller is 422 NO_PII {index, field: sellers}; 11 entries, a non-http URL and a long name are 422 VALIDATION_ERROR; nothing is stored', async () => {
    const x = await harness();
    const one = (sellers: unknown[]) => x.post('/candidates/intake', { names: [{ domain: 'okname.com', lane: 'S3', source: 'a' }, { domain: 'roofingdroneinspection.com', lane: 'S4', source: 'scout', sellers }] });
    for (const bad of [[{ name: 'Bob bob@acme.example', url: 'https://acme.example/' }], [{ name: 'Acme', url: 'https://bob@acme.example/' }]]) {
      const pii = await one(bad);
      expect([pii.statusCode, pii.json().error.code, pii.json().error.details]).toEqual([422, 'NO_PII', { index: 1, field: 'sellers' }]);
    }
    const many = await one(Array.from({ length: 11 }, (_, i) => ({ name: `Firm ${i}`, url: `https://firm${i}.example/` })));
    expect([many.statusCode, many.json().error.code]).toEqual([422, 'VALIDATION_ERROR']);
    for (const url of ['ftp://acme.example/', 'javascript:alert(1)', 'acme.example', '']) {
      const r = await one([{ name: 'Acme', url }]);
      expect([r.statusCode, r.json().error.code], url).toEqual([422, 'VALIDATION_ERROR']);
    }
    expect((await one([{ name: 'x'.repeat(101), url: 'https://acme.example/' }])).json().error.code).toBe('VALIDATION_ERROR');
    expect((await one([{ name: '', url: 'https://acme.example/' }])).json().error.code).toBe('VALIDATION_ERROR');
    expect((await one([{ name: 'A', url: 'https://acme.example/', extra: 1 }])).json().error.code).toBe('VALIDATION_ERROR');
    expect(await db.selectFrom('candidate_intake').select('id').execute()).toEqual([]);
    // exactly 10 is fine
    expect((await one(Array.from({ length: 10 }, (_, i) => ({ name: `Firm ${i}`, url: `https://firm${i}.example/` })))).statusCode).toBe(200);
  });

  it('AC-3 POST /candidates/{domain}/records kind sellers is 201 with fresh_until from freshness_hours.sellers (default 720); GET lists it; PII, bad shape and an old checked_at are refused', async () => {
    const x = await harness();
    const url = '/candidates/roofingdroneinspection.com/records';
    const r = await x.post(url, { kind: 'sellers', record: SELLERS3, checked_by: 'shomer' });
    expect(r.statusCode, r.body).toBe(201);
    expect(Date.parse(r.json().fresh_until) - Date.parse(r.json().created_at)).toBe(720 * 3_600_000);
    const g = (await x.get(`${url}?kind=sellers`)).json();
    expect(g.freshness_hours).toEqual({ sellers: 720 });
    expect(g.records).toHaveLength(1);
    expect(g.records[0]).toMatchObject({ kind: 'sellers', record: SELLERS3, checked_by: 'shomer', fresh: true });
    const pii = await x.post(url, { kind: 'sellers', record: [{ name: 'a@b.co', url: 'https://x.example/' }], checked_by: 'shomer' });
    expect([pii.statusCode, pii.json().error.code]).toEqual([422, 'NO_PII']);
    const shape = await x.post(url, { kind: 'sellers', record: { name: 'x' }, checked_by: 'shomer' });
    expect([shape.statusCode, shape.json().error.code]).toEqual([422, 'VALIDATION_ERROR']);
    const old = await x.post(url, { kind: 'sellers', record: SELLERS3, checked_by: 'shomer', checked_at: new Date(x.clock.t - 31 * 86_400_000).toISOString() });
    expect([old.statusCode, old.json().error.code]).toEqual([422, 'CHECKED_AT_INVALID']);
    const own = await x.post(url, { kind: 'sellers', record: SELLERS3, checked_by: 'shomer', checked_at: new Date(x.clock.t - 25 * 86_400_000).toISOString() });
    expect(own.statusCode, own.body).toBe(201);
  });
});

// ---------- B: verification in screening; C; D ----------

const SLD = 'roofingdroneinspection';
async function l112(): Promise<X> {
  const x = await harness();
  await draftAndActivate(x, 'v112', V112_SET);
  return x;
}
const runTier = (x: X, names: object[]) => x.runDone({ mode: 'full', checks: ['form', 'tier'], names });
const asRecord = (x: X, domain: string, list: unknown, extra: object = {}) => x.post(`/candidates/${domain}/records`, { kind: 'sellers', record: list, checked_by: 'shomer', ...extra });

describe('CR-023 B: verifying sellers during screening', () => {
  it('AC-4 live page + parked page + 404: sellers_verified_n is 1 and each entry shows its reason', async () => {
    const x = await l112();
    mswServer.use(...site('live-firm.example', LIVE), ...site('parked-firm.example', PARKED), ...site('gone-firm.example', '<html>nope</html>', 404));
    await asRecord(x, `${SLD}.com`, [
      { name: 'Live Firm', url: 'https://live-firm.example/' }, { name: 'Parked Firm', url: 'https://parked-firm.example/' }, { name: 'Gone Firm', url: 'https://gone-firm.example/' },
    ]);
    const { body } = await runTier(x, [{ domain: `${SLD}.com`, lane: 'S4' }]);
    const t = tierOf(body);
    expect(t.fields.inputs.sellers_verified_n).toBe(1);
    expect(t.fields.sellers).toMatchObject({ source: 'record', verified_n: 1 });
    expect(t.fields.sellers.entries).toEqual([
      { name: 'Live Firm', url: 'https://live-firm.example/', verified: true, reason: 'OK', http_status: 200, truncated: false },
      { name: 'Parked Firm', url: 'https://parked-firm.example/', verified: false, reason: 'PARKED_OR_FOR_SALE', http_status: 200, truncated: false },
      { name: 'Gone Firm', url: 'https://gone-firm.example/', verified: false, reason: 'HTTP_4XX', http_status: 404, truncated: false },
    ]);
    expect(t.fields.clauses.L).toBe('false'); // 1 < 2 for S4
    expect(t.upstream_calls ?? 0).toBeGreaterThan(0);
  });

  it('AC-4 two entries on one registrable domain count once; a redirect to another host, a timeout-free refusal and a robots block are not verified', async () => {
    const x = await l112();
    mswServer.use(
      ...site('www.dup-firm.example', LIVE), ...site('shop.dup-firm.example', LIVE),
      robots404('moved.example'), http.get('https://moved.example/', () => new HttpResponse(null, { status: 301, headers: { location: 'https://elsewhere.example/' } })),
      http.get('https://closed.example/robots.txt', () => new HttpResponse('User-agent: *\nDisallow: /\n', { status: 200, headers: { 'content-type': 'text/plain' } })),
    );
    await asRecord(x, `${SLD}.com`, [
      { name: 'Dup A', url: 'https://www.dup-firm.example/' }, { name: 'Dup B', url: 'https://shop.dup-firm.example/' },
      { name: 'Moved', url: 'https://moved.example/' }, { name: 'Closed', url: 'https://closed.example/' },
    ]);
    const { body } = await runTier(x, [{ domain: `${SLD}.com`, lane: 'S4' }]);
    const e = tierOf(body).fields.sellers.entries;
    expect(e.map((q: any) => [q.verified, q.reason])).toEqual([[true, 'OK'], [false, 'DUPLICATE_DOMAIN'], [false, 'REDIRECT_OFF_SITE'], [false, 'ROBOTS_DISALLOWED']]);
    expect(tierOf(body).fields.inputs.sellers_verified_n).toBe(1);
    expect(x.sites['shop.dup-firm.example/']).toBeUndefined(); // the duplicate is not even fetched
  });

  it('a missing or empty list is not a failure: 0 verified, no fetch, the clause is false (R-B5)', async () => {
    const x = await l112();
    const none = await runTier(x, [{ domain: `${SLD}.com`, lane: 'S4' }]);
    expect(tierOf(none.body).fields.inputs.sellers_verified_n).toBe(0);
    expect(tierOf(none.body).fields.sellers).toEqual({ source: null, verified_n: 0, unknown_n: 0, entries: [] });
    expect(tierOf(none.body).fields.clauses.L).toBe('false');
    await asRecord(x, `${SLD}.com`, []);
    const empty = await runTier(x, [{ domain: `${SLD}.com`, lane: 'S4' }]);
    expect(tierOf(empty.body).fields.sellers).toMatchObject({ source: 'record', verified_n: 0, entries: [] });
    expect(tierOf(empty.body).fields.clauses.L).toBe('false');
    expect(Object.keys(x.sites)).toEqual([]);
  });

  it('AC-3 a record older than freshness_hours.sellers is ignored: sellers_verified_n unknown with the reason SELLERS_STALE shown, no fetch', async () => {
    const x = await l112();
    mswServer.use(...site('live-firm.example', LIVE));
    await asRecord(x, `${SLD}.com`, [{ name: 'Live Firm', url: 'https://live-firm.example/' }]);
    x.clock.t += 31 * 86_400_000;
    const { body } = await runTier(x, [{ domain: `${SLD}.com`, lane: 'S4' }]);
    const t = tierOf(body);
    expect(t.fields.inputs.sellers_verified_n).toBeNull();
    expect(t.fields.sellers).toMatchObject({ source: 'record', verified_n: null, reason_code: 'SELLERS_STALE', entries: [] });
    expect(t.fields.clauses.L).toBe('unknown');
    expect(Object.keys(x.sites)).toEqual([]);
    const g = (await x.get(`/candidates/${SLD}.com/records?kind=sellers`)).json();
    expect(g.records[0].fresh).toBe(false);
  });

  it('the freshness window is the setting freshness_hours.sellers', async () => {
    const x = await harness();
    await draftAndActivate(x, 'v112', { ...V112_SET, 'freshness_hours.sellers': 24 });
    mswServer.use(...site('live-firm.example', LIVE));
    const r = await asRecord(x, `${SLD}.com`, [{ name: 'Live Firm', url: 'https://live-firm.example/' }]);
    expect(Date.parse(r.json().fresh_until) - Date.parse(r.json().created_at)).toBe(24 * 3_600_000);
    x.clock.t += 2 * 86_400_000;
    const { body } = await runTier(x, [{ domain: `${SLD}.com`, lane: 'S4' }]);
    expect(tierOf(body).fields.sellers.reason_code).toBe('SELLERS_STALE');
  });

  it('the newer of the intake list and the record wins', async () => {
    const x = await l112();
    mswServer.use(...site('intake-firm.example', LIVE), ...site('record-firm.example', LIVE), ...site('record-two.example', LIVE));
    await x.post('/candidates/intake', { names: [{ domain: `${SLD}.com`, lane: 'S4', source: 'scout', sellers: [{ name: 'Intake Firm', url: 'https://intake-firm.example/' }] }] });
    // 1. intake only
    let { body } = await runTier(x, [{ domain: `${SLD}.com`, lane: 'S4' }]);
    expect(tierOf(body).fields.sellers).toMatchObject({ source: 'intake', verified_n: 1 });
    // 2. a newer record wins
    await asRecord(x, `${SLD}.com`, [{ name: 'Record Firm', url: 'https://record-firm.example/' }, { name: 'Record Two', url: 'https://record-two.example/' }]);
    ({ body } = await runTier(x, [{ domain: `${SLD}.com`, lane: 'S4' }]));
    expect(tierOf(body).fields.sellers).toMatchObject({ source: 'record', verified_n: 2 });
    expect(tierOf(body).fields.clauses.L).toBe('true');
    // 3. an older record loses to a newer intake
    x.clock.t += 3_600_000;
    await x.post('/candidates/intake', { names: [{ domain: `${SLD}.com`, lane: 'S4', source: 'scout-2', sellers: [{ name: 'Intake Firm', url: 'https://intake-firm.example/' }] }] });
    ({ body } = await runTier(x, [{ domain: `${SLD}.com`, lane: 'S4' }]));
    expect(tierOf(body).fields.sellers).toMatchObject({ source: 'intake', verified_n: 1 });
  });

  it('Q3 a drop-list name has sellers only from a record, never from an intake row', async () => {
    const x = await l112();
    mswServer.use(...site('intake-firm.example', LIVE), ...site('record-firm.example', LIVE));
    await x.post('/candidates/intake', { names: [{ domain: `${SLD}.com`, lane: 'S4', source: 'scout', sellers: [{ name: 'Intake Firm', url: 'https://intake-firm.example/' }] }] });
    const run = await x.run({ mode: 'full', checks: ['form', 'tier'], names: [{ domain: `${SLD}.com`, lane: 'S4' }] });
    await db.insertInto('candidate_screenings').values({ intake_id: null, domain: `${SLD}.com`, origin: 'drop_list', run_id: run.id, day: '2026-10-06', at: new Date(x.clock.t) }).execute();
    await app!.screeningWorker.runToEnd(run.id);
    let body = (await x.get(`/screening/runs/${run.id}`)).json();
    expect(tierOf(body).fields.sellers).toEqual({ source: null, verified_n: 0, unknown_n: 0, entries: [] });
    await asRecord(x, `${SLD}.com`, [{ name: 'Record Firm', url: 'https://record-firm.example/' }]);
    const run2 = await x.run({ mode: 'full', checks: ['form', 'tier'], names: [{ domain: `${SLD}.com`, lane: 'S4' }] });
    await db.insertInto('candidate_screenings').values({ intake_id: null, domain: `${SLD}.com`, origin: 'drop_list', run_id: run2.id, day: '2026-10-06', at: new Date(x.clock.t) }).execute();
    await app!.screeningWorker.runToEnd(run2.id);
    body = (await x.get(`/screening/runs/${run2.id}`)).json();
    expect(tierOf(body).fields.sellers).toMatchObject({ source: 'record', verified_n: 1 });
  });

  it('under the active settings (no clause reads sellers_verified_n) no seller page is fetched and the tier result carries no sellers block', async () => {
    const x = await harness();
    await asRecord(x, `${SLD}.com`, [{ name: 'Live Firm', url: 'https://live-firm.example/' }]);
    const { body } = await runTier(x, [{ domain: `${SLD}.com`, lane: 'S4' }]);
    expect(tierOf(body).fields.sellers).toBeUndefined();
    expect(Object.keys(x.sites)).toEqual([]);
  });
});
