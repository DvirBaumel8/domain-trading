// CR-008 v2.4.0: ext.alt_list (C-1), the sibling method routes and the census that reads bt1@v1 (C-2), AC-5, AC-7, AC-8.
import { readFileSync } from 'node:fs';
import { http } from 'msw';
import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { RdapLookup, RdapLookupFn } from '../../src/rdap.js';
import { DEFAULT_SELECTION_VALUES, SelectionValues, applySet } from '../../src/screening/settings.js';
import { siblingsBt1 } from '../../src/screening/siblings.js';
import { testDb as db } from '../helpers/db.js';
import { screeningHarness, type ScreeningHarness } from '../helpers/screening.js';
import { fixture, respond } from '../helpers/screening-fixtures.js';
import { mswServer } from '../setup/network.js';

let app: FastifyInstance | undefined;
afterEach(async () => app?.close());
async function h(screening?: object): Promise<ScreeningHarness> {
  const x = await screeningHarness({ screening });
  app = x.app;
  return x;
}
const byDomain = (body: any, domain: string) => body.names.find((n: any) => n.domain === domain);
const res = (n: any, check: string) => n.results.find((r: any) => r.check === check);
const item = (domain: string, extra: object = {}) => ({ domain, lane: 'S3', ...extra });
const approval = (x: ScreeningHarness, text = 'sibling method bt1@v1 approved') => ({ text, approved_at: new Date(x.clock.t - 3_600_000).toISOString() });

const facts = (created: string | null) => ({ registrar: 'Fake Registrar', created_at: created, expires_at: null, updated_at: null, statuses: [], nameservers: [] });
const registered = (created: string | null): RdapLookup => ({ outcome: 'registered', reasonCode: null, httpStatus: 200, url: 'https://rdap.example/domain/x', retrievedAt: new Date(), body: '{"ldhName":"x"}', facts: facts(created) });
const notRegistered = (): RdapLookup => ({ outcome: 'not_registered', reasonCode: null, httpStatus: 404, url: 'https://rdap.example/domain/x', retrievedAt: new Date(), body: null, facts: null });
function fakeRdap(table: Record<string, RdapLookup>, fallback: RdapLookup = notRegistered()): { fn: RdapLookupFn; calls: { domain: string }[] } {
  const calls: { domain: string }[] = [];
  return { calls, fn: async (domain) => { calls.push({ domain }); return table[domain] ?? fallback; } };
}
const ianaOk = () => mswServer.use(http.get('https://data.iana.org/rdap/dns.json', () => respond(fixture('iana-dns.json'))));

describe('ext.alt_list (CR-008 C-1)', () => {
  it('ALT-1 the key is optional: the stored v1 parses with no alt_list and nothing is materialised', async () => {
    const raw = (await db.selectFrom('selection_settings').select('values').where('label', '=', 'v1').executeTakeFirstOrThrow()).values as { ext: object };
    expect(raw.ext).toEqual({ list: ['net', 'org', 'co', 'io', 'ai', 'info', 'us'] });
    expect(SelectionValues.parse(raw).ext).toEqual({ list: ['net', 'org', 'co', 'io', 'ai', 'info', 'us'] });
  });
  it('ALT-2 a draft may set ext.alt_list although the base lacks it; bad values are SETTINGS_INVALID with the path', async () => {
    expect(applySet(DEFAULT_SELECTION_VALUES, { 'ext.alt_list': ['net', 'org', 'biz', 'ca'] }).ext).toEqual({ list: DEFAULT_SELECTION_VALUES.ext.list, alt_list: ['net', 'org', 'biz', 'ca'] });
    const x = await h();
    const ok = await x.post('/selection/settings', { label: 'va', based_on: 'v1', set: { 'ext.alt_list': ['net', 'org', 'biz', 'ca'] } });
    expect(ok.statusCode).toBe(201);
    expect(ok.json().values.ext.alt_list).toEqual(['net', 'org', 'biz', 'ca']);
    for (const [i, bad] of ([[], ['net', 'net'], ['NET'], ['n'], 'net', ['toolongextension']] as unknown[]).entries()) {
      const r = await x.post('/selection/settings', { label: `vb${i}`, based_on: 'v1', set: { 'ext.alt_list': bad } });
      expect([r.statusCode, r.json().error.code], JSON.stringify(bad)).toEqual([422, 'SETTINGS_INVALID']);
      expect(JSON.stringify(r.json().error.details.issues)).toMatch(/ext\.alt_list/);
    }
    const other = await x.post('/selection/settings', { label: 'vc', based_on: 'v1', set: { 'ext.nope': ['net'] } });
    expect(other.json().error.code).toBe('SETTINGS_KEY_UNKNOWN');
  });
  it('ALT-3 AC-7: with alt_list [net,org,biz,ca] a label registered only on .ai before as_of gives alt_tld_before_n 0; without alt_list (v1) the same name gives 1', async () => {
    ianaOk();
    const COM = 'netextend.com';
    const rdap = fakeRdap({ [COM]: registered('2023-05-01T00:00:00Z'), 'netextend.ai': registered('2015-02-02T00:00:00Z') });
    const x = await h({ rdapLookup: rdap.fn });
    expect((await x.post('/selection/settings', { label: 'va', based_on: 'v1', set: { 'ext.alt_list': ['net', 'org', 'biz', 'ca'] } })).statusCode).toBe(201);
    const run = (settings: string) => x.runDone({ mode: 'full', settings, checks: ['ext_dates'], names: [item(COM, { as_of: '2024-01-01T00:00:00Z' })] });
    const a = res(byDomain((await run('va')).body, COM), 'ext_dates');
    expect(a.fields.alt_tld_before_n).toBe(0);
    expect(a.fields.extensions.map((e: any) => e.tld)).toEqual(['net', 'org', 'biz', 'ca']);
    const b = res(byDomain((await run('v1')).body, COM), 'ext_dates');
    expect(b.fields.alt_tld_before_n).toBe(1);
    expect(b.fields.extensions.map((e: any) => e.tld)).toEqual(['net', 'org', 'co', 'io', 'ai', 'info', 'us']);
  });
});

