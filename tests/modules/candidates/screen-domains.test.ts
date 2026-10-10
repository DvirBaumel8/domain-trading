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

describe('CR-026: POST /candidates/screen {domains} re-screens only what changed', () => {
  it('T26-1 nothing changed since the last screening: every name is skipped NOT_CHANGED, 200, run_id null, no run, no allowance used; the list is rebuilt', async () => {
    const x = await h();
    const post = await screenedOnce(x);
    const before = await db.selectFrom('job_queue_runs').select('id').execute();
    const r = await post('/candidates/screen', { domains: ['superpro.com', 'megabox.com'] });
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json()).toEqual({ run_id: null, names_n: 0, skipped: [{ domain: 'superpro.com', reason: 'NOT_CHANGED' }, { domain: 'megabox.com', reason: 'NOT_CHANGED' }], allowance: { daily_max: 30, used_today: 3, remaining: 27 } });
    expect(await db.selectFrom('job_queue_runs').select('id').execute()).toEqual(before);
    expect(await screenings()).toHaveLength(3);
    expect((await db.selectFrom('daily_candidate_lists').select('built_by').execute()).map((q) => q.built_by)).toContain('auto');
  }, 60_000);

  it('T26-2 the active settings version changed: the names go in again (202), only the named ones; a second call right after is NOT_CHANGED again', async () => {
    const x = await h();
    const post = await screenedOnce(x);
    await draftAndActivate(x, 'v2b', { 'freshness_hours.census': 169 });
    const r = await post('/candidates/screen', { domains: ['superpro.com', 'megabox.com'] });
    expect(r.statusCode, r.body).toBe(202);
    expect(r.json()).toMatchObject({ run_id: expect.stringMatching(/^run_/), names_n: 2, skipped: [], allowance: { used_today: 3, remaining: 27 } });
    await settle(x);
    expect((await screenings()).slice(3).sort()).toEqual(['megabox.com', 'superpro.com']);
    const run = (await db.selectFrom('candidate_screenings').select('run_id').orderBy('id', 'desc').executeTakeFirstOrThrow()).run_id;
    expect((await db.selectFrom('screening_runs').select('settings_label').where('id', '=', run).executeTakeFirstOrThrow()).settings_label).toBe('v2b');
    const again = await post('/candidates/screen', { domains: ['superpro.com', 'smarttech.com'] });
    expect(again.json().skipped).toEqual([{ domain: 'superpro.com', reason: 'NOT_CHANGED' }]); // smarttech.com was screened under v1, so it goes again
    expect(again.json().names_n).toBe(1);
    await settle(x);
  }, 60_000);

  it('T26-3 a record added after the last screening (and an intake row of the name) re-queues only that name; adding a record alone does not queue anything', async () => {
    const x = await h();
    const post = await screenedOnce(x);
    x.clock.t += HOUR;
    expect((await postRecord(x, 'superpro.com', 2)).statusCode).toBe(201);
    // T26-6 (documented): no automatic re-queue
    const plain = await post('/candidates/screen', {});
    expect(plain.json()).toMatchObject({ run_id: null, names_n: 0, skipped: 'NO_NAMES' });
    const r = await post('/candidates/screen', { domains: ['superpro.com', 'megabox.com'] });
    expect(r.statusCode, r.body).toBe(202);
    expect(r.json()).toMatchObject({ names_n: 1, skipped: [{ domain: 'megabox.com', reason: 'NOT_CHANGED' }] });
    await settle(x);
    expect((await screenings()).slice(3)).toEqual(['superpro.com']);
    // an intake row (a duplicate within 30 days) added later counts as a change too
    x.clock.t += HOUR;
    const dup = await (await scout(x)).intake([{ domain: 'megabox.com', lane: 'S3', source: 'scout', words: ['mega', 'box'] }]);
    expect(dup.json().duplicates).toHaveLength(1);
    const r2 = await post('/candidates/screen', { domains: ['megabox.com'] });
    expect(r2.statusCode, r2.body).toBe(202);
    await settle(x);
    expect((await screenings()).slice(4)).toEqual(['megabox.com']);
  }, 60_000);

  it('T26-4 no intake row: NO_INTAKE; a never-screened queued name just goes in; invalid input is 422', async () => {
    const x = await h();
    const post = await writer(x);
    await intake3(x, ['superpro.com']);
    const r = await post('/candidates/screen', { domains: ['superpro.com', 'nothing.com'] });
    expect(r.statusCode, r.body).toBe(202);
    expect(r.json()).toMatchObject({ names_n: 1, skipped: [{ domain: 'nothing.com', reason: 'NO_INTAKE' }] });
    await settle(x);
    const only = await post('/candidates/screen', { domains: ['nothing.com'] });
    expect([only.statusCode, only.json().skipped]).toEqual([200, [{ domain: 'nothing.com', reason: 'NO_INTAKE' }]]);
    for (const domains of [[], Array.from({ length: 31 }, (_, i) => `n${i}.com`), ['not a domain']]) {
      expect((await post('/candidates/screen', { domains })).statusCode).toBe(422);
    }
    expect((await post('/candidates/screen', { domains: ['superpro.com'], extra: 1 })).statusCode).toBe(422);
  }, 60_000);

  it('T26-5 re-screens count against the on-demand allowance as distinct names per IDT day: the same name twice in a day counts once; new names keep counting; the cap still holds', async () => {
    const x = await h();
    await patchActiveSettings(['intake'], { drop_list_max_share: 1, on_demand_screen_daily_max: 3 });
    const post = await screenedOnce(x, ['superpro.com', 'megabox.com']);
    await draftAndActivate(x, 'v2c', { 'freshness_hours.census': 169 });
    const r = await post('/candidates/screen', { domains: ['superpro.com', 'megabox.com'] });
    expect(r.json()).toMatchObject({ names_n: 2, allowance: { daily_max: 3, used_today: 2, remaining: 1 } }); // the same two names: still 2 of 3
    await settle(x);
    await intake3(x, ['smarttech.com']);
    const third = await post('/candidates/screen', {});
    expect(third.json()).toMatchObject({ names_n: 1, allowance: { used_today: 3, remaining: 0 } });
    await settle(x);
    await draftAndActivate(x, 'v2d', { 'freshness_hours.census': 170 });
    // v3.9.0: a NEW name is refused at the cap, but a name already screened on demand today is free (CR-026) and is re-screened
    await intake3(x, ['newbie.com']);
    const cap = await post('/candidates/screen', { domains: ['newbie.com'] });
    expect([cap.statusCode, cap.json().error.code]).toEqual([409, 'ON_DEMAND_SCREEN_CAP']);
    const free = await post('/candidates/screen', { domains: ['superpro.com'] });
    expect(free.statusCode, free.body).toBe(202);
    expect(free.json()).toMatchObject({ names_n: 1, allowance: { used_today: 3, remaining: 0 } });
    await settle(x);
    await draftAndActivate(x, 'v2e', { 'freshness_hours.census': 171 });
    x.clock.t += DAY; // tomorrow the allowance is whole again
    expect((await post('/candidates/screen', { domains: ['superpro.com'] })).statusCode).toBe(202);
    await settle(x);
  }, 90_000);

  it('T26-7 the same Idempotency-Key replays the first answer: one run, no more screenings', async () => {
    const x = await h();
    const post = await screenedOnce(x);
    await draftAndActivate(x, 'v2e', { 'freshness_hours.census': 169 });
    const key = randomUUID();
    const a = await post('/candidates/screen', { domains: ['superpro.com'] }, key);
    const b = await post('/candidates/screen', { domains: ['superpro.com'] }, key);
    expect(a.statusCode).toBe(202);
    expect([b.statusCode, b.json(), b.headers['idempotent-replayed']]).toEqual([202, a.json(), 'true']);
    await settle(x);
    expect(await db.selectFrom('job_queue_runs').select('id').where('job', '=', 'screen').execute()).toHaveLength(2);
    expect((await screenings()).slice(3)).toEqual(['superpro.com']);
  }, 60_000);
});
