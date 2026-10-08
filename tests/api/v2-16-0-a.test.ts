// v2.16.0 part A (tech debt): cohort abandon, record route reads inside the lock, seal needs a done run, run bookkeeping atomicity, geo LANDER-1 fails closed,
// intake lock and word rules, IDT dates, price-list query, CR-014 N-1..N-3 (T14-*), CR-015 I-1, I-2, I-4 (T15-*).
import { randomUUID } from 'node:crypto';
import { http } from 'msw';
import { sql } from 'kysely';
import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { freezeReadyCohorts } from '../../src/modules/candidates/cohorts.js';
import { watchStatusOf } from '../../src/modules/candidates/drop-lists.js';
import { dropOutcomeOf } from '../../src/modules/ops/jobs/cohort-outcomes.js';
import type { RdapLookup, RdapLookupFn } from '../../src/core/rdap.js';
import { currentLists } from '../../src/modules/selection/lists.js';
import { IntakeScreeningJob } from '../../src/modules/candidates/intake.js';
import type { ScreeningWorker } from '../../src/modules/selection/engine.js';
import { BuildDailyListJob } from '../../src/modules/candidates/daily-list.js';
import { GATE_OF } from '../../src/modules/selection/checks/index.js';
import { planFor } from '../../src/modules/selection/engine.js';
import { featuresOfRun } from '../../src/modules/selection/test-sets.js';
import { testDb as db } from '../helpers/db.js';
import { putBrandLists, putList, screeningHarness, type ScreeningHarness } from '../helpers/screening.js';
import { fixture, respond } from '../helpers/screening-fixtures.js';
import { issueToken } from '../helpers/tokens.js';
import { mswServer } from '../setup/network.js';

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

describe('item 7 IDT dates at the 00:00-03:00 edge', () => {
  it('A16-1 watchStatusOf takes the IDT day of RDAP updated_at', () => {
    // 2026-03-01T22:30Z is 00:30 IDT on 2 March (UTC+2): the IDT day is the 2nd, so pending delete + 5 days is the 7th (UTC date would give the 6th)
    const w = watchStatusOf({ outcome: 'registered', reasonCode: null, facts: { ...facts(null), statuses: ['pendingDelete'], updated_at: '2026-03-01T22:30:00Z' } });
    expect(w).toMatchObject({ status: 'pending_delete', last_changed: '2026-03-02', expected_drop_date: '2026-03-07' });
    const r = watchStatusOf({ outcome: 'registered', reasonCode: null, facts: { ...facts(null), statuses: ['redemptionPeriod'], updated_at: '2026-10-09T21:30:00Z' } }); // 00:30 IDT on 10 Oct (UTC+3)
    expect(r).toMatchObject({ last_changed: '2026-10-10', expected_drop_date: '2026-11-14' });
  });
  it('A16-2 dropOutcomeOf takes the IDT day of the registry creation date', () => {
    // created 2026-10-09T22:30Z = 01:30 IDT on 10 Oct; expected drop date 11 Oct: the IDT day (10 Oct) is on or after expected - 1 day, so someone caught it at the drop
    const f = (created: string) => ({ outcome: 'registered' as const, reasonCode: null, facts: { ...facts(created), statuses: ['ok'] } });
    expect(dropOutcomeOf(f('2026-10-09T22:30:00Z'), '2026-10-11').result).toBe('caught_at_drop');
    expect(dropOutcomeOf(f('2026-10-09T20:30:00Z'), '2026-10-11').result).toBe('restored'); // 23:30 IDT on the 9th
  });
});

describe('item 9 price lists', () => {
  it('A16-3 currentLists returns the highest version of each named list in one query, and leaves out a list with no rows', async () => {
    await putList('brand', ['a'], 1);
    await putList('brand', ['a', 'b'], 2);
    await putList('brand', ['a', 'b', 'c'], 3);
    await putList('bigco', ['x'], 1);
    await putList('event', ['e'], 1);
    await putList('event', ['e', 'f'], 2);
    expect(await currentLists(db, ['brand', 'bigco', 'event', 'nolist'])).toEqual({
      brand: { version: 3, terms: ['a', 'b', 'c'] }, bigco: { version: 1, terms: ['x'] }, event: { version: 2, terms: ['e', 'f'] },
    });
    expect(await currentLists(db, [])).toEqual({});
  });
});

