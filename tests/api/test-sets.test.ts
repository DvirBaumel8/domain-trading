// v2.5.0 (CR-007 §21, G-4a/G-4b, CR-008 AC-10): test sets (purpose new and rescore), seal, and the helpers behind them.
import { createHash } from 'node:crypto';
import { http } from 'msw';
import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { RdapLookup, RdapLookupFn } from '../../src/rdap.js';
import { decideReplayRow } from '../../src/screening/replay.js';
import { SelectionValues } from '../../src/screening/settings.js';
import { siblingsBt1 } from '../../src/screening/siblings.js';
import { dayBefore, midnightJerusalem, splitRoles, wilson95 } from '../../src/screening/test-sets.js';
import { testDb as db } from '../helpers/db.js';
import { screeningHarness, type ScreeningHarness } from '../helpers/screening.js';
import { fixture, respond } from '../helpers/screening-fixtures.js';
import { mswServer } from '../setup/network.js';

let app: FastifyInstance | undefined;
afterEach(async () => app?.close());
async function h(opts: { screening?: object; stopAfterResults?: number } = {}): Promise<ScreeningHarness> {
  ianaOk();
  const x = await screeningHarness({ ...opts, screening: { rdapLookup: fakeRdap({}), ...opts.screening } });
  app = x.app;
  return x;
}
const approval = (x: ScreeningHarness, text = 'sibling method bt1@v1 approved') => ({ text, approved_at: new Date(x.clock.t - 3_600_000).toISOString() });
const approveMethod = async (x: ScreeningHarness) => expect((await x.post('/selection/sibling-methods/bt1@v1/approve', { approval_ref: approval(x) })).statusCode).toBe(201);

const facts = (created: string | null) => ({ registrar: 'Fake Registrar', created_at: created, expires_at: null, updated_at: null, statuses: [], nameservers: [] });
const registered = (created: string | null): RdapLookup => ({ outcome: 'registered', reasonCode: null, httpStatus: 200, url: 'https://rdap.example/domain/x', retrievedAt: new Date(), body: '{"ldhName":"x"}', facts: facts(created) });
const notRegistered = (): RdapLookup => ({ outcome: 'not_registered', reasonCode: null, httpStatus: 404, url: 'https://rdap.example/domain/x', retrievedAt: new Date(), body: null, facts: null });
function fakeRdap(table: Record<string, RdapLookup>): RdapLookupFn {
  return async (domain) => table[domain] ?? notRegistered();
}
const ianaOk = () => mswServer.use(http.get('https://data.iana.org/rdap/dns.json', () => respond(fixture('iana-dns.json'))));
const sibsOf = (tokens: string[], n: number) => siblingsBt1(tokens).slice(0, n).map((l) => `${l}.com`);
const row = (domain: string, label: 'sold' | 'dropped', as_of: string, extra: object = {}) => ({ domain, label, as_of, source: 'unit', ...(label === 'sold' && { price_usd: 900 }), ...extra });
const sha = (s: string) => createHash('sha256').update(s).digest('hex');

