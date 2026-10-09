// v3.2.0 part B (CR-018 A/B, CR-019 C-1..C-4, CR-020 A..D): resume of a cut-off intake run, summary.why, the timeout retry, leftovers, lane fit, who_chases, partial, main lanes.
import { settleJob } from '../../helpers/app.js';
import { randomUUID } from 'node:crypto';
import { http } from 'msw';
import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildWhy } from '../../../src/modules/candidates/daily-list.js';
import { INTAKE_DAILY_MAX, IntakeScreeningJob } from '../../../src/modules/candidates/intake.js';
import { GATE_OF } from '../../../src/modules/selection/checks/index.js';
import { planFor } from '../../../src/modules/selection/engine.js';
import { DEFAULT_SELECTION_VALUES } from '../../../src/modules/selection/settings.js';
import { DOMAIN, buyBody, postBuy } from '../../helpers/buy.js';
import { testDb as db } from '../../helpers/db.js';
import { FakeAdapter } from '../../helpers/fake-adapter.js';
import { patchActiveSettings, putList, screeningHarness, type ScreeningHarness } from '../../helpers/screening.js';
import { fixture, respond } from '../../helpers/screening-fixtures.js';
import { issueToken } from '../../helpers/tokens.js';
import type { RdapLookup } from '../../../src/core/rdap.js';
import { mswServer } from '../../setup/network.js';

let app: FastifyInstance | undefined;
afterEach(async () => app?.close());
const DAY = 86_400_000;
const HOUR = 3_600_000;
const T_FREE = (): RdapLookup => ({ outcome: 'not_registered', reasonCode: null, httpStatus: 404, url: 'https://rdap.example/domain/x', retrievedAt: new Date(), body: null, facts: null });
const T_TIMEOUT = (): RdapLookup => ({ outcome: 'unknown', reasonCode: 'TIMEOUT', httpStatus: null, url: '', retrievedAt: new Date(), body: null, facts: null });
const T_TAKEN = (): RdapLookup => ({ outcome: 'registered', reasonCode: null, httpStatus: 200, url: 'https://rdap.example/domain/x', retrievedAt: new Date(), body: null, facts: { statuses: ['active'], registrar: 'X', created_at: null, expires_at: null, updated_at: null, nameservers: [] } as never });

async function h(opts: Parameters<typeof screeningHarness>[0] = {}): Promise<ScreeningHarness> {
  mswServer.use(http.get('https://data.iana.org/rdap/dns.json', () => respond(fixture('iana-dns.json'))));
  const x = await screeningHarness({ ...opts, screening: { rdapLookup: async () => T_FREE(), sleep: async () => {}, ...opts.screening } });
  app = x.app;
  return x;
}
async function scout(x: ScreeningHarness, name = 'scout-1') {
  const t = await issueToken('intake', name);
  const call = (method: 'GET' | 'POST', url: string, payload?: object) => (x.clock.t += 7_000, x.app.inject({ method, url, headers: { ...t.auth, 'idempotency-key': randomUUID() }, ...(payload && { payload }) }));
  return { ...t, call, intake: (names: object[]) => call('POST', '/candidates/intake', { names }) };
}
const realJob = (x: ScreeningHarness) => new IntakeScreeningJob({ db, worker: x.app.screeningWorker, now: () => x.clock.t });
const today = (x: ScreeningHarness) => new Date(x.clock.t + 3 * HOUR).toISOString().slice(0, 10);
const NAMES = ['superpro', 'superbox', 'supertech', 'superhealth', 'supermedia', 'superlab', 'superhub', 'supershop', 'superworks', 'supergroup', 'superhouse', 'superstore', 'megapro', 'megatech', 'megahealth', 'megamedia', 'megalab', 'megahub',
  'megaworks', 'megagroup', 'megahouse', 'smartpro', 'smartbox', 'smarttech', 'smarthealth', 'smartmedia', 'smartlab', 'smarthub', 'smartshop', 'smartworks', 'smartgroup', 'smarthouse', 'smartstore', 'quickpro', 'quickbox'];