describe('item 1 cohort freeze only on a done run', () => {
  const body = (name: string, domain: string) => ({ name, settings: ['v1'], names: [{ domain, expected_drop_date: '2026-10-20', source: 'a' }] });
  it('A16-4 a cancelled or partial run abandons the cohort: no decisions, not counted as open, the guard allows only computing -> frozen/abandoned', async () => {
    const x = await h();
    const a = await x.post('/selection/cohorts', body('co-cancel', 'superpro.com'));
    const b = await x.post('/selection/cohorts', body('co-partial', 'superbox.com'));
    const c = await x.post('/selection/cohorts', body('co-done', 'supertech.com'));
    expect([a.statusCode, b.statusCode, c.statusCode]).toEqual([202, 202, 202]);
    for (const r of [a, b, c]) await app!.screeningWorker.runToEnd(r.json().run_id);
    await db.updateTable('screening_runs').set({ status: 'cancelled', cancelled_at: new Date(x.clock.t), cancelled_by: 'gavriel' }).where('id', '=', a.json().run_id).execute();
    await db.updateTable('screening_runs').set({ status: 'partial' }).where('id', '=', b.json().run_id).execute();
    // the lazy read and the daily step
    expect((await x.get('/selection/cohorts/co-cancel')).json()).toMatchObject({ status: 'abandoned', run: { status: 'cancelled' }, report: {} });
    expect(await freezeReadyCohorts(db, x.clock.t)).toEqual(['co-done']);
    expect((await db.selectFrom('cohorts').select(['name', 'status']).orderBy('name').execute())).toEqual([
      { name: 'co-cancel', status: 'abandoned' }, { name: 'co-done', status: 'frozen' }, { name: 'co-partial', status: 'abandoned' },
    ]);
    expect((await x.get('/selection/cohorts/co-partial')).json()).toMatchObject({ status: 'abandoned', run: { status: 'partial' } });
    expect((await db.selectFrom('cohort_decisions').select('cohort').distinct().execute()).map((d) => d.cohort)).toEqual(['co-done']);
    // an abandoned cohort never freezes later, and does not hold its names
    await db.updateTable('screening_runs').set({ status: 'done' }).where('id', '=', a.json().run_id).execute();
    expect(await freezeReadyCohorts(db, x.clock.t)).toEqual([]);
    expect((await db.selectFrom('cohort_decisions').select('cohort').where('cohort', '=', 'co-cancel').execute())).toEqual([]);
    const again = await x.post('/selection/cohorts', body('co-again', 'superpro.com'));
    expect(again.statusCode, again.body).toBe(202);
    expect(again.json().excluded).toEqual({});
    const held = await x.post('/selection/cohorts', { name: 'co-held', settings: ['v1'], names: [{ domain: 'supertech.com', expected_drop_date: '2026-10-20', source: 'a' }, { domain: 'superbox.com', expected_drop_date: '2026-10-20', source: 'a' }] });
    expect(held.json().excluded).toEqual({ IN_OPEN_COHORT: 1 }); // supertech is in the frozen cohort; superbox's cohort was abandoned
    // the guard
    await expect(db.updateTable('cohorts').set({ status: 'frozen' }).where('name', '=', 'co-partial').execute()).rejects.toThrow(/append-only/);
    await expect(db.updateTable('cohorts').set({ status: 'computing' }).where('name', '=', 'co-partial').execute()).rejects.toThrow(/append-only/);
  });
});

