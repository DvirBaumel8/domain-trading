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
