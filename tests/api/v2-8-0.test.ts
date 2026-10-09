// v2.8.0 (CR-007 §22): drop lists (G-2 source A: upload, filters, dropWatch, window reads, DROP_FEED_STALE) and cohorts (G-1: creation, exclusions,
// frozen decisions, daily outcomes, the forward report). RDAP answers are injected recordings; no registrar adapter is ever called.
import { createHash } from 'node:crypto';
import { http } from 'msw';
import { sql } from 'kysely';
import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { FWD_MIN_N, FWD_MIN_RATIO, classRate, windowVerdict } from '../../src/modules/candidates/cohorts.js';
import { DROP_LIST_RETENTION_DAYS, DROP_WATCH_MAX_PER_RUN, watchStatusOf } from '../../src/modules/candidates/drop-lists.js';
import { addDays } from '../../src/core/dates.js';
import { CohortOutcomesJob } from '../../src/modules/ops/jobs/cohort-outcomes.js';
import { DropWatchJob } from '../../src/modules/ops/jobs/drop-watch.js';
import type { RdapLookup } from '../../src/core/rdap.js';
import { wilson95 } from '../../src/modules/selection/test-sets.js';
import { makeApp, runJobToEnd } from '../helpers/app.js';
import { testDb as db } from '../helpers/db.js';
import { FakeAdapter } from '../helpers/fake-adapter.js';
import { patchActiveSettings, screeningHarness, type ScreeningHarness } from '../helpers/screening.js';
import { fixture, respond } from '../helpers/screening-fixtures.js';
import { issueToken } from '../helpers/tokens.js';
import { mswServer } from '../setup/network.js';

const DAY = 86_400_000;
const at = (iso: string) => Date.parse(iso);
let app: FastifyInstance | undefined;
afterEach(async () => app?.close());

const facts = (o: Partial<NonNullable<RdapLookup['facts']>> = {}) => ({ registrar: 'Fake Registrar', created_at: '2015-06-01T00:00:00.000Z', expires_at: null, updated_at: null, statuses: ['client transfer prohibited'], nameservers: [], ...o });
const registered = (o: Partial<NonNullable<RdapLookup['facts']>> = {}): RdapLookup => ({ outcome: 'registered', reasonCode: null, httpStatus: 200, url: 'https://rdap.example/domain/x', retrievedAt: new Date(), body: '{"ldhName":"x"}', facts: facts(o) });
const notRegistered = (): RdapLookup => ({ outcome: 'not_registered', reasonCode: null, httpStatus: 404, url: 'https://rdap.example/domain/x', retrievedAt: new Date(), body: null, facts: null });
const unknown = (): RdapLookup => ({ outcome: 'unknown', reasonCode: 'TIMEOUT', httpStatus: null, url: 'https://rdap.example/domain/x', retrievedAt: new Date(), body: null, facts: null });

const rdap = { table: {} as Record<string, RdapLookup>, calls: [] as string[] };
async function h(): Promise<ScreeningHarness> {
  rdap.table = {}; rdap.calls = [];
  mswServer.use(http.get('https://data.iana.org/rdap/dns.json', () => respond(fixture('iana-dns.json'))));
  const x = await screeningHarness({ screening: { sleep: async () => {}, rdapLookup: async (d) => { rdap.calls.push(d); return rdap.table[d] ?? notRegistered(); } } });
  app = x.app;
  return x;
}
const watch = (x: ScreeningHarness, maxPerRun?: number) => new DropWatchJob({ db, screening: (x.app as any).screeningWorker.deps.screening, now: () => x.clock.t, ...(maxPerRun !== undefined && { maxPerRun }) });
const outcomes = (x: ScreeningHarness) => new CohortOutcomesJob({ db, screening: (x.app as any).screeningWorker.deps.screening, now: () => x.clock.t });
const upload = (x: ScreeningHarness, name: string, domains: string[], list_date = '2026-10-06') => x.post('/selection/drop-lists', { name, list_date, domains });
const latest = (domain: string) => db.selectFrom('drop_list_checks').selectAll().where('domain', '=', domain).orderBy('id', 'desc').executeTakeFirst();

describe('drop lists: upload and filters (G-2)', () => {
  it('V28-1 every removal reason with its count; kept names are lower-cased with their split-v2 tokens; 201 shape', async () => {
    const x = await h();
    const domains = ['superhealth.com', 'SuperTech.com', 'theeventhouse.com', 'bad name.com', 'sub.super.com', 'super.org', 'supertech.com', 'super1pro.com', 'super-pro.com', 'zzqxjkvv.com', 'thebestcoffeeshop.com', 'mountain.com'];
    const r = await upload(x, 'snap-1006', domains);
    expect(r.statusCode, r.body).toBe(201);
    expect(r.json()).toEqual({
      name: 'snap-1006', list_date: '2026-10-06', received_n: 12, kept_n: 3,
      removed: { DOMAIN_INVALID: 3, DUPLICATE_IN_UPLOAD: 1, HAS_DIGIT: 1, HAS_HYPHEN: 1, NO_SPLIT: 1, TOO_MANY_WORDS: 1, ONE_WORD: 1 },
    });
    const g = (await x.get('/selection/drop-lists/snap-1006')).json();
    expect(g).toMatchObject({ name: 'snap-1006', list_date: '2026-10-06', received_n: 12, kept_n: 3 });
    expect(g.rows).toHaveLength(12);
    expect(g.rows.filter((q: any) => q.kept).map((q: any) => [q.domain, q.tokens])).toEqual([['superhealth.com', ['super', 'health']], ['supertech.com', ['super', 'tech']], ['theeventhouse.com', ['the', 'event', 'house']]]);
    expect(g.rows.find((q: any) => q.domain === 'thebestcoffeeshop.com')).toMatchObject({ kept: false, reason: 'TOO_MANY_WORDS', tokens: ['the', 'best', 'coffee', 'shop'], status: null, expected_drop_date: null, checked_at: null });
    expect(g.rows.find((q: any) => q.domain === 'mountain.com').reason).toBe('ONE_WORD');
  });
  it('V28-2 DROP_LIST_NAME_TAKEN (409), DROP_LIST_NOT_FOUND (404), a bad name, a future list_date and an empty list are refused and store nothing', async () => {
    const x = await h();
    expect((await upload(x, 'snap-a1', ['superhealth.com'])).statusCode).toBe(201);
    const again = await upload(x, 'snap-a1', ['supertech.com']);
    expect([again.statusCode, again.json().error.code]).toEqual([409, 'DROP_LIST_NAME_TAKEN']);
    const nf = await x.get('/selection/drop-lists/nope-list');
    expect([nf.statusCode, nf.json().error.code]).toEqual([404, 'DROP_LIST_NOT_FOUND']);
    expect((await upload(x, 'Bad Name', ['superhealth.com'])).statusCode).toBe(422);
    expect((await upload(x, 'snap-a2', ['superhealth.com'], '2026-10-09')).statusCode).toBe(422);
    expect((await upload(x, 'snap-a3', [])).statusCode).toBe(422);
    expect(await db.selectFrom('drop_lists').select('name').execute()).toEqual([{ name: 'snap-a1' }]);
    expect(await db.selectFrom('drop_list_rows').selectAll().execute()).toHaveLength(1);
  });
});

