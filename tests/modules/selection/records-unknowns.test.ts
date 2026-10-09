// v2.16.0 part A (tech debt): cohort abandon, record route reads inside the lock, seal needs a done run, run bookkeeping atomicity, geo LANDER-1 fails closed,
// intake lock and word rules, IDT dates, price-list query, CR-014 N-1..N-3 (T14-*), CR-015 I-1, I-2, I-4 (T15-*).
import { randomUUID } from 'node:crypto';
import { http } from 'msw';
import { sql } from 'kysely';
import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { freezeReadyCohorts } from '../../../src/modules/candidates/cohorts.js';
import { watchStatusOf } from '../../../src/modules/candidates/drop-lists.js';
import { dropOutcomeOf } from '../../../src/modules/ops/jobs/cohort-outcomes.js';
import type { RdapLookup, RdapLookupFn } from '../../../src/core/rdap.js';
import { currentLists } from '../../../src/modules/selection/lists.js';
import { IntakeScreeningJob } from '../../../src/modules/candidates/intake.js';
import type { ScreeningWorker } from '../../../src/modules/selection/engine.js';
import { BuildDailyListJob } from '../../../src/modules/candidates/daily-list.js';
import { GATE_OF } from '../../../src/modules/selection/checks/index.js';
import { planFor } from '../../../src/modules/selection/engine.js';
import { featuresOfRun } from '../../../src/modules/selection/test-sets.js';
import { testDb as db } from '../../helpers/db.js';
import { putBrandLists, putList, screeningHarness, type ScreeningHarness } from '../../helpers/screening.js';
import { fixture, respond } from '../../helpers/screening-fixtures.js';
import { issueToken } from '../../helpers/tokens.js';
import { mswServer } from '../../setup/network.js';

let app: FastifyInstance | undefined;
afterEach(async () => app?.close());
const DAY = 86_400_000;
const HOUR = 3_600_000;
const free = (): RdapLookup => ({ outcome: 'not_registered', reasonCode: null, httpStatus: 404, url: 'https://rdap.example/domain/x', retrievedAt: new Date(), body: null, facts: null });
async function h(rdapLookup: RdapLookupFn = async () => free()): Promise<ScreeningHarness> {
  mswServer.use(http.get('https://data.iana.org/rdap/dns.json', () => respond(fixture('iana-dns.json'))));
  const x = await screeningHarness({ screening: { rdapLookup } });
  app = x.app;
  return x;
}
const fakeWorker = (x: ScreeningHarness, kicked: string[] = []): ScreeningWorker => ({ checks: x.app.screeningWorker.checks, kick: (id: string) => { kicked.push(id); }, runToEnd: async () => {}, cancel: async () => null }) as unknown as ScreeningWorker;
const ap = (x: ScreeningHarness, text: string) => ({ text, approved_at: new Date(x.clock.t - HOUR).toISOString() });
const facts = (created: string | null) => ({ registrar: 'Fake Registrar', created_at: created, expires_at: null, updated_at: null, statuses: [], nameservers: [] });
const registered = (created: string | null): RdapLookup => ({ outcome: 'registered', reasonCode: null, httpStatus: 200, url: 'https://rdap.example/domain/x', retrievedAt: new Date(), body: '{"ldhName":"x"}', facts: facts(created) });

/** Makes every insert into `table` fail (a forced bookkeeping failure after the run was created). */
async function failInserts(table: string): Promise<() => Promise<void>> {
  await sql.raw(`CREATE OR REPLACE FUNCTION public.t16a_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'forced failure'; END $$`).execute(db);
  await sql.raw(`CREATE TRIGGER t16a_fail BEFORE INSERT ON public.${table} FOR EACH ROW EXECUTE FUNCTION public.t16a_fail()`).execute(db);
  return async () => { await sql.raw(`DROP TRIGGER IF EXISTS t16a_fail ON public.${table}`).execute(db); };
}