describe('item 2 the manual record reads the history inside the run lock', () => {
  const D = 'tampapoolsco.com';
  const TM = { phrases_queried: ['TAMPA POOLS CO', 'TAMPAPOOLSCO'], control_ok: true, exact_or_core_live: [], generic_live: [] };
  const HIST = { result: 'FLAG_PRIOR_BUSINESS', prior_business_name: 'Sunny Pools LLC', first_capture_year: 2019, last_capture_year: 2021, evidence_urls: ['https://web.archive.org/web/20190412093000/http://tampapoolsco.com/'], checked_by: 'gavriel' };
  it('A16-5 a tm_us record posted after a history record with a prior business name is judged against it; the same record with the phrase passes the prior-name rule', async () => {
    await putBrandLists();
    const x = await h();
    const run = await x.runDone({ checks: ['form', 'history', 'tm_us'], names: [{ domain: D, lane: 'S3' }] });
    const at = new Date(x.clock.t - HOUR).toISOString();
    const hist = await x.post(`/screening/runs/${run.id}/manual`, { domain: D, check: 'history', checked_at: at, result: HIST });
    expect(hist.statusCode, hist.body).toBe(201);
    const tm = await x.post(`/screening/runs/${run.id}/manual`, { domain: D, check: 'tm_us', checked_at: at, evidence_url: 'https://tmsearch.uspto.gov/x', result: TM });
    expect(tm.statusCode, tm.body).toBe(201);
    expect(tm.json()).toMatchObject({ check: 'tm_us', status: 'UNKNOWN', reason_code: 'PRIOR_NAME_NOT_QUERIED' });
    const ok = await x.post(`/screening/runs/${run.id}/manual`, { domain: D, check: 'tm_us', checked_at: at, evidence_url: 'https://tmsearch.uspto.gov/x', result: { ...TM, phrases_queried: [...TM.phrases_queried, 'SUNNY POOLS LLC'] } });
    expect(ok.json().reason_code).not.toBe('PRIOR_NAME_NOT_QUERIED');
  });
});

describe('item 3 seal needs a done run; is_geo is unknown when the form did not pass', () => {
  it('A16-6 a partial run is 409 TEST_SET_NOT_READY with details.status partial and registers nothing', async () => {
    const x = await h();
    expect((await x.post('/selection/sibling-methods/bt1@v1/approve', { approval_ref: ap(x, 'sibling method bt1@v1 approved') })).statusCode).toBe(201);
    const r = await x.post('/selection/test-sets', { name: 'TS-PART', purpose: 'new', sibling_method: 'bt1@v1', seed: 'k', rows: [{ domain: 'superhealth.com', label: 'sold', as_of: '2024-06-01', source: 'u', price_usd: 900 }, { domain: 'supertech.com', label: 'dropped', as_of: '2024-06-01', source: 'u' }] });
    expect(r.statusCode, r.body).toBe(202);
    await app!.screeningWorker.runToEnd(r.json().run_id);
    await db.updateTable('screening_runs').set({ status: 'partial' }).where('id', '=', r.json().run_id).execute();
    const seal = await x.post('/selection/test-sets/TS-PART/seal', {});
    expect([seal.statusCode, seal.json().error.code, seal.json().error.details.status]).toEqual([409, 'TEST_SET_NOT_READY', 'partial']);
    expect(await db.selectFrom('labelled_names').selectAll().execute()).toHaveLength(0);
    // once the run is done the same set seals
    await db.updateTable('screening_runs').set({ status: 'done' }).where('id', '=', r.json().run_id).execute();
    expect((await x.post('/selection/test-sets/TS-PART/seal', {})).statusCode).toBe(201);
  });
  it('A16-7 featuresOfRun: is_geo is null (unknown) when the form row is not PASS, 0 or 1 when it passed', async () => {
    await putBrandLists();
    const x = await h();
    const run = await x.runDone({ checks: ['form'], names: [{ domain: 'qxz9.com', lane: 'S3' }, { domain: 'superpro.com', lane: 'S3' }, { domain: 'tampapoolsco.com', lane: 'S2', city: 'Tampa', trade: 'pools' }] });
    const row = await db.selectFrom('screening_runs').selectAll().where('id', '=', run.id).executeTakeFirstOrThrow();
    const f = (await featuresOfRun(db, row)).byDomain;
    expect(run.body.names.find((n: any) => n.domain === 'qxz9.com').results.find((q: any) => q.check === 'form').status).toBe('FAIL');
    expect(f.get('qxz9.com')!.is_geo).toBeNull();
    expect(f.get('superpro.com')!.is_geo).toBe(0);
    expect([0, 1, null]).toContain(f.get('tampapoolsco.com')!.is_geo);
  });
});