describe('dropWatch (G-2)', () => {
  const NAMES = ['superhealth.com', 'supertech.com', 'superpro.com', 'superbox.com', 'supermedia.com', 'supercapital.com'];
  const setup = async () => {
    const x = await h();
    await upload(x, 'snap-w1', NAMES);
    rdap.table = {
      'superhealth.com': registered({ statuses: ['pendingDelete'], updated_at: '2026-10-04T10:00:00.000Z' }),
      'supertech.com': registered({ statuses: ['redemption period', 'server hold'], updated_at: '2026-09-20T10:00:00.000Z' }),
      'superpro.com': registered({ updated_at: '2026-09-01T00:00:00.000Z' }),
      'superbox.com': notRegistered(),
      'supermedia.com': unknown(),
      'supercapital.com': registered({ statuses: ['pending delete'], updated_at: null }),
    };
    return x;
  };
  it('V28-3 mapping: pending delete + last changed -> +5 days (rdap_last_changed); redemption -> +35 days (estimate); registered; not registered; unknown with its reason; summary', async () => {
    const x = await setup();
    const s = await watch(x).runOnce();
    expect(s).toEqual({ dryRun: false, skipped: false, checked: 6, pending_delete: 2, redemption: 1, registered: 1, not_registered: 1, unknown: 1, left_for_next_run: 0, rechecked: 0 });
    expect(await latest('superhealth.com')).toMatchObject({ status: 'pending_delete', last_changed: '2026-10-04', expected_drop_date: '2026-10-09', drop_date_source: 'rdap_last_changed' });
    expect(await latest('supertech.com')).toMatchObject({ status: 'redemption', last_changed: '2026-09-20', expected_drop_date: '2026-10-25', drop_date_source: 'estimate' });
    expect(await latest('superpro.com')).toMatchObject({ status: 'registered', expected_drop_date: null, drop_date_source: null });
    expect(await latest('superbox.com')).toMatchObject({ status: 'not_registered', expected_drop_date: null });
    expect(await latest('supermedia.com')).toMatchObject({ status: 'unknown', reason_code: 'TIMEOUT', expected_drop_date: null });
    expect(await latest('supercapital.com')).toMatchObject({ status: 'pending_delete', last_changed: null, expected_drop_date: null, drop_date_source: null });
    expect(watchStatusOf(registered({ statuses: ['PendingDelete'], updated_at: '2026-03-01T00:00:00Z' }))).toMatchObject({ status: 'pending_delete', expected_drop_date: '2026-03-06' });
    const g = (await x.get('/selection/drop-lists/snap-w1')).json();
    expect(g.rows.find((r: any) => r.domain === 'superhealth.com')).toMatchObject({ status: 'pending_delete', expected_drop_date: '2026-10-09', drop_date_source: 'rdap_last_changed' });
    const audit = await db.selectFrom('audit_log').select('result_summary').where('path', '=', 'drop-watch').execute();
    expect(audit).toHaveLength(1);
  });
  it('V28-4 a name already checked is not asked again; unknown is asked once per IDT day and at most 5 checks in all', async () => {
    const x = await setup();
    await watch(x).runOnce();
    rdap.calls = [];
    expect((await watch(x).runOnce()).checked).toBe(0); // same day: nothing due (the unknown one waits for tomorrow)
    expect(rdap.calls).toEqual([]);
    for (let day = 1; day <= 6; day++) {
      x.clock.t += DAY;
      rdap.calls = [];
      const s = await watch(x).runOnce();
      // v3.2.0 (CR-019 C-4): superhealth (expected drop 10-09) is also asked each day from its drop date for 7 days (days 3 to 6 here); the unknown one as before
      const expected = [...(day >= 3 ? ['superhealth.com'] : []), ...(day <= 4 ? ['supermedia.com'] : [])].sort();
      expect(s.checked).toBe(expected.length);
      expect([...rdap.calls].sort()).toEqual(expected);
      expect(s.rechecked).toBe(day >= 3 ? 1 : 0);
    }
    expect(await db.selectFrom('drop_list_checks').select('id').where('domain', '=', 'supermedia.com').execute()).toHaveLength(5);
    // a later answer replaces the unknown one in reads: it became not registered on day 2 here
  });
  it('V28-5 the per-run cap leaves the rest for the next run; the default cap is 3000; a dry run asks and tallies but records nothing', async () => {
    expect(DROP_WATCH_MAX_PER_RUN).toBe(3000);
    const x = await setup();
    const dry = await watch(x).runOnce({ dryRun: true });
    expect(dry).toMatchObject({ dryRun: true, checked: 6, pending_delete: 2 });
    expect(await db.selectFrom('drop_list_checks').selectAll().execute()).toHaveLength(0);
    expect(await db.selectFrom('audit_log').select('id').where('path', '=', 'drop-watch').execute()).toHaveLength(0);
    const a = await watch(x, 4).runOnce();
    expect(a).toMatchObject({ checked: 4, left_for_next_run: 2 });
    const b = await watch(x, 4).runOnce();
    expect(b).toMatchObject({ checked: 2, left_for_next_run: 0 });
  });
  it('V28-6 window query: names whose latest check has an expected drop date in the window, by date then domain; strict query; at most 31 days', async () => {
    const x = await setup();
    await watch(x).runOnce();
    const w = (q: string) => x.get(`/selection/drop-lists${q}`);
    const r = await w('?drop_from=2026-10-01&drop_to=2026-10-31');
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json()).toEqual({ names: [
      { domain: 'superhealth.com', list_name: 'snap-w1', status: 'pending_delete', expected_drop_date: '2026-10-09', drop_date_source: 'rdap_last_changed', tokens: ['super', 'health'] },
      { domain: 'supertech.com', list_name: 'snap-w1', status: 'redemption', expected_drop_date: '2026-10-25', drop_date_source: 'estimate', tokens: ['super', 'tech'] },
    ] });
    expect((await w('?drop_from=2026-10-10&drop_to=2026-10-31')).json().names.map((n: any) => n.domain)).toEqual(['supertech.com']);
    expect((await w('?drop_from=2026-10-09&drop_to=2026-10-09')).json().names.map((n: any) => n.domain)).toEqual(['superhealth.com']);
    for (const q of ['', '?drop_from=2026-10-01', '?drop_from=2026-10-01&drop_to=2026-12-31', '?drop_from=2026-10-05&drop_to=2026-10-01', '?drop_from=2026-10-01&drop_to=2026-10-02&x=1', '?drop_from=bad&drop_to=2026-10-02']) {
      const e = await w(q);
      expect([e.statusCode, e.json().error.code], q).toEqual([400, 'VALIDATION_ERROR']);
    }
    // a later check that says the name is registered again removes it from the window (latest check per domain)
    rdap.table['superhealth.com'] = registered();
    x.clock.t += DAY;
    await db.insertInto('drop_list_checks').values({ list_name: 'snap-w1', domain: 'superhealth.com', checked_at: new Date(x.clock.t), status: 'registered' }).execute();
    expect((await w('?drop_from=2026-10-01&drop_to=2026-10-31')).json().names.map((n: any) => n.domain)).toEqual(['supertech.com']);
  });
  it('V28-7 retention: a list more than 60 days after its list_date is ignored by reads and by dropWatch; its rows stay (append-only)', async () => {
    expect(DROP_LIST_RETENTION_DAYS).toBe(60);
    const x = await setup();
    await watch(x).runOnce();
    x.clock.t = at('2026-10-06T08:00:00Z') + 61 * DAY;
    rdap.calls = [];
    expect((await x.get(`/selection/drop-lists?drop_from=${addDays('2026-10-06', 61)}&drop_to=${addDays('2026-10-06', 90)}`)).json().names).toEqual([]);
    expect((await watch(x).runOnce()).checked).toBe(0);
    expect(rdap.calls).toEqual([]);
    expect(await db.selectFrom('drop_list_checks').selectAll().execute()).toHaveLength(6);
    await expect(db.deleteFrom('drop_lists').execute()).rejects.toThrow(/append-only/);
  });
  it('V28-8 DROP_FEED_STALE (v3.3.0: with intake.drop_feed_stale_days 2 and level warn, the old rule): none without a list; none up to 2 days after the newest list_date; a warn (with newest_list, newest_list_date) from the 3rd day', async () => {
    const x = await h();
    await patchActiveSettings(['intake'], { drop_list_max_share: 1, drop_feed_stale_days: 2, drop_feed_stale_level: 'warn' });
    const stale = async () => (await x.get('/report')).json().warnings.filter((w: any) => w.code === 'DROP_FEED_STALE');
    expect(await stale()).toEqual([]);
    await upload(x, 'snap-s1', ['superhealth.com'], '2026-10-05');
    await upload(x, 'snap-s0', ['supertech.com'], '2026-10-03');
    x.clock.t = at('2026-10-07T08:00:00Z');
    expect(await stale()).toEqual([]); // 2 days old
    x.clock.t = at('2026-10-08T08:00:00Z');
    const w = await stale();
    expect(w).toHaveLength(1);
    expect(w[0]).toMatchObject({ code: 'DROP_FEED_STALE', level: 'warn', details: { newest_list: 'snap-s1', newest_list_date: '2026-10-05' } });
    await upload(x, 'snap-s2', ['superpro.com'], '2026-10-08');
    expect(await stale()).toEqual([]);
  });
});

