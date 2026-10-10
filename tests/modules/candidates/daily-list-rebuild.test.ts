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
import { advisoryXactLock } from '../../../src/core/locks.js';
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
  it('v3.9.0: the daily step (BuildDailyListJob) takes the daily_rebuild lock itself; it waits for a holder and builds once it lets go, with version 1 then 2', async () => {
    const x = await h();
    await seedRun(x, [{ domain: 'superpro.com' }]);
    let release!: () => void;
    const holding = new Promise<void>((r) => { release = r; });
    let locked!: () => void;
    const hasLock = new Promise<void>((r) => { locked = r; });
    const holder = db.transaction().execute(async (trx) => { await advisoryXactLock(trx, 'daily_rebuild'); locked(); await holding; });
    await hasLock;
    const job = new BuildDailyListJob({ db, worker: fakeWorker(x), now: () => x.clock.t });
    let done = false;
    const run = job.runOnce().then((r) => { done = true; return r; });
    await new Promise((r) => setTimeout(r, 400));
    expect(done).toBe(false);
    expect(await db.selectFrom('daily_candidate_lists').selectAll().execute()).toHaveLength(0);
    release();
    await holder;
    expect(await run).toMatchObject({ version: 1, entries_n: 1 });
    expect(await job.runOnce()).toMatchObject({ version: 2 });
  });
});
