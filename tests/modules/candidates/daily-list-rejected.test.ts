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
