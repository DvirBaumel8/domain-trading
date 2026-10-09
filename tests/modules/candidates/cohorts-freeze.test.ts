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