describe('helpers', () => {
  it('TS-U1 wilson95: 286/400 is [0.6689, 0.7570]; 0/0 is null; bounds stay in 0..1', () => {
    expect(wilson95(286, 400)).toEqual([0.6689, 0.757]); // the Wilson score interval, z = 1.96 (0.71295 \u00b1 0.04408)
    expect(wilson95(0, 0)).toBeNull();
    const all = wilson95(10, 10)!;
    expect(all[1]).toBe(1);
    expect(wilson95(0, 10)![0]).toBe(0);
  });
  it('TS-U2 split: same seed gives the same split, another seed another; test count is Math.round(share * n); order is the sha256 of seed:domain', () => {
    const ds = Array.from({ length: 40 }, (_, i) => `name${i}.com`);
    const a = splitRoles(ds, 'seed-1', 0.5);
    expect([...splitRoles([...ds].reverse(), 'seed-1', 0.5)]).not.toEqual([]);
    expect(Object.fromEntries(splitRoles([...ds].reverse(), 'seed-1', 0.5))).toEqual(Object.fromEntries(a));
    expect(Object.fromEntries(splitRoles(ds, 'seed-2', 0.5))).not.toEqual(Object.fromEntries(a));
    expect([...a.values()].filter((r) => r === 'test')).toHaveLength(20);
    expect([...splitRoles(ds, 'x', 0.3).values()].filter((r) => r === 'test')).toHaveLength(12);
    const sorted = [...ds].sort((p, q) => (sha(`seed-1:${p}`) < sha(`seed-1:${q}`) ? -1 : 1));
    expect(sorted.slice(0, 20).every((d) => a.get(d) === 'test')).toBe(true);
    expect(sorted.slice(20).every((d) => a.get(d) === 'dev')).toBe(true);
  });
  it('TS-U3 as_of is midnight Asia/Jerusalem with the offset of that day (also on the DST change days)', () => {
    expect(midnightJerusalem('2024-06-01')).toBe('2024-06-01T00:00:00+03:00');
    expect(midnightJerusalem('2024-01-15')).toBe('2024-01-15T00:00:00+02:00');
    expect(midnightJerusalem('2024-10-27')).toBe('2024-10-27T00:00:00+03:00');
    expect(dayBefore('2024-03-01')).toBe('2024-02-29');
  });
});

