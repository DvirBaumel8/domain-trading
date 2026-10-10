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

describe('CR-028 A: POST /candidates/screen {domains, force}', () => {
  it('T28-1 without force the unchanged names are NOT_CHANGED (as in 3.4.0); with force:true they are screened again (202)', async () => {
    const x = await h();
    const post = await screenedOnce(x);
    const no = await post('/candidates/screen', { domains: NAMES });
    expect([no.statusCode, no.json().skipped.map((s: any) => s.reason)]).toEqual([200, ['NOT_CHANGED', 'NOT_CHANGED']]); // eslint-disable-line @typescript-eslint/no-explicit-any
    const off = await post('/candidates/screen', { domains: NAMES, force: false });
    expect(off.statusCode).toBe(200);
    const r = await post('/candidates/screen', { domains: NAMES, force: true });
    expect(r.statusCode, r.body).toBe(202);
    expect(r.json()).toMatchObject({ run_id: expect.stringMatching(/^run_/), names_n: 2, skipped: [] });
    await settle(x);
    expect((await screenings()).slice(2).sort()).toEqual(['megabox.com', 'superpro.com']);
  }, 60_000);

  it('T28-2 force skips only what has nothing to screen: NO_INTAKE and OWNED still skip; unnamed names are not touched', async () => {
    const x = await h();
    const post = await screenedOnce(x, ['superpro.com', 'megabox.com', 'smarttech.com']);
    const r = await post('/candidates/screen', { domains: ['superpro.com', 'nothing.com'], force: true });
    expect(r.statusCode, r.body).toBe(202);
    expect(r.json()).toMatchObject({ names_n: 1, skipped: [{ domain: 'nothing.com', reason: 'NO_INTAKE' }] });
    await settle(x);
    expect((await screenings()).slice(3)).toEqual(['superpro.com']);
    await db.insertInto('domains').values({ domain: 'megabox.com', status: 'pending_purchase', registrar: 'porkbun', category: 'geo' }).execute();
    const o = await post('/candidates/screen', { domains: ['megabox.com'], force: true });
    expect([o.statusCode, o.json().skipped]).toEqual([200, [{ domain: 'megabox.com', reason: 'OWNED' }]]);
  }, 60_000);

  it('T28-3 force without domains is 422 VALIDATION_ERROR (also force:false); a non-boolean force is 422; nothing runs', async () => {
    const x = await h();
    const post = await screenedOnce(x);
    const before = await db.selectFrom('job_queue_runs').select('id').execute();
    for (const body of [{ force: true }, { force: false }, { max_names: 2, force: true }, { domains: ['superpro.com'], force: 'yes' }]) {
      const r = await post('/candidates/screen', body);
      expect([r.statusCode, r.json().error.code], JSON.stringify(body)).toEqual([422, 'VALIDATION_ERROR']);
    }
    expect(await db.selectFrom('job_queue_runs').select('id').execute()).toEqual(before);
  }, 60_000);

  it('T28-4 a forced re-screen counts against the on-demand allowance as distinct names per IDT day; the cap still holds', async () => {
    const x = await h();
    await patchActiveSettings(['intake'], { drop_list_max_share: 1, on_demand_screen_daily_max: 3 });
    const post = await screenedOnce(x);
    const r = await post('/candidates/screen', { domains: NAMES, force: true });
    expect(r.json()).toMatchObject({ names_n: 2, allowance: { daily_max: 3, used_today: 2, remaining: 1 } }); // the same two names count once
    await settle(x);
    await (await scout(x)).intake([{ domain: 'smarttech.com', lane: 'S3', source: 'scout' }]);
    expect((await post('/candidates/screen', {})).json()).toMatchObject({ names_n: 1, allowance: { used_today: 3, remaining: 0 } });
    await settle(x);
    // v3.9.0: the cap refuses a NEW name, but a name already screened on demand today is free (CR-026): its forced re-screen is accepted with the allowance used up
    await (await scout(x)).intake([{ domain: 'fresh-name.com', lane: 'S3', source: 'scout' }]);
    const cap = await post('/candidates/screen', { domains: ['fresh-name.com'], force: true });
    expect([cap.statusCode, cap.json().error.code]).toEqual([409, 'ON_DEMAND_SCREEN_CAP']);
    const free = await post('/candidates/screen', { domains: ['superpro.com'], force: true });
    expect(free.statusCode, free.body).toBe(202);
    expect(free.json()).toMatchObject({ names_n: 1, allowance: { used_today: 3, remaining: 0 } });
    await settle(x);
    expect((await screenings()).filter((d) => d === 'superpro.com')).toHaveLength(3);
    expect((await screenings()).includes('fresh-name.com')).toBe(false);
  }, 90_000);

  it('T28-4b force is stored in the queue run params and shows in the audit summary and the job audit row', async () => {
    const x = await h();
    const post = await screenedOnce(x);
    const r = await post('/candidates/screen', { domains: ['superpro.com'], force: true });
    expect(r.statusCode).toBe(202);
    const run = await db.selectFrom('job_queue_runs').select(['params']).where('id', '=', r.json().run_id).executeTakeFirstOrThrow();
    expect(run.params).toMatchObject({ domains: ['superpro.com'], force: true });
    await settle(x);
    const audit = await db.selectFrom('audit_log').select(['path', 'result_summary', 'request']).where('path', '=', '/candidates/screen').orderBy('at', 'desc').limit(1).executeTakeFirstOrThrow();
    expect(audit.result_summary).toContain('(force)');
    const job = await db.selectFrom('audit_log').select('request').where('path', '=', 'on-demand-screen').orderBy('at', 'desc').limit(1).executeTakeFirstOrThrow();
    expect(typeof job.request === 'string' ? JSON.parse(job.request) : job.request).toMatchObject({ force: true });
    const plain = await post('/candidates/screen', { domains: ['megabox.com'] });
    expect(plain.statusCode).toBe(200);
    const none = await db.selectFrom('job_queue_runs').select('params').where('job', '=', 'screen').orderBy('created_at', 'desc').limit(1).executeTakeFirstOrThrow();
    expect((none.params as any).force).toBe(true); // the newest run is still the forced one: a skipped call makes no run
  }, 60_000);
});

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