describe('CR-014 N-1, N-2 records (T14-1..T14-5)', () => {
  const D = 'tampapoolsco.com';
  const TM = { phrases_queried: ['TAMPA POOLS CO', 'Tampapoolsco'], control_ok: true, exact_or_core_live: [], generic_live: [] };
  const EV = 'https://tmsearch.uspto.gov/x';
  const rec = (x: ScreeningHarness, over: object) => x.post(`/candidates/${D}/records`, { kind: 'tm_us', record: TM, checked_by: 'gavriel', evidence_url: EV, ...over });
  it('T14-1 a tm_us record needs an https evidence_url (422 VALIDATION_ERROR); history does not', async () => {
    const x = await h();
    const none = await x.post(`/candidates/${D}/records`, { kind: 'tm_us', record: TM, checked_by: 'gavriel' });
    expect([none.statusCode, none.json().error.code]).toEqual([422, 'VALIDATION_ERROR']);
    expect(JSON.stringify(none.json().error.details)).toContain('evidence_url');
    expect((await rec(x, { evidence_url: 'http://tmsearch.uspto.gov/x' })).statusCode).toBe(422); // https only
    expect((await rec(x, {})).statusCode).toBe(201);
    const hist = await x.post(`/candidates/${D}/records`, { kind: 'history', record: { result: 'PASS', checked_by: 'gavriel' }, checked_by: 'gavriel' });
    expect(hist.statusCode, hist.body).toBe(201);
  });
  it('T14-2 phrases_queried must include the name\'s exact phrase (SLD, upper case, letters and digits): else 422 VALIDATION_ERROR with details.missing_phrase', async () => {
    const x = await h();
    const miss = await rec(x, { record: { ...TM, phrases_queried: ['TAMPA POOLS CO', 'TAMPA POOLS'] } });
    expect([miss.statusCode, miss.json().error.code, miss.json().error.details]).toEqual([422, 'VALIDATION_ERROR', { missing_phrase: 'TAMPAPOOLSCO' }]);
    expect(await db.selectFrom('domain_records').selectAll().execute()).toEqual([]);
    expect((await rec(x, { record: { ...TM, phrases_queried: ['  tampapoolsco '] } })).statusCode).toBe(201); // compared like the prior-name phrase: case and spacing do not matter
    const dig = await x.post('/candidates/super9pro.com/records', { kind: 'tm_us', record: { ...TM, phrases_queried: ['SUPER9PRO'] }, checked_by: 'g', evidence_url: EV });
    expect(dig.statusCode, dig.body).toBe(201);
  });
  it('T14-3 checked_at: optional ISO with offset; fresh_until counts from it; the row keeps it', async () => {
    const x = await h();
    const at = new Date(x.clock.t - 10 * DAY).toISOString();
    const r = await rec(x, { checked_at: at });
    expect(r.statusCode, r.body).toBe(201);
    expect(Date.parse(r.json().fresh_until)).toBe(Date.parse(at) + 30 * DAY);
    const list = (await x.get(`/candidates/${D}/records`)).json().records[0];
    expect(Date.parse(list.checked_at)).toBe(Date.parse(at));
    expect(list.fresh).toBe(true);
    expect(Date.parse(list.created_at)).toBeGreaterThan(Date.parse(at)); // created_at is the server time
  });
  it('T14-4 checked_at in the future, or older than the kind\'s window, is 422 CHECKED_AT_INVALID', async () => {
    const x = await h();
    const future = await rec(x, { checked_at: new Date(x.clock.t + DAY).toISOString() });
    expect([future.statusCode, future.json().error.code]).toEqual([422, 'CHECKED_AT_INVALID']);
    const old = await rec(x, { checked_at: new Date(x.clock.t - 31 * DAY).toISOString() });
    expect([old.statusCode, old.json().error.code, old.json().error.details]).toEqual([422, 'CHECKED_AT_INVALID', { freshness_days: 30 }]);
    const okHist = await x.post(`/candidates/${D}/records`, { kind: 'history', record: { result: 'PASS', checked_by: 'g' }, checked_by: 'g', checked_at: new Date(x.clock.t - 100 * DAY).toISOString() });
    expect(okHist.statusCode, okHist.body).toBe(201); // history stays fresh for 180 days
    const oldHist = await x.post(`/candidates/${D}/records`, { kind: 'history', record: { result: 'PASS', checked_by: 'g' }, checked_by: 'g', checked_at: new Date(x.clock.t - 181 * DAY).toISOString() });
    expect(oldHist.json().error.code).toBe('CHECKED_AT_INVALID');
    expect((await rec(x, { checked_at: '2026-10-05' })).statusCode).toBe(422); // not ISO with an offset
    expect(await db.selectFrom('domain_records').select('id').execute()).toHaveLength(1);
  });
});

