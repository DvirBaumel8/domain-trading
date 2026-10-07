// v2.13.0 (CR-012 parts A, D, E): bt1@v3 on the routes, unknowns, rescore of the names with unknowns, records per domain, buy-hold steps.
import { http } from 'msw';
import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { RdapLookup, RdapLookupFn } from '../../src/rdap.js';
import { siblingsBt1 } from '../../src/screening/siblings.js';
import { splitV2OfDomain } from '../../src/screening/split-v2.js';
import { enableWayback, patchActiveSettings, putBrandLists, screeningHarness, type ScreeningHarness } from '../helpers/screening.js';
import { testDb as db } from '../helpers/db.js';
import { fixture, respond } from '../helpers/screening-fixtures.js';
import { mswServer } from '../setup/network.js';

let app: FastifyInstance | undefined;
afterEach(async () => app?.close());
const DAY = 86_400_000;
const ianaOk = () => mswServer.use(http.get('https://data.iana.org/rdap/dns.json', () => respond(fixture('iana-dns.json'))));
const free = (): RdapLookup => ({ outcome: 'not_registered', reasonCode: null, httpStatus: 404, url: 'https://rdap.example/domain/x', retrievedAt: new Date(), body: null, facts: null });
const refused = (): RdapLookup => ({ outcome: 'unknown', reasonCode: 'SOURCE_ERROR', httpStatus: 403, url: 'https://rdap.example/domain/x', retrievedAt: new Date(), body: null, facts: null });
async function h(lookup: RdapLookupFn = async () => free()): Promise<ScreeningHarness> {
  ianaOk();
  const x = await screeningHarness({ screening: { rdapLookup: lookup } });
  app = x.app;
  return x;
}
const ap = (x: ScreeningHarness, text: string) => ({ text, approved_at: new Date(x.clock.t - 3_600_000).toISOString() });
const FEAT = { registered_share: 0.9, alt_tld_before_n: 0, prior_history: 1, n_words: 2, sld_chars: 8, is_geo: 0 };
const reg = (domain: string, role: string, label: string, slice: string) => ({ domain, role, label, source: 'old', slice, as_of: '2024-06-01', features: FEAT });

describe('bt1@v3 on the routes (CR-012)', () => {
  it('V213-1 sibling-methods GET and approve, census, and test-set sibling_method accept bt1@v3 (default stays bt1@v2); the cohort enum too', async () => {
    const x = await h();
    const g = (await x.get('/selection/sibling-methods/bt1@v3?domain=uaelloyd.com')).json();
    expect(g).toMatchObject({ method: 'bt1@v3', split_sha256: 'a76396a60d25d38c699ae94194b28d6ea354551419c4baf9c9b70d1d33f70d5e', approved: false, siblings: { size: 20 } });
    expect(g.siblings.tokens).toEqual(splitV2OfDomain('uaelloyd.com', 'bt1@v3'));
    expect((await x.get('/selection/sibling-methods/bt1@v2?domain=uaelloyd.com')).json().siblings).toMatchObject({ tokens: [], size: 0 });
    const wrong = await x.post('/selection/sibling-methods/bt1@v3/approve', { approval_ref: ap(x, 'sibling method bt1@v2 approved') });
    expect(wrong.statusCode).toBe(422);
    expect((await x.post('/selection/sibling-methods/bt1@v3/approve', { approval_ref: ap(x, 'sibling method bt1@v3 approved') })).statusCode).toBe(201);
    const r = await x.runDone({ checks: ['census'], names: [{ domain: 'uaelloyd.com', lane: 'S3', census_list: 'bt1@v3' }] });
    const c = r.body.names[0].results.find((q: any) => q.check === 'census');
    expect(c).toMatchObject({ status: 'PASS', fields: { list: 'bt1@v3', n_checked: 20 } });
    expect(c.fields.sibling_tokens).toEqual(splitV2OfDomain('uaelloyd.com', 'bt1@v3'));
    const ts = await x.post('/selection/test-sets', { name: 'TS-V3', purpose: 'new', sibling_method: 'bt1@v3', seed: 's', rows: [{ domain: 'uaelloyd.com', label: 'sold', as_of: '2024-06-01', source: 'u', price_usd: 900 }] });
    expect(ts.statusCode, ts.body).toBe(202);
    expect(ts.json().sibling_method).toBe('bt1@v3');
  });
});