describe('item 4 a run whose bookkeeping failed is cancelled, not left running', () => {
  it('A16-8 cohort: a failed cohort_names insert cancels the run (cancelled_by system) and stores no cohort', async () => {
    const x = await h();
    const undo = await failInserts('cohort_names');
    try {
      const r = await x.post('/selection/cohorts', { name: 'co-fail', settings: ['v1'], names: [{ domain: 'superpro.com', expected_drop_date: '2026-10-20', source: 'a' }] });
      expect(r.statusCode).toBe(500);
    } finally { await undo(); }
    const runs = await db.selectFrom('screening_runs').select(['status', 'cancelled_by']).execute();
    expect(runs).toEqual([{ status: 'cancelled', cancelled_by: 'system' }]);
    expect(await db.selectFrom('cohorts').selectAll().execute()).toEqual([]);
    expect((await x.post('/selection/cohorts', { name: 'co-fail', settings: ['v1'], names: [{ domain: 'superpro.com', expected_drop_date: '2026-10-20', source: 'a' }] })).statusCode).toBe(202);
  });
  it('A16-9 test set: a failed test_set_rows insert cancels the run', async () => {
    const x = await h();
    expect((await x.post('/selection/sibling-methods/bt1@v1/approve', { approval_ref: ap(x, 'sibling method bt1@v1 approved') })).statusCode).toBe(201);
    const undo = await failInserts('test_set_rows');
    try {
      const r = await x.post('/selection/test-sets', { name: 'TS-FAIL', purpose: 'new', sibling_method: 'bt1@v1', seed: 'k', rows: [{ domain: 'superhealth.com', label: 'sold', as_of: '2024-06-01', source: 'u', price_usd: 900 }] });
      expect(r.statusCode).toBe(500);
    } finally { await undo(); }
    expect(await db.selectFrom('screening_runs').select(['status', 'cancelled_by']).execute()).toEqual([{ status: 'cancelled', cancelled_by: 'system' }]);
    expect(await db.selectFrom('test_sets').selectAll().execute()).toEqual([]);
  });
  it('A16-10 intake screening: a failed bookkeeping insert cancels the run and rethrows; the names stay queued and the next run takes them', async () => {
    const x = await h();
    const send = (names: object[]) => x.post('/candidates/intake', { names });
    expect((await send([{ domain: 'superpro.com', lane: 'S3', source: 's' }, { domain: 'superbox.com', lane: 'S3', source: 's' }])).statusCode).toBe(200);
    const undo = await failInserts('candidate_screenings');
    try {
      await expect(new IntakeScreeningJob({ db, worker: x.app.screeningWorker, now: () => x.clock.t }).runOnce()).rejects.toThrow(/forced failure/);
    } finally { await undo(); }
    expect(await db.selectFrom('screening_runs').select(['status', 'cancelled_by', 'created_by']).execute()).toEqual([{ status: 'cancelled', cancelled_by: 'system', created_by: 'intakeScreening' }]);
    expect(await db.selectFrom('candidate_screenings').selectAll().execute()).toEqual([]);
    const kicked: string[] = [];
    const again = await new IntakeScreeningJob({ db, worker: fakeWorker(x, kicked), now: () => x.clock.t }).runOnce();
    expect(again).toMatchObject({ screened: 2, from_intake: 2 });
    expect(kicked).toEqual([again.run_id]);
  });
});

describe('item 6 intake: one screening at a time, and the drop-list word rules', () => {
  it('A16-11 two instances racing take the queue once: one run, every name screened once', async () => {
    const x = await h();
    const names = ['superpro', 'superbox', 'supertech', 'superhealth', 'supermedia'].map((n) => `${n}.com`);
    expect((await x.post('/candidates/intake', { names: names.map((domain) => ({ domain, lane: 'S3', source: 'bulk' })) })).statusCode).toBe(200);
    const kicked: string[] = [];
    const [a, b] = await Promise.all([1, 2].map(() => new IntakeScreeningJob({ db, worker: fakeWorker(x, kicked), now: () => x.clock.t }).runOnce()));
    const taken = [a!, b!].filter((r) => !r.skipped);
    expect(taken).toHaveLength(1);
    expect(taken[0]).toMatchObject({ screened: 5, from_intake: 5 });
    expect([a!, b!].find((r) => r.skipped)).toMatchObject({ skipped: true, reason: 'NO_NAMES' });
    expect(await db.selectFrom('screening_runs').select('id').execute()).toHaveLength(1);
    const screened = await db.selectFrom('candidate_screenings').select('domain').execute();
    expect(screened.map((s) => s.domain).sort()).toEqual([...names].sort());
    expect(kicked).toHaveLength(1);
  });
  it('A16-12 NO_SPLIT and ONE_WORD are removal reasons on /candidates/intake, as on a drop list; a good name is still accepted', async () => {
    const x = await h();
    const r = await x.post('/candidates/intake', { names: ['zzqxjkvv.com', 'mountain.com', 'thebestcoffeeshop.com', 'superpro.com'].map((domain) => ({ domain, lane: 'S3', source: 's' })) });
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json().removed).toEqual([{ domain: 'zzqxjkvv.com', reason: 'NO_SPLIT' }, { domain: 'mountain.com', reason: 'ONE_WORD' }, { domain: 'thebestcoffeeshop.com', reason: 'TOO_MANY_WORDS' }]);
    expect(r.json().accepted).toEqual([{ domain: 'superpro.com', intake_id: expect.any(Number) }]);
  });
});

