// v2.14.0 (CR-012 parts B and C): the intake scope and route, the daily intake screening, the daily candidate list.
import { settleJob } from '../helpers/app.js';
import { randomUUID } from 'node:crypto';
import { http } from 'msw';
import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { BuildDailyListJob } from '../../src/modules/candidates/daily-list.js';
import { GATE_OF } from '../../src/modules/selection/checks/index.js';
import { planFor } from '../../src/modules/selection/engine.js';
import { INTAKE_DAILY_MAX, INTAKE_DEDUPE_DAYS, IntakeScreeningJob, intakeCensusList } from '../../src/modules/candidates/intake.js';
import type { ScreeningWorker } from '../../src/modules/selection/engine.js';
import { insertOwnedDomain, testDb as db } from '../helpers/db.js';
import { screeningHarness, type ScreeningHarness } from '../helpers/screening.js';
import { fixture, respond } from '../helpers/screening-fixtures.js';
import { issueToken } from '../helpers/tokens.js';
import type { RdapLookup } from '../../src/core/rdap.js';
import { mswServer } from '../setup/network.js';

let app: FastifyInstance | undefined;
afterEach(async () => app?.close());
const DAY = 86_400_000;
const HOUR = 3_600_000;
const free = (): RdapLookup => ({ outcome: 'not_registered', reasonCode: null, httpStatus: 404, url: 'https://rdap.example/domain/x', retrievedAt: new Date(), body: null, facts: null });
async function h(): Promise<ScreeningHarness> {
  mswServer.use(http.get('https://data.iana.org/rdap/dns.json', () => respond(fixture('iana-dns.json'))));
  const x = await screeningHarness({ screening: { rdapLookup: async () => free() } });
  app = x.app;
  return x;
}
/** A job that records its run but never executes it (the screening itself is covered elsewhere); `runToEnd` resolves at once. */
const fakeWorker = (x: ScreeningHarness, kicked: string[] = []): ScreeningWorker => ({ checks: x.app.screeningWorker.checks, kick: (id: string) => { kicked.push(id); }, runToEnd: async () => {} }) as unknown as ScreeningWorker;
const intakeJob = (x: ScreeningHarness, kicked: string[] = []) => new IntakeScreeningJob({ db, worker: fakeWorker(x, kicked), now: () => x.clock.t });
const ap = (x: ScreeningHarness, text: string) => ({ text, approved_at: new Date(x.clock.t - 3_600_000).toISOString() });
// two-word names (the intake word rules need a reading of 2 or 3 words by the bt1@v2 split)
const NAMES = ['superpro', 'superbox', 'supertech', 'superhealth', 'supermedia', 'superlab', 'superhub', 'supershop', 'superworks', 'supergroup', 'superhouse', 'superstore', 'megapro', 'megatech', 'megahealth', 'megamedia', 'megalab', 'megahub',
  'megaworks', 'megagroup', 'megahouse', 'smartpro', 'smartbox', 'smarttech', 'smarthealth', 'smartmedia', 'smartlab', 'smarthub', 'smartshop', 'smartworks', 'smartgroup', 'smarthouse', 'smartstore', 'quickpro', 'quickbox'];
const nm = (i: number) => `${NAMES[i]}.com`;
const COMPS = [
  { domain: 'alpha.com', price_usd: 1200, sold_on: '2026-01-05', venue: 'Afternic', source_url: 'https://example.com/a' },
  { domain: 'beta.com', price_usd: 900, sold_on: '2026-02-05', venue: 'Sedo', source_url: 'https://example.com/b' },
];

async function scout(x: ScreeningHarness, name = 'scout-1') {
  const t = await issueToken('intake', name);
  const call = (method: 'GET' | 'POST', url: string, payload?: object) => (x.clock.t += 7_000, x.app.inject({ method, url, headers: { ...t.auth, 'idempotency-key': randomUUID() }, ...(payload && { payload }) }));
  return { ...t, call, intake: (names: object[]) => call('POST', '/candidates/intake', { names }) };
}
const queuedRows = () => db.selectFrom('candidate_intake').selectAll().orderBy('id').execute();

