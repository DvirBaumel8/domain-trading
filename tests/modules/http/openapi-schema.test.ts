// v3.4.0: CR-027 (scout words in form / tier / run view), CR-026 (re-screen named intake names), CR-024 (openapi: itself, request bodies, rebuild 201).
// Sellers pages are MSW handlers; the L settings are activated in the test database only.
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { http, HttpResponse } from 'msw';
import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createRun } from '../../../src/modules/selection/index.js';
import { newAuditId } from '../../../src/http/audit.js';
import { DEFAULT_SELECTION_VALUES } from '../../../src/modules/selection/settings.js';
import { outcome, type Check, type CheckId } from '../../../src/modules/selection/types.js';
import { FakeAdapter } from '../../helpers/fake-adapter.js';
import { testDb as db } from '../../helpers/db.js';
import { createV3 } from '../../helpers/pricing.js';
import { patchActiveSettings, screeningHarness, type ScreeningHarness } from '../../helpers/screening.js';
import { fixture, respond } from '../../helpers/screening-fixtures.js';
import { issueToken } from '../../helpers/tokens.js';
import type { RdapLookup } from '../../../src/core/rdap.js';
import { mswServer } from '../../setup/network.js';

let app: FastifyInstance | undefined;
afterEach(async () => app?.close());
const T_FREE = (): RdapLookup => ({ outcome: 'not_registered', reasonCode: null, httpStatus: 404, url: 'https://rdap.example/domain/x', retrievedAt: new Date(), body: null, facts: null });
const HOUR = 3_600_000;
const DAY = 86_400_000;

// ---------- shared ----------
const page = (n: string) => readFileSync(new URL(`../../fixtures/screening/sites/${n}`, import.meta.url), 'utf8');
const LIVE = page('synthetic-service.html');
const site = (host: string, body: string) => [
  http.get(`https://${host}/robots.txt`, () => new HttpResponse(null, { status: 404 })),
  http.get(`https://${host}/`, () => new HttpResponse(body, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } })),
];
const approval = (x: ScreeningHarness, text: string) => ({ text, approved_at: new Date(x.clock.t - HOUR).toISOString() });
async function draftAndActivate(x: ScreeningHarness, label: string, set: object): Promise<void> {
  const d = await x.post('/selection/settings', { label, set });
  expect(d.statusCode, d.body).toBe(201);
  const a = await x.post(`/selection/settings/${label}/activate`, { approval_ref: approval(x, `Dvir: activate ${label}`) });
  expect(a.statusCode, a.body).toBe(200);
}
const fake = (id: CheckId, gate: string, fields: Record<string, unknown>): Check => ({ id, gate, ruleIds: [], lists: [], run: async () => outcome('PASS', null, null, fields) });
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

// ---------- CR-027 ----------
// The R-D2 draft with tier L and p_passive.L 0.015, as v11.3 (CR-023 activation record).
const share = (extra: object[]) => [{ f: 'registered_share', op: '>=', v: '$registered_share_min_v11' }, ...extra];
const formC = [{ f: 'n_words', op: '>=', v: '$v11_min_words' }, { f: 'n_words', op: '<=', v: '$v11_max_words' }, { f: 'sld_chars', op: '<=', v: '$v11_max_chars' }, { f: 'is_geo', op: '==', v: 0 }];
const V113_SET = {
  'thresholds.registered_share_min_v11': 0.55, 'thresholds.v11_min_words': 2, 'thresholds.v11_max_words': 3, 'thresholds.v11_max_chars': 25,
  'tier.clauses': {
    A: { all: share(formC) },
    I: { all: [{ f: 'alt_tld_before_n', op: '>=', v: '$alt_tld_before_min' }, ...formC] },
    G: DEFAULT_SELECTION_VALUES.tier.clauses.G,
    L: { all: [{ f: 'lane', op: 'in', v: ['S3', 'S4', 'S6'] }, { f: 'sellers_verified_n', op: '>=', v: '$lane_sellers_min' }, ...formC] },
  },
  'tier.order': ['A', 'I', 'G', 'L'], 'tier.demand2_pass_tiers': ['A', 'I', 'G', 'L'],
  'freshness_hours.census': 168, 'ext.alt_list': ['net', 'org', 'biz', 'ca'],
  'thresholds.lane_sellers_min': { S3: 5, S4: 2, S6: 3 }, 'tier.p_passive.L': 0.015,
};
const CHECKS = ['form', 'history', 'census', 'ext_dates', 'tier', 'quote', 'price'];