describe('CR-015 I-1 intake note and source carry no personal data (T15-1)', () => {
  it('T15-1 an "@" in note or source is 422 NO_PII with {index, field}; nothing is stored', async () => {
    const x = await h();
    const bad1 = await x.post('/candidates/intake', { names: [{ domain: 'superpro.com', lane: 'S3', source: 'ok' }, { domain: 'superbox.com', lane: 'S3', source: 's', note: 'ask bob@example.com' }] });
    expect([bad1.statusCode, bad1.json().error.code, bad1.json().error.details]).toEqual([422, 'NO_PII', { index: 1, field: 'note' }]);
    const bad2 = await x.post('/candidates/intake', { names: [{ domain: 'superbox.com', lane: 'S3', source: 'scout@host' }] });
    expect([bad2.statusCode, bad2.json().error.code, bad2.json().error.details]).toEqual([422, 'NO_PII', { index: 0, field: 'source' }]);
    expect(await db.selectFrom('candidate_intake').selectAll().execute()).toEqual([]);
    expect((await x.post('/candidates/intake', { names: [{ domain: 'superbox.com', lane: 'S3', source: 'scout-1/run-4', note: 'seen on a list' }] })).statusCode).toBe(200);
  });
});

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

describe('CR-015 I-2 GET /audit names the token (T15-2)', () => {
  it('T15-2 rows carry token_name (never the hash); a job or admin row has null', async () => {
    const x = await h();
    await x.post('/candidates/intake', { names: [{ domain: 'superpro.com', lane: 'S3', source: 's' }] });
    const rows = (await x.get('/audit?limit=50')).json().rows;
    const intake = rows.find((r: any) => r.path === '/candidates/intake');
    expect(intake).toMatchObject({ token_name: 'gavriel' });
    expect(typeof intake.token_id).toBe('number');
    expect(JSON.stringify(rows)).not.toMatch(/token_sha256|sha256/);
    await db.insertInto('audit_log').values({ id: 'aud_' + '2'.repeat(32), method: 'JOB', path: '/job/x', status_code: 200, scope: 'job' }).execute();
    const again = (await x.get('/audit?limit=50')).json().rows;
    expect(again.find((r: any) => r.id === 'aud_' + '2'.repeat(32)).token_name).toBeNull();
    expect(again.every((r: any) => 'token_name' in r)).toBe(true);
  });
});

