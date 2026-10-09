// v3.3.0 part A: CR-021 (POST /candidates/screen, run links), CR-022 (A words, B bt1@v3 intake split, F-2 schema-check body), CR-023 (E rejected + run ids, F /openapi.json, G drop-feed stale settings).
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { http } from 'msw';
import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { INTAKE_DAILY_MAX, IntakeScreeningJob } from '../../src/modules/candidates/intake.js';
import { GATE_OF } from '../../src/modules/selection/checks/index.js';
import { planFor } from '../../src/modules/selection/engine.js';
import { splitV2OfDomain } from '../../src/modules/selection/split-v2.js';
import { KNOWN_METHODS } from '../../src/modules/selection/siblings.js';
import { buildWhy } from '../../src/modules/candidates/daily-list.js';
import { testDb as db } from '../helpers/db.js';
import { patchActiveSettings, screeningHarness, type ScreeningHarness } from '../helpers/screening.js';
import { fixture, respond } from '../helpers/screening-fixtures.js';
import { issueToken } from '../helpers/tokens.js';
import { b64, makePng, textChunk } from '../helpers/images.js';
import { introspectionAnswer } from '../helpers/buffer-schema.js';
import { mswServer } from '../setup/network.js';
import { seedDailyRun } from '../helpers/db.js';
import type { RdapLookup } from '../../src/core/rdap.js';

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