describe('test sets, purpose new', () => {
  const FILTERS = { min_words: 2, max_chars: 14, min_price_usd: 500, as_of_from: '2024-01-01', as_of_to: '2025-12-31' };
  const body = (rows: object[], extra: object = {}) => ({ name: 'TS-ONE', purpose: 'new', seed: 'seed-1', filters: FILTERS, rows, ...extra });

  it('TS-1 every removal reason, each with its row; kept rows are split; nothing is stored when the method is not approved', async () => {
    const x = await h();
    await x.post('/selection/labelled-names', { rows: [{ domain: 'supermedia.com', role: 'fit', label: 'sold', source: 'old', slice: 'old', as_of: '2023-01-01', features: {} }] });
    const rows = [
      row('superhealth.com', 'sold', '2024-06-01'), row('supertech.com', 'dropped', '2024-07-01'),
      row('Bad Name.com', 'sold', '2024-06-01'), row('supertech.com', 'dropped', '2024-07-02'),
      row('supermedia.com', 'sold', '2024-06-01'), row('super1pro.com', 'sold', '2024-06-01'), row('mountain.com', 'sold', '2024-06-01'),
      row('supercapitalhealthgroup.com', 'sold', '2024-06-01'), row('austinroofing.com', 'sold', '2024-06-01'),
      row('superbox.com', 'sold', '2024-06-01', { price_usd: 300 }), row('superlabs.com', 'sold', '2023-05-01'), row('superpay.com', 'dropped', '2026-01-01'),
    ];
    const no = await x.post('/selection/test-sets', body(rows));
    expect([no.statusCode, no.json().error.code]).toEqual([409, 'SIBLING_METHOD_NOT_APPROVED']);
    expect(await db.selectFrom('test_sets').selectAll().execute()).toHaveLength(0);
    expect(await db.selectFrom('screening_runs').selectAll().execute()).toHaveLength(0);

    await approveMethod(x);
    const r = await x.post('/selection/test-sets', body(rows));
    expect(r.statusCode, r.body).toBe(202);
    expect(r.json()).toMatchObject({ name: 'TS-ONE', purpose: 'new', status: 'computing', kept_n: 2, removed_n: 10, test_n: 1, dev_n: 1, poll: '/selection/test-sets/TS-ONE' });
    expect(r.json().run_id).toMatch(/^run_/);
    const got = (await x.get('/selection/test-sets/TS-ONE')).json();
    expect(got.removed).toEqual([
      { domain: 'Bad Name.com', reason: 'DOMAIN_INVALID' }, { domain: 'supertech.com', reason: 'DUPLICATE_IN_UPLOAD' }, { domain: 'supermedia.com', reason: 'ALREADY_REGISTERED' },
      { domain: 'super1pro.com', reason: 'FORM_FILTER' }, { domain: 'mountain.com', reason: 'FORM_FILTER' }, { domain: 'supercapitalhealthgroup.com', reason: 'FORM_FILTER' },
      { domain: 'austinroofing.com', reason: 'FORM_FILTER' }, { domain: 'superbox.com', reason: 'PRICE_BELOW_MIN' }, { domain: 'superlabs.com', reason: 'OUTSIDE_WINDOW' },
      { domain: 'superpay.com', reason: 'OUTSIDE_WINDOW' },
    ]);
    expect(got).toMatchObject({ purpose: 'new', seed: 'seed-1', test_share: 0.5, settings_version: 'v1', kept_n: 2, removed_n: 10, test_n: 1, dev_n: 1, sealed_at: null, member_count: null, member_hash: null, report: null });
    expect(got.filters).toEqual({ ...FILTERS, exclude_geo: true });
  });

  it('TS-2 the split is the sha256 order of seed:domain, test_share rounded; the run is a full backtest-style run: lane S7, census_list bt1@v1, as_of midnight IDT, 48 h deadline', async () => {
    const x = await h();
    await approveMethod(x);
    const ds = ['superhealth.com', 'supertech.com', 'superpro.com', 'superbox.com', 'supercapital.com'];
    const r = await x.post('/selection/test-sets', { name: 'TS-SPLIT', purpose: 'new', seed: 'abc', test_share: 0.4, rows: ds.map((d, i) => row(d, i % 2 ? 'dropped' : 'sold', i < 2 ? '2024-06-01' : '2024-01-15')) });
    expect(r.statusCode, r.body).toBe(202);
    expect(r.json()).toMatchObject({ kept_n: 5, removed_n: 0, test_n: 2, dev_n: 3 });
    const stored = await db.selectFrom('test_set_rows').selectAll().where('set_name', '=', 'TS-SPLIT').execute();
    const sorted = [...ds].sort((p, q) => (sha(`abc:${p}`) < sha(`abc:${q}`) ? -1 : 1));
    for (const [i, d] of sorted.entries()) expect(stored.find((s) => s.domain === d)).toMatchObject({ role: i < 2 ? 'test' : 'dev', kept: true, reason: null });
    const run = await db.selectFrom('screening_runs').selectAll().where('id', '=', r.json().run_id).executeTakeFirstOrThrow();
    expect(run).toMatchObject({ mode: 'full', backtest: false, settings_label: 'v1' });
    expect(run.gate_plan).toEqual({ S7: ['form', 'census', 'ext_dates'] });
    const names = (run.input as { names: any[]; checks: string[] }).names;
    expect((run.input as any).checks).toEqual(['form', 'census', 'ext_dates']);
    expect(names.map((n) => [n.domain, n.lane, n.census_list, n.as_of])).toEqual([
      ['superhealth.com', 'S7', 'bt1@v1', '2024-06-01T00:00:00+03:00'], ['supertech.com', 'S7', 'bt1@v1', '2024-06-01T00:00:00+03:00'],
      ['superpro.com', 'S7', 'bt1@v1', '2024-01-15T00:00:00+02:00'], ['superbox.com', 'S7', 'bt1@v1', '2024-01-15T00:00:00+02:00'], ['supercapital.com', 'S7', 'bt1@v1', '2024-01-15T00:00:00+02:00'],
    ]);
    expect(run.deadline_at.getTime() - run.created_at.getTime()).toBe(48 * 3_600_000);
    // same seed and rows in another set would split the same way (pure function of seed and name)
    expect(Object.fromEntries([...splitRoles(ds, 'abc', 0.4)])).toEqual(Object.fromEntries(stored.map((s) => [s.domain, s.role])));
  });

  it('TS-3 name taken is 409 TEST_SET_NAME_TAKEN; zero kept rows is 422 TEST_SET_EMPTY and stores nothing; a bad name or a future as_of is VALIDATION_ERROR', async () => {
    const x = await h();
    await approveMethod(x);
    const ok = await x.post('/selection/test-sets', body([row('superhealth.com', 'sold', '2024-06-01')]));
    expect(ok.statusCode, ok.body).toBe(202);
    const again = await x.post('/selection/test-sets', body([row('supertech.com', 'sold', '2024-06-01')]));
    expect([again.statusCode, again.json().error.code]).toEqual([409, 'TEST_SET_NAME_TAKEN']);
    const empty = await x.post('/selection/test-sets', body([row('mountain.com', 'sold', '2024-06-01')], { name: 'TS-EMPTY' }));
    expect([empty.statusCode, empty.json().error.code]).toEqual([422, 'TEST_SET_EMPTY']);
    expect(await db.selectFrom('test_sets').select('name').execute()).toEqual([{ name: 'TS-ONE' }]);
    expect(await db.selectFrom('screening_runs').selectAll().execute()).toHaveLength(1);
    for (const bad of [{ name: 'ts-lower' }, { name: 'AB' }, { seed: '' }, { test_share: 1 }]) {
      const r = await x.post('/selection/test-sets', body([row('superhealth.com', 'sold', '2024-06-01')], bad));
      expect([r.statusCode, r.json().error.code], JSON.stringify(bad)).toEqual([422, 'VALIDATION_ERROR']);
    }
    const future = await x.post('/selection/test-sets', body([row('superhealth.com', 'sold', '2030-01-01')], { name: 'TS-FUT' }));
    expect([future.statusCode, future.json().error.code]).toEqual([422, 'VALIDATION_ERROR']);
    const nf = await x.get('/selection/test-sets/TS-NONE');
    expect([nf.statusCode, nf.json().error.code]).toEqual([404, 'TEST_SET_NOT_FOUND']);
  });

  it('TS-4 GET never shows labels, features or decisions of a new set; the run finishes (RDAP) and the set is ready; seal registers the rows with DOM features and input dates and freezes the test hash', async () => {
    const A = 'superhealth.com';
    const B = 'supertech.com';
    const rdap = fakeRdap({ ...Object.fromEntries(sibsOf(['super', 'health'], 11).map((d) => [d, registered('2015-06-01T00:00:00Z')])), 'superhealth.net': registered('2016-01-01T00:00:00Z') });
    const x = await h({ stopAfterResults: 1, screening: { rdapLookup: rdap } });
    await approveMethod(x);
    const r = await x.post('/selection/test-sets', { name: 'TS-SEAL', purpose: 'new', seed: 'k', rows: [row(A, 'sold', '2024-06-01', { report_lane: 'fresh' }), row(B, 'dropped', '2024-06-01')] });
    expect(r.statusCode, r.body).toBe(202);
    await app!.screeningWorker.idle();
    const early = (await x.get('/selection/test-sets/TS-SEAL')).json();
    expect(early).toMatchObject({ status: 'computing', run: { status: 'running', names_n: 2 } });
    const notReady = await x.post('/selection/test-sets/TS-SEAL/seal', {});
    expect([notReady.statusCode, notReady.json().error.code]).toEqual([409, 'TEST_SET_NOT_READY']);
    expect(await db.selectFrom('labelled_names').selectAll().execute()).toHaveLength(0);

    await app!.screeningWorker.runToEnd(r.json().run_id);
    const got = await x.get('/selection/test-sets/TS-SEAL');
    const g = got.json();
    expect(g).toMatchObject({ status: 'ready', run: { status: 'done', names_n: 2, done_n: 2 }, features: { census_known_n: 2, alt_known_n: 2 } });
    for (const secret of [A, B, '"label"', '"role"', 'sold', 'dropped', 'registered_share', 'price']) expect(got.body, secret).not.toContain(secret);

    const sealed = await x.post('/selection/test-sets/TS-SEAL/seal', {});
    expect(sealed.statusCode, sealed.body).toBe(201);
    const roles = splitRoles([A, B], 'k', 0.5);
    const tests = [A, B].filter((d) => roles.get(d) === 'test');
    expect(sealed.json()).toEqual({ name: 'TS-SEAL', status: 'sealed', registered_n: 2, test_n: 1, dev_n: 1, member_count: 1, member_hash: sha(tests.join('\n')) });
    const reg = await db.selectFrom('labelled_names').selectAll().orderBy('domain').execute();
    expect(reg.map((l) => [l.domain, l.role, l.label, l.slice, l.source, l.as_of, l.report_lane])).toEqual([
      [A, roles.get(A), 'sold', 'TS-SEAL', 'unit', '2024-06-01', 'fresh'], [B, roles.get(B), 'dropped', 'TS-SEAL', 'unit', '2024-06-01', null],
    ].sort((p, q) => (p[0]! < q[0]! ? -1 : 1)));
    expect(reg.find((l) => l.domain === A)).toMatchObject({ price_cents: 90_000, features: { registered_share: 0.55, alt_tld_before_n: 1, n_words: 2, sld_chars: 11, is_geo: 0, input_dates: { census: '2024-05-31', ext_dates: '2024-05-31' } } });
    expect(reg.find((l) => l.domain === B)!.features).toEqual({ registered_share: 0, alt_tld_before_n: 0, n_words: 2, sld_chars: 9, is_geo: 0, input_dates: { census: '2024-05-31', ext_dates: '2024-05-31' } });
    const after = (await x.get('/selection/test-sets/TS-SEAL')).json();
    expect(after).toMatchObject({ status: 'sealed', member_count: 1, member_hash: sha(tests.join('\n')) });
    expect(after.sealed_at).toMatch(/^20/);

    const twice = await x.post('/selection/test-sets/TS-SEAL/seal', {});
    expect([twice.statusCode, twice.json().error.code]).toEqual([409, 'TEST_SET_ALREADY_SEALED']);
    expect(await db.selectFrom('labelled_names').selectAll().execute()).toHaveLength(2);

    // a later set excludes the sealed names, and a set that still holds a name blocks it too
    const later = await x.post('/selection/test-sets', { name: 'TS-LATER', purpose: 'new', seed: 'k', rows: [row(A, 'sold', '2024-06-01'), row('superpro.com', 'sold', '2024-06-01')] });
    expect(later.json()).toMatchObject({ kept_n: 1, removed_n: 1 });
    expect((await x.get('/selection/test-sets/TS-LATER')).json().removed).toEqual([{ domain: A, reason: 'ALREADY_REGISTERED' }]);
    const third = await x.post('/selection/test-sets', { name: 'TS-THIRD', purpose: 'new', seed: 'k', rows: [row('superpro.com', 'sold', '2024-06-01')] });
    expect([third.statusCode, third.json().error.code]).toEqual([422, 'TEST_SET_EMPTY']);
  });

  it('TS-5 seal refuses a name registered meanwhile (LABELLED_NAME_CONFLICT, nothing stored); the test_set_rows table is append-only', async () => {
    const x = await h();
    await approveMethod(x);
    const r = await x.post('/selection/test-sets', { name: 'TS-RACE', purpose: 'new', seed: 'k', rows: [row('superhealth.com', 'sold', '2024-06-01'), row('supertech.com', 'dropped', '2024-06-01')] });
    await app!.screeningWorker.runToEnd(r.json().run_id);
    await x.post('/selection/labelled-names', { rows: [{ domain: 'supertech.com', role: 'fit', label: 'sold', source: 'other', slice: 'other', features: {} }] });
    const seal = await x.post('/selection/test-sets/TS-RACE/seal', {});
    expect([seal.statusCode, seal.json().error.code]).toEqual([409, 'LABELLED_NAME_CONFLICT']);
    expect(seal.json().error.details).toMatchObject({ count: 1, domains: ['supertech.com'] });
    expect(await db.selectFrom('labelled_names').selectAll().execute()).toHaveLength(1);
    expect((await x.get('/selection/test-sets/TS-RACE')).json().status).toBe('ready'); // the failed seal rolled back, ready is derived again
    await expect(db.updateTable('test_set_rows').set({ kept: false }).execute()).rejects.toThrow(/append-only/);
    await expect(db.deleteFrom('test_set_rows').execute()).rejects.toThrow(/append-only/);
  });
});

