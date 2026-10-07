// v2.6.0 (CR-009): sibling method bt1@v2 (routes, census), test sets with sibling_method and features_as_of, not_screened (N-7),
// Web Risk error detail (N-3), a non-WRITE token on POST /jobs/run (N-4). N-2 (preview) is in jobs-v2-1.test.ts, the blocklist rule in portfolio-check.test.ts.
import { http, HttpResponse } from 'msw';
import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { RdapLookup, RdapLookupFn } from '../../src/rdap.js';
import { deriveItem } from '../../src/screening/derive.js';
import { siblingsBt1 } from '../../src/screening/siblings.js';
import { splitV2 } from '../../src/screening/split-v2.js';
import { makeApp } from '../helpers/app.js';
import { testDb as db } from '../helpers/db.js';
import { screeningHarness, type ScreeningHarness } from '../helpers/screening.js';
import { fixture, respond } from '../helpers/screening-fixtures.js';
import { issueToken } from '../helpers/tokens.js';
import { mswServer } from '../setup/network.js';

let app: FastifyInstance | undefined;
afterEach(async () => app?.close());
async function h(screening?: object): Promise<ScreeningHarness> {
  mswServer.use(http.get('https://data.iana.org/rdap/dns.json', () => respond(fixture('iana-dns.json'))));
  const x = await screeningHarness({ screening: { rdapLookup: fakeRdap({}), ...screening } });
  app = x.app;
  return x;
}
const facts = (created: string | null) => ({ registrar: 'Fake Registrar', created_at: created, expires_at: null, updated_at: null, statuses: [], nameservers: [] });
const registered = (created: string | null): RdapLookup => ({ outcome: 'registered', reasonCode: null, httpStatus: 200, url: 'https://rdap.example/domain/x', retrievedAt: new Date(), body: '{"ldhName":"x"}', facts: facts(created) });
const notRegistered = (): RdapLookup => ({ outcome: 'not_registered', reasonCode: null, httpStatus: 404, url: 'https://rdap.example/domain/x', retrievedAt: new Date(), body: null, facts: null });
const fakeRdap = (table: Record<string, RdapLookup>): RdapLookupFn => async (domain) => table[domain] ?? notRegistered();
const approval = (x: ScreeningHarness, method: string) => ({ text: `sibling method ${method} approved`, approved_at: new Date(x.clock.t - 3_600_000).toISOString() });
const approve = async (x: ScreeningHarness, method: string) => expect((await x.post(`/selection/sibling-methods/${method}/approve`, { approval_ref: approval(x, method) })).statusCode).toBe(201);
const byDomain = (body: any, domain: string) => body.names.find((n: any) => n.domain === domain);
const res = (n: any, check: string) => n.results.find((r: any) => r.check === check);
const sibs = (tokens: string[]) => siblingsBt1(tokens).map((l) => `${l}.com`);

describe('sibling method bt1@v2 routes (CR-009 N-8)', () => {
  it('V26-1 GET shows the pools hash and the split hash (null for bt1@v1); domain uses the split-v2 tokens, tokens= the given split', async () => {
    const x = await h();
    const v1 = (await x.get('/selection/sibling-methods/bt1@v1')).json();
    const v2 = (await x.get('/selection/sibling-methods/bt1@v2')).json();
    expect(v1).toMatchObject({ method: 'bt1@v1', split_sha256: null });
    expect(v2).toMatchObject({ method: 'bt1@v2', pools_sha256: v1.pools_sha256, split_sha256: '69e659c242ef3a6ea7f55c76dba5680db2199c81ef281d0e80adaf1547f80d73', approved: false });
    expect(v2.pools).toEqual(v1.pools);
    const d = (await x.get('/selection/sibling-methods/bt1@v2?domain=theeventhouse.com')).json();
    expect(d.siblings).toEqual({ tokens: ['the', 'event', 'house'], list: siblingsBt1(['the', 'event', 'house']), size: 20 });
    const t = (await x.get('/selection/sibling-methods/bt1@v2?tokens=achieve,hire')).json();
    expect(t.siblings.tokens).toEqual(['achieve', 'hire']);
    const none = (await x.get('/selection/sibling-methods/bt1@v2?domain=zzqxjkvv.com')).json();
    expect(none.siblings).toEqual({ tokens: [], list: [], size: 0 });
  });
  it('V26-2 approvals are per method: bt1@v2 needs its own line naming bt1@v2; the v1 approval does not approve it', async () => {
    const x = await h();
    await approve(x, 'bt1@v1');
    expect((await x.get('/selection/sibling-methods/bt1@v2')).json().approved).toBe(false);
    const wrong = await x.post('/selection/sibling-methods/bt1@v2/approve', { approval_ref: approval(x, 'bt1@v1') });
    expect([wrong.statusCode, wrong.json().error.code]).toEqual([422, 'APPROVAL_INVALID']);
    await approve(x, 'bt1@v2');
    const g = (await x.get('/selection/sibling-methods/bt1@v2')).json();
    expect(g).toMatchObject({ approved: true, approval_text: 'sibling method bt1@v2 approved' });
    const again = await x.post('/selection/sibling-methods/bt1@v2/approve', { approval_ref: approval(x, 'bt1@v2') });
    expect(again.json().error.code).toBe('SIBLING_METHOD_ALREADY_APPROVED');
  });
});