describe('sibling method routes (CR-008 C-2)', () => {
  it('SIB-1 GET returns the frozen pools (order, duplicates), sha256 and approval state; also with the URL-encoded @', async () => {
    const x = await h();
    const ref = JSON.parse(readFileSync(new URL('../../docs/requests/CR-008-reference/bt1_pools_v1.json', import.meta.url), 'utf8')) as Record<string, string[]>;
    for (const path of ['bt1@v1', 'bt1%40v1']) {
      const r = await x.get(`/selection/sibling-methods/${path}`);
      expect(r.statusCode, path).toBe(200);
      const b = r.json();
      expect(b).toMatchObject({ method: 'bt1@v1', pools_sha256: 'a984b85e06ed79cf972590518214ccd35c6ea12887a8e08d8a5e807e1a7df48b', approved: false, approval_text: null, approved_at: null });
      expect(b.pools).toEqual({ first_pool: ref.first_pool, last_pool: ref.last_pool, tech: ref.tech, trades: ref.trades });
      expect(b.pools.tech.filter((w: string) => w === 'cyber')).toHaveLength(2);
      expect(b).not.toHaveProperty('siblings');
    }
  });
  it('SIB-2 GET with tokens or domain adds the siblings; both, a bad value or a short list of tokens is VALIDATION_ERROR; unknown method is 404', async () => {
    const x = await h();
    const t = (await x.get('/selection/sibling-methods/bt1@v1?tokens=achieve,hire')).json();
    expect(t.siblings).toEqual({ tokens: ['achieve', 'hire'], list: siblingsBt1(['achieve', 'hire']), size: 20 });
    const d = (await x.get('/selection/sibling-methods/bt1@v1?domain=achievehire.com')).json();
    expect(d.siblings.tokens).toEqual(['achieve', 'hire']);
    expect(d.siblings.list).toEqual(t.siblings.list);
    const one = (await x.get('/selection/sibling-methods/bt1@v1?domain=mountain.com')).json();
    expect(one.siblings).toEqual({ tokens: ['mountain'], list: [], size: 0 });
    for (const q of ['domain=achievehire.com&tokens=achieve,hire', 'tokens=achieve', 'tokens=Achieve,hire', 'tokens=a1,b', 'zzz=1']) {
      const r = await x.get(`/selection/sibling-methods/bt1@v1?${q}`);
      expect([r.statusCode, r.json().error.code], q).toEqual([400, 'VALIDATION_ERROR']);
    }
    expect((await x.get('/selection/sibling-methods/bt1@v1?domain=achievehire.net')).json().error.code).toBe('TLD_NOT_SUPPORTED');
    expect((await x.get('/selection/sibling-methods/bt1@v1?domain=not%20a%20domain')).json().error.code).toBe('DOMAIN_INVALID');
    const nf = await x.get('/selection/sibling-methods/bt9@v9');
    expect([nf.statusCode, nf.json().error.code]).toEqual([404, 'SIBLING_METHOD_NOT_FOUND']);
  });
  it('SIB-3 approve: a text that does not name bt1@v1 is APPROVAL_INVALID, none is APPROVAL_REQUIRED; ok is 201 once, then 409; unknown method 404; GET shows it', async () => {
    const x = await h();
    const no = await x.post('/selection/sibling-methods/bt1@v1/approve', { approval_ref: approval(x, 'sibling method approved') });
    expect([no.statusCode, no.json().error.code]).toEqual([422, 'APPROVAL_INVALID']);
    const near = await x.post('/selection/sibling-methods/bt1@v1/approve', { approval_ref: approval(x, 'sibling method bt1@v1b approved') });
    expect(near.json().error.code).toBe('APPROVAL_INVALID');
    const none = await x.post('/selection/sibling-methods/bt1@v1/approve', {});
    expect([none.statusCode, none.json().error.code]).toEqual([422, 'APPROVAL_REQUIRED']);
    const old = await x.post('/selection/sibling-methods/bt1@v1/approve', { approval_ref: { text: 'bt1@v1 approved', approved_at: new Date(x.clock.t - 100 * 3_600_000).toISOString() } });
    expect(old.json().error.code).toBe('APPROVAL_EXPIRED');
    expect(await db.selectFrom('sibling_method_approvals').selectAll().execute()).toHaveLength(0);
    const ok = await x.post('/selection/sibling-methods/bt1@v1/approve', { approval_ref: approval(x) });
    expect(ok.statusCode).toBe(201);
    expect(ok.json()).toMatchObject({ method: 'bt1@v1', approved: true, approval_text: 'sibling method bt1@v1 approved' });
    const again = await x.post('/selection/sibling-methods/bt1@v1/approve', { approval_ref: approval(x) });
    expect([again.statusCode, again.json().error.code]).toEqual([409, 'SIBLING_METHOD_ALREADY_APPROVED']);
    const nf = await x.post('/selection/sibling-methods/bt9@v9/approve', { approval_ref: approval(x, 'bt9@v9') });
    expect([nf.statusCode, nf.json().error.code]).toEqual([404, 'SIBLING_METHOD_NOT_FOUND']);
    const g = (await x.get('/selection/sibling-methods/bt1@v1')).json();
    expect(g).toMatchObject({ approved: true, approval_text: 'sibling method bt1@v1 approved' });
    expect(g.approved_at).toMatch(/^20/);
    await expect(db.updateTable('sibling_method_approvals').set({ approval_text: 'x' }).execute()).rejects.toThrow(/append-only/);
    await expect(db.deleteFrom('sibling_method_approvals').execute()).rejects.toThrow(/append-only/);
    const row = await db.selectFrom('sibling_method_approvals').selectAll().executeTakeFirstOrThrow();
    expect(row).toMatchObject({ method: 'bt1@v1', pools_sha256: 'a984b85e06ed79cf972590518214ccd35c6ea12887a8e08d8a5e807e1a7df48b', created_by: 'gavriel' });
    expect(row.audit_id).toBeTruthy();
  });
});