describe('cohorts: creation (G-1)', () => {
  const nm = (domain: string, expected_drop_date: string, source = 'unit') => ({ domain, expected_drop_date, source });
  it('V28-9 from names: 202 with the exclusions counted (DOMAIN_INVALID, DUPLICATE_IN_UPLOAD, LATE, IN_OPEN_COHORT); the run is a rescore-style feature run as of now', async () => {
    const x = await h();
    const r = await x.post('/selection/cohorts', { name: 'co-one', settings: ['v1'], names: [nm('superhealth.com', '2026-10-20'), nm('Bad Name.com', '2026-10-20'), nm('superhealth.com', '2026-10-21'), nm('supertech.com', '2026-10-06'), nm('superpro.com', '2026-10-05'), nm('superbox.com', '2026-10-07')] });
    expect(r.statusCode, r.body).toBe(202);
    expect(r.json()).toMatchObject({ name: 'co-one', status: 'computing', included_n: 2, excluded: { DOMAIN_INVALID: 1, DUPLICATE_IN_UPLOAD: 1, LATE: 2 } });
    expect(r.json().run_id).toMatch(/^run_/);
    const run = await db.selectFrom('screening_runs').selectAll().where('id', '=', r.json().run_id).executeTakeFirstOrThrow();
    expect(run).toMatchObject({ mode: 'full', backtest: false });
    expect(run.gate_plan).toEqual({ S7: ['form', 'census', 'ext_dates'] });
    const input = run.input as any;
    expect(input.allow_unapproved_method).toBe(true);
    expect(input.test_set).toEqual({ max_answer_age_days: 7, as_of_is_now: true });
    const asOf = run.created_at.toISOString();
    expect(input.names.map((n: any) => [n.domain, n.census_list, n.as_of])).toEqual([['superhealth.com', 'bt1@v2', asOf], ['superbox.com', 'bt1@v2', asOf]]);
    expect(await db.selectFrom('sibling_method_approvals').selectAll().execute()).toHaveLength(0);
    expect(await db.selectFrom('labelled_names').selectAll().execute()).toHaveLength(0); // research only: nothing is registered
    const g = (await x.get('/selection/cohorts/co-one')).json();
    expect(g).toMatchObject({ name: 'co-one', status: 'computing', settings: ['v1'], included_n: 2, excluded_n: 4, excluded: { DOMAIN_INVALID: 1, DUPLICATE_IN_UPLOAD: 1, LATE: 2 } });
    // a name of a cohort made within the last 120 days cannot join another
    const second = await x.post('/selection/cohorts', { name: 'co-two', settings: ['v1'], names: [nm('superhealth.com', '2026-10-20'), nm('supermedia.com', '2026-10-20')] });
    expect(second.json()).toMatchObject({ included_n: 1, excluded: { IN_OPEN_COHORT: 1 } });
    // a cohort made 121 days earlier no longer blocks
    await db.connection().execute(async (c) => { await sql`SET session_replication_role = replica`.execute(c); await sql`update cohorts set created_at = created_at - interval '121 days' where name = 'co-one'`.execute(c); await sql`SET session_replication_role = origin`.execute(c); });
    const third = await x.post('/selection/cohorts', { name: 'co-three', settings: ['v1'], names: [nm('superhealth.com', '2026-10-20')] });
    expect(third.json()).toMatchObject({ included_n: 1, excluded: {} });
  });
  it('V28-10 COHORT_EMPTY (422, nothing stored), COHORT_NAME_TAKEN (409), SETTINGS_NOT_FOUND (404), COHORT_NOT_FOUND (404), validation', async () => {
    const x = await h();
    const empty = await x.post('/selection/cohorts', { name: 'co-empty', settings: ['v1'], names: [nm('superhealth.com', '2026-10-06'), nm('bad name.com', '2026-10-20')] });
    expect([empty.statusCode, empty.json().error.code]).toEqual([422, 'COHORT_EMPTY']);
    expect(empty.json().error.details.excluded).toEqual({ LATE: 1, DOMAIN_INVALID: 1 });
    expect(await db.selectFrom('cohorts').selectAll().execute()).toHaveLength(0);
    expect(await db.selectFrom('screening_runs').selectAll().execute()).toHaveLength(0);
    const ok = await x.post('/selection/cohorts', { name: 'co-ok1', settings: ['v1'], names: [nm('superhealth.com', '2026-10-20')] });
    expect(ok.statusCode).toBe(202);
    const taken = await x.post('/selection/cohorts', { name: 'co-ok1', settings: ['v1'], names: [nm('supertech.com', '2026-10-20')] });
    expect([taken.statusCode, taken.json().error.code]).toEqual([409, 'COHORT_NAME_TAKEN']);
    const noSettings = await x.post('/selection/cohorts', { name: 'co-ok2', settings: ['v1', 'nope'], names: [nm('supertech.com', '2026-10-20')] });
    expect([noSettings.statusCode, noSettings.json().error.code]).toEqual([404, 'SETTINGS_NOT_FOUND']);
    const nf = await x.get('/selection/cohorts/co-none');
    expect([nf.statusCode, nf.json().error.code]).toEqual([404, 'COHORT_NOT_FOUND']);
    for (const body of [{ name: 'co-v1', settings: [], names: [nm('superpro.com', '2026-10-20')] }, { name: 'co-v2', settings: ['v1'] }, { name: 'co-v3', settings: ['v1'], names: [nm('superpro.com', '2026-10-20')], from_drop_lists: { drop_from: '2026-10-01', drop_to: '2026-10-10', sample_n: 1, seed: 'a' } },
      { name: 'co-v4', settings: ['v1', 'v1'], names: [nm('superpro.com', '2026-10-20')] }, { name: 'co-v5', settings: ['v1'], names: [nm('superpro.com', 'soon')] }, { name: 'co-v6', settings: ['v1'], from_drop_lists: { drop_from: '2026-10-01', drop_to: '2026-10-10', sample_n: 201, seed: 'a' } }]) {
      const e = await x.post('/selection/cohorts', body);
      expect([e.statusCode, e.json().error.code], JSON.stringify(body)).toEqual([422, 'VALIDATION_ERROR']);
    }
    const win = await x.post('/selection/cohorts', { name: 'co-v7', settings: ['v1'], from_drop_lists: { drop_from: '2026-10-01', drop_to: '2026-12-10', sample_n: 5, seed: 'a' } });
    expect([win.statusCode, win.json().error.code]).toEqual([400, 'VALIDATION_ERROR']);
  });
  it('V28-11 from drop lists: a seeded sample (first sample_n by sha256(seed:domain)) of pending delete / redemption names in the window; the same seed gives the same sample', async () => {
    const x = await h();
    const ds = ['superhealth.com', 'supertech.com', 'superpro.com', 'superbox.com', 'supermedia.com', 'supercapital.com', 'austinroofing.com', 'smartcoffee.com'];
    await upload(x, 'snap-c1', ds);
    for (const d of ds.slice(0, 6)) rdap.table[d] = registered({ statuses: ['pendingDelete'], updated_at: '2026-10-04T10:00:00.000Z' }); // all expected 2026-10-09
    rdap.table['austinroofing.com'] = registered(); // registered: not eligible
    await watch(x).runOnce();
    const key = (seed: string, d: string) => createHash('sha256').update(`${seed}:${d}`).digest('hex');
    const expected = (seed: string) => ds.slice(0, 6).sort((p, q) => (key(seed, p) < key(seed, q) ? -1 : 1)).slice(0, 3);
    const mk = (name: string, seed: string | number) => x.post('/selection/cohorts', { name, settings: ['v1'], from_drop_lists: { drop_from: '2026-10-07', drop_to: '2026-10-20', sample_n: 3, seed } });
    const a = await mk('co-sa', 'seed-1');
    expect(a.statusCode, a.body).toBe(202);
    expect(a.json().included_n).toBe(3);
    const namesOf = async (c: string) => (await db.selectFrom('cohort_names').select(['domain', 'source', 'expected_drop_date']).where('cohort', '=', c).orderBy('id').execute());
    const first = await namesOf('co-sa');
    expect(first.map((n) => n.domain).sort()).toEqual(expected('seed-1').sort());
    expect(first.every((n) => n.source === 'drop_list:snap-c1' && n.expected_drop_date === '2026-10-09')).toBe(true);
    expect((await db.selectFrom('cohorts').select('source').where('name', '=', 'co-sa').executeTakeFirstOrThrow()).source).toMatchObject({ kind: 'from_drop_lists', seed: 'seed-1', sample_n: 3, drop_from: '2026-10-07', drop_to: '2026-10-20' });
    const b = await mk('co-sb', 'seed-1'); // same sample; all of it is now in an open cohort
    expect(b.statusCode).toBe(422);
    expect(b.json().error).toMatchObject({ code: 'COHORT_EMPTY', details: { excluded: { IN_OPEN_COHORT: 3 } } });
    const c = await mk('co-sc', 7); // an integer seed is the string "7"
    expect(c.statusCode).toBe(202);
    expect((await namesOf('co-sc')).map((n) => n.domain).sort()).toEqual(expected('7').sort()); // none of these is in the first cohort; the seed 7 sample is listed in full
  });
});