async function l113(): Promise<ScreeningHarness> {
  mswServer.use(...[1, 2, 3, 4, 5].flatMap((i) => site(`firm${i}.example`, LIVE)));
  const x = await screeningHarness({
    start: Date.now(), adapters: [new FakeAdapter('porkbun', { capabilities: { afternicFastTransfer: true } })], rdap: async () => 'not_registered' as const,
    screening: { sleep: async () => {}, siteFetch: ((i: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => globalThis.fetch(i, init)) as typeof fetch },
  });
  app = x.app;
  await createV3(db);
  await draftAndActivate(x, 'v113', V113_SET);
  const c = x.app.screeningWorker.checks;
  c.census = fake('census', 'G8', { registered_share: 0 });
  c.history = fake('history', 'G6', { prior_history: 0 });
  c.ext_dates = fake('ext_dates', 'G8', { alt_tld_before_n: 0 });
  return x;
}
const sellersOf = (n: number) => Array.from({ length: n }, (_, i) => ({ name: `Firm ${i + 1}`, url: `https://firm${i + 1}.example/` }));
const postRecord = (x: ScreeningHarness, domain: string, n: number) => x.post(`/candidates/${domain}/records`, { kind: 'sellers', record: sellersOf(n), checked_by: 'shomer' });
/** A full-mode run with the scout's `words` (the path POST /screening/runs does not open: the intake runs use it). */
async function runWithWords(x: ScreeningHarness, names: object[]) {
  const auditId = newAuditId();
  await db.insertInto('audit_log').values({ id: auditId, at: new Date(x.clock.t), scope: 'job', method: 'JOB', path: 't27', request: '{}', status_code: 200, result_summary: 't27' }).execute();
  const run = await createRun(db, { mode: 'full', checks: CHECKS as never, names: names as never }, { createdBy: 'test', auditId, now: new Date(x.clock.t) }, x.app.screeningWorker.checks);
  await x.app.screeningWorker.runToEnd(run.id);
  return (await x.get(`/screening/runs/${run.id}?view=full`)).json();
}
const res = (n: any, check: string) => n.results.find((r: any) => r.check === check); // eslint-disable-line @typescript-eslint/no-explicit-any

// ---------- CR-026 ----------
async function h(): Promise<ScreeningHarness> {
  mswServer.use(http.get('https://data.iana.org/rdap/dns.json', () => respond(fixture('iana-dns.json'))));
  const x = await screeningHarness({ adapters: [], screening: { rdapLookup: async () => T_FREE(), sleep: async () => {} } });
  app = x.app;
  return x;
}
const NAMES = ['superpro.com', 'megabox.com', 'smarttech.com'];
const intake3 = async (x: ScreeningHarness, names = NAMES) => (await scout(x)).intake(names.map((domain) => ({ domain, lane: 'S3', source: 'scout' })));
async function screenedOnce(x: ScreeningHarness, names = NAMES) {
  await intake3(x, names);
  const post = await writer(x);
  expect((await post('/candidates/screen', {})).statusCode).toBe(202);
  await settle(x);
  return post;
}
const screenings = async () => (await db.selectFrom('candidate_screenings').select(['domain', 'on_demand']).orderBy('id').execute()).map((c) => c.domain);

// ---------- CR-024 ----------
describe('CR-024: openapi', () => {
  it('T24-1 F-1 /openapi.json lists itself; F-2 every POST has a requestBody or x-no-body; F-3 the rebuild answers 201 in the document', async () => {
    const x = await h();
    const doc = (await x.get('/openapi.json')).json();
    expect(doc.paths['/openapi.json'].get).toMatchObject({ 'x-scope': 'read' });
    const posts = Object.entries(doc.paths).filter(([p, o]: [string, any]) => o.post && !p.startsWith('/__test')); // eslint-disable-line @typescript-eslint/no-explicit-any
    expect(posts.length).toBeGreaterThan(45);
    for (const [p, o] of posts as [string, any][]) { // eslint-disable-line @typescript-eslint/no-explicit-any
      expect(Boolean(o.post.requestBody) || o.post['x-no-body'] === true, `POST ${p} needs requestBody or x-no-body`).toBe(true);
    }
    const body = (p: string) => doc.paths[p].post.requestBody.content['application/json'].schema;
    expect(body('/selection/evaluate').properties.features.properties).toHaveProperty('sellers_verified_n');
    expect(body('/selection/evaluate').required).toEqual(expect.arrayContaining(['lane', 'features', 'leads_ab']));
    expect(JSON.stringify(body('/selection/labelled-names'))).toContain('"rows"');
    expect(doc.paths['/reviews/run'].post['x-no-body']).toBe(true);
    expect(doc.paths['/candidates/daily/rebuild'].post).toMatchObject({ 'x-no-body': true, responses: { '201': { description: 'OK' } } });
    expect(doc.paths['/candidates/screen'].post.requestBody.content['application/json'].schema.properties).toHaveProperty('domains');
    for (const p of ['/selection/test-sets/{name}/cancel', '/screening/runs/{id}/cancel', '/selection/sibling-methods/{method}/approve', '/posts/schema-check']) expect(doc.paths[p].post.requestBody, p).toBeTruthy();
  });

  it('T24-2 F-3 the rebuild code stays as it was: 201 with the summary', async () => {
    const x = await h();
    const post = await writer(x);
    const r = await post('/candidates/daily/rebuild', {});
    expect(r.statusCode).toBe(201);
    expect(r.json()).toHaveProperty('rebuilds_left_today');
  });
});