describe('census with bt1@v2 (CR-009 N-8)', () => {
  const NAME = 'theeventhouse.com';
  const SIBS = sibs(['the', 'event', 'house']);
  it('V26-3 not approved: UNKNOWN CENSUS_METHOD_NOT_APPROVED; approved: the share over the siblings of the split-v2 tokens, without any form check in the plan', async () => {
    const x = await h({ rdapLookup: fakeRdap(Object.fromEntries(SIBS.slice(0, 5).map((d) => [d, registered('2015-06-01T00:00:00Z')]))) });
    const run = () => x.runDone({ checks: ['census'], names: [{ domain: NAME, lane: 'S3', census_list: 'bt1@v2' }] });
    const a = res(byDomain((await run()).body, NAME), 'census');
    expect(a).toMatchObject({ status: 'UNKNOWN', reason_code: 'CENSUS_METHOD_NOT_APPROVED', fields: { list: 'bt1@v2' } });
    await approve(x, 'bt1@v2');
    const b = res(byDomain((await run()).body, NAME), 'census');
    expect(b).toMatchObject({ status: 'PASS', fields: { list: 'bt1@v2', registered_share: 0.25, n_registered: 5, n_checked: 20, sibling_tokens: ['the', 'event', 'house'] } });
    expect(b.fields.siblings.map((s: any) => s.domain)).toEqual(SIBS);
  });
  it('V26-4 the tokens are the split-v2 ones, not the form check\'s; a name with no reading is CENSUS_LIST_SIZE; bt1@v1 still uses the form tokens', async () => {
    const x = await h();
    await approve(x, 'bt1@v2');
    await approve(x, 'bt1@v1');
    const D = 'addsold.com';
    const r2 = await x.runDone({ checks: ['form', 'census'], names: [{ domain: D, lane: 'S3', census_list: 'bt1@v2' }] });
    expect(res(byDomain(r2.body, D), 'census').fields.sibling_tokens).toEqual(splitV2('addsold'));
    const none = await x.runDone({ checks: ['census'], names: [{ domain: 'zzqxjkvv.com', lane: 'S3', census_list: 'bt1@v2' }] });
    expect(res(byDomain(none.body, 'zzqxjkvv.com'), 'census')).toMatchObject({ status: 'UNKNOWN', reason_code: 'CENSUS_LIST_SIZE', fields: { list: 'bt1@v2' } });
    const r1 = await x.runDone({ checks: ['form', 'census'], names: [{ domain: D, lane: 'S3', census_list: 'bt1@v1' }] });
    expect(res(byDomain(r1.body, D), 'census').fields.sibling_tokens).toEqual(res(byDomain(r1.body, D), 'form').fields.tokens);
  });
});