interface Seed { domain: string; noRecords?: boolean; recordsAgeDays?: number; firstYearCents?: number }
/** A finished full-plan run on settings v1 (hold on), every planned check seeded as PASS (history/tm_us MANUAL_REQUIRED when noRecords); fresh domain records unless noRecords. */
async function seedRun(x: ScreeningHarness, names: Seed[]): Promise<string> {
  const sel = await db.selectFrom('selection_settings').select(['id', 'label', 'values']).where('label', '=', 'v1').executeTakeFirstOrThrow();
  const id = `run_${randomUUID()}`;
  const gate_plan: Record<string, string[]> = { S3: planFor(sel.values as never, 'S3') };
  const created = new Date(x.clock.t - HOUR);
  await db.insertInto('screening_runs').values({
    id, created_at: created, created_by: 'test', mode: 'full', backtest: false, settings_id: sel.id, settings_label: 'v1', buy_hold: true, tranche_id: null,
    input: JSON.stringify({ names: names.map((n, idx) => ({ idx, domain: n.domain, lane: 'S3', leads_ab: 0 })) }),
    gate_plan: JSON.stringify(gate_plan), list_versions: '{}', status: 'done', deadline_at: new Date(x.clock.t + 3_600_000), finished_at: created,
  }).execute();
  for (const [idx, n] of names.entries()) {
    for (const check of gate_plan.S3!) {
      let status: 'PASS' | 'MANUAL_REQUIRED' = 'PASS';
      let reason_code: string | null = null;
      let fields: Record<string, unknown> = {};
      if ((check === 'tm_us' || check === 'history') && n.noRecords) { status = 'MANUAL_REQUIRED'; reason_code = 'MANUAL_SOURCE'; }
      if (check === 'price') fields = { bin_cents: 148800, ratio_at_bin: 3, ratio_at_floor: 2, score_0_100: 50, floor_cents: 96700, walkaway_cents: 71500 };
      if (check === 'quote') fields = { registrar: 'porkbun', first_year_cents: n.firstYearCents ?? 1108, renewal_cents: 1208, quoted_at: new Date(x.clock.t - HOUR).toISOString() };
      if (check === 'tier') fields = { tier: 'A', tier_exact: true, fired: 'A' };
      await db.insertInto('screening_results').values({
        run_id: id, item_idx: idx, domain: n.domain, lane: 'S3', check_id: check, gate: GATE_OF[check as keyof typeof GATE_OF], rule_ids: ['X'], status, reason_code, reason: reason_code ? 'seeded' : null,
        fields: JSON.stringify(fields), checked_at: created, settings_label: 'v1', list_versions: '{}', duration_ms: 0, upstream_calls: 0, source: 'auto',
      }).execute();
    }
    if (!n.noRecords) {
      for (const kind of ['tm_us', 'history'] as const) {
        await db.insertInto('domain_records').values({ domain: n.domain, kind, record: JSON.stringify({ seeded: true }), checked_by: 'gavriel', checked_at: new Date(x.clock.t - (n.recordsAgeDays ?? 0) * DAY - 2 * HOUR), created_by: 'gavriel' }).execute();
      }
    }
  }
  return id;
}
const TM_OK = (d: string) => ({ phrases_queried: [d.replace('.com', '').toUpperCase()], control_ok: true, exact_or_core_live: [], generic_live: [] });