describe('cohorts: frozen decisions (G-1)', () => {
  it('V28-12 the decisions are computed once when the run is done, with the late flag; GET lazily freezes; nothing is recomputed afterwards', async () => {
    const x = await h();
    const r = await x.post('/selection/cohorts', { name: 'co-fz', settings: ['v1'], names: [{ domain: 'superpro.com', expected_drop_date: '2026-10-08', source: 'a' }, { domain: 'superbox.com', expected_drop_date: '2026-10-20', source: 'b' }] });
    expect(r.statusCode, r.body).toBe(202);
    await app!.screeningWorker.runToEnd(r.json().run_id);
    x.clock.t = at('2026-10-09T09:00:00Z'); // after the first expected drop date
    const g = (await x.get('/selection/cohorts/co-fz')).json();
    expect(g.status).toBe('frozen');
    const d1 = await db.selectFrom('cohort_decisions').selectAll().where('cohort', '=', 'co-fz').orderBy('id').execute();
    expect(d1).toHaveLength(2);
    expect(d1.map((d) => [d.domain, d.settings_label, d.late])).toEqual([['superpro.com', 'v1', true], ['superbox.com', 'v1', false]]);
    expect(d1.every((d) => ['accept', 'reject', 'undecided'].includes(d.decision) && d.decided_at.getTime() === at('2026-10-09T09:00:00Z'))).toBe(true);
    const row = g.names.find((n: any) => n.domain === 'superpro.com');
    expect(row).toMatchObject({ expected_drop_date: '2026-10-08', drop: null, rereg: { d30: null, d60: null, d90: null } });
    expect(row.decisions.v1).toMatchObject({ decision: d1[0]!.decision, late: true });
    expect(g.names.find((n: any) => n.domain === 'superbox.com').decisions.v1.late).toBe(false);
    expect(g.report.v1.counts).toMatchObject({ names: 2, late: 1, drop_not_checked: 2 });
    // later: other registry answers, a later day, the daily step, another GET: the rows do not change
    rdap.table['superpro.com'] = registered();
    x.clock.t = at('2026-10-12T09:00:00Z');
    expect(await outcomes(x).runOnce()).toMatchObject({ frozen: 0 });
    await x.get('/selection/cohorts/co-fz');
    expect(await db.selectFrom('cohort_decisions').selectAll().where('cohort', '=', 'co-fz').orderBy('id').execute()).toEqual(d1);
  });
  it('V28-13 the daily step freezes a finished cohort (and only that); a cohort whose run is still going stays computing; a dry run freezes nothing', async () => {
    const x = await h();
    const a = await x.post('/selection/cohorts', { name: 'co-d1', settings: ['v1'], names: [{ domain: 'superpro.com', expected_drop_date: '2026-10-20', source: 'a' }] });
    const b = await x.post('/selection/cohorts', { name: 'co-d2', settings: ['v1'], names: [{ domain: 'superbox.com', expected_drop_date: '2026-10-20', source: 'a' }] });
    await app!.screeningWorker.runToEnd(a.json().run_id);
    await app!.screeningWorker.runToEnd(b.json().run_id);
    await db.updateTable('screening_runs').set({ status: 'running', heartbeat_at: new Date(x.clock.t) }).where('id', '=', b.json().run_id).execute();
    expect(await outcomes(x).runOnce({ dryRun: true })).toMatchObject({ dryRun: true, frozen: 0 });
    expect((await db.selectFrom('cohorts').select(['name', 'status']).orderBy('name').execute())).toEqual([{ name: 'co-d1', status: 'computing' }, { name: 'co-d2', status: 'computing' }]);
    const s = await outcomes(x).runOnce();
    expect(s).toMatchObject({ frozen: 1, checked: 0 });
    expect((await db.selectFrom('cohorts').select(['name', 'status']).orderBy('name').execute())).toEqual([{ name: 'co-d1', status: 'frozen' }, { name: 'co-d2', status: 'computing' }]);
    expect(await db.selectFrom('cohort_decisions').select('cohort').where('cohort', '=', 'co-d2').execute()).toEqual([]);
  });
  it('V28-14 cohorts is guarded: only computing -> frozen may change; no delete, no truncate; the new tables are append-only', async () => {
    const x = await h();
    const r = await x.post('/selection/cohorts', { name: 'co-gd', settings: ['v1'], names: [{ domain: 'superpro.com', expected_drop_date: '2026-10-20', source: 'a' }] });
    await expect(db.updateTable('cohorts').set({ created_by: 'x' }).where('name', '=', 'co-gd').execute()).rejects.toThrow(/append-only/);
    await expect(db.updateTable('cohorts').set({ status: 'computing' }).where('name', '=', 'co-gd').execute()).rejects.toThrow(/append-only/);
    await app!.screeningWorker.runToEnd(r.json().run_id);
    await x.get('/selection/cohorts/co-gd');
    await expect(db.updateTable('cohorts').set({ status: 'computing' }).where('name', '=', 'co-gd').execute()).rejects.toThrow(/append-only/);
    await expect(db.deleteFrom('cohorts').execute()).rejects.toThrow(/append-only/);
    await expect(sql`TRUNCATE cohorts CASCADE`.execute(db)).rejects.toThrow(/append-only/);
    for (const t of ['cohort_names', 'cohort_decisions', 'drop_lists', 'drop_list_rows', 'drop_list_checks', 'cohort_outcomes'] as const) {
      await expect(sql`TRUNCATE ${sql.table(t)} CASCADE`.execute(db), t).rejects.toThrow(/append-only/);
    }
    await expect(db.updateTable('cohort_decisions').set({ late: true }).execute()).rejects.toThrow(/append-only/);
    await expect(db.deleteFrom('cohort_names').execute()).rejects.toThrow(/append-only/);
  });
});