describe('unknowns (CR-012 T12-2, T12-3)', () => {
  // zzqxjkvv: no reading at all (CENSUS_LIST_SIZE). superpro: its siblings are all refused (TOO_MANY_UNKNOWN).
  const REFUSED = new Set(siblingsBt1(['super', 'pro']).map((l) => `${l}.com`));
  const rdap: RdapLookupFn = async (d) => (REFUSED.has(d) ? refused() : free());

  it('V213-2 a rescore set lists each name with an unknown feature, with tokens and size or the lookups with tries; a new set gives counts only', async () => {
    const x = await h(rdap);
    await x.post('/selection/labelled-names', { rows: [reg('superpro.com', 'fit', 'sold', 'R'), reg('zzqxjkvv.com', 'fit', 'sold', 'R'), reg('superbox.com', 'dev', 'dropped', 'R')] });
    const r = await x.post('/selection/test-sets', { name: 'RS-ONE', purpose: 'rescore', slices: ['R'] });
    expect(r.statusCode, r.body).toBe(202);
    await app!.screeningWorker.runToEnd(r.json().run_id);
    const got = (await x.get('/selection/test-sets/RS-ONE')).json();
    expect(got.unknowns).toMatchObject({ total_n: 2, truncated: false });
    const byName = Object.fromEntries(got.unknowns.entries.map((e: any) => [e.domain, e.features]));
    expect(Object.keys(byName).sort()).toEqual(['superpro.com', 'zzqxjkvv.com']);
    expect(byName['zzqxjkvv.com']).toEqual([{ check: 'census', reason_code: 'CENSUS_LIST_SIZE', detail: { tokens: [], size: 0 } }]);
    const sp = byName['superpro.com'].find((f: any) => f.check === 'census');
    expect(sp).toMatchObject({ reason_code: 'TOO_MANY_UNKNOWN' });
    expect(sp.detail.lookups).toHaveLength(20);
    expect(sp.detail.lookups[0]).toMatchObject({ reason_code: 'SOURCE_ERROR', tries: 1 });
    expect(sp.detail.lookups[0].name).toMatch(/\.com$/);
    expect(typeof sp.detail.lookups[0].last_try_at).toBe('string');
    // the run read carries the same
    const run = (await x.get(`/screening/runs/${r.json().run_id}`)).json();
    expect(run.unknowns.total_n).toBe(2);
    expect((await x.get(`/screening/runs/${r.json().run_id}?domain=superbox.com`)).json().unknowns).toMatchObject({ total_n: 0, entries: [] });

    // a `new` set: counts only, never names (R-18)
    await x.post('/selection/sibling-methods/bt1@v2/approve', { approval_ref: ap(x, 'sibling method bt1@v2 approved') });
    const n = await x.post('/selection/test-sets', { name: 'NEW-ONE', purpose: 'new', seed: 's', rows: [{ domain: 'zzqxjkww.com', label: 'sold', as_of: '2024-06-01', source: 'u', price_usd: 900 }, { domain: 'superlab.com', label: 'dropped', as_of: '2024-06-01', source: 'u' }] });
    expect(n.statusCode, n.body).toBe(202);
    await app!.screeningWorker.runToEnd(n.json().run_id);
    const ng = (await x.get('/selection/test-sets/NEW-ONE')).json();
    expect(ng.unknowns).toEqual({ total_n: 1, by_check_reason: { 'census:CENSUS_LIST_SIZE': 1 } });
    expect(JSON.stringify(ng.unknowns)).not.toContain('zzqxjkww');
  });

  it('V213-3 only_names_with_unknowns + from_set: the new rescore holds only the earlier names that had an unknown, and reports gaps before/after', async () => {
    let refuse = true;
    const x = await h(async (d) => (refuse && REFUSED.has(d) ? refused() : free()));
    await x.post('/selection/labelled-names', { rows: [reg('superpro.com', 'fit', 'sold', 'R'), reg('zzqxjkvv.com', 'fit', 'sold', 'R'), reg('superbox.com', 'dev', 'dropped', 'R')] });
    const first = await x.post('/selection/test-sets', { name: 'RS-ONE', purpose: 'rescore', slices: ['R'] });
    await app!.screeningWorker.runToEnd(first.json().run_id);
    refuse = false;
    // the two options go together
    for (const bad of [{ only_names_with_unknowns: true }, { from_set: 'RS-ONE' }]) {
      const b = await x.post('/selection/test-sets', { name: 'RS-BAD', purpose: 'rescore', slices: ['R'], ...bad });
      expect([b.statusCode, b.json().error.code], JSON.stringify(bad)).toEqual([422, 'VALIDATION_ERROR']);
    }
    const nf = await x.post('/selection/test-sets', { name: 'RS-BAD', purpose: 'rescore', slices: ['R'], only_names_with_unknowns: true, from_set: 'RS-NONE' });
    expect([nf.statusCode, nf.json().error.code]).toEqual([404, 'TEST_SET_NOT_FOUND']);
    const second = await x.post('/selection/test-sets', { name: 'RS-TWO', purpose: 'rescore', slices: ['R'], only_names_with_unknowns: true, from_set: 'RS-ONE', max_answer_age_days: 0 });
    expect(second.statusCode, second.body).toBe(202);
    expect(second.json()).toMatchObject({ kept_n: 2 });
    expect((await db.selectFrom('test_set_rows').select('domain').where('set_name', '=', 'RS-TWO').orderBy('domain').execute()).map((r) => r.domain)).toEqual(['superpro.com', 'zzqxjkvv.com']);
    await app!.screeningWorker.runToEnd(second.json().run_id);
    const got = (await x.get('/selection/test-sets/RS-TWO')).json();
    expect(got.report.gaps).toEqual({ before: 2, after: 1 }); // superpro is read now; zzqxjkvv has no reading
    expect(got.filters).toMatchObject({ only_names_with_unknowns: true, from_set: 'RS-ONE', before_n: 2 });
  });
});