const nm = (i: number) => `${NAMES[i]}.com`;

type Outcome = 'pass' | 'taken' | 'form' | 'timeout';
interface Seed { domain: string; outcome?: Outcome; origin?: 'intake' | 'drop_list'; records?: boolean }
/** A full-plan run on the seeded settings with every planned check seeded (one name = one outcome); `origin` also writes the candidate_screenings row. */
async function seedRun(x: ScreeningHarness, names: Seed[], o: { status?: 'done' | 'partial' | 'running'; ageHours?: number } = {}): Promise<string> {
  const sel = await db.selectFrom('selection_settings').select(['id', 'label', 'values']).where('label', '=', 'v1').executeTakeFirstOrThrow();
  const id = `run_${randomUUID()}`;
  const plan = planFor(sel.values as never, 'S3');
  const created = new Date(x.clock.t - (o.ageHours ?? 1) * HOUR);
  const status = o.status ?? 'done';
  await db.insertInto('screening_runs').values({
    id, created_at: created, created_by: 'intakeScreening', mode: 'full', backtest: false, settings_id: sel.id, settings_label: 'v1', buy_hold: true, tranche_id: null,
    input: JSON.stringify({ names: names.map((n, idx) => ({ idx, domain: n.domain, lane: 'S3', leads_ab: 0 })) }),
    gate_plan: JSON.stringify({ S3: plan }), list_versions: '{}', status, deadline_at: new Date(x.clock.t + HOUR), finished_at: status === 'running' ? null : created,
  }).execute();
  for (const [idx, n] of names.entries()) {
    const outcome = n.outcome ?? 'pass';
    for (const check of plan) {
      let st: 'PASS' | 'FAIL' | 'UNKNOWN' = 'PASS';
      let code: string | null = null;
      let fields: Record<string, unknown> = {};
      if (outcome === 'taken' && check === 'availability') { st = 'FAIL'; code = 'REGISTERED'; }
      if (outcome === 'form' && check === 'form') { st = 'FAIL'; code = 'UNKNOWN_TOKEN'; }
      if (outcome === 'timeout' && check === 'availability') { st = 'UNKNOWN'; code = 'TIMEOUT'; }
      if (check === 'price') fields = { bin_cents: 148800, ratio_at_bin: 3, ratio_at_floor: 2, score_0_100: 50, floor_cents: 96700, walkaway_cents: 71500 };
      if (check === 'quote') fields = { registrar: 'porkbun', first_year_cents: 1108, renewal_cents: 1208, quoted_at: new Date(x.clock.t - HOUR).toISOString() };
      if (check === 'tier') fields = { tier: 'A', tier_exact: true, fired: 'A' };
      await db.insertInto('screening_results').values({
        run_id: id, item_idx: idx, domain: n.domain, lane: 'S3', check_id: check, gate: GATE_OF[check as keyof typeof GATE_OF], rule_ids: ['X'], status: st, reason_code: code, reason: code ? 'seeded' : null,
        fields: JSON.stringify(fields), checked_at: created, settings_label: 'v1', list_versions: '{}', duration_ms: 0, upstream_calls: 0, source: 'auto',
      }).execute();
    }
    if (outcome === 'pass' && n.records !== false) {
      for (const kind of ['tm_us', 'history'] as const) {
        await db.insertInto('domain_records').values({ domain: n.domain, kind, record: JSON.stringify({ seeded: true }), checked_by: 'gavriel', checked_at: new Date(x.clock.t - 2 * HOUR), created_by: 'gavriel' }).execute();
      }
    }
    if (n.origin) await db.insertInto('candidate_screenings').values({ intake_id: null, domain: n.domain, origin: n.origin, run_id: id, day: today(x), at: created }).execute();
  }
  return id;
}