describe('CR-022 A/B: scout words and the bt1@v3 intake split', () => {
  it('T22-1 T22-2 words make ukcbamcompliance.com and aievalsconsulting.com acceptable; stored, audited, shown on the list entry', async () => {
    const x = await h();
    const s = await scout(x);
    const r = await s.intake([
      { domain: 'ukcbamcompliance.com', lane: 'S6', source: 'scout', words: ['uk', 'cbam', 'compliance'] },
      { domain: 'aievalsconsulting.com', lane: 'S3', source: 'scout', words: ['ai', 'evals', 'consulting'] },
    ]);
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json()).toEqual({ accepted: [{ domain: 'ukcbamcompliance.com', intake_id: expect.any(Number) }, { domain: 'aievalsconsulting.com', intake_id: expect.any(Number) }], duplicates: [], removed: [] });
    expect((await db.selectFrom('candidate_intake').select(['domain', 'words']).orderBy('id').execute())).toEqual([
      { domain: 'ukcbamcompliance.com', words: ['uk', 'cbam', 'compliance'] }, { domain: 'aievalsconsulting.com', words: ['ai', 'evals', 'consulting'] }]);
    const audit = await db.selectFrom('audit_log').select(['request', 'result_summary']).where('path', '=', '/candidates/intake').executeTakeFirstOrThrow();
    expect(JSON.stringify(audit.request)).toContain('"words":["uk","cbam","compliance"]');
    expect(audit.result_summary).toContain('ukcbamcompliance.com');
    // screened under the scout's words (the census split follows them); the list shows words + split_source
    const job = await realJob(x).runOnce();
    await x.app.screeningWorker.idle();
    const run = await db.selectFrom('screening_runs').select('input').where('id', '=', job.run_id!).executeTakeFirstOrThrow();
    expect((run.input as any).names.map((n: any) => [n.domain, n.words])).toEqual([['ukcbamcompliance.com', ['uk', 'cbam', 'compliance']], ['aievalsconsulting.com', ['ai', 'evals', 'consulting']]]); // eslint-disable-line @typescript-eslint/no-explicit-any
  }, 60_000);

  it('T22-1 T22-2 the list entry shows the scout\'s words and split_source scout (a passing name); a name without words shows the bt1@v3 split and dictionary', async () => {
    const x = await h();
    const s = await scout(x);
    await s.intake([
      { domain: 'ukcbamcompliance.com', lane: 'S6', source: 'scout', words: ['uk', 'cbam', 'compliance'] },
      { domain: 'superpro.com', lane: 'S3', source: 'scout' },
    ]);
    await seedRun(x, [{ domain: 'ukcbamcompliance.com' }, { domain: 'superpro.com' }]);
    const w = await issueToken('write');
    await x.app.inject({ method: 'POST', url: '/candidates/daily/rebuild', headers: { ...w.auth, 'idempotency-key': randomUUID() }, payload: {} });
    const l = await daily(x);
    const byDomain = Object.fromEntries(l.entries.map((e: any) => [e.domain, e])); // eslint-disable-line @typescript-eslint/no-explicit-any
    expect(byDomain['ukcbamcompliance.com']).toMatchObject({ words: ['uk', 'cbam', 'compliance'], split_source: 'scout' });
    expect(byDomain['superpro.com']).toMatchObject({ words: ['super', 'pro'], split_source: 'dictionary' });
    expect(byDomain['superpro.com']).toMatchObject({ sellers: null, sellers_verified_n: null }); // CR-023 B fields on every row
  }, 60_000);

  it('T22-8b the census sibling split of a name with scout words uses those words (sibling_tokens), not the dictionary split', async () => {
    const x = await h();
    await db.insertInto('sibling_method_approvals').values({ method: 'bt1@v3', pools_sha256: KNOWN_METHODS['bt1@v3']!.sha256, approval_text: 'seeded in a test', approval_at: new Date(x.clock.t - HOUR) }).execute();
    const s = await scout(x);
    await s.intake([{ domain: 'ukcbamcompliance.com', lane: 'S6', source: 'scout', words: ['uk', 'cbam', 'compliance'] }]);
    const job = await realJob(x).runOnce();
    expect(job.census_list).toBe('bt1@v3');
    await x.app.screeningWorker.idle();
    const c = await db.selectFrom('screening_results').select(['status', 'fields']).where('run_id', '=', job.run_id!).where('check_id', '=', 'census').executeTakeFirstOrThrow();
    expect((c.fields as any).sibling_tokens).toEqual(['uk', 'cbam', 'compliance']); // eslint-disable-line @typescript-eslint/no-explicit-any
  }, 60_000);

  it('CR-023 B the list entry shows the newest intake sellers list and sellers_verified_n from the tier check\'s sellers block', async () => {
    const x = await h();
    const s = await scout(x);
    const list = [{ name: 'Acme Roofing', url: 'https://acme-roofing.example/drones' }];
    const r = await s.intake([{ domain: 'superpro.com', lane: 'S3', source: 'scout', sellers: list }]);
    expect(r.statusCode, r.body).toBe(200);
    await seedRun(x, [{ domain: 'superpro.com', tier: { sellers: { source: 'intake', verified_n: 2, entries: [] } } }]);
    const w = await issueToken('write');
    await x.app.inject({ method: 'POST', url: '/candidates/daily/rebuild', headers: { ...w.auth, 'idempotency-key': randomUUID() }, payload: {} });
    const e = (await daily(x)).entries.find((q: any) => q.domain === 'superpro.com'); // eslint-disable-line @typescript-eslint/no-explicit-any
    expect(e).toMatchObject({ sellers: list, sellers_verified_n: 2 });
  });

  it('T22-3 words that do not join to the name are 422 VALIDATION_ERROR (index, field words) and nothing is stored; bad pieces are refused too', async () => {
    const x = await h();
    const s = await scout(x);
    const r = await s.intake([{ domain: 'superpro.com', lane: 'S3', source: 'scout' }, { domain: 'ukcbamcompliance.com', lane: 'S6', source: 'scout', words: ['uk', 'cbam'] }]);
    expect(r.statusCode).toBe(422);
    expect(r.json().error).toMatchObject({ code: 'VALIDATION_ERROR', details: { index: 1, field: 'words' } });
    expect(await db.selectFrom('candidate_intake').select('id').execute()).toEqual([]);
    for (const words of [[], ['Uk', 'cbam', 'compliance'], ['uk', 'cbam', 'compl-iance'], ['a', 'b', 'c', 'd', 'e', 'f', 'g'], ['uk', '']]) {
      const bad = await s.intake([{ domain: 'ukcbamcompliance.com', lane: 'S6', source: 'scout', words }]);
      expect([words, bad.statusCode, bad.json().error.code]).toEqual([words, 422, 'VALIDATION_ERROR']);
    }
    expect(await db.selectFrom('candidate_intake').select('id').execute()).toEqual([]);
  });

  it('T22-4 words do not pass a name: 5 pieces are TOO_MANY_WORDS, one piece is ONE_WORD, a digit is HAS_DIGIT; the override only replaces the split', async () => {
    const x = await h();
    const s = await scout(x);
    const r = await s.intake([
      { domain: 'aabbccddee.com', lane: 'S3', source: 'scout', words: ['aa', 'bb', 'cc', 'dd', 'ee'] },
      { domain: 'xyzzyplugh.com', lane: 'S3', source: 'scout', words: ['xyzzyplugh'] },
      { domain: 'alpha1beta.com', lane: 'S3', source: 'scout', words: ['alpha1beta'] },
      { domain: 'xyzzyplugh.net', lane: 'S3', source: 'scout' },
    ]);
    expect(r.json().removed).toEqual([
      { domain: 'aabbccddee.com', reason: 'TOO_MANY_WORDS' }, { domain: 'xyzzyplugh.com', reason: 'ONE_WORD' }, { domain: 'alpha1beta.com', reason: 'HAS_DIGIT' }, { domain: 'xyzzyplugh.net', reason: 'NOT_COM' },
    ]);
    expect(r.json().accepted).toEqual([]);
  });

  it('T22-5 without words nothing changes: a readable name is accepted, an unreadable one is NO_SPLIT, a duplicate is a duplicate', async () => {
    const x = await h();
    const s = await scout(x);
    const r = await s.intake([{ domain: 'superpro.com', lane: 'S3', source: 'scout' }, { domain: 'xqzvkw.com', lane: 'S3', source: 'scout' }, { domain: 'superpro.com', lane: 'S3', source: 'scout' }]);
    expect(r.json()).toMatchObject({ accepted: [{ domain: 'superpro.com' }], removed: [{ domain: 'xqzvkw.com', reason: 'NO_SPLIT' }, { domain: 'superpro.com', reason: 'DUPLICATE_IN_UPLOAD' }] });
    expect((await db.selectFrom('candidate_intake').select('words').execute()).every((q) => q.words === null)).toBe(true);
    const job = await realJob(x).runOnce();
    await x.app.screeningWorker.idle();
    const run = await db.selectFrom('screening_runs').select('input').where('id', '=', job.run_id!).executeTakeFirstOrThrow();
    expect((run.input as any).names[0]).not.toHaveProperty('words'); // eslint-disable-line @typescript-eslint/no-explicit-any
  }, 60_000);

  it('T22-6 T22-7 without words the bt1@v3 split decides (real outcome): ukcbamcompliance.com reads uk|cb|am|compliance (TOO_MANY_WORDS), aievalsconsulting.com has no split (NO_SPLIT) while cbam and evals are unknown to it', async () => {
    const x = await h();
    const s = await scout(x);
    const r = await s.intake([{ domain: 'ukcbamcompliance.com', lane: 'S6', source: 'scout' }, { domain: 'aievalsconsulting.com', lane: 'S3', source: 'scout' }]);
    expect(r.json().removed).toEqual([{ domain: 'ukcbamcompliance.com', reason: 'TOO_MANY_WORDS' }, { domain: 'aievalsconsulting.com', reason: 'NO_SPLIT' }]);
    expect(splitV2OfDomain('ukcbamcompliance.com', 'bt1@v3')).toEqual(['uk', 'cb', 'am', 'compliance']);
    expect(splitV2OfDomain('aievalsconsulting.com', 'bt1@v3')).toEqual([]);
  });

  it('T22-8 one splitter, one answer: the intake word rules read a name as the bt1@v3 census split does; a scout\'s words win for that name', async () => {
    const x = await h();
    const s = await scout(x);
    for (const d of ['roofingdroneinspection.com', 'aiactauditor.com']) {
      expect((await s.intake([{ domain: d, lane: 'S4', source: 'scout' }])).json().accepted).toHaveLength(1);
    }
    const job = await realJob(x).runOnce();
    await x.app.screeningWorker.idle();
    expect(job.screened).toBe(2);
    // the census of the intake run reads the same split (its sibling tokens), when it ran
    const census = await db.selectFrom('screening_results').select(['domain', 'fields']).where('run_id', '=', job.run_id!).where('check_id', '=', 'census').execute();
    for (const c of census) {
      const tokens = (c.fields as any).sibling_tokens; // eslint-disable-line @typescript-eslint/no-explicit-any
      if (tokens) expect(tokens).toEqual(splitV2OfDomain(c.domain, 'bt1@v3'));
    }
  }, 60_000);
});

