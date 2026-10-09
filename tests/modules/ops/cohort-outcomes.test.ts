// v2.8.0 (CR-007 §22): drop lists (G-2 source A: upload, filters, dropWatch, window reads, DROP_FEED_STALE) and cohorts (G-1: creation, exclusions,
// frozen decisions, daily outcomes, the forward report). RDAP answers are injected recordings; no registrar adapter is ever called.
import { createHash } from 'node:crypto';
import { http } from 'msw';
import { sql } from 'kysely';
import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { FWD_MIN_N, FWD_MIN_RATIO, classRate, windowVerdict } from '../../../src/modules/candidates/cohorts.js';
import { DROP_LIST_RETENTION_DAYS, DROP_WATCH_MAX_PER_RUN, watchStatusOf } from '../../../src/modules/candidates/drop-lists.js';
import { addDays } from '../../../src/core/dates.js';
import { CohortOutcomesJob } from '../../../src/modules/ops/jobs/cohort-outcomes.js';
import { DropWatchJob } from '../../../src/modules/ops/jobs/drop-watch.js';
import type { RdapLookup } from '../../../src/core/rdap.js';
import { wilson95 } from '../../../src/modules/selection/test-sets.js';
import { makeApp, runJobToEnd } from '../../helpers/app.js';
import { testDb as db } from '../../helpers/db.js';
import { FakeAdapter } from '../../helpers/fake-adapter.js';
import { patchActiveSettings, screeningHarness, type ScreeningHarness } from '../../helpers/screening.js';
import { fixture, respond } from '../../helpers/screening-fixtures.js';
import { issueToken } from '../../helpers/tokens.js';
import { mswServer } from '../../setup/network.js';

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