describe('records per domain (CR-012 part E)', () => {
  const D = 'tampapoolsco.com';
  const TM = { phrases_queried: ['TAMPA POOLS CO'], control_ok: true, exact_or_core_live: [], generic_live: [] };
  const URL1 = 'https://web.archive.org/web/20190412093000/http://tampapoolsco.com/';
  const HIST = { result: 'PASS', first_capture_year: 2019, last_capture_year: 2021, evidence_urls: [URL1], checked_by: 'gavriel' };
  const at = (res: any, check: string) => res.results.find((q: any) => q.check === check);
  const run = async (x: ScreeningHarness, checks = ['form', 'history', 'tm_us']) => (await x.runDone({ checks, names: [{ domain: D, lane: 'S3' }] })).body.names[0];

  it('V213-4 POST writes a record; GET lists newest first with fresh_until and fresh; a later run uses a fresh record as a manual row would', async () => {
    await putBrandLists();
    const x = await h();
    const before = await run(x);
    expect(at(before, 'tm_us').status).toBe('MANUAL_REQUIRED');
    expect(at(before, 'history').status).toBe('MANUAL_REQUIRED');
    const t0 = x.clock.t;
    const a = await x.post(`/candidates/${D}/records`, { kind: 'tm_us', record: TM, checked_by: 'gavriel', evidence_url: 'https://tmsearch.uspto.gov/x' });
    expect(a.statusCode, a.body).toBe(201);
    expect(a.json()).toMatchObject({ domain: D, kind: 'tm_us', id: expect.any(Number) });
    expect(Date.parse(a.json().fresh_until) - Date.parse(a.json().created_at)).toBe(30 * DAY);
    const b = await x.post(`/candidates/${D}/records`, { kind: 'history', record: { ...HIST, checked_by: undefined }, checked_by: 'dvir' });
    expect(b.statusCode, b.body).toBe(201);
    expect(Date.parse(b.json().fresh_until) - Date.parse(b.json().created_at)).toBe(180 * DAY);
    const list = (await x.get(`/candidates/${D}/records`)).json();
    expect(list.records.map((r: any) => [r.kind, r.fresh, r.checked_by])).toEqual([['history', true, 'dvir'], ['tm_us', true, 'gavriel']]);
    expect(list.records[1]).toMatchObject({ record: TM, source_run_id: null, evidence_url: 'https://tmsearch.uspto.gov/x' });
    expect((await x.get(`/candidates/${D}/records?kind=tm_us`)).json().records).toHaveLength(1);
    expect(Date.parse(list.records[1].fresh_until)).toBeGreaterThan(t0);

    const after = await run(x);
    expect(at(after, 'tm_us')).toMatchObject({ status: 'PASS', fields: { domain_record_id: a.json().id, evidence_url: 'https://tmsearch.uspto.gov/x' } });
    expect(at(after, 'history')).toMatchObject({ status: 'PASS', fields: { manual: true, domain_record_id: b.json().id, checked_by: 'dvir', hist2: 'PASS' } });
  });

  it('V213-5 a stale record counts as missing: tm_us after 30 days, history after 180; GET says fresh false', async () => {
    await putBrandLists();
    const x = await h();
    await x.post(`/candidates/${D}/records`, { kind: 'tm_us', record: TM, checked_by: 'gavriel' });
    await x.post(`/candidates/${D}/records`, { kind: 'history', record: HIST, checked_by: 'gavriel' });
    x.clock.t += 29 * DAY;
    const ok = await run(x);
    expect([at(ok, 'tm_us').status, at(ok, 'history').status]).toEqual(['PASS', 'PASS']);
    x.clock.t += 2 * DAY; // 31 days: tm_us stale, history still fresh
    const mid = await run(x);
    expect([at(mid, 'tm_us').status, at(mid, 'history').status]).toEqual(['MANUAL_REQUIRED', 'PASS']);
    expect((await x.get(`/candidates/${D}/records`)).json().records.map((r: any) => [r.kind, r.fresh])).toEqual([['history', true], ['tm_us', false]]);
    x.clock.t += 150 * DAY; // 181 days
    const late = await run(x);
    expect([at(late, 'tm_us').status, at(late, 'history').status]).toEqual(['MANUAL_REQUIRED', 'MANUAL_REQUIRED']);
  });

  it('V213-6 precedence: a run-level manual row outranks the domain record; the A1 prior-name rule still applies; an automated history result is not replaced', async () => {
    await putBrandLists();
    const x = await h();
    await x.post(`/candidates/${D}/records`, { kind: 'tm_us', record: TM, checked_by: 'gavriel' });
    await x.post(`/candidates/${D}/records`, { kind: 'history', record: { ...HIST, result: 'FLAG_PRIOR_BUSINESS', prior_business_name: 'Sunny Pools LLC' }, checked_by: 'gavriel' });
    // the history record names a prior business, so the tm_us record (which did not query its phrase) is UNKNOWN, as a manual row would be
    const r1 = await run(x);
    expect(at(r1, 'history')).toMatchObject({ status: 'FLAG', reason_code: 'PRIOR_BUSINESS_FLAGGED' });
    expect(at(r1, 'tm_us')).toMatchObject({ status: 'UNKNOWN', reason_code: 'PRIOR_NAME_NOT_QUERIED' });
    // a run-level manual row on the same name outranks the domain record
    const live = await x.runDone({ checks: ['form', 'history', 'tm_us'], names: [{ domain: D, lane: 'S3' }] });
    const man = await x.post(`/screening/runs/${live.id}/manual`, { domain: D, check: 'tm_us', checked_at: new Date(x.clock.t - 3_600_000).toISOString(), evidence_url: 'https://example.com/x', result: { ...TM, phrases_queried: ['TAMPA POOLS CO', 'SUNNY POOLS LLC'], generic_live: [{ mark: 'POOLS', serial: '1', owner: 'x', status: 'live' }] } });
    expect(man.statusCode, man.body).toBe(201);
    await app!.screeningWorker.idle();
    const after = (await x.get(`/screening/runs/${live.id}`)).json().names[0];
    expect(at(after, 'tm_us')).toMatchObject({ status: 'FLAG', reason_code: 'TM_GENERIC_HITS' });
    // with the automated archive on, the history check runs its own source and never reads the record
    await enableWayback();
    const auto = (await x.runDone({ checks: ['form', 'history'], mode: 'full', names: [{ domain: D, lane: 'S3', as_of: '2026-01-01T00:00:00Z' }] })).body.names[0];
    expect(at(auto, 'history').fields.domain_record_id).toBeUndefined();
  });

  it('V213-7 the per-run manual route also writes a domain record (source_run_id), reused by a later run of the name', async () => {
    await putBrandLists();
    const x = await h();
    const first = await x.runDone({ checks: ['form', 'history', 'tm_us'], names: [{ domain: D, lane: 'S3' }] });
    const tm = await x.post(`/screening/runs/${first.id}/manual`, { domain: D, check: 'tm_us', checked_at: new Date(x.clock.t - 3_600_000).toISOString(), evidence_url: 'https://example.com/x', result: TM, note: 'by hand' });
    expect(tm.statusCode, tm.body).toBe(201);
    const hi = await x.post(`/screening/runs/${first.id}/manual`, { domain: D, check: 'history', checked_at: new Date(x.clock.t - 3_600_000).toISOString(), result: HIST });
    expect(hi.statusCode, hi.body).toBe(201);
    await app!.screeningWorker.idle();
    const rows = await db.selectFrom('domain_records').selectAll().orderBy('id').execute();
    expect(rows.map((r) => [r.domain, r.kind, r.source_run_id, r.checked_by, r.note])).toEqual([[D, 'tm_us', first.id, 'gavriel', 'by hand'], [D, 'history', first.id, 'gavriel', null]]);
    expect(rows[0]!.record).toEqual(TM);
    const again = await run(x);
    expect([at(again, 'tm_us').status, at(again, 'history').status]).toEqual(['PASS', 'PASS']);
    // another name has none
    const other = (await x.runDone({ checks: ['form', 'history', 'tm_us'], names: [{ domain: 'austinroofing.com', lane: 'S3' }] })).body.names[0];
    expect(at(other, 'tm_us').status).toBe('MANUAL_REQUIRED');
  });

  it('V213-8 validation: the manual shapes, the kind, the domain; the table is append-only', async () => {
    const x = await h();
    const bad = async (payload: object, d = D) => (await x.post(`/candidates/${d}/records`, payload));
    expect((await bad({ kind: 'tm_us', record: { ...TM, control_ok: 'yes' }, checked_by: 'g' })).json().error.code).toBe('VALIDATION_ERROR');
    expect((await bad({ kind: 'history', record: { result: 'REJECT_HARMFUL', checked_by: 'g' }, checked_by: 'g' })).json().error.code).toBe('VALIDATION_ERROR');
    expect((await bad({ kind: 'web_risk', record: {}, checked_by: 'g' })).json().error.code).toBe('VALIDATION_ERROR');
    expect((await bad({ kind: 'tm_us', record: TM })).json().error.code).toBe('VALIDATION_ERROR');
    expect((await bad({ kind: 'tm_us', record: TM, checked_by: 'g' }, 'tampapools.net')).statusCode).toBe(422);
    expect(await db.selectFrom('domain_records').selectAll().execute()).toHaveLength(0);
    await bad({ kind: 'tm_us', record: TM, checked_by: 'g' });
    await expect(db.updateTable('domain_records').set({ checked_by: 'x' }).execute()).rejects.toThrow(/append-only/);
    await expect(db.deleteFrom('domain_records').execute()).rejects.toThrow(/append-only/);
    const read = await app!.inject({ method: 'POST', url: `/candidates/${D}/records`, payload: {} });
    expect([401, 403]).toContain(read.statusCode);
  });
});