describe('intake scope and route (CR-012 T12-14, T12-15, T12-18)', () => {
  it('V214-1 an intake token may call only POST /candidates/intake and POST /selection/drop-lists; every other route is 403 SCOPE_FORBIDDEN (GETs too); a READ token cannot intake', async () => {
    const x = await h();
    const s = await scout(x);
    const ok = await s.intake([{ domain: 'quickmedia.com', lane: 'S3', source: 'scout-1/run-7' }]);
    expect(ok.statusCode, ok.body).toBe(200);
    const drops = await s.call('POST', '/selection/drop-lists', { name: 'dl-intake', list_date: '2026-10-06', domains: ['alphabeta.com'] });
    expect(drops.statusCode, drops.body).toBe(201);
    for (const [m, u, p] of [
      ['GET', '/health'], ['GET', '/candidates/daily'], ['GET', '/jobs/runs'], ['GET', '/selection/drop-lists/dl-intake'], ['GET', '/report'],
      ['POST', '/jobs/run', { job: 'daily' }], ['POST', '/screening/runs', { names: [{ domain: 'a.com', lane: 'S3' }] }], ['POST', '/buy', { domain: 'a.com' }], ['POST', '/candidates/a.com/records', {}],
    ] as const) {
      const r = await s.call(m, u, p as object | undefined);
      expect([m, u, r.statusCode, r.json().error.code]).toEqual([m, u, 403, 'SCOPE_FORBIDDEN']);
    }
    const read = await issueToken('read');
    const r = await x.app.inject({ method: 'POST', url: '/candidates/intake', headers: { ...read.auth, 'idempotency-key': randomUUID() }, payload: { names: [{ domain: 'quicklab.com', lane: 'S3', source: 's' }] } });
    expect([r.statusCode, r.json().error.code]).toEqual([403, 'SCOPE_FORBIDDEN']);
    // the audit row names the token (token_id -> api_tokens.name) and carries the intake scope; the intake row names the scout and the audit row
    const audit = await db.selectFrom('audit_log').innerJoin('api_tokens', 'api_tokens.id', 'audit_log.token_id').select(['audit_log.id as aid', 'audit_log.scope', 'api_tokens.name'])
      .where('audit_log.path', '=', '/candidates/intake').where('audit_log.status_code', '=', 200).executeTakeFirstOrThrow();
    expect(audit).toMatchObject({ scope: 'intake', name: 'scout-1' });
    expect((await queuedRows())[0]).toMatchObject({ token_name: 'scout-1', audit_id: audit.aid, source: 'scout-1/run-7', status: 'queued' });
    // a WRITE token works too
    const w = await x.post('/candidates/intake', { names: [{ domain: 'quickhub.com', lane: 'S4', source: 'gavriel' }] });
    expect(w.statusCode).toBe(200);
  });

  it('V214-2 removal reasons, one answer per name; removed names are stored too', async () => {
    const x = await h();
    await insertOwnedDomain(db, { domain: 'ownedname.com' });
    const s = await scout(x);
    const r = await s.intake([
      { domain: 'bad domain', lane: 'S3', source: 's' }, { domain: 'qxzaa.net', lane: 'S3', source: 's' }, { domain: 'qxz9.com', lane: 'S3', source: 's' },
      { domain: 'qxz-aa.com', lane: 'S3', source: 's' }, { domain: 'littlebigredhousepaint.com', lane: 'S3', source: 's' }, { domain: 'OwnedName.com', lane: 'S3', source: 's' },
      { domain: 'quickshop.com', lane: 'S3', source: 's' }, { domain: 'QUICKSHOP.com', lane: 'S3', source: 's' }, { domain: 'www.quickworks.com', lane: 'S3', source: 's' },
    ]);
    expect(r.statusCode, r.body).toBe(200);
    const b = r.json();
    expect(b.removed).toEqual([
      { domain: 'bad domain', reason: 'DOMAIN_INVALID' }, { domain: 'qxzaa.net', reason: 'NOT_COM' }, { domain: 'qxz9.com', reason: 'HAS_DIGIT' }, { domain: 'qxz-aa.com', reason: 'HAS_HYPHEN' },
      { domain: 'littlebigredhousepaint.com', reason: 'TOO_MANY_WORDS' }, { domain: 'ownedname.com', reason: 'OWNED' }, { domain: 'quickshop.com', reason: 'DUPLICATE_IN_UPLOAD' }, { domain: 'www.quickworks.com', reason: 'DOMAIN_INVALID' },
    ]);
    expect(b.accepted).toEqual([{ domain: 'quickshop.com', intake_id: expect.any(Number) }]);
    expect(b.duplicates).toEqual([]);
    expect((await queuedRows()).map((q) => q.status)).toEqual(['removed', 'removed', 'removed', 'removed', 'removed', 'removed', 'queued', 'removed', 'removed']);
    // strict body: an unknown field, a lane outside S2..S7, comps of one, an empty list
    for (const bad of [
      { names: [{ domain: 'quickgroup.com', lane: 'S3', source: 's', price: 5 }] }, { names: [{ domain: 'quickgroup.com', lane: 'S1', source: 's' }] },
      { names: [{ domain: 'quickgroup.com', lane: 'S3', source: 's', comps: [COMPS[0]] }] }, { names: [] }, { names: [{ domain: 'quickgroup.com', lane: 'S3', source: '' }] },
    ]) expect((await s.call('POST', '/candidates/intake', bad)).statusCode).toBe(422);
    const future = await s.intake([{ domain: 'quickhouse.com', lane: 'S3', source: 's', comps: [COMPS[0], { ...COMPS[1], sold_on: '2030-01-01' }] }]);
    expect([future.statusCode, future.json().error.code]).toEqual([422, 'COMPS_INVALID']);
  });

  it('V214-3 dedupe: the same name within 30 days is a duplicate (its extra source is stored), after 30 days it is queued again', async () => {
    const x = await h();
    const a = await scout(x, 'scout-a');
    const b = await scout(x, 'scout-b');
    const first = (await a.intake([{ domain: 'quickmedia.com', lane: 'S3', source: 'a/1', comps: COMPS }])).json();
    expect(first.accepted).toHaveLength(1);
    x.clock.t += (INTAKE_DEDUPE_DAYS - 1) * DAY;
    const dup = (await b.intake([{ domain: 'quickmedia.com', lane: 'S4', source: 'b/9', note: 'seen on a list' }])).json();
    expect(dup).toMatchObject({ accepted: [], duplicates: [{ domain: 'quickmedia.com', first_intake_id: first.accepted[0].intake_id }] });
    x.clock.t += 2 * DAY;
    const again = (await b.intake([{ domain: 'quickmedia.com', lane: 'S4', source: 'b/10' }])).json();
    expect(again.accepted).toHaveLength(1);
    const rows = await queuedRows();
    expect(rows.map((r) => [r.source, r.status, r.token_name])).toEqual([['a/1', 'queued', 'scout-a'], ['b/9', 'duplicate', 'scout-b'], ['b/10', 'queued', 'scout-b']]);
    expect(rows[0]!.comps).toEqual(COMPS);
  });
});

