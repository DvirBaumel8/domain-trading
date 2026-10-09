// v3.3.0 part A: CR-021 (POST /candidates/screen, run links), CR-022 (A words, B bt1@v3 intake split, F-2 schema-check body), CR-023 (E rejected + run ids, F /openapi.json, G drop-feed stale settings).
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { http } from 'msw';
import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { INTAKE_DAILY_MAX, IntakeScreeningJob } from '../../../src/modules/candidates/intake.js';
import { GATE_OF } from '../../../src/modules/selection/checks/index.js';
import { planFor } from '../../../src/modules/selection/engine.js';
import { splitV2OfDomain } from '../../../src/modules/selection/split-v2.js';
import { KNOWN_METHODS } from '../../../src/modules/selection/siblings.js';
import { buildWhy } from '../../../src/modules/candidates/daily-list.js';
import { testDb as db } from '../../helpers/db.js';
import { patchActiveSettings, screeningHarness, type ScreeningHarness } from '../../helpers/screening.js';
import { fixture, respond } from '../../helpers/screening-fixtures.js';
import { issueToken } from '../../helpers/tokens.js';
import { b64, makePng, textChunk } from '../../helpers/images.js';
import { introspectionAnswer } from '../../helpers/buffer-schema.js';
import { mswServer } from '../../setup/network.js';
import { seedDailyRun } from '../../helpers/db.js';
import type { RdapLookup } from '../../../src/core/rdap.js';

let app: FastifyInstance | undefined;
afterEach(async () => app?.close());
const HOUR = 3_600_000;
const DAY = 86_400_000;
const T_FREE = (): RdapLookup => ({ outcome: 'not_registered', reasonCode: null, httpStatus: 404, url: 'https://rdap.example/domain/x', retrievedAt: new Date(), body: null, facts: null });
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
const PREFIX = ['super', 'mega', 'smart', 'quick', 'prime'];
const SUFFIX = ['pro', 'box', 'tech', 'lab', 'hub', 'works', 'group', 'house'];
const nm = (i: number) => `${PREFIX[Math.floor(i / SUFFIX.length)]}${SUFFIX[i % SUFFIX.length]}.com`;
const intakeN = async (x: ScreeningHarness, from: number, n: number) => (await scout(x)).intake(Array.from({ length: n }, (_, k) => ({ domain: nm(from + k), lane: 'S3', source: 'scout' })));

/** A write call with a chosen Idempotency-Key. */
async function writer(x: ScreeningHarness, name = 'gavriel-screen') {
  const w = await issueToken('write', name);
  return (url: string, payload?: object, key: string = randomUUID()) => (x.clock.t += 7_000, x.app.inject({ method: 'POST', url, headers: { ...w.auth, 'idempotency-key': key }, ...(payload !== undefined && { payload }) }));
}
const settle = async (x: ScreeningHarness) => { await x.app.jobQueue.idle(); await x.app.screeningWorker.idle(); await x.app.jobQueue.idle(); };
const daily = async (x: ScreeningHarness) => (await x.get('/candidates/daily?limit=25')).json();
const everyRow = (l: any) => [...l.entries, ...l.sections.almost_ready, ...l.sections.upcoming]; // eslint-disable-line @typescript-eslint/no-explicit-any

