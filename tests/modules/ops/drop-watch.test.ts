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