describe('test sets, purpose rescore', () => {
  const FEAT = { registered_share: 0.9, alt_tld_before_n: 0, prior_history: 1, n_words: 2, sld_chars: 8, is_geo: 0 };
  const reg = (domain: string, role: string, label: string, slice: string, extra: object = {}) => ({
    domain, role, label, source: 'old', slice, as_of: '2024-06-01', features: FEAT, ...extra,
  });

  it('TS-6 rescore: not sealable; aggregates with Wilson ranges only; decisions under the chosen settings; rows_changed_vs_registered; nothing registered or changed', async () => {
    const sold = ['superpro.com', 'superbox.com', 'supercapital.com'];
    const dropped = ['superlab.com', 'superpay.com'];
    // DOM sees 11 of 20 siblings of superpro registered before as_of (share 0.55); every other name's siblings are free (share 0).
    const rdap = fakeRdap(Object.fromEntries(sibsOf(['super', 'pro'], 11).map((d) => [d, registered('2015-06-01T00:00:00Z')])));
    const x = await h({ screening: { rdapLookup: rdap } });
    await approveMethod(x);
    const up = await x.post('/selection/labelled-names', { rows: [...sold.map((d) => reg(d, 'fit', 'sold', 'R15')), ...dropped.map((d) => reg(d, 'dev', 'dropped', 'R15'))] });
    expect(up.statusCode, up.body).toBe(200);
    const before = await db.selectFrom('labelled_names').selectAll().orderBy('domain').execute();

    const r = await x.post('/selection/test-sets', { name: 'RS-ONE', purpose: 'rescore', slices: ['R15'] });
    expect(r.statusCode, r.body).toBe(202);
    expect(r.json()).toMatchObject({ purpose: 'rescore', status: 'computing', kept_n: 5, removed_n: 0, test_n: 0, dev_n: 0 });
    await app!.screeningWorker.runToEnd(r.json().run_id);
    const got = (await x.get('/selection/test-sets/RS-ONE')).json();
    expect(got).toMatchObject({ status: 'ready', settings_version: 'v1', seed: null, test_share: null, features: { census_known_n: 5, alt_known_n: 5 } });
    expect(Object.keys(got.report).sort()).toEqual(['as_of_reconstructed', 'dropped', 'features_unknown_n', 'rows_changed_vs_registered', 'settings_version', 'sold']);

    // expected by the replay's own tier code
    const v1 = SelectionValues.parse((await db.selectFrom('selection_settings').select('values').where('label', '=', 'v1').executeTakeFirstOrThrow()).values);
    const own = (d: string) => ({ ...FEAT, registered_share: d === 'superpro.com' ? 0.55 : 0, alt_tld_before_n: 0 });
    const dec = (d: string, f: object) => decideReplayRow(f as any, v1).decision;
    const all = [...sold.map((d) => [d, 'sold'] as const), ...dropped.map((d) => [d, 'dropped'] as const)];
    const count = (label: string, dd: string) => all.filter(([d, l]) => l === label && dec(d, own(d)) === dd).length;
    expect(got.report.sold).toMatchObject({ n: 3, accepted: count('sold', 'accept'), rejected: count('sold', 'reject'), undecided: count('sold', 'undecided'), wilson95: wilson95(count('sold', 'accept'), 3) });
    expect(got.report.dropped).toMatchObject({ n: 2, accepted: count('dropped', 'accept'), rejected: count('dropped', 'reject'), undecided: count('dropped', 'undecided'), wilson95: wilson95(count('dropped', 'reject'), 2) });
    expect(got.report.sold.accept_rate).toBe(count('sold', 'accept') / 3);
    expect(got.report.rows_changed_vs_registered).toBe(all.filter(([d]) => dec(d, own(d)) !== dec(d, FEAT)).length);
    expect(got.report).toMatchObject({ settings_version: 'v1', features_unknown_n: 0, as_of_reconstructed: true });

    const seal = await x.post('/selection/test-sets/RS-ONE/seal', {});
    expect([seal.statusCode, seal.json().error.code]).toEqual([409, 'TEST_SET_NOT_SEALABLE']);
    expect(await db.selectFrom('labelled_names').selectAll().orderBy('domain').execute()).toEqual(before);
    const rows = await db.selectFrom('test_set_rows').selectAll().where('set_name', '=', 'RS-ONE').execute();
    expect(rows).toHaveLength(5);
    expect(rows.every((s) => s.role === null && s.kept)).toBe(true);
    // the same slice can be rescored again under another settings label (a draft), and an unknown label is 404
    expect((await x.post('/selection/settings', { label: 'vb', based_on: 'v1', set: { 'ext.alt_list': ['net', 'org'] } })).statusCode).toBe(201);
    const again = await x.post('/selection/test-sets', { name: 'RS-TWO', purpose: 'rescore', slices: ['R15'], settings: 'vb' });
    expect(again.statusCode, again.body).toBe(202);
    await app!.screeningWorker.runToEnd(again.json().run_id);
    expect((await x.get('/selection/test-sets/RS-TWO')).json()).toMatchObject({ status: 'ready', settings_version: 'vb', report: { settings_version: 'vb' } });
    const nf = await x.post('/selection/test-sets', { name: 'RS-NF', purpose: 'rescore', slices: ['R15'], settings: 'nope' });
    expect([nf.statusCode, nf.json().error.code]).toEqual([404, 'SETTINGS_NOT_FOUND']);
  });

  it('TS-7 rescore refuses test rows (HOLDOUT_CONTAMINATED with the first 20 domains and the count), an empty slice (TEST_SET_EMPTY), rows without as_of (AS_OF_REQUIRED), an unapproved method', async () => {
    const x = await h();
    const t = await x.post('/selection/test-sets', { name: 'RS-A', purpose: 'rescore', slices: ['S'] });
    expect([t.statusCode, t.json().error.code]).toEqual([409, 'SIBLING_METHOD_NOT_APPROVED']);
    await approveMethod(x);
    const names = Array.from({ length: 25 }, (_, i) => `contam${String.fromCharCode(97 + (i % 26))}${String.fromCharCode(97 + ((i * 7) % 26))}.com`);
    await x.post('/selection/labelled-names', { rows: [...names.map((d) => reg(d, 'test', 'sold', 'S')), reg('superpro.com', 'fit', 'sold', 'S')] });
    await x.post('/selection/labelled-names', { rows: [reg('noasof.com', 'fit', 'sold', 'N', { as_of: null })] });
    const c = await x.post('/selection/test-sets', { name: 'RS-B', purpose: 'rescore', slices: ['S'] });
    expect([c.statusCode, c.json().error.code]).toEqual([422, 'HOLDOUT_CONTAMINATED']);
    expect(c.json().error.details.count).toBe(25);
    expect(c.json().error.details.domains).toHaveLength(20);
    const e = await x.post('/selection/test-sets', { name: 'RS-C', purpose: 'rescore', slices: ['none'] });
    expect([e.statusCode, e.json().error.code]).toEqual([422, 'TEST_SET_EMPTY']);
    const a = await x.post('/selection/test-sets', { name: 'RS-D', purpose: 'rescore', slices: ['N'] });
    expect([a.statusCode, a.json().error.code]).toEqual([422, 'AS_OF_REQUIRED']);
    expect(await db.selectFrom('test_sets').selectAll().execute()).toHaveLength(0);
    const dup = await x.post('/selection/test-sets', { name: 'RS-E', purpose: 'rescore', slices: Array.from({ length: 21 }, (_, i) => `s${i}`) });
    expect([dup.statusCode, dup.json().error.code]).toEqual([422, 'VALIDATION_ERROR']);
  });
});