/** A finished full-plan run with seeded results; `fails` makes a name fail one check. Also the candidate_screenings row when `origin` is given. */
type Fail = { check: string; code: string; reason?: string; fields?: Record<string, unknown> };
async function seedRun(x: ScreeningHarness, names: { domain: string; lane?: string; fail?: Fail; onDemand?: boolean; tier?: Record<string, unknown> }[], o: { ageHours?: number; origin?: boolean; records?: boolean } = {}): Promise<string> {
  const sel = await db.selectFrom('selection_settings').select(['id', 'label', 'values']).where('label', '=', 'v1').executeTakeFirstOrThrow();
  const id = `run_${randomUUID()}`;
  const plan = planFor(sel.values as never, 'S3');
  const created = new Date(x.clock.t - (o.ageHours ?? 1) * HOUR);
  await db.insertInto('screening_runs').values({
    id, created_at: created, created_by: 'intakeScreening', mode: 'full', backtest: false, settings_id: sel.id, settings_label: 'v1', buy_hold: true, tranche_id: null,
    input: JSON.stringify({ names: names.map((n, idx) => ({ idx, domain: n.domain, lane: n.lane ?? 'S3', leads_ab: 0 })) }),
    gate_plan: JSON.stringify({ S3: plan, S4: plan, S6: plan }), list_versions: '{}', status: 'done', deadline_at: new Date(x.clock.t + HOUR), finished_at: created,
  }).execute();
  for (const [idx, n] of names.entries()) {
    for (const check of plan) {
      const failing = n.fail?.check === check;
      let fields: Record<string, unknown> = {};
      if (check === 'price') fields = { bin_cents: 148800, ratio_at_bin: 3, ratio_at_floor: 2, score_0_100: 50, floor_cents: 96700, ev_cents: 301, P_sale: 0.1, p_passive: 0.01 };
      if (check === 'quote') fields = { registrar: 'porkbun', first_year_cents: 1108, renewal_cents: 1208, quoted_at: new Date(x.clock.t - HOUR).toISOString() };
      if (check === 'tier') fields = { tier: 'A', tier_exact: true, fired: 'A', ...n.tier };
      if (failing) fields = n.fail!.fields ?? {};
      await db.insertInto('screening_results').values({
        run_id: id, item_idx: idx, domain: n.domain, lane: (n.lane ?? 'S3') as never, check_id: check, gate: GATE_OF[check as keyof typeof GATE_OF], rule_ids: ['X'], status: failing ? 'FAIL' : 'PASS', reason_code: failing ? n.fail!.code : null,
        reason: failing ? (n.fail!.reason ?? 'seeded') : null, fields: JSON.stringify(fields), checked_at: created, settings_label: 'v1', list_versions: '{}', duration_ms: 0, upstream_calls: 0, source: 'auto',
      }).execute();
    }
    if (!n.fail && o.records !== false) {
      for (const kind of ['tm_us', 'history'] as const) {
        await db.insertInto('domain_records').values({ domain: n.domain, kind, record: JSON.stringify({ seeded: true }), checked_by: 'gavriel', checked_at: new Date(x.clock.t - 2 * HOUR), created_by: 'gavriel' }).execute();
      }
    }
    if (o.origin) await db.insertInto('candidate_screenings').values({ intake_id: null, domain: n.domain, origin: 'intake', run_id: id, day: today(x), at: created, on_demand: n.onDemand ?? false }).execute();
  }
  return id;
}