describe('CR-022 F-2: POST /posts/schema-check takes a post body', () => {
  const KEY = 'buf_fake_key_0123456789abcdefABCDEF';
  async function boot() {
    const calls: string[] = [];
    mswServer.use(http.post('https://api.buffer.com', async ({ request }) => {
      const body = (await request.json()) as { query: string; variables: any }; // eslint-disable-line @typescript-eslint/no-explicit-any
      calls.push(body.query.includes('__type(') ? 'schema' : 'other');
      return introspectionAnswer(body.variables.name);
    }));
    const { makeApp } = await import('../helpers/app.js');
    const a = await makeApp({ now: () => Date.parse('2026-10-20T10:00:00Z'), env: { BUFFER_API_KEY: KEY }, testRoutes: false });
    app = a;
    const w = (await issueToken('write', 'gavriel-write')).auth;
    return { a, calls, post: (payload?: object) => a.inject({ method: 'POST', url: '/posts/schema-check', headers: { ...w, 'idempotency-key': randomUUID() }, ...(payload !== undefined && { payload }) }) };
  }

  it('T22-10 a real post body (a big image) is checked, not refused 413; nothing is stored or published; an empty body is the fixed sample', async () => {
    const t = await boot();
    const big = b64(makePng(16, 16, [textChunk('Comment', 'x'.repeat(150_000))])); // base64 well over the default 64 KB body limit (the text chunk is stripped by the image checks)
    expect(big.length).toBeGreaterThan(100_000);
    const r = await t.post({ text: 'Hello', images: [{ data_base64: big, alt: 'A grey square' }] });
    expect(r.statusCode, r.body.slice(0, 300)).toBe(200);
    expect(r.json()).toMatchObject({ ok: true, problems: [], checked: 'post' });
    expect(await db.selectFrom('posts').select('id').execute()).toEqual([]);
    expect(await db.selectFrom('post_images').select('id').execute()).toEqual([]);
    expect(new Set(t.calls)).toEqual(new Set(['schema']));
    for (const empty of [undefined, {}]) expect((await t.post(empty)).json()).toMatchObject({ ok: true, checked: 'sample' });
  });

  it('T22-10 the post is validated like POST /posts (blank text, too long, a bad image are the same 422/400 errors); an unknown field is refused', async () => {
    const t = await boot();
    expect((await t.post({ text: 'x'.repeat(400) })).json().error.code).toBe('POST_TOO_LONG');
    expect((await t.post({ text: 'ok', images: [{ data_base64: 'AAAA', alt: 'bad' }] })).json().error.code).toBe('POST_INVALID');
    expect((await t.post({ text: 'ok', nope: 1 })).statusCode).toBe(422);
  });

  it('a problem in the input DOM builds for that post shows (the live schema mock refuses the thread part\'s field)', async () => {
    const t = await boot();
    const r = await t.post({ text: 'Hello', thread: [{ text: 'Part two' }] });
    expect(r.json()).toMatchObject({ ok: true, checked: 'post' });
  });
});