describe('test sets: sibling_method and features_as_of (CR-009 N-8)', () => {
  const FEAT = { registered_share: 0.9, alt_tld_before_n: 0, prior_history: 1, n_words: 2, sld_chars: 8, is_geo: 0 };
  const reg = (domain: string, role: string, label: string, slice: string) => ({ domain, role, label, source: 'old', slice, as_of: '2024-06-01', features: FEAT });
  const row = (domain: string, label: 'sold' | 'dropped', as_of: string) => ({ domain, label, as_of, source: 'unit', ...(label === 'sold' && { price_usd: 900 }) });
  const censusOf = async (runId: string, domain: string) =>
    (await db.selectFrom('screening_results').select(['status', 'reason_code', 'fields']).where('run_id', '=', runId).where('domain', '=', domain).where('check_id', '=', 'census').executeTakeFirstOrThrow());

  it('V26-5 rescore may use an unapproved method (default bt1@v2): the census runs; the flag is stored in the run input; the report and GET show sibling_method and features_as_of', async () => {
    const x = await h();
    expect((await x.post('/selection/labelled-names', { rows: [reg('superpro.com', 'fit', 'sold', 'R'), reg('superlab.com', 'dev', 'dropped', 'R')] })).statusCode).toBe(200);
    const r = await x.post('/selection/test-sets', { name: 'RS-V2', purpose: 'rescore', slices: ['R'] });
    expect(r.statusCode, r.body).toBe(202);
    expect(r.json().sibling_method).toBe('bt1@v2');
    await app!.screeningWorker.runToEnd(r.json().run_id);
    const c = await censusOf(r.json().run_id, 'superpro.com');
    expect(c.reason_code).not.toBe('CENSUS_METHOD_NOT_APPROVED');
    expect(c).toMatchObject({ status: 'PASS', fields: { list: 'bt1@v2', sibling_tokens: ['super', 'pro'] } });
    const run = await db.selectFrom('screening_runs').select('input').where('id', '=', r.json().run_id).executeTakeFirstOrThrow();
    expect((run.input as any).allow_unapproved_method).toBe(true);
    const got = (await x.get('/selection/test-sets/RS-V2')).json();
    expect(got).toMatchObject({ sibling_method: 'bt1@v2', features_as_of: 'row', status: 'ready', report: { sibling_method: 'bt1@v2', features_as_of: 'row' } });
    expect(await db.selectFrom('sibling_method_approvals').selectAll().execute()).toHaveLength(0);
  });

  it('V26-6 a new set needs its method approved: bt1@v2 (default) unapproved is 409 even when bt1@v1 is approved; an unknown method is 422; approved, the set stores and shows its method', async () => {
    const x = await h();
    await approve(x, 'bt1@v1');
    const body = (extra: object = {}) => ({ name: 'TS-V2', purpose: 'new', seed: 's', rows: [row('superhealth.com', 'sold', '2024-06-01')], ...extra });
    const no = await x.post('/selection/test-sets', body());
    expect([no.statusCode, no.json().error.code]).toEqual([409, 'SIBLING_METHOD_NOT_APPROVED']);
    expect(no.json().error.details).toEqual({ method: 'bt1@v2' });
    const bad = await x.post('/selection/test-sets', body({ sibling_method: 'bt1@v3' }));
    expect([bad.statusCode, bad.json().error.code]).toEqual([422, 'VALIDATION_ERROR']);
    expect(await db.selectFrom('test_sets').selectAll().execute()).toHaveLength(0);
    await approve(x, 'bt1@v2');
    const ok = await x.post('/selection/test-sets', body());
    expect(ok.statusCode, ok.body).toBe(202);
    expect(ok.json().sibling_method).toBe('bt1@v2');
    const run = await db.selectFrom('screening_runs').select('input').where('id', '=', ok.json().run_id).executeTakeFirstOrThrow();
    expect((run.input as any).names[0].census_list).toBe('bt1@v2');
    expect((run.input as any).allow_unapproved_method).toBeUndefined(); // only a rescore sets it
    const got = (await x.get('/selection/test-sets/TS-V2')).json();
    expect(got.sibling_method).toBe('bt1@v2');
    expect(got).not.toHaveProperty('features_as_of');
    const old = await x.post('/selection/test-sets', body({ name: 'TS-V1', sibling_method: 'bt1@v1', rows: [row('supertech.com', 'sold', '2024-06-01')] }));
    expect(old.json().sibling_method).toBe('bt1@v1');
    await x.post('/selection/test-sets', body({ name: 'TS-F', features_as_of: 'now' })).then((r) => expect(r.statusCode).toBe(422)); // rescore only
  });

  it('V26-7 a set stored before v2.6.0 (no method column value) reads as bt1@v1', async () => {
    const x = await h();
    await approve(x, 'bt1@v1');
    const r = await x.post('/selection/test-sets', { name: 'TS-OLD', purpose: 'new', sibling_method: 'bt1@v1', seed: 's', rows: [row('superhealth.com', 'sold', '2024-06-01')] });
    expect(r.statusCode).toBe(202);
    await db.updateTable('test_sets').set({ sibling_method: null, features_as_of: null }).where('name', '=', 'TS-OLD').execute();
    expect((await x.get('/selection/test-sets/TS-OLD')).json().sibling_method).toBe('bt1@v1');
  });

  it('V26-8 features_as_of now: every item is as of the creation instant, so siblings created after the row date but before now count; row keeps the row date', async () => {
    const ONE = sibs(['super', 'pro']).slice(0, 11);
    const x = await h({ rdapLookup: fakeRdap(Object.fromEntries(ONE.map((d) => [d, registered('2025-01-01T00:00:00Z')]))) });
    expect((await x.post('/selection/labelled-names', { rows: [reg('superpro.com', 'fit', 'sold', 'R')] })).statusCode).toBe(200);
    const mk = async (name: string, features_as_of?: string) => {
      const r = await x.post('/selection/test-sets', { name, purpose: 'rescore', sibling_method: 'bt1@v1', slices: ['R'], ...(features_as_of && { features_as_of }) });
      expect(r.statusCode, r.body).toBe(202);
      await app!.screeningWorker.runToEnd(r.json().run_id);
      return r.json().run_id as string;
    };
    const rowRun = await mk('RS-ROW');
    const nowRun = await mk('RS-NOW', 'now');
    // the 11 siblings were created 2025-01-01: after the row date (2024-06-01), before now (2026-10)
    expect((await censusOf(rowRun, 'superpro.com')).fields).toMatchObject({ registered_share: 0, n_registered: 0, registered_after_as_of_n: 11, as_of: '2024-05-31T21:00:00.000Z' });
    expect((await censusOf(nowRun, 'superpro.com')).fields).toMatchObject({ registered_share: 0.55, n_registered: 11, registered_after_as_of_n: 0 });
    const created = (await x.get('/selection/test-sets/RS-NOW')).json().created_at as string;
    const input = (await db.selectFrom('screening_runs').select('input').where('id', '=', nowRun).executeTakeFirstOrThrow()).input as { names: { as_of: string }[] };
    expect(input.names.map((n) => Date.parse(n.as_of))).toEqual([Date.parse(created)]);
    expect((await x.get('/selection/test-sets/RS-NOW')).json()).toMatchObject({ features_as_of: 'now', report: { features_as_of: 'now' } });
  });

  it('V26-9 POST /screening/runs cannot set the flag, at run or name level (unknown key, 422)', async () => {
    const x = await h();
    const a = await x.run({ names: [{ domain: 'superpro.com', lane: 'S3' }], allow_unapproved_method: true });
    expect(a.res.statusCode).toBe(422);
    const b = await x.run({ names: [{ domain: 'superpro.com', lane: 'S3', allow_unapproved_method: true }] });
    expect(b.res.statusCode).toBe(422);
  });
});