/** A drop list with, per name, the registry checks it has had, in order: [status, expected_drop_date]. */
async function dropList(x: ScreeningHarness, name: string, entries: { domain: string; checks: [string, string | null][]; kept?: boolean }[], ageDays = 0): Promise<void> {
  await db.insertInto('drop_lists').values({ name, list_date: today(x), created_by: 'scout-1', received_n: entries.length, kept_n: entries.length }).execute();
  await db.insertInto('drop_list_rows').values(entries.map((e) => ({ list_name: name, domain: e.domain, kept: e.kept ?? true, reason: null, tokens: ['drop', 'x'] }))).execute();
  let i = 0;
  for (const e of entries) {
    for (const [status, d] of e.checks) {
      await db.insertInto('drop_list_checks').values({ list_name: name, domain: e.domain, checked_at: new Date(x.clock.t - ageDays * DAY - (1000 - i++) * 1000), status: status as never, last_changed: null, expected_drop_date: d, drop_date_source: d ? 'estimate' : null, reason_code: null }).execute();
    }
  }
}
const ymd = (x: ScreeningHarness, plusDays: number) => new Date(x.clock.t + 3 * HOUR + plusDays * DAY).toISOString().slice(0, 10);
const rebuild = (x: ScreeningHarness) => x.post('/candidates/daily/rebuild', {});
const daily = async (x: ScreeningHarness) => (await x.get('/candidates/daily?limit=25')).json();
/** Lists so the lane names below read as: S2 city+trade, S4 tech+trade, S6 regime. */
async function lanes(): Promise<void> {
  await putList('trade', ['roofing', 'plumbing', 'restaurant', 'consultants', 'declarants'], 2);
  await putList('tech', ['voice', 'agent'], 2);
  await putList('regime', ['cbam', 'gdpr'], 2);
  await putList('dictionary_extra', ['declarants'], 2);
}
const LEFTOVER: [string, string | null][] = [['pending_delete', '__E__'], ['not_registered', null]];
const leftover = (x: ScreeningHarness, domain: string) => ({ domain, checks: LEFTOVER.map(([s, d]) => [s, d === '__E__' ? ymd(x, -1) : d] as [string, string | null]) });