describe('cohortOutcomes (G-1)', () => {
  const NAMES = ['superhealth.com', 'supertech.com', 'superpro.com', 'superbox.com', 'supermedia.com'];
  const drop = async (cohort: string, domain: string) => (await db.selectFrom('cohort_outcomes').selectAll().where('cohort', '=', cohort).where('domain', '=', domain).where('kind', '=', 'drop').orderBy('id').execute());
  const rr = async (cohort: string, domain: string, kind: string) => (await db.selectFrom('cohort_outcomes').selectAll().where('cohort', '=', cohort).where('domain', '=', domain).where('kind', '=', kind as 'rereg30').orderBy('id').execute());
  const setup = async () => {
    const x = await h();
    const r = await x.post('/selection/cohorts', { name: 'co-out', settings: ['v1'], names: NAMES.map((domain) => ({ domain, expected_drop_date: '2026-10-10', source: 'unit' })) });
    expect(r.statusCode, r.body).toBe(202);
    await app!.screeningWorker.runToEnd(r.json().run_id);
    await x.get('/selection/cohorts/co-out'); // freezes
    return x;
  };
  it('V28-15 drop outcomes from the day after the expected drop date: available_after_drop, caught_at_drop vs restored by created_at, still_pending asked again, unknown at most 5 times', async () => {
    const x = await setup();
    rdap.table = {
      'superhealth.com': notRegistered(),
      'supertech.com': registered({ created_at: '2026-10-09T03:00:00.000Z', registrar: 'Catcher Inc' }), // created on expected - 1: caught at the drop
      'superpro.com': registered({ created_at: '2020-05-01T00:00:00.000Z' }), // created long ago: restored
      'superbox.com': registered({ statuses: ['pendingDelete'], created_at: '2020-05-01T00:00:00.000Z' }),
      'supermedia.com': unknown(),
    };
    x.clock.t = at('2026-10-10T20:00:00Z'); // expected drop date (IDT 10-10 23:00): too early
    rdap.calls = [];
    expect(await outcomes(x).runOnce()).toMatchObject({ checked: 0 });
    expect(rdap.calls).toEqual([]);
    x.clock.t = at('2026-10-11T09:00:00Z');
    const dry = await outcomes(x).runOnce({ dryRun: true });
    expect(dry).toMatchObject({ dryRun: true, checked: 5 });
    expect(await db.selectFrom('cohort_outcomes').selectAll().execute()).toHaveLength(0);
    const s = await outcomes(x).runOnce();
    expect(s).toEqual({ dryRun: false, skipped: false, frozen: 0, checked: 5, drop: { available_after_drop: 1, caught_at_drop: 1, restored: 1, still_pending: 1, unknown: 1 }, rereg: { yes: 0, no: 0, unknown: 0 }, left_for_next_run: 0 });
    expect((await drop('co-out', 'superhealth.com'))[0]).toMatchObject({ result: 'available_after_drop' });
    expect((await drop('co-out', 'supertech.com'))[0]).toMatchObject({ result: 'caught_at_drop', registrar: 'Catcher Inc' });
    expect((await drop('co-out', 'supertech.com'))[0]!.created_at_registry!.toISOString()).toBe('2026-10-09T03:00:00.000Z');
    expect((await drop('co-out', 'superpro.com'))[0]).toMatchObject({ result: 'restored' });
    expect((await drop('co-out', 'superbox.com'))[0]).toMatchObject({ result: 'still_pending' });
    expect((await drop('co-out', 'supermedia.com'))[0]).toMatchObject({ result: 'unknown', reason_code: 'TIMEOUT' });
    // same day again: nothing asked (one try per IDT day)
    rdap.calls = [];
    expect((await outcomes(x).runOnce()).checked).toBe(0);
    expect(rdap.calls).toEqual([]);
    // next days: still_pending and unknown are asked again; a final outcome is not
    rdap.table['superbox.com'] = notRegistered();
    for (let day = 12; day <= 17; day++) {
      x.clock.t = at(`2026-10-${day}T09:00:00Z`);
      rdap.calls = [];
      await outcomes(x).runOnce();
      if (day === 12) expect(rdap.calls.sort()).toEqual(['superbox.com', 'supermedia.com']);
      else if (day <= 15) expect(rdap.calls).toEqual(['supermedia.com']);
      else expect(rdap.calls).toEqual([]); // 5 unknown answers in all: it stays unknown
    }
    expect((await drop('co-out', 'superbox.com')).map((o) => o.result)).toEqual(['still_pending', 'available_after_drop']);
    expect((await drop('co-out', 'supermedia.com')).map((o) => o.result)).toEqual(['unknown', 'unknown', 'unknown', 'unknown', 'unknown']);
    expect((await drop('co-out', 'superhealth.com'))).toHaveLength(1);
  });
  it('V28-16 re-registration at 30, 60 and 90 days after the drop outcome: yes with created_at and registrar, no, unknown retried a day at a time (5 at most); done once answered', async () => {
    const x = await setup();
    rdap.table = { 'superhealth.com': notRegistered(), 'supertech.com': notRegistered(), 'superpro.com': registered(), 'superbox.com': registered(), 'supermedia.com': registered() };
    x.clock.t = at('2026-10-11T09:00:00Z');
    await outcomes(x).runOnce();
    expect((await drop('co-out', 'superhealth.com'))[0]!.result).toBe('available_after_drop');
    rdap.calls = [];
    x.clock.t = at('2026-11-09T09:00:00Z'); // 29 days
    expect((await outcomes(x).runOnce()).rereg).toEqual({ yes: 0, no: 0, unknown: 0 });
    expect(rdap.calls).toEqual([]);
    // day 30 (2026-11-10): superhealth re-registered, supertech still free
    rdap.table['superhealth.com'] = registered({ created_at: '2026-10-25T12:00:00.000Z', registrar: 'New Owner LLC' });
    x.clock.t = at('2026-11-10T09:00:00Z');
    const s30 = await outcomes(x).runOnce();
    expect(s30.rereg).toEqual({ yes: 1, no: 1, unknown: 0 });
    expect((await rr('co-out', 'superhealth.com', 'rereg30'))[0]).toMatchObject({ result: 'yes', registrar: 'New Owner LLC' });
    expect((await rr('co-out', 'superhealth.com', 'rereg30'))[0]!.created_at_registry!.toISOString()).toBe('2026-10-25T12:00:00.000Z');
    expect((await rr('co-out', 'supertech.com', 'rereg30'))[0]).toMatchObject({ result: 'no', created_at_registry: null });
    // between 30 and 60: nothing due
    rdap.calls = [];
    x.clock.t = at('2026-12-09T09:00:00Z');
    expect((await outcomes(x).runOnce()).checked).toBe(0);
    // day 60: both answered
    x.clock.t = at('2026-12-10T09:00:00Z');
    expect((await outcomes(x).runOnce()).rereg).toEqual({ yes: 1, no: 1, unknown: 0 });
    // day 90 (2027-01-09): the registry does not answer; retried on the following days, at most 5 attempts, never counted as yes or no
    rdap.table = {};
    rdap.table['superhealth.com'] = unknown();
    rdap.table['supertech.com'] = unknown();
    for (let i = 0; i < 7; i++) {
      x.clock.t = at('2027-01-09T09:00:00Z') + i * DAY;
      await outcomes(x).runOnce();
    }
    expect((await rr('co-out', 'supertech.com', 'rereg90')).map((o) => o.result)).toEqual(['unknown', 'unknown', 'unknown', 'unknown', 'unknown']);
    const rep = (await x.get('/selection/cohorts/report?settings=v1')).json();
    expect(rep.rereg.d90.accepted.n + rep.rereg.d90.rejected.n).toBe(0); // unknown is never counted
    // an unknown that is answered later is the last row: tomorrow's retry (4th day) gives yes
    const got = (await x.get('/selection/cohorts/co-out')).json();
    expect(got.names.find((n: any) => n.domain === 'superhealth.com')).toMatchObject({
      drop: { result: 'available_after_drop' }, rereg: { d30: { result: 'yes', registrar: 'New Owner LLC' }, d60: { result: 'yes' }, d90: { result: 'unknown' } },
    });
  });
});