describe('intakeScreening (CR-012 T12-16, T12-17, T12-19)', () => {
  it('V214-4 at most 30 names a day in arrival order, ONE run, the rest wait and are counted; the next day takes them', async () => {
    const x = await h();
    const s = await scout(x);
    for (let i = 0; i < 35; i += 5) await s.intake(Array.from({ length: 5 }, (_, k) => ({ domain: nm(i + k), lane: 'S3', source: 'bulk' })));
    const kicked: string[] = [];
    const job = intakeJob(x, kicked);
    const r1 = await job.runOnce();
    expect(r1).toMatchObject({ queued_before: 35, screened: INTAKE_DAILY_MAX, from_intake: 30, from_drop_lists: 0, left_for_next_run: 5 });
    expect(kicked).toEqual([r1.run_id]);
    const runs = await db.selectFrom('screening_runs').selectAll().execute();
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ mode: 'full', backtest: false, created_by: 'intakeScreening' });
    const names = (runs[0]!.input as { names: { domain: string; lane: string; census_list?: string }[] }).names;
    expect(names.map((n) => n.domain)).toEqual(Array.from({ length: 30 }, (_, i) => nm(i)));
    expect(names[0]!.census_list).toBeUndefined(); // no approved sibling method: the census stays honestly UNKNOWN
    const shots = await db.selectFrom('candidate_screenings').selectAll().execute();
    expect(shots).toHaveLength(30);
    expect(shots[0]).toMatchObject({ run_id: r1.run_id, origin: 'intake', day: '2026-10-06' });
    // the same day again: the daily maximum is reached
    expect(await job.runOnce()).toMatchObject({ skipped: true, reason: 'DAILY_MAX_REACHED', queued_before: 5, left_for_next_run: 5, screened: 0 });
    x.clock.t += DAY;
    const r2 = await job.runOnce();
    expect(r2).toMatchObject({ queued_before: 5, screened: 5, left_for_next_run: 0 });
    expect(await job.runOnce()).toMatchObject({ skipped: true, reason: 'NO_NAMES', queued_before: 0 });
    expect(await db.selectFrom('screening_runs').select('id').execute()).toHaveLength(2);
  });

  it('V214-5 drop-list names about to drop join the run after the intake names, are not screened again within 7 days, and an owned name never is', async () => {
    const x = await h();
    const s = await scout(x);
    await s.intake([{ domain: 'quickmedia.com', lane: 'S3', source: 'scout' }]);
    await db.insertInto('drop_lists').values({ name: 'dl-1', list_date: '2026-10-06', created_by: 'scout-1', received_n: 5, kept_n: 5 }).execute();
    const names = ['dropone.com', 'droptwo.com', 'dropthree.com', 'dropfour.com', 'dropfive.com'];
    await db.insertInto('drop_list_rows').values(names.map((domain) => ({ list_name: 'dl-1', domain, kept: true, reason: null, tokens: ['drop', 'x'] }))).execute();
    const checks = [['dropone.com', 'pending_delete', '2026-10-08'], ['droptwo.com', 'redemption', '2026-10-12'], ['dropthree.com', 'registered', null], ['dropfour.com', 'pending_delete', '2026-10-30'], ['dropfive.com', 'pending_delete', '2026-10-09']] as const;
    await db.insertInto('drop_list_checks').values(checks.map(([domain, status, d]) => ({ list_name: 'dl-1', domain, checked_at: new Date(x.clock.t), status, last_changed: null, expected_drop_date: d, drop_date_source: d ? 'estimate' : null, reason_code: null }))).execute();
    await insertOwnedDomain(db, { domain: 'dropfive.com' });
    const job = intakeJob(x);
    const r = await job.runOnce();
    expect(r).toMatchObject({ queued_before: 1, screened: 3, from_intake: 1, from_drop_lists: 2, left_for_next_run: 0 });
    const run = await db.selectFrom('screening_runs').selectAll().executeTakeFirstOrThrow();
    expect((run.input as { names: { domain: string }[] }).names.map((n) => n.domain)).toEqual(['quickmedia.com', 'dropone.com', 'droptwo.com']);
    expect((await db.selectFrom('candidate_screenings').select(['domain', 'origin', 'intake_id']).orderBy('id').execute()).map((q) => [q.domain, q.origin, q.intake_id === null])).toEqual([['quickmedia.com', 'intake', false], ['dropone.com', 'drop_list', true], ['droptwo.com', 'drop_list', true]]);
    x.clock.t += 2 * DAY; // inside the 7 days: not again
    expect(await job.runOnce()).toMatchObject({ skipped: true, reason: 'NO_NAMES' });
    expect(await db.selectFrom('screening_runs').select('id').execute()).toHaveLength(1);
  });

  it('V214-6 the census list is the newest approved sibling method: bt1@v3, else bt1@v2, else none', async () => {
    const x = await h();
    const s = await scout(x);
    expect(await intakeCensusList(db)).toBeNull();
    expect((await x.post('/selection/sibling-methods/bt1@v2/approve', { approval_ref: ap(x, 'sibling method bt1@v2 approved') })).statusCode).toBe(201);
    expect(await intakeCensusList(db)).toBe('bt1@v2');
    await s.intake([{ domain: 'quickmedia.com', lane: 'S3', source: 'scout' }]);
    const r1 = await intakeJob(x).runOnce();
    expect(r1.census_list).toBe('bt1@v2');
    expect(((await db.selectFrom('screening_runs').select('input').where('id', '=', r1.run_id!).executeTakeFirstOrThrow()).input as { names: { census_list?: string }[] }).names[0]!.census_list).toBe('bt1@v2');
    expect((await x.post('/selection/sibling-methods/bt1@v3/approve', { approval_ref: ap(x, 'sibling method bt1@v3 approved') })).statusCode).toBe(201);
    expect(await intakeCensusList(db)).toBe('bt1@v3');
    await s.intake([{ domain: 'quickshop.com', lane: 'S3', source: 'scout' }]);
    x.clock.t += DAY;
    const r2 = await intakeJob(x).runOnce();
    expect(r2.census_list).toBe('bt1@v3');
    expect(((await db.selectFrom('screening_runs').select('input').where('id', '=', r2.run_id!).executeTakeFirstOrThrow()).input as { names: { census_list?: string }[] }).names[0]!.census_list).toBe('bt1@v3');
  });

  it('V214-7 both steps run in the daily job after dropWatch and before cohortOutcomes, show in GET /jobs/runs, and the real worker screens the intake run', async () => {
    const x = await h();
    const s = await scout(x);
    await s.intake([{ domain: 'quickmedia.com', lane: 'S3', source: 'scout' }]);
    const res = await settleJob(x.app, 'daily', await x.post('/jobs/run', { job: 'daily' }));
    expect(res.statusCode, res.body).toBe(202);
    const steps = Object.keys(res.json().steps);
    expect(steps.slice(steps.indexOf('dropWatch'))).toEqual(['dropWatch', 'intakeScreening', 'buildDailyList', 'cohortOutcomes', 'referenceRefresh', 'outsideReview', 'postsRefresh', 'backupExport']);
    expect(res.json().steps.intakeScreening).toMatchObject({ ok: true, summary: { queued_before: 1, screened: 1, left_for_next_run: 0, run_id: expect.stringMatching(/^run_/) } });
    expect(res.json().steps.buildDailyList).toMatchObject({ ok: true, summary: { day: '2026-10-06', entries_n: 0 } });
    const runs = (await x.get('/jobs/runs?job=daily')).json().runs;
    expect(runs[0].steps.intakeScreening.summary.screened).toBe(1);
    expect((await db.selectFrom('screening_runs').select('status').executeTakeFirstOrThrow()).status).toBe('done'); // buildDailyList waited for it
    // the next day: nothing queued, the step is skipped with its reason
    x.clock.t += DAY;
    const again = await settleJob(x.app, 'daily', await x.post('/jobs/run', { job: 'daily' }));
    expect(again.json().steps.intakeScreening).toMatchObject({ ok: true, skipped: true, summary: { skipped: true, reason: 'NO_NAMES' } });
  }, 60_000);
});