describe('not_screened (CR-009 N-7)', () => {
  it('V26-10 a plan cut to feature checks only: final_status not_screened, left out of the ranking; a plan with a gate is unchanged', async () => {
    const x = await h();
    const r = await x.runDone({ checks: ['census'], names: [{ domain: 'superpro.com', lane: 'S3', census_list: 'bt1@v2', rank: 1 }] });
    expect(r.body.names[0].final_status).toBe('not_screened');
    expect(r.body.ranking ?? []).toEqual([]);
    const g = await x.runDone({ checks: ['form'], names: [{ domain: 'superpro.com', lane: 'S3' }] });
    expect(g.body.names[0].final_status).not.toBe('not_screened');
  });
  it('V26-11 deriveItem: no gating check in the plan is not_screened, with or without results; a gating check is not', () => {
    expect(deriveItem([], ['census', 'ext_dates'], ['census', 'ext_dates', 'namebio'], true, true).final_status).toBe('not_screened');
    expect(deriveItem([], ['census', 'ext_dates'], ['census', 'ext_dates', 'namebio'], true, false).final_status).toBe('not_screened');
    expect(deriveItem([], ['form', 'census'], ['census'], true, false).final_status).toBe('running');
  });
});

describe('Web Risk error detail (CR-009 N-3)', () => {
  const KEY = 'wr_fake_key_0000000000000000';
  const HOST = 'https://webrisk.googleapis.com/v1/uris:search';
  const one = async (reply: () => Response) => {
    mswServer.use(http.get(HOST, reply));
    const x = await h({ webRiskApiKey: KEY });
    const r = await x.runDone({ checks: ['web_risk'], names: [{ domain: 'site1.com', lane: 'S3' }] });
    return res(r.body.names[0], 'web_risk');
  };
  it('V26-12 a 403 with Google\'s error body: http_status, error_status, error_reason (details[].reason); the key never appears', async () => {
    const r = await one(() => HttpResponse.json({ error: { code: 403, message: 'Requests from this IP are blocked', status: 'PERMISSION_DENIED', details: [{ '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason: 'API_KEY_SERVICE_BLOCKED' }] } }, { status: 403 }));
    expect(r).toMatchObject({ status: 'UNKNOWN', reason_code: 'SOURCE_ERROR', fields: { http_status: 403, error_status: 'PERMISSION_DENIED', error_reason: 'API_KEY_SERVICE_BLOCKED', error_message: null } });
    expect(JSON.stringify(r)).not.toContain(KEY);
  });
  it('V26-13 no reason: error.message cut to 200 characters', async () => {
    const a = await one(() => HttpResponse.json({ error: { code: 400, message: 'x'.repeat(500), status: 'INVALID_ARGUMENT' } }, { status: 400 }));
    expect(a.fields).toMatchObject({ http_status: 400, error_status: 'INVALID_ARGUMENT', error_reason: null });
    expect(a.fields.error_message).toHaveLength(200);
  });
  it('V26-15 a non-JSON error body gives null detail but the http status', async () => {
    const b = await one(() => new Response('<html>bad gateway</html>', { status: 502 }));
    expect(b.fields).toMatchObject({ http_status: 502, error_status: null, error_reason: null, error_message: null });
  });
  it('V26-16 a quota 429 keeps reason QUOTA with the detail', async () => {
    const c = await one(() => HttpResponse.json({ error: { code: 429, message: 'Quota exceeded', status: 'RESOURCE_EXHAUSTED' } }, { status: 429 }));
    expect(c).toMatchObject({ reason_code: 'QUOTA', fields: { http_status: 429, error_status: 'RESOURCE_EXHAUSTED' } });
  });
  it('V26-17 a network failure has no http status', async () => {
    const d = await one(() => HttpResponse.error());
    expect(d.fields).toMatchObject({ http_status: null, error_status: null });
  });
});

describe('POST /jobs/run by a non-WRITE token (CR-009 N-4)', () => {
  it('V26-14 a READ token is 401 with no RateLimit headers and never consumes the WRITE limiter (4 WRITE starts still succeed afterwards)', async () => {
    app = await makeApp({ testRoutes: false, env: { JOB_TRIGGER_TOKEN: 'job_token_fake_0123456789abcdef0123456789' } });
    const read = await issueToken('read');
    const write = await issueToken('write');
    const post = (auth: Record<string, string>, i: number) => app!.inject({ method: 'POST', url: '/jobs/run', headers: { ...auth, 'idempotency-key': `n4-${i}` }, payload: { job: 'tick' } });
    for (let i = 0; i < 6; i++) {
      const r = await post(read.auth, i);
      expect(r.statusCode).toBe(401);
      expect(r.json().error.code).toBe('UNAUTHORIZED');
      expect(Object.keys(r.headers).filter((k) => k.startsWith('ratelimit') || k === 'retry-after')).toEqual([]);
    }
    const codes: number[] = [];
    for (let i = 10; i < 14; i++) codes.push((await post(write.auth, i)).statusCode);
    expect(codes).toEqual([200, 200, 200, 200]);
  });
});