describe('cohorts: the report (G-1)', () => {
  it('V28-17 rates, Wilson 95% and the FWD-1 pass line from the stored rows; unknown, caught, restored, undecided and late names are counted apart; the constants', async () => {
    expect([FWD_MIN_RATIO, FWD_MIN_N]).toEqual([2, 50]);
    // by hand: 30 of 60 = 0.5; centre 0.5; half = 1.96 * sqrt(0.25/60 + 3.8416/(4*3600)) / 1.064033 = 0.12266 -> [0.3773, 0.6227]
    expect(wilson95(30, 60)).toEqual([0.3773, 0.6227]);
    const x = await h();
    const r = await x.post('/selection/cohorts', { name: 'co-rep', settings: ['v1'], names: [{ domain: 'superpro.com', expected_drop_date: '2026-12-01', source: 'a' }] });
    await app!.screeningWorker.runToEnd(r.json().run_id);
    await x.get('/selection/cohorts/co-rep');
    // synthetic names (same cohort): 60 accepted and 60 rejected names, all available_after_drop
    type Spec = { d: string; decision: 'accept' | 'reject' | 'undecided'; late: boolean; drop: string | null; r30?: string; r60?: string; r90?: string };
    const specs: Spec[] = [];
    const yesNo = (i: number, yes: number, unk: number, total: number) => (i < yes ? 'yes' : i < total - unk ? 'no' : 'unknown');
    for (let i = 0; i < 60; i++) {
      specs.push({ d: `acc${i}.com`, decision: 'accept', late: false, drop: 'available_after_drop', r30: yesNo(i, 30, 3, 60), r60: i < 40 ? yesNo(i, 20, 0, 40) : undefined });
      specs.push({ d: `rej${i}.com`, decision: 'reject', late: false, drop: 'available_after_drop', r30: yesNo(i, 12, 1, 60), r60: i < 40 ? yesNo(i, 10, 0, 40) : undefined });
    }
    for (let i = 0; i < 5; i++) specs.push({ d: `caught${i}.com`, decision: 'accept', late: false, drop: 'caught_at_drop' });
    for (let i = 0; i < 2; i++) specs.push({ d: `rest${i}.com`, decision: 'reject', late: false, drop: 'restored' });
    specs.push({ d: 'pend0.com', decision: 'accept', late: false, drop: 'still_pending' }, { d: 'unk0.com', decision: 'accept', late: false, drop: 'unknown' });
    for (let i = 0; i < 3; i++) specs.push({ d: `und${i}.com`, decision: 'undecided', late: false, drop: 'available_after_drop', r30: 'yes' });
    for (let i = 0; i < 4; i++) specs.push({ d: `late${i}.com`, decision: 'accept', late: true, drop: 'available_after_drop', r30: 'yes' });
    for (let i = 0; i < specs.length; i += 200) {
      const part = specs.slice(i, i + 200);
      await db.insertInto('cohort_names').values(part.map((s) => ({ cohort: 'co-rep', domain: s.d, expected_drop_date: '2026-10-10', source: 'syn', included: true, reason: null }))).execute();
      await db.insertInto('cohort_decisions').values(part.map((s) => ({ cohort: 'co-rep', domain: s.d, settings_label: 'v1', decision: s.decision, tier: null, decided_at: new Date(x.clock.t), late: s.late }))).execute();
      const oc: any[] = [];
      for (const s of part) {
        if (s.drop) oc.push({ cohort: 'co-rep', domain: s.d, kind: 'drop', checked_at: new Date(x.clock.t), result: s.drop });
        for (const [k, v] of [['rereg30', s.r30], ['rereg60', s.r60], ['rereg90', s.r90]] as const) if (v) oc.push({ cohort: 'co-rep', domain: s.d, kind: k, checked_at: new Date(x.clock.t), result: v });
      }
      await db.insertInto('cohort_outcomes').values(oc).execute();
    }
    const rep = (await x.get('/selection/cohorts/report?settings=v1')).json();
    expect(rep).toMatchObject({ settings: 'v1', cohorts: ['co-rep'], fwd_min_ratio: 2, fwd_min_n: 50 });
    // d30: accepted 30 yes / 27 no (3 unknown, left out); rejected 12 yes / 47 no (1 unknown)
    expect(rep.rereg.d30.accepted).toEqual({ n: 57, re_registered: 30, rate: 0.5263, wilson95: wilson95(30, 57), unknown: 3 });
    expect(rep.rereg.d30.rejected).toEqual({ n: 59, re_registered: 12, rate: 0.2034, wilson95: wilson95(12, 59), unknown: 1 });
    expect(rep.rereg.d30.ratio).toBe(2.5877);
    expect(rep.rereg.d30.pass).toBe(true);
    // d60: 40 names per class: n below 50 -> no pass although the ratio is 2
    expect(rep.rereg.d60).toMatchObject({ accepted: { n: 40, re_registered: 20, rate: 0.5 }, rejected: { n: 40, re_registered: 10, rate: 0.25 }, ratio: 2, pass: false });
    expect(rep.rereg.d60.accepted.wilson95).toEqual(wilson95(20, 40));
    // d90: nothing answered
    expect(rep.rereg.d90).toEqual({ accepted: { n: 0, re_registered: 0, rate: null, wilson95: null, unknown: 0 }, rejected: { n: 0, re_registered: 0, rate: null, wilson95: null, unknown: 0 }, ratio: null, pass: false });
    expect(rep.counts).toEqual({ names: 1 + specs.length, caught_at_drop: 5, restored: 2, still_pending: 1, unknown_drop: 1, drop_not_checked: 1, undecided: 3, late: 4 });
    // the cohort's own GET carries the same report; the cohorts= filter; unknown label / cohort
    expect((await x.get('/selection/cohorts/co-rep')).json().report.v1.rereg.d30.ratio).toBe(2.5877);
    expect((await x.get('/selection/cohorts/report?settings=v1&cohorts=co-rep')).json().cohorts).toEqual(['co-rep']);
    const none = await x.get('/selection/cohorts/report?settings=v9');
    expect([none.statusCode, none.json().error.code]).toEqual([404, 'SETTINGS_NOT_FOUND']);
    const nc = await x.get('/selection/cohorts/report?settings=v1&cohorts=co-rep,zzz');
    expect([nc.statusCode, nc.json().error.code]).toEqual([404, 'COHORT_NOT_FOUND']);
    expect((await x.get('/selection/cohorts/report')).statusCode).toBe(400);
    expect((await x.get('/selection/cohorts/report?settings=v1&x=1')).statusCode).toBe(400);
  });
  it('V28-18 ratio is null when the rejected rate is 0 (never a pass); classRate leaves unknown out of n', () => {
    const acc = classRate(Array<'yes' | 'no' | 'unknown'>(60).fill('yes'));
    const rej = classRate(Array<'yes' | 'no' | 'unknown'>(60).fill('no'));
    expect(windowVerdict(acc, rej)).toMatchObject({ ratio: null, pass: false });
    expect(classRate(['yes', 'no', 'unknown', 'unknown'])).toMatchObject({ n: 2, re_registered: 1, rate: 0.5, unknown: 2 });
    expect(classRate(['unknown'])).toMatchObject({ n: 0, rate: null, wilson95: null, unknown: 1 });
  });
});