describe('CR-018 A: a cut-off intake run resumes and the list is rebuilt', () => {
  it('T18-1 a run left running by a dead process resumes at the first kick (not waiting for a stale heartbeat), the list is built without a manual call; T18-2 finished checks are not written again', async () => {
    const x = await h({ stopAfterResults: 8 });
    const s = await scout(x);
    await s.intake([0, 1, 2].map((i) => ({ domain: nm(i), lane: 'S3', source: 'scout' })));
    const r = await realJob(x).runOnce();
    await x.app.screeningWorker.idle();
    const mid = await db.selectFrom('screening_runs').select(['status', 'heartbeat_at']).where('id', '=', r.run_id!).executeTakeFirstOrThrow();
    expect(mid.status).toBe('running'); // killed mid-run
    const before = await db.selectFrom('screening_results').select(['id', 'item_idx', 'check_id']).where('run_id', '=', r.run_id!).orderBy('id').execute();
    expect(before.length).toBe(8);
    expect(await db.selectFrom('daily_candidate_lists').select('id').execute()).toHaveLength(0);
    // the heartbeat is fresh: the old poll-time rule would wait; the restart rule does not
    x.clock.t += 5_000;
    await x.app.jobQueue.kickIfNeeded();
    await x.app.screeningWorker.idle();
    expect((await db.selectFrom('screening_runs').select('status').where('id', '=', r.run_id!).executeTakeFirstOrThrow()).status).toBe('done');
    const after = await db.selectFrom('screening_results').select(['id', 'item_idx', 'check_id']).where('run_id', '=', r.run_id!).orderBy('id').execute();
    expect(after.slice(0, 8)).toEqual(before); // T18-2: the rows of the finished steps are the same rows
    const keys = after.map((a) => `${a.item_idx}|${a.check_id}`);
    expect(new Set(keys).size).toBe(keys.length); // and no (name, check) is written twice
    const lists = await db.selectFrom('daily_candidate_lists').select(['built_by', 'day']).execute();
    expect(lists).toEqual([{ built_by: 'auto', day: today(x) }]);
    expect((await daily(x)).summary.screened_today).toBe(3);
  }, 60_000);

  it('the first kick of a process resumes; a later kick still leaves a fresh heartbeat alone', async () => {
    const x = await h({ stopAfterResults: 4 });
    const s = await scout(x);
    await s.intake([{ domain: nm(0), lane: 'S3', source: 'scout' }]);
    const r = await realJob(x).runOnce();
    await x.app.screeningWorker.idle();
    await db.updateTable('screening_runs').set({ heartbeat_at: new Date(x.clock.t) }).where('id', '=', r.run_id!).execute();
    expect(await x.app.screeningWorker.resumeStalled()).toEqual({ resumed: [], finalized: [] }); // the poll rule: heartbeat fresh
    expect((await x.app.screeningWorker.resumeStalled({ atStart: true })).resumed).toEqual([r.run_id]);
    await x.app.screeningWorker.idle();
  }, 60_000);

  it('T18-3 a daily run that cannot finish is named by JOB_RUN_INCOMPLETE with its open steps (the 3.1.0 alert; covered in v3-1-0.test.ts)', async () => {
    const x = await h();
    const created = new Date(x.clock.t - 3 * HOUR);
    await db.insertInto('job_queue_runs').values({ id: 'run_stuck', job: 'daily', trigger: 'scheduled', scheduled_for: created, created_at: created }).execute();
    await db.insertInto('job_steps').values({ run_id: 'run_stuck', job: 'daily', step: 'intakeScreening', position: 0, status: 'running', max_attempts: 2, timeout_ms: 1000, started_at: created }).execute();
    const w = (await x.get('/report')).json().warnings.find((q: { code: string }) => q.code === 'JOB_RUN_INCOMPLETE');
    expect(w).toMatchObject({ level: 'error', details: { run_id: 'run_stuck', open_steps: ['intakeScreening'] } });
  });

  it('no auto rebuild while the daily job\'s own buildDailyList step is still to come (it builds then); nor for a run that is not today\'s intake run', async () => {
    const x = await h();
    const s = await scout(x);
    await s.intake([{ domain: nm(0), lane: 'S3', source: 'scout' }]);
    const res = await settleJob(x.app, 'daily', await x.post('/jobs/run', { job: 'daily' }));
    expect(res.statusCode).toBe(202);
    // one list from the daily step; the finished run did not add an auto one
    expect((await db.selectFrom('daily_candidate_lists').select('built_by').execute()).map((r) => r.built_by)).toEqual(['daily']);
    const run = await x.runDone({ mode: 'full', names: [{ domain: 'plainrun.com', lane: 'S3' }] });
    expect(run.id).toMatch(/^run_/);
    expect(await db.selectFrom('daily_candidate_lists').select('id').execute()).toHaveLength(1);
  }, 60_000);

  it('an auto rebuild does not count toward the 6 manual rebuilds a day', async () => {
    const x = await h();
    await seedRun(x, [{ domain: 'aaaone.com' }]);
    for (let i = 0; i < 3; i++) await db.insertInto('daily_candidate_lists').values({ day: today(x), built_at: new Date(x.clock.t), entries: '[]', sections: '{}', summary: '{}', built_by: 'auto' }).execute();
    const r = await rebuild(x);
    expect(r.statusCode).toBe(201);
    expect(r.json()).toMatchObject({ rebuilds_today: 1, rebuilds_left_today: 5 });
  });
});