describe('CR-023 E: rejected names and run ids on the daily list', () => {
  it('AC-8 summary.screening_run_id equals the intakeScreening run id of /jobs/runs; summary.rejected has one entry per failed name with first_fail and key_inputs; why names the check per lane', async () => {
    const x = await h();
    const s = await scout(x);
    const names = [{ domain: 'aiactauditor.com', lane: 'S6' }, { domain: 'paytransparencyreporting.com', lane: 'S6' }, { domain: 'roofingdroneinspection.com', lane: 'S4' }, { domain: 'contextengineering.com', lane: 'S3' }, { domain: 'superpro.com', lane: 'S3' }];
    await s.intake(names.map((n) => ({ ...n, source: 'scout' })));
    // a real daily run through the queue screens the names (offline); the list it builds carries the run id of its intakeScreening step
    const w = await issueToken('write');
    const queued = await x.app.inject({ method: 'POST', url: '/jobs/run', headers: { ...w.auth, 'idempotency-key': randomUUID() }, payload: { job: 'daily' } });
    expect(queued.statusCode).toBe(202);
    await settle(x);
    const runId = (await db.selectFrom('candidate_screenings').select('run_id').executeTakeFirstOrThrow()).run_id;
    const jr = (await x.get('/jobs/runs?job=daily')).json().runs[0];
    expect(jr.steps.intakeScreening.summary.run_id).toBe(runId);
    await x.post('/candidates/daily/rebuild', {});
    const list = await daily(x);
    expect(list.summary.screening_run_id).toBe(runId);
    expect(list.summary.screening_run_ids).toEqual([runId]);
  }, 120_000);

  it('AC-8 rejected entries and the per-lane why (seeded results)', async () => {
    const x = await h();
    const tierFields = (lane: string) => ({ tier: 'none', clauses: { A: 'false', I: 'false', B: 'false', G: 'false' }, fired: null, demand2: 'FAIL', inputs: { lane, n_words: 3, sld_chars: 12, registered_share: 0 } });
    const run = await seedRun(x, [
      { domain: 'aiactauditor.com', lane: 'S6', fail: { check: 'tier', code: 'DEMAND2_FAIL', reason: 'No tier that passes DEMAND-2 applies', fields: tierFields('S6') } },
      { domain: 'paytransparencyreporting.com', lane: 'S6', fail: { check: 'tier', code: 'DEMAND2_FAIL', fields: tierFields('S6') } },
      { domain: 'deforestationaudit.com', lane: 'S6', fail: { check: 'tier', code: 'DEMAND2_FAIL', fields: tierFields('S6') } },
      { domain: 'roofingdroneinspection.com', lane: 'S4', fail: { check: 'tier', code: 'DEMAND2_FAIL', fields: tierFields('S4') } },
      { domain: 'constructioncomputervision.com', lane: 'S4', fail: { check: 'tier', code: 'DEMAND2_FAIL', fields: tierFields('S4') } },
      { domain: 'contextengineeringconsulting.com', lane: 'S3', fail: { check: 'tier', code: 'DEMAND2_FAIL', fields: tierFields('S3') } },
      { domain: 'badprice.com', lane: 'S3', fail: { check: 'price', code: 'EV_NOT_POSITIVE', reason: 'Expected value -$1.00 is not above zero', fields: { ev_cents: -100, P_sale: 0.02, p_passive: 0.01, bin_cents: 148800 } } },
    ], { origin: true });
    const w = await issueToken('write');
    const rb = await x.app.inject({ method: 'POST', url: '/candidates/daily/rebuild', headers: { ...w.auth, 'idempotency-key': randomUUID() }, payload: {} });
    expect(rb.statusCode, rb.body).toBe(201);
    const l = await daily(x);
    const sm = l.summary;
    expect(sm.screening_run_id).toBe(run);
    expect(sm.rejected_n).toBe(7);
    expect(sm.rejected).toHaveLength(7);
    const byDomain = Object.fromEntries(sm.rejected.map((r: any) => [r.domain, r])); // eslint-disable-line @typescript-eslint/no-explicit-any
    expect(byDomain['aiactauditor.com']).toMatchObject({
      domain: 'aiactauditor.com', lane: 'S6', origin: 'intake', run_id: run,
      first_fail: { check: 'tier', gate: 'G8', reason_code: 'DEMAND2_FAIL', reason: 'No tier that passes DEMAND-2 applies' },
      key_inputs: { inputs: { lane: 'S6', n_words: 3, sld_chars: 12, registered_share: 0 }, clauses: { A: 'false', I: 'false', B: 'false', G: 'false' } },
    });
    expect(byDomain['badprice.com']).toMatchObject({ first_fail: { check: 'price', reason_code: 'EV_NOT_POSITIVE' }, key_inputs: { ev_cents: -100, P_sale: 0.02, p_passive: 0.01 } });
    expect(sm.failed_by_check).toEqual({ tier: 6, price: 1 });
    expect(sm.why).toContain('6 failed the demand check (S6: 3, S4: 2, S3: 1)');
    expect(sm.why).toContain('1 failed the price check (S3: 1)');
  }, 60_000);

  it('rejected lists at most 30 (rejected_n is the whole number); buildWhy without lane data keeps the plain sentence', () => {
    expect(buildWhy({ screened_today: 2, candidates_n: 0, failed_by_check: { tier: 2 } })).toContain('2 failed the demand check, 0 passed');
    expect(buildWhy({ screened_today: 2, candidates_n: 0, failed_by_check: { tier: 2 }, failed_by_check_lane: { tier: { S4: 1, S6: 1 } } })).toContain('2 failed the demand check (S4: 1, S6: 1), 0 passed');
  });
});