describe('CR-015 I-4 the daily list is judged at build time, and can be rebuilt on demand (T15-3..T15-6)', () => {
  it('T15-3 POST /candidates/daily/rebuild builds a new version of today now; the first order is kept and a change is marked; it is audited and needs WRITE and an Idempotency-Key', async () => {
    const x = await h();
    await seedRun(x, [{ domain: 'superpro.com' }]);
    await new BuildDailyListJob({ db, worker: fakeWorker(x), now: () => x.clock.t }).runOnce();
    expect((await x.get('/candidates/daily')).json()).toMatchObject({ version: 1, entries: [{ domain: 'superpro.com', rank: 1 }] });
    await seedRun(x, [{ domain: 'superbox.com' }]);
    const r = await x.post('/candidates/daily/rebuild', {});
    expect(r.statusCode, r.body).toBe(201);
    expect(r.json()).toMatchObject({ day: '2026-10-06', entries_n: 2, version: 2, rebuilds_today: 1, rebuilds_left_today: 5 });
    expect((await x.get('/candidates/daily')).json().entries.map((e: any) => [e.rank, e.domain])).toEqual([[1, 'superpro.com'], [2, 'superbox.com']]);
    // a change since the first build is marked
    await seedRun(x, [{ domain: 'superpro.com', firstYearCents: 999 }]); // a newer screening of the name with another first-year price
    expect((await x.post('/candidates/daily/rebuild', {})).statusCode).toBe(201);
    const e = (await x.get('/candidates/daily')).json().entries.find((q: any) => q.domain === 'superpro.com');
    expect(e.changed_since_first).toEqual({ reason: 'STATE_CHANGED', changes: ['price'] });
    expect(await db.selectFrom('audit_log').select('id').where('path', '=', '/candidates/daily/rebuild').where('status_code', '=', 201).execute()).toHaveLength(2);
    // scope and key
    const read = await issueToken('read');
    const noScope = await x.app.inject({ method: 'POST', url: '/candidates/daily/rebuild', headers: { ...read.auth, 'idempotency-key': randomUUID() }, payload: {} });
    expect(noScope.statusCode).toBeGreaterThanOrEqual(401);
    expect(noScope.statusCode).toBeLessThan(404);
    expect(await db.selectFrom('daily_candidate_lists').select('id').execute()).toHaveLength(3);
  });
  it('T15-4 at most 6 rebuilds per IDT day: the 7th is 429 RATE_LIMITED and builds nothing; the next day starts again; the daily step does not count', async () => {
    const x = await h();
    await seedRun(x, [{ domain: 'superpro.com' }]);
    await new BuildDailyListJob({ db, worker: fakeWorker(x), now: () => x.clock.t }).runOnce();
    for (let i = 0; i < 6; i++) expect((await x.post('/candidates/daily/rebuild', {})).statusCode, `rebuild ${i + 1}`).toBe(201);
    const before = (await db.selectFrom('daily_candidate_lists').select('id').execute()).length;
    const seventh = await x.post('/candidates/daily/rebuild', {});
    expect([seventh.statusCode, seventh.json().error.code, seventh.json().error.details]).toEqual([429, 'RATE_LIMITED', { max_per_day: 6, day: '2026-10-06' }]);
    expect(await db.selectFrom('daily_candidate_lists').select('id').execute()).toHaveLength(before);
    x.clock.t = Date.parse('2026-10-07T07:00:00Z');
    expect((await x.post('/candidates/daily/rebuild', {})).statusCode).toBe(201);
  });
  it('T15-5 a record posted after the screening is seen at build time: the name is almost ready with nothing missing and a note to screen it again', async () => {
    const x = await h();
    await seedRun(x, [{ domain: 'superpro.com', noRecords: true }]);
    await new BuildDailyListJob({ db, worker: fakeWorker(x), now: () => x.clock.t }).runOnce();
    const first = (await x.get('/candidates/daily')).json().sections.almost_ready[0];
    expect(first.missing).toEqual([{ kind: 'tm_us', reason: 'NO_RECORD' }, { kind: 'history', reason: 'NO_RECORD' }]);
    expect((await x.post('/candidates/superpro.com/records', { kind: 'tm_us', record: TM_OK('superpro.com'), checked_by: 'gavriel', evidence_url: 'https://tmsearch.uspto.gov/x' })).statusCode).toBe(201);
    expect((await x.post('/candidates/superpro.com/records', { kind: 'history', record: { result: 'PASS', checked_by: 'gavriel' }, checked_by: 'gavriel' })).statusCode).toBe(201);
    expect((await x.post('/candidates/daily/rebuild', {})).statusCode).toBe(201);
    const now = (await x.get('/candidates/daily')).json().sections.almost_ready[0];
    expect(now.missing).toEqual([]);
    expect(now.note).toMatch(/screening ran before/);
    expect(now.records.tm_us).toMatchObject({ source: 'domain_record', checked_by: 'gavriel' });
    expect(now.records.history).toMatchObject({ source: 'domain_record' });
  });
  it('T15-6 a record that went stale since the screening counts as missing at build time (STALE), though the run saw it', async () => {
    const x = await h();
    // tm_us/history fresh for the run (checked 29 days and 22 h ago), stale 3 hours later
    await seedRun(x, [{ domain: 'superpro.com', recordsAgeDays: 29.9 }]);
    await new BuildDailyListJob({ db, worker: fakeWorker(x), now: () => x.clock.t }).runOnce();
    expect((await x.get('/candidates/daily')).json().entries.map((e: any) => e.domain)).toEqual(['superpro.com']);
    x.clock.t += 4 * HOUR;
    expect((await x.post('/candidates/daily/rebuild', {})).statusCode).toBe(201);
    const l = (await x.get('/candidates/daily')).json();
    expect(l.sections.almost_ready.find((a: any) => a.domain === 'superpro.com').missing).toEqual([{ kind: 'tm_us', reason: 'STALE' }]);
    expect(l.sections.removed_since_first).toEqual([{ domain: 'superpro.com', was_rank: 1, reason: expect.any(String) }]);
  });
});