describe('CR-018 B: summary.why', () => {
  it('T18-4 the day of 10-08: 30 screened, 27 taken, 1 form fail, 2 timeouts, 0 candidates, 35 waiting', async () => {
    const x = await h();
    const s = await scout(x);
    await s.intake(Array.from({ length: 35 }, (_, i) => ({ domain: nm(i), lane: 'S3', source: 'bulk' })));
    const names: Seed[] = [
      ...Array.from({ length: 27 }, (_, i) => ({ domain: `taken${'abcdefghijklmnopqrstuvwxyz'[i]}.com`, outcome: 'taken' as const, origin: 'intake' as const })),
      { domain: 'badform.com', outcome: 'form', origin: 'intake' }, { domain: 'slowone.com', outcome: 'timeout', origin: 'intake' }, { domain: 'slowtwo.com', outcome: 'timeout', origin: 'intake' },
    ];
    await seedRun(x, names);
    expect((await rebuild(x)).statusCode).toBe(201);
    const l = await daily(x);
    expect(l.summary).toMatchObject({ screened_today: 30, candidates_n: 0, failed_by_check: { availability: 27, form: 1 }, unknown_by_reason: { TIMEOUT: 2 }, timeout_n: 2, queued_waiting_n: 35, left_for_tomorrow_n: 35 });
    expect(l.summary.why).toBe('Screened 30 names today: 27 already taken, 1 failed the name form (S3: 1), 2 timed out, 0 passed. 35 more wait for tomorrow.');
  });

  it('T18-5 after a rebuild the why matches the current summary, not a stale string', async () => {
    const x = await h();
    await seedRun(x, [{ domain: 'takenone.com', outcome: 'taken', origin: 'intake' }]);
    await rebuild(x);
    expect((await daily(x)).summary.why).toContain('Screened 1 name today: 1 already taken, 0 passed.');
    await seedRun(x, [{ domain: 'takentwo.com', outcome: 'taken', origin: 'intake' }, { domain: 'goodone.com', origin: 'intake' }]);
    await rebuild(x);
    const l = await daily(x);
    expect(l.summary).toMatchObject({ screened_today: 3, candidates_n: 1 });
    expect(l.summary.why).toBe(buildWhy(l.summary));
    expect(l.summary.why).toContain('Screened 3 names today: 2 already taken, 1 passed.');
  });

  it('T18-6 intake empty: the why says so, and when only drop-list names were screened', async () => {
    const x = await h();
    await rebuild(x);
    expect((await daily(x)).summary.why).toBe('No names were screened today. Intake was empty: no scout names were waiting.');
    await seedRun(x, [{ domain: 'dropone.com', outcome: 'taken', origin: 'drop_list' }]);
    await rebuild(x);
    expect((await daily(x)).summary.why).toBe('Screened 1 name today: 1 already taken, 0 passed. No scout names came in, so only drop-list names were screened.');
  });

  it('the why also names waiting records, dropping names, NO_KEPT_LANE names, and a screening that is still running', () => {
    const why = buildWhy({
      screened_today: 4, candidates_n: 1, failed_by_check: { availability: 1, history: 2 }, unknown_by_reason: { SOURCE_ERROR: 1 }, waiting_for_records: 2, dropping_n: 3, no_kept_lane_n: 5,
      scout_screened_n: 4, queued_waiting_n: 0, left_for_tomorrow_n: 0, partial: true, timeout_retry: { resolved: 2 },
    });
    expect(why).toBe('Screened 4 names today: 1 already taken, 2 failed the history check, 1 could not be checked, 1 passed. 2 names wait for records. 3 names on the drop lists are still dropping and will be screened only if free after the drop. 5 names from the drop lists were skipped because they fit no kept lane. 2 lookups that timed out cleared on a retry. Screening is still running, so this may change.');
  });
});