describe('buy-hold steps (CR-012 part D)', () => {
  const steps = async (x: ScreeningHarness) => (await x.get('/selection/buy-hold')).json();
  const status = (b: any) => b.steps.map((s: any) => s.status);

  it('V213-9 a fresh system: seven open steps in order, ready false, next actors named', async () => {
    const x = await h();
    const b = await steps(x);
    expect(b.steps.map((s: any) => s.n)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(status(b)).toEqual(Array(7).fill('open'));
    expect(b.steps.map((s: any) => s.next_actor)).toEqual(['gavriel', 'dvir', 'gavriel', 'gavriel', 'gavriel', 'dvir', 'dvir']);
    expect(b.steps.every((s: any) => s.evidence === null)).toBe(true);
    expect(b.ready).toBe(false);
  });

  it('V213-10 the steps follow the data: sealed set, approved method, hold suite, draft, passing holdout replay, activation, production tranche; a failed replay sticks', async () => {
    const x = await h();
    const run = await x.runDone({ checks: ['form'], names: [{ domain: 'tampapoolsco.com', lane: 'S3' }] });
    await db.insertInto('test_sets').values({ name: 'SEALED-1', purpose: 'new', settings_label: 'v1', run_id: run.id, created_by: 'gavriel', seed: 's', test_share: '0.5', filters: '{}', sibling_method: 'bt1@v3', features_as_of: null, max_answer_age_days: 7, status: 'sealed', sealed_at: new Date('2026-10-07T10:00:00Z'), member_count: 1, member_hash: 'a'.repeat(64) }).execute();
    expect((await x.post('/selection/sibling-methods/bt1@v3/approve', { approval_ref: ap(x, 'sibling method bt1@v3 approved') })).statusCode).toBe(201);
    let b = await steps(x);
    expect(status(b).slice(0, 3)).toEqual(['done', 'done', 'open']);
    expect(b.steps[0].evidence.set).toBe('SEALED-1');
    expect(Date.parse(b.steps[0].evidence.sealed_at)).toBe(Date.parse('2026-10-07T10:00:00Z'));
    expect(b.steps[1].evidence).toMatchObject({ method: 'bt1@v3' });
    expect(b.steps[0].next_actor).toBeNull();

    const suite = (await db.insertInto('holdout_suites').values({ suite: 'HOLD-1', version: 1, slices: ['s'], member_hash: 'b'.repeat(64), member_count: 120, cell: 'pooled', created_by: 'gavriel', approval_text: 'freeze HOLD-1 clears hold', approval_at: new Date(), gates_not_assessed: ['tm_us'], clears_hold: true }).returning('id').executeTakeFirstOrThrow());
    b = await steps(x);
    expect(b.steps[2]).toMatchObject({ status: 'done', evidence: { suite: 'HOLD-1', version: 1 } });
    expect(b.steps[3].status).toBe('open');

    // a draft with buy_hold false
    expect((await x.post('/selection/settings', { label: 'v1b', based_on: 'v1', set: { buy_hold: false } })).statusCode).toBe(201);
    b = await steps(x);
    expect(b.steps[3]).toMatchObject({ status: 'done', evidence: { label: 'v1b' } });
    expect(b.steps[4].status).toBe('open');
    expect(b.ready).toBe(false);

    const draftId = (await db.selectFrom('selection_settings').select('id').where('label', '=', 'v1b').executeTakeFirstOrThrow()).id;
    const judged = (ok: boolean) => ({ judged: { sold: { n: 60, accept_rate: ok ? 0.8 : 0.1 }, dropped: { n: 60, reject_rate: ok ? 0.8 : 0.1 } } });
    const replay = (id: string, ok: boolean) => db.insertInto('replay_runs').values({ id, suite: 'HOLD-1', mode: 'holdout', settings_id: draftId, settings_label: 'v1b', suite_def_id: suite.id, filter: '{}', report: JSON.stringify(judged(ok)), leakage_rows: 0, pass: ok, created_by: 'gavriel' }).execute();
    await replay('rpl_0000000000a1', true);
    b = await steps(x);
    expect(b.steps[4]).toMatchObject({ status: 'done', evidence: { settings: 'v1b', replays: [{ suite: 'HOLD-1', replay_id: 'rpl_0000000000a1', pass: true }] } });
    expect(b.ready).toBe(true);
    expect(b.steps[5]).toMatchObject({ status: 'open', next_actor: 'dvir' });
    expect(b.steps[6].status).toBe('open');

    // a production tranche (a probe does not count)
    await db.insertInto('tranches').values({ id: 'trn_0000000000c1', name: 'accept-v2-probe-20261007', status: 'open', opened_by: 'gavriel', settings_label: 'v1', spend_cap_cents: 20_000 }).execute();
    expect((await steps(x)).steps[6].status).toBe('open');
    await db.updateTable('tranches').set({ status: 'closed', closed_at: new Date(), closed_by: 'gavriel', close_report: '{}' }).where('id', '=', 'trn_0000000000c1').execute(); // only one tranche is open at a time
    await db.insertInto('tranches').values({ id: 'trn_0000000000d2', name: 'production-1', status: 'open', opened_by: 'gavriel', settings_label: 'v1', spend_cap_cents: 50_000 }).execute();
    b = await steps(x);
    expect(b.steps[6]).toMatchObject({ status: 'done', evidence: { tranche_id: 'trn_0000000000d2', cap_cents: 50_000, cap: '$500.00' } });

    // a failed holdout replay sticks (steps 3 and 5)
    await replay('rpl_0000000000b2', false);
    b = await steps(x);
    expect(b.steps[2].status).toBe('failed');
    expect(b.steps[2].evidence.failed_replays).toEqual([{ suite: 'HOLD-1', replay_id: 'rpl_0000000000b2' }]);
    expect(b.steps[4].status).toBe('failed');
    expect(b.ready).toBe(false);
    expect(b.steps[4].next_actor).toBe('gavriel');

    await patchActiveSettings(['buy_hold'], false); // the lifted hold in force (the activation itself is covered by the selection tests)
    expect((await steps(x)).steps[5]).toMatchObject({ status: 'done', next_actor: null, evidence: { label: 'v1' } });
  });
});