describe('CR-014 N-3 unknowns list every undecided name (T14-6..T14-8)', () => {
  const FEAT = { registered_share: 0.9, alt_tld_before_n: 0, n_words: 2, sld_chars: 8, is_geo: 0 };
  const lab = (domain: string, features: object) => ({ domain, role: 'fit', label: 'sold', source: 'o', slice: 'R', as_of: '2024-06-01', features });
  const regd = (): RdapLookup => registered('2015-01-01T00:00:00Z');
  it('T14-6 CENSUS_LIST_SIZE adds `unread`: the part of the SLD after the longest readable prefix, or the whole SLD when nothing reads', async () => {
    const x = await h(async () => free());
    await x.post('/selection/labelled-names', { rows: [lab('superzzqxj.com', { ...FEAT, prior_history: 1 }), lab('zzqxjkvv.com', { ...FEAT, prior_history: 1 })] });
    const r = await x.post('/selection/test-sets', { name: 'RS-UNREAD', purpose: 'rescore', slices: ['R'] });
    expect(r.statusCode, r.body).toBe(202);
    await app!.screeningWorker.runToEnd(r.json().run_id);
    const u = (await x.get('/selection/test-sets/RS-UNREAD')).json().unknowns;
    const by = Object.fromEntries(u.entries.map((e: any) => [e.domain, e.features[0].detail]));
    expect(by['superzzqxj.com']).toEqual({ tokens: [], size: 0, unread: 'zzqxj' });
    expect(by['zzqxjkvv.com']).toEqual({ tokens: [], size: 0, unread: 'zzqxjkvv' });
  });
  it('T14-7 a rescore name that is undecided with every feature known is listed with tier DEMAND2_UNDECIDED and the inputs that were unknown; a decided name is not', async () => {
    const x = await h(async (d) => (d.endsWith('.com') ? regd() : free()));
    // four words (rule B fails), no prior_history uploaded: rule A and I stay unknown though the census and the extension dates are known
    await x.post('/selection/labelled-names', { rows: [lab('thebestcoffeeshop.com', FEAT), lab('supertech.com', { ...FEAT, prior_history: 1 })] });
    const r = await x.post('/selection/test-sets', { name: 'RS-UNDEC', purpose: 'rescore', slices: ['R'] });
    await app!.screeningWorker.runToEnd(r.json().run_id);
    const got = (await x.get('/selection/test-sets/RS-UNDEC')).json();
    expect(got.report.sold).toMatchObject({ accepted: 1, undecided: 1 });
    expect(got.unknowns).toMatchObject({ total_n: 1, entries: [{ domain: 'thebestcoffeeshop.com', features: [{ check: 'tier', reason_code: 'DEMAND2_UNDECIDED', detail: { unknown_inputs: ['prior_history'] } }] }] });
  });
  it('T14-8 a screening run lists a tier row that is UNKNOWN with the inputs that were unknown', async () => {
    await putBrandLists();
    const x = await h(async (d) => (d.endsWith('.com') ? regd() : free()));
    expect((await x.post('/selection/sibling-methods/bt1@v2/approve', { approval_ref: ap(x, 'sibling method bt1@v2 approved') })).statusCode).toBe(201);
    const run = await x.runDone({ mode: 'full', checks: ['form', 'census', 'ext_dates', 'history', 'tier'], names: [{ domain: 'thebestcoffeeshop.com', lane: 'S3', census_list: 'bt1@v2', as_of: '2026-10-01T00:00:00Z' }] });
    const tier = run.body.names[0].results.find((q: any) => q.check === 'tier');
    expect(tier).toMatchObject({ status: 'UNKNOWN', reason_code: 'DEMAND2_UNDECIDED' });
    const e = run.body.unknowns.entries.find((q: any) => q.domain === 'thebestcoffeeshop.com');
    expect(e.features.find((f: any) => f.check === 'tier')).toMatchObject({ reason_code: 'DEMAND2_UNDECIDED', detail: { unknown_inputs: expect.arrayContaining(['prior_history']) } });
  });
});