interface Seed {
  domain: string; lane?: 'S3' | 'S7'; ratio?: number; score?: number; exact?: boolean; fail?: boolean; unknownPrice?: boolean; noRecords?: boolean; registrar?: string;
  ageHours?: number; records?: boolean; first_year_cents?: number;
}
/** A finished full-plan run on settings v1 (hold on), every planned check seeded; `records` writes fresh tm_us and history domain records. */
async function seedRun(x: ScreeningHarness, names: Seed[]): Promise<string> {
  const sel = await db.selectFrom('selection_settings').select(['id', 'label', 'values']).where('label', '=', 'v1').executeTakeFirstOrThrow();
  const id = `run_${randomUUID()}`;
  const gate_plan: Record<string, string[]> = {};
  for (const n of names) gate_plan[n.lane ?? 'S3'] ??= planFor(sel.values as never, n.lane ?? 'S3');
  const created = new Date(x.clock.t - (names[0]?.ageHours ?? 1) * HOUR);
  await db.insertInto('screening_runs').values({
    id, created_at: created, created_by: 'test', mode: 'full', backtest: false, settings_id: sel.id, settings_label: 'v1', buy_hold: true, tranche_id: null,
    input: JSON.stringify({ names: names.map((n, idx) => ({ idx, domain: n.domain, lane: n.lane ?? 'S3', leads_ab: 0 })) }),
    gate_plan: JSON.stringify(gate_plan), list_versions: '{}', status: 'done', deadline_at: new Date(x.clock.t + 3_600_000), finished_at: created,
  }).execute();
  for (const [idx, n] of names.entries()) {
    const lane = n.lane ?? 'S3';
    for (const [i, check] of gate_plan[lane]!.entries()) {
      let status: 'PASS' | 'FAIL' | 'FLAG' | 'UNKNOWN' | 'MANUAL_REQUIRED' = 'PASS';
      let reason_code: string | null = null;
      let fields: Record<string, unknown> = {};
      if (n.fail && i === 1) { status = 'FAIL'; reason_code = 'BRAND_HIT'; }
      if (check === 'tm_us' || check === 'history') { if (n.noRecords) { status = 'MANUAL_REQUIRED'; reason_code = 'MANUAL_SOURCE'; } }
      if (check === 'price') {
        fields = { bin_cents: 148800, ratio_at_bin: (n.ratio ?? 2) + 1, ratio_at_floor: n.ratio ?? 2, score_0_100: n.score ?? 50, floor_cents: 96700, walkaway_cents: 71500 };
        if (n.unknownPrice) { status = 'UNKNOWN'; reason_code = 'NO_QUOTE'; }
      }
      if (check === 'quote') fields = { registrar: n.registrar ?? 'porkbun', first_year_cents: n.first_year_cents ?? 1108, renewal_cents: 1208, quoted_at: new Date(x.clock.t - HOUR).toISOString() };
      if (check === 'tier') fields = { tier: 'A', tier_exact: n.exact !== false, fired: 'A' };
      if (check === 'tm_us' && status === 'PASS' && n.domain.startsWith('flag')) { status = 'FLAG'; reason_code = 'TM_GENERIC_HITS'; }
      await db.insertInto('screening_results').values({
        run_id: id, item_idx: idx, domain: n.domain, lane, check_id: check, gate: GATE_OF[check as keyof typeof GATE_OF], rule_ids: ['X'], status, reason_code, reason: reason_code ? 'seeded' : null,
        fields: JSON.stringify(fields), checked_at: created, settings_label: 'v1', list_versions: '{}', duration_ms: 0, upstream_calls: 0, source: 'auto',
      }).execute();
    }
    if (n.records !== false && !n.noRecords) {
      for (const kind of ['tm_us', 'history'] as const) {
        await db.insertInto('domain_records').values({ domain: n.domain, kind, record: JSON.stringify({ seeded: true }), checked_by: 'gavriel', checked_at: new Date(x.clock.t - 2 * HOUR), created_by: 'gavriel' }).execute();
      }
    }
  }
  return id;
}
const build = (x: ScreeningHarness) => new BuildDailyListJob({ db, worker: fakeWorker(x), now: () => x.clock.t }).runOnce();