describe('CR-021 POST /candidates/screen', () => {
  it('T21-1 T21-5 T21-6 screens the waiting names (own run, steps onDemandScreen + buildDailyList), rebuilds the list the same day, shows on /jobs/runs, uses no outside review', async () => {
    const x = await h({ screening: { rdapLookup: async () => T_TAKEN() } });
    await intakeN(x, 0, 3);
    const post = await writer(x);
    const before = await db.selectFrom('review_packets').select('id').execute();
    const r = await post('/candidates/screen', {});
    expect(r.statusCode, r.body).toBe(202);
    const j = r.json();
    expect(j).toMatchObject({ names_n: 3, allowance: { daily_max: 30, used_today: 3, remaining: 27 } });
    expect(j.run_id).toMatch(/^run_/);
    await settle(x);
    const l = await daily(x);
    const seen = new Set([...everyRow(l), ...l.summary.rejected].map((e: any) => e.domain)); // eslint-disable-line @typescript-eslint/no-explicit-any
    expect([...seen].sort()).toEqual([nm(0), nm(1), nm(2)].sort());
    expect(l.summary.screened_today).toBe(3);
    const runs = (await x.get('/jobs/runs?job=screen')).json().runs;
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ run_id: j.run_id, job: 'screen', trigger: 'manual', triggered_by: 'gavriel-screen', status: 'finished', ok: true });
    expect(Object.keys(runs[0].steps)).toEqual(['onDemandScreen', 'buildDailyList']);
    expect(runs[0].steps.onDemandScreen.summary).toMatchObject({ screened: 3, from_intake: 3, on_demand: true, allowance: { daily_max: 30, used_today: 3, remaining: 27 } });
    expect(runs[0].steps.buildDailyList.summary).toMatchObject({ day: today(x) });
    expect(await db.selectFrom('review_packets').select('id').execute()).toEqual(before); // T21-6: no outside review packet, attempt or retry
    expect(await db.selectFrom('review_retries').select('day').execute()).toEqual([]);
    expect((await db.selectFrom('candidate_screenings').select('on_demand').execute()).every((c) => c.on_demand)).toBe(true);
    // the daily list built by the screen job is 'auto' (does not count toward the 6 manual rebuilds)
    expect((await db.selectFrom('daily_candidate_lists').select('built_by').execute()).map((q) => q.built_by)).toContain('auto');
  }, 60_000);

  it('max_names caps one run (oldest first); the allowance is its own setting and the rest stays queued', async () => {
    const x = await h();
    await intakeN(x, 0, 4);
    const post = await writer(x);
    const r = await post('/candidates/screen', { max_names: 2 });
    expect(r.json()).toMatchObject({ names_n: 2, allowance: { used_today: 2, remaining: 28 } });
    await settle(x);
    expect((await db.selectFrom('candidate_screenings').select('domain').orderBy('id').execute()).map((c) => c.domain)).toEqual([nm(0), nm(1)]);
    expect((await post('/candidates/screen', { max_names: 0 })).statusCode).toBe(422);
    expect((await post('/candidates/screen', { whatever: 1 })).statusCode).toBe(422);
  }, 60_000);

  it('T21-2 the daily run and the on-demand allowance do not eat each other: 30 daily names leave the on-demand allowance whole; 30 on-demand names leave the daily run its 30', async () => {
    const x = await h();
    const s = await scout(x);
    // 30 names the scheduled run screened today
    await seedRun(x, Array.from({ length: INTAKE_DAILY_MAX }, (_, i) => ({ domain: `daily${i}.com` })), { origin: true });
    await s.intake([0, 1, 2, 3].map((i) => ({ domain: nm(i), lane: 'S3', source: 'scout' })));
    expect(await realJob(x).runOnce()).toMatchObject({ skipped: true, reason: 'DAILY_MAX_REACHED', queued_before: 4 });
    await patchActiveSettings(['intake'], { drop_list_max_share: 1, on_demand_screen_daily_max: 3 });
    const post = await writer(x);
    const r = await post('/candidates/screen', {});
    expect(r.statusCode, r.body).toBe(202);
    expect(r.json()).toMatchObject({ names_n: 3, allowance: { daily_max: 3, used_today: 3, remaining: 0 } });
    await settle(x);
  }, 60_000);

  it('T21-2b 30 on-demand names today: the daily run still screens (its quota is untouched)', async () => {
    const x = await h();
    const s = await scout(x);
    await seedRun(x, Array.from({ length: 30 }, (_, i) => ({ domain: `od${i}.com`, onDemand: true })), { origin: true });
    await s.intake([0, 1].map((i) => ({ domain: nm(i), lane: 'S3', source: 'scout' })));
    const r = await realJob(x).runOnce();
    expect(r).toMatchObject({ screened: 2, from_intake: 2 });
    expect(r.skipped).toBeUndefined();
    await x.app.screeningWorker.idle();
    const post = await writer(x);
    const cap = await post('/candidates/screen', {});
    expect(cap.statusCode).toBe(409); // 30 of 30 on-demand names used
  }, 60_000);

  it('T21-3 the same Idempotency-Key replays the first answer: one run, no more names, no more allowance', async () => {
    const x = await h();
    await intakeN(x, 0, 2);
    const post = await writer(x);
    const key = randomUUID();
    const a = await post('/candidates/screen', {}, key);
    const b = await post('/candidates/screen', {}, key);
    expect(a.statusCode).toBe(202);
    expect([b.statusCode, b.json(), b.headers['idempotent-replayed']]).toEqual([202, a.json(), 'true']);
    await settle(x);
    expect(await db.selectFrom('job_queue_runs').select('id').where('job', '=', 'screen').execute()).toHaveLength(1);
    expect(await db.selectFrom('candidate_screenings').select('id').execute()).toHaveLength(2);
  }, 60_000);

  it('T21-4 allowance used up: 409 ON_DEMAND_SCREEN_CAP with next_allowed_at, nothing screened, no run; and it does not count names that were not screened', async () => {
    const x = await h();
    await patchActiveSettings(['intake'], { drop_list_max_share: 1, on_demand_screen_daily_max: 2 });
    await seedRun(x, [{ domain: 'od1.com', onDemand: true }, { domain: 'od2.com', onDemand: true }], { origin: true });
    await intakeN(x, 0, 2);
    const post = await writer(x);
    const r = await post('/candidates/screen', {});
    expect(r.statusCode).toBe(409);
    expect(r.json().error).toMatchObject({ code: 'ON_DEMAND_SCREEN_CAP', details: { daily_max: 2, used_today: 2, remaining: 0, next_allowed_at: expect.stringMatching(/T00:00:00\+0[23]:00$/) } });
    expect(await db.selectFrom('job_queue_runs').select('id').execute()).toEqual([]);
    expect(await db.selectFrom('candidate_screenings').select('id').execute()).toHaveLength(2);
    // tomorrow the allowance is whole again
    x.clock.t += DAY;
    expect((await post('/candidates/screen', {})).statusCode).toBe(202);
    await settle(x);
  }, 60_000);

  it('nothing waiting: 200 NO_NAMES, no run, no allowance used, the list is rebuilt', async () => {
    const x = await h();
    const post = await writer(x);
    const r = await post('/candidates/screen');
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ run_id: null, names_n: 0, skipped: 'NO_NAMES', allowance: { daily_max: 30, used_today: 0, remaining: 30 } });
    expect(await db.selectFrom('job_queue_runs').select('id').execute()).toEqual([]);
    expect((await db.selectFrom('daily_candidate_lists').select('built_by').execute()).map((q) => q.built_by)).toEqual(['auto']);
    expect((await daily(x)).summary.why).toContain('No names were screened today');
  });

  it('409 ALREADY_RUNNING while a daily run or a screen run is open (details.run_id), nothing queued', async () => {
    const x = await h();
    await intakeN(x, 0, 2);
    const post = await writer(x);
    for (const job of ['daily', 'screen'] as const) {
      const id = `run_${randomUUID()}`;
      await db.insertInto('job_queue_runs').values({ id, job, trigger: 'manual' } as never).execute();
      await db.insertInto('job_steps').values({ run_id: id, job, step: 'x', position: 0, max_attempts: 1, timeout_ms: 1000 }).execute();
      const r = await post('/candidates/screen', {});
      expect([r.statusCode, r.json().error.code, r.json().error.details.run_id]).toEqual([409, 'ALREADY_RUNNING', id]);
      await db.updateTable('job_steps').set({ status: 'skipped' }).where('run_id', '=', id).execute();
    }
    expect(await db.selectFrom('candidate_screenings').select('id').execute()).toEqual([]);
  });

  it('only a WRITE token calls it (READ and intake tokens are refused)', async () => {
    const x = await h();
    const s = await scout(x);
    expect((await s.call('POST', '/candidates/screen', {})).statusCode).toBe(403);
    const r = await issueToken('read');
    expect((await x.app.inject({ method: 'POST', url: '/candidates/screen', headers: { ...r.auth, 'idempotency-key': randomUUID() }, payload: {} })).statusCode).toBe(403);
  });

  it('T21-7 T21-8 T21-9 every row carries the run that screened it; a later scheduled run keeps earlier on-demand links; a rebuild changes none; summary lists the runs', async () => {
    const x = await h({ screening: { rdapLookup: async () => T_TAKEN() } });
    await intakeN(x, 0, 2);
    const post = await writer(x);
    const queued = (await post('/candidates/screen', { max_names: 1 })).json();
    await settle(x);
    // the list rows name the SCREENING run, which is steps.onDemandScreen.summary.run_id of the queue run on /jobs/runs
    const jr = (await x.get('/jobs/runs?job=screen')).json().runs.find((r: any) => r.run_id === queued.run_id); // eslint-disable-line @typescript-eslint/no-explicit-any
    const od = { run_id: jr.steps.onDemandScreen.summary.run_id as string };
    const first = await daily(x);
    const rowOf = (l: any, d: string) => [...everyRow(l), ...l.summary.rejected].find((e: any) => e.domain === d); // eslint-disable-line @typescript-eslint/no-explicit-any
    expect(rowOf(first, nm(0)).run_id).toBe(od.run_id); // T21-7
    expect(first.summary.screening_run_ids).toEqual([(await db.selectFrom('candidate_screenings').select('run_id').orderBy('id').executeTakeFirstOrThrow()).run_id]);
    expect(first.summary.screening_run_id).toBe(first.summary.screening_run_ids[0]);
    const sched = await realJob(x).runOnce(); // the scheduled run takes the rest
    expect(sched).toMatchObject({ screened: 1, from_intake: 1 });
    await x.app.screeningWorker.idle();
    const w = await issueToken('write');
    await x.app.inject({ method: 'POST', url: '/candidates/daily/rebuild', headers: { ...w.auth, 'idempotency-key': randomUUID() }, payload: {} });
    const second = await daily(x);
    expect(rowOf(second, nm(0)).run_id).toBe(od.run_id); // T21-8: the on-demand name keeps its run
    expect(rowOf(second, nm(1)).run_id).toBe(sched.run_id);
    expect(second.summary.screening_run_ids).toEqual([od.run_id, sched.run_id]);
    expect(second.summary.screening_run_id).toBe(sched.run_id); // the scheduled intake run
    await x.app.inject({ method: 'POST', url: '/candidates/daily/rebuild', headers: { ...w.auth, 'idempotency-key': randomUUID() }, payload: {} });
    const third = await daily(x);
    expect([nm(0), nm(1)].map((d) => rowOf(third, d).run_id)).toEqual([od.run_id, sched.run_id]); // T21-9
  }, 60_000);

  it('T21-10 the settings key is shipped at its default 30 and the active version is untouched', async () => {
    const x = await h();
    const g = (await x.get('/selection/settings')).json();
    expect(g.active.values.intake).toEqual({ drop_list_max_share: 1, on_demand_screen_daily_max: 30, drop_feed_stale_days: 7, drop_feed_stale_level: 'info' });
    expect(g.active.label).toBe('v1');
    // the stored row has no new key: reading gives the default, the row itself is not changed
    const row = await db.selectFrom('selection_settings').select('values').where('label', '=', 'v1').executeTakeFirstOrThrow();
    expect('intake' in (row.values as object)).toBe(false);
  });
});