describe('CR-019 C: intake fixes', () => {
  it('T19-1 C-1 drop-list names that fail the shape are removed at upload with the reason, never get a check, and are not screened', async () => {
    const x = await h();
    const s = await scout(x);
    const up = await s.call('POST', '/selection/drop-lists', { name: 'shape-1', list_date: today(x), domains: ['qxz9.com', 'hyphen-name.com', 'oneword.net', 'tampaplumbing.com'] });
    expect(up.statusCode, up.body).toBe(201);
    expect(up.json().removed).toMatchObject({ HAS_DIGIT: 1, HAS_HYPHEN: 1, DOMAIN_INVALID: 1 });
    const got = (await x.get('/selection/drop-lists/shape-1')).json();
    expect(got.rows.filter((r: { kept: boolean }) => !r.kept).map((r: { reason: string }) => r.reason).sort()).toEqual(['DOMAIN_INVALID', 'HAS_DIGIT', 'HAS_HYPHEN']);
    // a removed name that nevertheless has a check row (old data) is never screened and never counted in screened_today
    await db.insertInto('drop_list_rows').values({ list_name: 'shape-1', domain: 'abc9.com', kept: false, reason: 'HAS_DIGIT', tokens: null }).execute();
    await db.insertInto('drop_list_checks').values([{ list_name: 'shape-1', domain: 'abc9.com', checked_at: new Date(x.clock.t), status: 'not_registered', last_changed: null, expected_drop_date: null, drop_date_source: null, reason_code: null }]).execute();
    const r = await realJob(x).runOnce();
    expect(r).toMatchObject({ skipped: true, reason: 'NO_NAMES' });
    expect((await rebuild(x)).statusCode).toBe(201);
    expect((await daily(x)).summary.screened_today).toBe(0);
  });

  it('T19-2 C-2 a timed-out availability lookup is retried at the end of the run (30 s apart, twice at most); the summary shows resolved and still-TIMEOUT with try counts', async () => {
    const calls = new Map<string, number>();
    const sleeps: number[] = [];
    const x = await h({
      screening: {
        sleep: async (ms: number) => { sleeps.push(ms); },
        rdapLookup: async (domain: string) => {
          const n = (calls.get(domain) ?? 0) + 1;
          calls.set(domain, n);
          if (domain === 'flakyname.com') return n < 2 ? T_TIMEOUT() : T_FREE(); // times out once, then answers
          if (domain === 'deadname.com') return T_TIMEOUT(); // never answers
          return T_FREE();
        },
      },
    });
    const run = await x.runDone({ mode: 'full', names: [{ domain: 'flakyname.com', lane: 'S3' }, { domain: 'deadname.com', lane: 'S3' }, { domain: 'steadyname.com', lane: 'S3' }] });
    expect(run.body.status === 'done' || run.body.status === 'partial').toBe(true);
    const rows = await db.selectFrom('screening_results').select(['domain', 'status', 'reason_code', 'inputs']).where('run_id', '=', run.id).where('check_id', '=', 'availability').orderBy('id').execute();
    const by = (d: string) => rows.filter((r) => r.domain === d).map((r) => `${r.status}:${r.reason_code ?? ''}`);
    expect(by('flakyname.com')).toEqual(['UNKNOWN:TIMEOUT', 'PASS:']);
    expect(by('deadname.com')).toEqual(['UNKNOWN:TIMEOUT', 'UNKNOWN:TIMEOUT', 'UNKNOWN:TIMEOUT']);
    expect(by('steadyname.com')).toEqual(['PASS:']);
    expect(sleeps.filter((m) => m === 30_000)).toHaveLength(2); // one wait per round, two rounds
    expect(calls.get('deadname.com')).toBe(3);
    await db.insertInto('candidate_screenings').values([{ intake_id: null, domain: 'flakyname.com', origin: 'intake', run_id: run.id, day: today(x) }]).execute();
    await rebuild(x);
    expect((await daily(x)).summary.timeout_retry).toEqual({ timed_out_first: 2, resolved: 1, still_timeout: 1, tries: { '2': 1, '3': 1 } });
  }, 60_000);

  it('T19-2 a retry that cannot fit before the run\'s deadline is not made', async () => {
    const calls = new Map<string, number>();
    const ref: { x?: ScreeningHarness } = {};
    // the run's whole budget is one minute and the lookup itself takes 40 s of it: the 30 s wait for a retry does not fit
    const x = await h({ screening: { rdapLookup: async (d: string) => { calls.set(d, (calls.get(d) ?? 0) + 1); ref.x!.clock.t += 40_000; return T_TIMEOUT(); } } });
    ref.x = x;
    await patchActiveSettings(['run', 'time_budget_minutes'], 1);
    const run = await x.runDone({ mode: 'full', names: [{ domain: 'deadname.com', lane: 'S3' }] });
    expect(calls.get('deadname.com')).toBe(1);
    expect(run.id).toMatch(/^run_/);
  }, 60_000);

  it('T19-3 C-3 a pending delete / redemption name is "dropping", not taken; it is not screened', async () => {
    const x = await h();
    await lanes();
    await dropList(x, 'dl-pd', [{ domain: 'phoenixroofing.com', checks: [['pending_delete', ymd(x, 3)]] }, { domain: 'austinplumbing.com', checks: [['redemption', ymd(x, 20)]] }]);
    const r = await realJob(x).runOnce();
    expect(r).toMatchObject({ skipped: true, reason: 'NO_NAMES', dropping: 2 });
    // a name that was screened earlier as registered and is pending delete now: counted dropping, not under failed_by_check.availability
    await seedRun(x, [{ domain: 'phoenixroofing.com', outcome: 'taken', origin: 'drop_list' }]);
    await rebuild(x);
    const l = await daily(x);
    expect(l.summary.failed_by_check.availability).toBeUndefined();
    expect(l.summary).toMatchObject({ dropping_n: 2, screened_today: 1 });
    expect(l.summary.dropping).toEqual([
      { domain: 'phoenixroofing.com', status: 'pending_delete', expected_drop_date: ymd(x, 3), list_name: 'dl-pd' },
      { domain: 'austinplumbing.com', status: 'redemption', expected_drop_date: ymd(x, 20), list_name: 'dl-pd' },
    ]);
    expect(l.summary.why).toContain('2 names on the drop lists are still dropping');
  });

  it('T19-12 C-4 dropWatch re-checks a name from its expected drop date for 7 days; free after the drop, it is a leftover and the next intake screens it (origin drop_list)', async () => {
    const x = await h();
    await lanes();
    await dropList(x, 'dl-lo', [{ domain: 'phoenixroofing.com', checks: [['pending_delete', ymd(x, 0)]] }], 1);
    const watch = await app!.dropWatchJob.runOnce();
    expect(watch).toMatchObject({ checked: 1, not_registered: 1, rechecked: 1 });
    const checks = await db.selectFrom('drop_list_checks').select(['status', 'expected_drop_date']).orderBy('id').execute();
    expect(checks.map((c) => c.status)).toEqual(['pending_delete', 'not_registered']);
    const r = await realJob(x).runOnce();
    expect(r).toMatchObject({ screened: 1, from_drop_lists: 1, from_intake: 0, leftovers: 1 });
    const run = await db.selectFrom('screening_runs').select('input').where('id', '=', r.run_id!).executeTakeFirstOrThrow();
    expect((run.input as { names: { domain: string; lane: string }[] }).names.map((n) => [n.domain, n.lane])).toEqual([['phoenixroofing.com', 'S2']]);
    expect((await db.selectFrom('candidate_screenings').select(['domain', 'origin']).execute())).toEqual([{ domain: 'phoenixroofing.com', origin: 'drop_list' }]);
    await x.app.screeningWorker.idle();
    // not screened again within 7 days
    x.clock.t += DAY;
    expect(await realJob(x).runOnce()).toMatchObject({ skipped: true, reason: 'NO_NAMES' });
    // the daily entry says where the name came from
    await seedRun(x, [{ domain: 'austinroofing.com', origin: 'drop_list' }]);
    await rebuild(x);
    const e = (await daily(x)).entries.find((q: { domain: string }) => q.domain === 'austinroofing.com');
    expect(e).toMatchObject({ origin: 'drop_list' });
  }, 60_000);

  it('dropWatch asks a name once a day, only from its expected drop date for 7 days, and not after it was seen registered again', async () => {
    let answer: RdapLookup = T_FREE();
    const asked: string[] = [];
    const x = await h({ screening: { rdapLookup: async (d: string) => { asked.push(d); return answer; } } });
    await dropList(x, 'dl-w', [
      { domain: 'earlyname.com', checks: [['pending_delete', ymd(x, 5)]] }, { domain: 'liveone.com', checks: [['pending_delete', ymd(x, -1)]] }, { domain: 'oldname.com', checks: [['pending_delete', ymd(x, -9)], ['not_registered', null]] },
    ], 1);
    await app!.dropWatchJob.runOnce();
    expect(asked).toEqual(['liveone.com']); // early: before its date; old: past the 7 days
    asked.length = 0;
    await app!.dropWatchJob.runOnce();
    expect(asked).toEqual([]); // once per IDT day
    // re-registered after the drop: taken, never a leftover, and asked no more
    answer = T_TAKEN();
    x.clock.t += DAY;
    await app!.dropWatchJob.runOnce();
    expect(asked).toEqual(['liveone.com']);
    expect((await db.selectFrom('drop_list_checks').select('status').where('domain', '=', 'liveone.com').orderBy('id').execute()).map((c) => c.status)).toEqual(['pending_delete', 'not_registered', 'registered']);
    asked.length = 0;
    x.clock.t += DAY;
    await app!.dropWatchJob.runOnce();
    expect(asked).toEqual([]);
  });

  it('T19-13 a name re-registered at the drop is not a leftover (taken); a name still in pending delete is dropping', async () => {
    const x = await h();
    await lanes();
    await dropList(x, 'dl-13', [
      { domain: 'phoenixroofing.com', checks: [['pending_delete', ymd(x, -1)], ['registered', null]] }, { domain: 'austinroofing.com', checks: [['pending_delete', ymd(x, 2)]] },
    ]);
    expect(await realJob(x).runOnce()).toMatchObject({ skipped: true, reason: 'NO_NAMES', leftovers: 0, dropping: 1 });
    await rebuild(x);
    expect((await daily(x)).summary).toMatchObject({ leftovers_n: 0, dropping_n: 1, screened_today: 0 });
  });

  it('T19-14 a list with both already-dropped free names and pending-delete names: only the free ones are screened, and the summary counts both kinds', async () => {
    const x = await h();
    await lanes();
    await dropList(x, 'dl-14', [
      leftover(x, 'phoenixroofing'.concat('.com')), leftover(x, 'austinroofing.com'), { domain: 'dallasroofing.com', checks: [['pending_delete', ymd(x, 4)]] }, { domain: 'denverplumbing.com', checks: [['redemption', ymd(x, 30)]] }, { domain: 'bostonroofing.com', checks: [['pending_delete', ymd(x, 1)]] },
    ]);
    const r = await realJob(x).runOnce();
    expect(r).toMatchObject({ screened: 2, from_drop_lists: 2, leftovers: 2, dropping: 3 });
    await x.app.screeningWorker.idle();
    await rebuild(x);
    expect((await daily(x)).summary).toMatchObject({ leftovers_n: 2, dropping_n: 3, drop_list_screened_n: 2 });
  }, 60_000);

  it('T19-15 a leftover goes through the same /buy dry-run path as any other candidate (no separate route)', async () => {
    const pb = new FakeAdapter('porkbun');
    const x = await h({ adapters: [pb], rdap: async () => 'not_registered' });
    await lanes();
    const auth = (await issueToken('write')).auth;
    await dropList(x, 'dl-15', [leftover(x, 'phoenixroofing.com')]);
    const s = await scout(x);
    await s.intake([{ domain: 'austinplumbing.com', lane: 'S3', source: 'scout' }]);
    await realJob(x).runOnce();
    await x.app.screeningWorker.idle();
    expect((await db.selectFrom('candidate_screenings').select(['domain', 'origin']).orderBy('id').execute()).map((r) => `${r.domain}:${r.origin}`)).toEqual(['austinplumbing.com:intake', 'phoenixroofing.com:drop_list']);
    const dry = async (domain: string) => (await postBuy(x.app, { ...buyBody({ domain, dry_run: true }), approval_ref: { text: `yes buy ${domain} up to $11.50`, approved_at: new Date(x.clock.t - HOUR).toISOString() } }, auth, undefined, { ready: false }));
    const a = await dry('austinplumbing.com');
    const b = await dry('phoenixroofing.com');
    expect([a.statusCode, b.statusCode]).toEqual([200, 200]);
    expect(b.json()).toMatchObject({ dry_run: true });
    expect(b.json().would_be_blocked).toEqual(a.json().would_be_blocked);
    void DOMAIN;
  }, 60_000);
});