describe('daily candidate list (CR-012 T12-7..T12-13)', () => {
  it('V214-8 not built yet: 200 with empty entries and summary not_built; built with nothing: the day funnel, never padded', async () => {
    const x = await h();
    const r = await x.get('/candidates/daily');
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ date: '2026-10-06', built_at: null, entries: [], sections: { almost_ready: [], upcoming: [] }, summary: { not_built: true } });
    expect(await build(x)).toMatchObject({ day: '2026-10-06', entries_n: 0, partial: false, version: 1 });
    const e = (await x.get('/candidates/daily?date=2026-10-06')).json();
    expect(e.entries).toEqual([]);
    expect(e.summary).toMatchObject({ screened_today: 0, failed_by_check: {}, waiting_for_records: 0, unknown_by_reason: {}, partial: false });
    expect(e.summary.not_built).toBeUndefined();
    expect((await x.get('/candidates/daily?date=2026-10-05')).json().summary).toEqual({ not_built: true });
    for (const bad of ['?limit=26', '?limit=0', '?date=yesterday', '?foo=1']) expect((await x.get(`/candidates/daily${bad}`)).statusCode).toBe(400);
  });

  it('V214-9 ranking: exact tier first, then ratio at the floor, then score, then arrival; held true while the hold is on; would_be_blocked from the /buy gates; no walk-away anywhere', async () => {
    const x = await h();
    const s = await scout(x);
    await seedRun(x, [
      { domain: 'alphaone.com', ratio: 2, score: 50 }, { domain: 'alphatwo.com', ratio: 3, score: 40 }, { domain: 'alphathree.com', ratio: 3, score: 60 },
      { domain: 'alphafour.com', ratio: 9, score: 99, exact: false }, { domain: 'alphafive.com', ratio: 2, score: 50 },
    ]);
    // equal ratio and score: the earlier arrival ranks first (alphafive arrived before alphaone)
    await s.intake([{ domain: 'alphafive.com', lane: 'S3', source: 'first' }]);
    x.clock.t += 60_000;
    await s.intake([{ domain: 'alphaone.com', lane: 'S3', source: 'second', comps: COMPS }]);
    await build(x);
    const res = await x.get('/candidates/daily?limit=25');
    const list = res.json();
    expect(list.entries.map((e: any) => [e.rank, e.domain])).toEqual([[1, 'alphathree.com'], [2, 'alphatwo.com'], [3, 'alphafive.com'], [4, 'alphaone.com'], [5, 'alphafour.com']]);
    const one = list.entries.find((e: any) => e.domain === 'alphaone.com');
    expect(one).toMatchObject({
      lane: 'S3', held: true, final_status: 'would_buy', settings_version: 'v1', run_id: expect.stringMatching(/^run_/),
      sources: [{ source: 'second', token_name: 'scout-1', received_at: expect.any(String) }], comps: COMPS,
      price: { registrar: 'porkbun', first_year_cents: 1108, first_year: '$11.08', renewal_cents: 1208, quoted_at: expect.any(String) },
      plan: { bin_cents: 148800, floor_cents: 96500, min_offer_cents: 10000 }, why: { tier: 'A', tier_exact: true, clause: 'A', ratio_at_floor: 2, ratio_at_bin: 3 },
      dates: { expiry_or_drop: null, buyable_from: '2026-10-06' },
      records: { tm_us: { result: 'PASS', checked_by: 'gavriel', source: 'domain_record' }, history: { result: 'PASS', checked_by: 'gavriel' } },
    });
    expect(one.checks.map((c: any) => c.check)).toContain('price');
    expect(one.would_be_blocked).toEqual(['BUY_HOLD', 'SCREENING_PACK_REQUIRED', 'NO_TRANCHE']);
    expect(list.entries.find((e: any) => e.domain === 'alphafour.com').why.tier_exact).toBe(false);
    expect(res.body.toLowerCase()).not.toContain('walkaway');
    expect(res.body.toLowerCase()).not.toContain('walk_away');
    // limit applies on read
    const two = (await x.get('/candidates/daily?limit=2')).json();
    expect(two.entries.map((e: any) => e.domain)).toEqual(['alphathree.com', 'alphatwo.com']);
    expect((await x.get('/candidates/daily')).json().entries).toHaveLength(5); // default 10, only 5 exist: never padded
  });

  it('V214-10 exclusions: a FAIL, a gating UNKNOWN, a stale run (over 72 h), an owned name; missing records go to almost_ready; the summary counts them', async () => {
    const x = await h();
    await seedRun(x, [{ domain: 'goodname.com' }, { domain: 'failname.com', fail: true }, { domain: 'unkname.com', unknownPrice: true }, { domain: 'ownedone.com' }, { domain: 'norecords.com', noRecords: true }]);
    await seedRun(x, [{ domain: 'oldname.com', ageHours: 73 }]);
    await insertOwnedDomain(db, { domain: 'ownedone.com' });
    // a name whose run row says PASS but whose records are not kept: also almost ready (the records are the gate)
    await seedRun(x, [{ domain: 'bareone.com', records: false }]);
    await build(x);
    const l = (await x.get('/candidates/daily')).json();
    expect(l.entries.map((e: any) => e.domain)).toEqual(['goodname.com']);
    expect(l.sections.almost_ready.map((a: any) => a.domain).sort()).toEqual(['bareone.com', 'norecords.com']);
    expect(l.sections.almost_ready.find((a: any) => a.domain === 'norecords.com').missing).toEqual([{ kind: 'tm_us', reason: 'NO_RECORD' }, { kind: 'history', reason: 'NO_RECORD' }]);
    expect(l.sections.almost_ready.find((a: any) => a.domain === 'bareone.com').missing).toEqual([{ kind: 'tm_us', reason: 'NO_RECORD' }, { kind: 'history', reason: 'NO_RECORD' }]);
    expect(l.summary).toMatchObject({ failed_by_check: { brand_lists: 1 }, waiting_for_records: 2, unknown_by_reason: { NO_QUOTE: 1 }, partial: false });
    // a stale record is missing, with the reason
    await db.insertInto('domain_records').values({ domain: 'norecords.com', kind: 'tm_us', record: JSON.stringify({}), checked_by: 'gavriel', checked_at: new Date(x.clock.t - 40 * DAY), created_by: 'gavriel' }).execute();
    await build(x);
    expect((await x.get('/candidates/daily')).json().sections.almost_ready.find((a: any) => a.domain === 'norecords.com').missing[0]).toEqual({ kind: 'tm_us', reason: 'STALE' });
  });

  it('V214-11 upcoming: a drop name still registered, expected to drop within 7 days, that passed everything else; a later drop is not upcoming', async () => {
    const x = await h();
    await seedRun(x, [{ domain: 'dropsoon.com' }, { domain: 'droplater.com' }]);
    // turn the availability row of both into REGISTERED fails and their price/quote into UNKNOWN (what a registered name gives)
    for (const d of ['dropsoon.com', 'droplater.com']) {
      await db.connection().execute(async (conn) => {
        const { sql } = await import('kysely');
        await sql`SET session_replication_role = replica`.execute(conn);
        await sql`UPDATE screening_results SET status = 'FAIL', reason_code = 'REGISTERED' WHERE domain = ${d} AND check_id = 'availability'`.execute(conn);
        await sql`UPDATE screening_results SET status = 'UNKNOWN', reason_code = 'NO_QUOTE' WHERE domain = ${d} AND check_id IN ('quote', 'price')`.execute(conn);
        await sql`SET session_replication_role = origin`.execute(conn);
      });
    }
    await db.insertInto('drop_lists').values({ name: 'dl-up', list_date: '2026-10-06', created_by: 'scout-1', received_n: 2, kept_n: 2 }).execute();
    await db.insertInto('drop_list_rows').values(['dropsoon.com', 'droplater.com'].map((domain) => ({ list_name: 'dl-up', domain, kept: true, reason: null, tokens: ['drop', 'x'] }))).execute();
    await db.insertInto('drop_list_checks').values([['dropsoon.com', '2026-10-09'], ['droplater.com', '2026-10-20']].map(([domain, d]) => ({ list_name: 'dl-up', domain: domain!, checked_at: new Date(x.clock.t), status: 'pending_delete' as const, last_changed: null, expected_drop_date: d!, drop_date_source: 'estimate', reason_code: null }))).execute();
    await build(x);
    const l = (await x.get('/candidates/daily')).json();
    expect(l.entries).toEqual([]);
    expect(l.sections.upcoming).toHaveLength(1);
    expect(l.sections.upcoming[0]).toMatchObject({ domain: 'dropsoon.com', expected_drop_date: '2026-10-09', buyable_from: '2026-10-09', list_name: 'dl-up', missing_records: [], sources: [{ source: 'dl-up', token_name: 'scout-1' }] });
    expect(l.summary.failed_by_check).toEqual({ availability: 2 });
  });

  it('V214-12 same-day rebuild keeps the first build order, appends new names, shows a changed name with its reason and a dropped one in removed_since_first', async () => {
    const x = await h();
    await seedRun(x, [{ domain: 'namea.com', ratio: 3 }, { domain: 'nameb.com', ratio: 2 }, { domain: 'namec.com', ratio: 1 }]);
    await build(x);
    expect((await x.get('/candidates/daily')).json().entries.map((e: any) => e.domain)).toEqual(['namea.com', 'nameb.com', 'namec.com']);
    x.clock.t += 5 * 60_000;
    // a newer run: B now ranks above A and its quote changed; D is new and best; C was bought
    await seedRun(x, [{ domain: 'nameb.com', ratio: 9 }, { domain: 'named.com', ratio: 20 }, { domain: 'namea.com', ratio: 3, registrar: 'namecheap', first_year_cents: 999 }]);
    await insertOwnedDomain(db, { domain: 'namec.com' });
    const second = await build(x);
    expect(second).toMatchObject({ version: 2, entries_n: 3 });
    const l = (await x.get('/candidates/daily')).json();
    expect(l.version).toBe(2);
    expect(l.entries.map((e: any) => [e.rank, e.domain])).toEqual([[1, 'namea.com'], [2, 'nameb.com'], [3, 'named.com']]);
    expect(l.entries[0].changed_since_first).toEqual({ reason: 'STATE_CHANGED', changes: ['price'] });
    expect(l.entries[1].changed_since_first).toBeUndefined();
    expect(l.entries[2].changed_since_first).toBeUndefined();
    expect(l.sections.removed_since_first).toEqual([{ domain: 'namec.com', was_rank: 3, reason: 'OWNED' }]);
    expect(await db.selectFrom('daily_candidate_lists').select('id').execute()).toHaveLength(2);
    await expect(db.updateTable('daily_candidate_lists').set({ day: '2026-01-01' }).execute()).rejects.toThrow(/append-only/);
  });

  it('V214-13 a run that is still running when the wait ends: the list is built from what is done and marked partial', async () => {
    const x = await h();
    await seedRun(x, [{ domain: 'doneone.com' }]);
    const sel = await db.selectFrom('selection_settings').select(['id']).where('label', '=', 'v1').executeTakeFirstOrThrow();
    const rid = `run_${randomUUID()}`;
    await db.insertInto('screening_runs').values({
      id: rid, created_at: new Date(x.clock.t - 60_000), created_by: 'intakeScreening', mode: 'full', backtest: false, settings_id: sel.id, settings_label: 'v1', buy_hold: true, tranche_id: null,
      input: JSON.stringify({ names: [{ idx: 0, domain: 'slowone.com', lane: 'S3', leads_ab: 0 }] }), gate_plan: JSON.stringify({ S3: planFor((await db.selectFrom('selection_settings').select('values').where('label', '=', 'v1').executeTakeFirstOrThrow()).values as never, 'S3') }),
      list_versions: '{}', status: 'running', deadline_at: new Date(x.clock.t + 3_600_000),
    }).execute();
    await db.insertInto('candidate_screenings').values({ intake_id: null, domain: 'slowone.com', origin: 'drop_list', run_id: rid, day: '2026-10-06' }).execute();
    const stuck = { checks: {}, kick: () => {}, runToEnd: () => new Promise<void>(() => {}) } as unknown as ScreeningWorker;
    const r = await new BuildDailyListJob({ db, worker: stuck, now: () => x.clock.t, waitMs: 30 }).runOnce();
    expect(r).toMatchObject({ partial: true, entries_n: 1 });
    expect((await x.get('/candidates/daily')).json().summary.partial).toBe(true);
  });
});