describe('daily run (G-1, G-2)', () => {
  it('V28-19 dropWatch and cohortOutcomes are daily steps after portfolioCheck and before referenceRefresh; no registrar adapter is called', async () => {
    const adapter = new FakeAdapter('porkbun');
    const a = await makeApp({
      testRoutes: false, env: { JOB_TRIGGER_TOKEN: 'job_token_fake_0123456789abcdef0123456789' }, adapters: [adapter], now: () => at('2026-10-20T09:00:00Z'),
      screening: { sleep: async () => {}, rdapLookup: async () => registered({ statuses: ['pendingDelete'], updated_at: '2026-10-18T00:00:00.000Z' }) },
    });
    app = a;
    const w = (await issueToken('write', 'gavriel')).auth;
    const up = await a.inject({ method: 'POST', url: '/selection/drop-lists', headers: { ...w, 'idempotency-key': 'dl-1' }, payload: { name: 'snap-day', list_date: '2026-10-20', domains: ['superhealth.com', 'supertech.com'] } });
    expect(up.statusCode, up.body).toBe(201);
    const before = adapter.calls.length;
    const res = await runJobToEnd(a, 'daily', { key: 'dw-1' });
    expect(res.statusCode, res.body).toBe(202);
    const steps = Object.keys(res.json().steps);
    expect(steps.slice(steps.indexOf('portfolioCheck'))).toEqual(['portfolioCheck', 'dropWatch', 'intakeScreening', 'buildDailyList', 'cohortOutcomes', 'referenceRefresh', 'outsideReview', 'postsRefresh', 'backupExport']);
    expect(res.json().steps.dropWatch).toMatchObject({ ok: true, summary: { checked: 2, pending_delete: 2, left_for_next_run: 0 } });
    expect(res.json().steps.cohortOutcomes).toMatchObject({ ok: true, summary: { frozen: 0, checked: 0 } });
    // v2.14.0: the intakeScreening run also screens the two pending-delete names, and its quote check asks the registrar for a read-only `quote`; dropWatch and cohortOutcomes still only use RDAP, and nothing is ever registered.
    expect(adapter.calls.slice(before).every((c) => c.startsWith('findDomain') || c.startsWith('quote '))).toBe(true);
    expect(await db.selectFrom('drop_list_checks').select('expected_drop_date').execute()).toEqual([{ expected_drop_date: '2026-10-23' }, { expected_drop_date: '2026-10-23' }]);
  });
});