describe('census with the sibling method (CR-008 C-2, AC-8)', () => {
  const NAME = 'achievehire.com';
  const sibs = siblingsBt1(['achieve', 'hire']).map((l) => `${l}.com`);
  it('CEN-1 before the approval: UNKNOWN CENSUS_METHOD_NOT_APPROVED with no share; after: the share over the 20 generated siblings, list bt1@v1, no per-name list needed', async () => {
    const rdap = fakeRdap(Object.fromEntries(sibs.slice(0, 11).map((d) => [d, registered('2015-06-01T00:00:00Z')])));
    const x = await h({ rdapLookup: rdap.fn });
    const run = () => x.runDone({ checks: ['form', 'census'], names: [item(NAME, { census_list: 'bt1@v1' })] });
    const a = res(byDomain((await run()).body, NAME), 'census');
    expect(a).toMatchObject({ status: 'UNKNOWN', reason_code: 'CENSUS_METHOD_NOT_APPROVED' });
    expect(a.fields.registered_share).toBeNull();
    expect(rdap.calls).toEqual([]);
    expect((await x.post('/selection/sibling-methods/bt1@v1/approve', { approval_ref: approval(x) })).statusCode).toBe(201);
    const b = res(byDomain((await run()).body, NAME), 'census');
    expect(b).toMatchObject({ status: 'PASS', fields: { list: 'bt1@v1', registered_share: 0.55, n_registered: 11, n_checked: 20, n_unknown: 0, sibling_tokens: ['achieve', 'hire'] } });
    expect(b.fields.siblings.map((s: any) => s.domain)).toEqual(sibs);
    expect(rdap.calls.map((c) => c.domain).sort()).toEqual([...sibs].sort());
  });
  it('CEN-2 a name whose generated list is short (one word) is UNKNOWN CENSUS_LIST_SIZE; per-name lists still work', async () => {
    const rdap = fakeRdap({});
    const x = await h({ rdapLookup: rdap.fn });
    await x.post('/selection/sibling-methods/bt1@v1/approve', { approval_ref: approval(x) });
    const r = await x.runDone({ checks: ['form', 'census'], names: [item('mountain.com', { census_list: 'bt1@v1' })] });
    expect(res(byDomain(r.body, 'mountain.com'), 'census')).toMatchObject({ status: 'UNKNOWN', reason_code: 'CENSUS_LIST_SIZE', fields: { registered_share: null, list: 'bt1@v1' } });
    expect(rdap.calls).toEqual([]);
    const terms = Array.from({ length: 20 }, (_, i) => `perlist${String.fromCharCode(97 + i)}.com`);
    await db.insertInto('selection_lists').values({ name: 'bt1_mountain', version: 1, terms, created_by: 'test', approval_text: 'Dvir: freeze bt1_mountain' }).execute();
    const p = await x.runDone({ checks: ['census'], names: [item('mountain.com', { census_list: 'bt1_mountain@v1' })] });
    expect(res(byDomain(p.body, 'mountain.com'), 'census')).toMatchObject({ status: 'PASS', fields: { list: 'bt1_mountain@v1', registered_share: 0 } });
  });
});