describe('CR-023 F: GET /openapi.json', () => {
  it('AC-9 lists exactly the routes Fastify registered (itself included), every route of the contract route table, with scope, summary and body schemas', async () => {
    const x = await h();
    const r = await x.get('/openapi.json');
    expect(r.statusCode).toBe(200);
    const doc = r.json();
    expect(doc.openapi).toMatch(/^3\.1/);
    const listed = Object.entries(doc.paths).flatMap(([p, ops]: [string, any]) => Object.keys(ops).map((m) => `${m.toUpperCase()} ${p}`)).sort(); // eslint-disable-line @typescript-eslint/no-explicit-any
    const registered = [...new Set(x.app.routeTable.filter((q) => q.method !== 'HEAD').map((q) => `${q.method} ${q.url.replace(/:([A-Za-z0-9_]+)/g, '{$1}')}`))].sort();
    expect(listed).toEqual(registered);
    // every route of the contract's route table
    const table = readFileSync('docs/contract/endpoints.md', 'utf8').split('\n').filter((l) => /^\| (GET|POST)/.test(l));
    const documented = table.flatMap((l) => {
      const [, method, paths] = l.split('|').map((c) => c.trim());
      return [...paths!.matchAll(/`([^`]+)`/g)].map((m) => `${method} ${m[1]!.split('?')[0]}`);
    });
    expect(documented.length).toBeGreaterThan(50);
    expect(listed).toEqual(expect.arrayContaining(documented));
    for (const [p, ops] of Object.entries(doc.paths) as [string, any][]) { // eslint-disable-line @typescript-eslint/no-explicit-any
      for (const [m, op] of Object.entries(ops) as [string, any][]) { // eslint-disable-line @typescript-eslint/no-explicit-any
        expect(typeof op['x-scope'], `${m} ${p}`).toBe('string');
        expect(op.summary.length, `${m} ${p}`).toBeGreaterThan(3);
        if (!p.startsWith('/__test')) expect(op.summary, `${m} ${p}: add a summary`).not.toBe(`${m.toUpperCase()} ${p}`);
      }
    }
    expect(doc.paths['/candidates/screen'].post).toMatchObject({ 'x-scope': 'write', requestBody: { content: { 'application/json': { schema: { type: 'object', properties: { max_names: { type: 'integer' } } } } } } });
    expect(doc.paths['/candidates/intake'].post['x-scope']).toBe('write or intake');
    expect(doc.paths['/candidates/intake'].post.requestBody.content['application/json'].schema.properties.names.items.properties).toHaveProperty('words');
    expect(doc.paths['/health/ping'].get['x-scope']).toBe('none');
    expect(doc.paths['/report'].get['x-scope']).toBe('read');
    expect(doc.paths['/jobs/run'].post['x-scope']).toBe('write or job-trigger token');
  });

  it('needs a token like the other reads; an intake token is refused', async () => {
    const x = await h();
    expect((await x.app.inject({ method: 'GET', url: '/openapi.json' })).statusCode).toBe(401);
    const s = await scout(x);
    expect((await s.call('GET', '/openapi.json')).statusCode).toBe(403);
  });
});

describe('CR-023 G: DROP_FEED_STALE settings', () => {
  const report = async (x: ScreeningHarness) => (await x.get('/report')).json();
  const stale = (r: any) => (r.warnings as any[]).filter((w) => w.code === 'DROP_FEED_STALE'); // eslint-disable-line @typescript-eslint/no-explicit-any
  async function listAged(x: ScreeningHarness, days: number) {
    await seedDailyRun(db, x.clock.t);
    const d = new Date(x.clock.t + 3 * HOUR - days * DAY).toISOString().slice(0, 10);
    await db.insertInto('drop_lists').values({ name: 'dl-old', list_date: d, created_by: 'scout-1', received_n: 1, kept_n: 1 }).execute();
  }

  it('AC-10 with defaults: a list 3 days old shows nothing', async () => {
    const x = await h();
    await listAged(x, 3);
    expect(stale(await report(x))).toEqual([]);
  });

  it('AC-10 at 8 days it shows DROP_FEED_STALE at level info (no warning counted)', async () => {
    const x = await h();
    await listAged(x, 8);
    const w = stale(await report(x));
    expect(w).toHaveLength(1);
    expect(w[0]).toMatchObject({ level: 'info', details: { newest_list: 'dl-old' } });
  });

  it('AC-10 days 2 + level warn restores the old behaviour: 3 days old is a warn', async () => {
    const x = await h();
    await patchActiveSettings(['intake'], { drop_list_max_share: 1, drop_feed_stale_days: 2, drop_feed_stale_level: 'warn' });
    await listAged(x, 3);
    const w = stale(await report(x));
    expect(w).toHaveLength(1);
    expect(w[0].level).toBe('warn');
  });
});
