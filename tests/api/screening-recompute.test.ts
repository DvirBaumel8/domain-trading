// v1.2.0 Task 3: a manual history record recomputes, in the same run, the checks that read history (ext_dates, tier, price, tm_us).
// New rows are appended (generation = the newest dependency row id); the stale rows stay; a manual row is never stale.
import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { DEPENDS_ON, GATE_OF } from '../../src/screening/checks/index.js';
import { planFor, recomputePending, reopenRun, staleChecks, toResultRow } from '../../src/screening/engine.js';
import { outcome, type Check, type CheckId, type ResultRow } from '../../src/screening/types.js';
import { currentLists } from '../../src/screening/lists.js';
import { testDb as db } from '../helpers/db.js';
import { patchActiveSettings, putBrandLists, screeningHarness, type ScreeningHarness } from '../helpers/screening.js';

let app: FastifyInstance | undefined;
afterEach(async () => app?.close());

const DOMAIN = 'officeprepexample.com';
const URL1 = 'https://web.archive.org/web/20150412093000/http://officeprepexample.com/';

type Seed = Partial<Record<CheckId, 'PASS' | 'MANUAL_REQUIRED' | 'UNKNOWN'>>;
interface Setup { x: ScreeningHarness; id: string; calls: Record<string, number> }

/** A finished live S7 run, rows seeded in plan order up to `upTo` (as a run stopped at that check leaves it). Every check is a PASS stub; ext_dates and tier read history like the real ones. */
async function setup(upTo: CheckId = 'tier', over: Seed = { history: 'MANUAL_REQUIRED', tier: 'UNKNOWN' }, plan?: CheckId[]): Promise<Setup> {
  await putBrandLists(['zzbrand'], ['zzbigco'], ['zzevent']);
  const x = await screeningHarness();
  app = x.app;
  const sel = await db.selectFrom('selection_settings').select(['id', 'values']).where('label', '=', 'v1').executeTakeFirstOrThrow();
  const full = plan ?? planFor(sel.values as never, 'S7');
  const lists = await currentLists(db, ['brand', 'bigco']);
  const id = `run_${randomUUID()}`;
  await db.insertInto('screening_runs').values({
    id, created_by: 'test', mode: 'live', backtest: false, settings_id: sel.id, settings_label: 'v1', buy_hold: true, tranche_id: null,
    input: JSON.stringify({ names: [{ idx: 0, domain: DOMAIN, lane: 'S7', leads_ab: 0 }] }),
    gate_plan: JSON.stringify({ S7: full }), list_versions: JSON.stringify(Object.fromEntries(Object.entries(lists).map(([k, v]) => [k, v.version]))),
    status: 'done', deadline_at: new Date(Date.now() + 3_600_000), finished_at: new Date(),
  }).execute();
  for (const check of full.slice(0, full.indexOf(upTo) + 1)) {
    const st = over[check] ?? 'PASS';
    await db.insertInto('screening_results').values({
      run_id: id, item_idx: 0, domain: DOMAIN, lane: 'S7', check_id: check, gate: GATE_OF[check], rule_ids: ['X'],
      status: st, reason_code: st === 'PASS' ? null : st === 'UNKNOWN' ? 'NO_PRIOR_HISTORY' : 'MANUAL_SOURCE', reason: null,
      fields: JSON.stringify(check === 'ext_dates' ? { com_prior_registration: 'unknown' } : {}),
      checked_at: new Date(), settings_label: 'v1', list_versions: '{}', duration_ms: 0, upstream_calls: 0, source: 'auto',
    }).execute();
  }
  const calls: Record<string, number> = {};
  for (const c of full) {
    const stub: Check = {
      id: c, gate: GATE_OF[c], ruleIds: ['X'], lists: [],
      async run(ctx) {
        calls[c] = (calls[c] ?? 0) + 1;
        const h = ctx.latest('history');
        if (c === 'ext_dates') return outcome('PASS', null, null, { com_prior_registration: h?.fields.com_prior_registration ?? 'unknown' });
        if (c === 'tier') return h?.fields.prior_history ? outcome('PASS', null, null, { tier: 'B' }) : outcome('UNKNOWN', 'NO_PRIOR_HISTORY', 'no history');
        return outcome('PASS', null, null);
      },
    };
    x.app.screeningWorker.checks[c] = stub;
  }
  return { x, id, calls };
}

const historyPass = (x: ScreeningHarness, result: object = { first_capture_year: 2015, last_capture_year: 2021, evidence_urls: [URL1] }) => ({
  domain: DOMAIN, check: 'history', checked_at: new Date(x.clock.t - 3_600_000).toISOString(), result: { result: 'PASS', checked_by: 'gavriel', ...result },
});
const rowsOf = async (id: string, check: string) => (await db.selectFrom('screening_results').selectAll().where('run_id', '=', id).where('check_id', '=', check).orderBy('id').execute());
const statusOf = async (id: string) => (await db.selectFrom('screening_runs').select('status').where('id', '=', id).executeTakeFirstOrThrow()).status;

describe('same-run recompute after a manual history record', () => {
  it('a manual history PASS with capture years recomputes ext_dates, tier and price in the same run, appends rows, and ends done', async () => {
    const { x, id } = await setup();
    expect(await rowsOf(id, 'price')).toHaveLength(0);
    const r = await x.post(`/screening/runs/${id}/manual`, historyPass(x));
    expect(r.statusCode).toBe(201);
    expect(r.json().recompute).toBe(true);
    await x.app.screeningWorker.runToEnd(id);
    const body = (await x.get(`/screening/runs/${id}`)).json();
    expect(body.status).toBe('done');
    const tierRows = await rowsOf(id, 'tier');
    expect(tierRows.length).toBe(2);
    expect(tierRows[0]!.status).toBe('UNKNOWN'); // the old row stays
    expect(tierRows[1]!.status).not.toBe('UNKNOWN');
    expect(Number(tierRows[1]!.generation)).toBeGreaterThan(0);
    expect(tierRows[1]!.inputs).toMatchObject({ history: Number((await rowsOf(id, 'history')).at(-1)!.id) });
    expect(await rowsOf(id, 'price')).toHaveLength(1);
    expect(((await rowsOf(id, 'ext_dates')).at(-1)!.fields as any).com_prior_registration).toBe('yes');
    expect(body.names[0].final_status).toBe('would_buy');
  });

  it('manual rows are never stale (a manual tm_us record older than the history record is not recomputed into an auto row)', async () => {
    const { x, id, calls } = await setup();
    const tm = { domain: DOMAIN, check: 'tm_us', checked_at: new Date(x.clock.t - 3_600_000).toISOString(), evidence_url: 'https://tmsearch.uspto.gov/x', result: { phrases_queried: ['OFFICEPREPEXAMPLE'], control_ok: true, exact_or_core_live: [], generic_live: [] } };
    expect((await x.post(`/screening/runs/${id}/manual`, tm)).statusCode).toBe(201);
    const before = (await rowsOf(id, 'tm_us')).length;
    expect((await x.post(`/screening/runs/${id}/manual`, historyPass(x))).json().recompute).toBe(true);
    await x.app.screeningWorker.runToEnd(id);
    const after = await rowsOf(id, 'tm_us');
    expect(after.filter((r) => r.source === 'auto' && Number(r.generation) > 0)).toHaveLength(0);
    expect(after.length).toBeLessThanOrEqual(before + 1); // at most the history route's own re-read of the manual record
    expect(calls.tm_us).toBeUndefined();
    expect(calls.tier).toBe(1);
    const lm = new Map<CheckId, ResultRow>([['tm_us', { id: 1, source: 'manual' } as ResultRow], ['history', { id: 9, source: 'manual' } as ResultRow]]);
    expect([...staleChecks(lm, ['history', 'tm_us'])]).toEqual([]);
  });

  it('a check with dependencies is never served from the cache (a stale recompute calls the check)', async () => {
    await patchActiveSettings(['freshness_hours', 'tier'], 168);
    const { x, id, calls } = await setup();
    // A fresh, cacheable tier PASS for the same name from another run: a first computation would take it.
    const sel = await db.selectFrom('selection_settings').select(['id']).where('label', '=', 'v1').executeTakeFirstOrThrow();
    const oid = `run_${randomUUID()}`;
    await db.insertInto('screening_runs').values({
      id: oid, created_by: 'test', mode: 'live', backtest: false, settings_id: sel.id, settings_label: 'v1', buy_hold: true, tranche_id: null,
      input: JSON.stringify({ names: [{ idx: 0, domain: DOMAIN, lane: 'S7', leads_ab: 0 }] }), gate_plan: JSON.stringify({ S7: ['tier'] }), list_versions: '{}',
      status: 'done', deadline_at: new Date(Date.now() + 3_600_000), finished_at: new Date(),
    }).execute();
    await db.insertInto('screening_results').values({
      run_id: oid, item_idx: 0, domain: DOMAIN, lane: 'S7', check_id: 'tier', gate: 'G8', rule_ids: ['X'], status: 'PASS', reason_code: null, reason: null,
      fields: JSON.stringify({ tier: 'A' }), checked_at: new Date(x.clock.t - 60_000), settings_label: 'v1', list_versions: '{}', duration_ms: 0, upstream_calls: 0, source: 'auto',
    }).execute();
    await x.post(`/screening/runs/${id}/manual`, historyPass(x));
    await x.app.screeningWorker.runToEnd(id);
    expect(calls.tier).toBe(1);
    const t = await rowsOf(id, 'tier');
    expect(t.at(-1)!.source).toBe('auto');
    expect(t.some((r) => r.source === 'cache')).toBe(false);
  });

  it('two history records back to back with a poll in between: one auto row per (check, generation), status ends done, nothing stale left', async () => {
    const { x, id } = await setup();
    const [r1, r2] = await Promise.all([
      x.post(`/screening/runs/${id}/manual`, historyPass(x)),
      x.post(`/screening/runs/${id}/manual`, historyPass(x, { first_capture_year: 2016, last_capture_year: 2020, evidence_urls: [URL1] })),
    ]); // truly concurrent: the run row lock serialises them, the worker is kicked by both
    expect([r1.statusCode, r2.statusCode]).toEqual([201, 201]);
    await x.get(`/screening/runs/${id}`); // a poll while the worker may be running
    await x.app.screeningWorker.runToEnd(id);
    await x.app.screeningWorker.runToEnd(id);
    expect(await statusOf(id)).toBe('done');
    const dup = await db.selectFrom('screening_results').select(['check_id', 'generation']).select((e) => e.fn.countAll().as('n'))
      .where('run_id', '=', id).where('source', '<>', 'manual').groupBy(['check_id', 'generation']).having((e) => e.fn.countAll(), '>', 1).execute();
    expect(dup).toEqual([]);
    const t = await rowsOf(id, 'tier');
    expect(t.length).toBeGreaterThanOrEqual(2);
    expect(t.length).toBeLessThanOrEqual(3);
    const rows = (await db.selectFrom('screening_results').selectAll().where('run_id', '=', id).orderBy('id').execute());
    const run = await db.selectFrom('screening_runs').selectAll().where('id', '=', id).executeTakeFirstOrThrow();
    expect(recomputePending((run.input as any).names, run.gate_plan as any, rows.map(toResultRow), [], true)).toBe(false);
  });

  it('a record on a name whose dependents are not in its plan: recompute false, status unchanged', async () => {
    const { x, id } = await setup('history', { history: 'MANUAL_REQUIRED' }, ['form', 'history']);
    const r = await x.post(`/screening/runs/${id}/manual`, historyPass(x));
    expect(r.statusCode).toBe(201);
    expect(r.json().recompute).toBe(false);
    expect(await statusOf(id)).toBe('done');
  });

  it('a record on a running run kicks it (recompute true); a worker that already finished its pass catches the record before it ends', async () => {
    const { x, id } = await setup();
    await db.updateTable('screening_runs').set({ status: 'running', finished_at: null }).where('id', '=', id).execute();
    const r = await x.post(`/screening/runs/${id}/manual`, historyPass(x));
    expect(r.json().recompute).toBe(true);
    await x.app.screeningWorker.runToEnd(id);
    expect(await statusOf(id)).toBe('done');
    expect((await rowsOf(id, 'tier')).length).toBe(2);
  });

  it('lost update: a history record committed while a dependent is running (between load and its insert) is recomputed against, and the name ends on it', async () => {
    const { x, id } = await setup('ext_dates', { history: 'MANUAL_REQUIRED' });
    await db.updateTable('screening_runs').set({ status: 'running', finished_at: null }).where('id', '=', id).execute();
    const real = x.app.screeningWorker.checks.tier!;
    let posted = false;
    x.app.screeningWorker.checks.tier = { ...real, async run(ctx) {
      const o = await real.run(ctx); // computed from the history the worker read: none yet
      if (!posted) { posted = true; expect((await x.post(`/screening/runs/${id}/manual`, historyPass(x))).statusCode).toBe(201); }
      return o;
    } };
    await x.app.screeningWorker.runToEnd(id);
    await x.app.screeningWorker.runToEnd(id);
    expect(await statusOf(id)).toBe('done');
    const t = await rowsOf(id, 'tier');
    expect(t.map((r) => r.status)).toEqual(['UNKNOWN', 'PASS']);
    expect(t[1]!.generation).not.toBe(t[0]!.generation);
    expect(t[1]!.inputs).toMatchObject({ history: expect.any(Number) }); // the exact dependency rows it was computed from
    expect(await rowsOf(id, 'price')).toHaveLength(1);
    expect((await x.get(`/screening/runs/${id}`)).json().names[0].final_status).toBe('would_buy');
  });

  it('a time-out during a recompute turns the stale dependents UNKNOWN TIMEOUT: the name is neither would_buy nor buy_candidate', async () => {
    const { x, id } = await setup();
    const real = x.app.screeningWorker.checks.ext_dates!;
    x.app.screeningWorker.checks.ext_dates = { ...real, async run(ctx) { const o = await real.run(ctx); x.clock.t += 31 * 60_000; return o; } };
    expect((await x.post(`/screening/runs/${id}/manual`, historyPass(x))).json().recompute).toBe(true);
    await x.app.screeningWorker.runToEnd(id);
    const body = (await x.get(`/screening/runs/${id}`)).json();
    expect(body.status).toBe('partial');
    const t = (await rowsOf(id, 'tier')).at(-1)!;
    expect([t.status, t.reason_code]).toEqual(['UNKNOWN', 'TIMEOUT']);
    expect(body.names[0].final_status).toBe('unknown');
    expect(body.ranking).toEqual([]);
  });

  it('a stale row counts as missing for readers: running while the run runs, unknown once it ended', async () => {
    const { x, id } = await setup('price', {});
    // A manual history record lands (inserted directly: no worker is started) after tier and price were computed without it.
    await db.insertInto('screening_results').values({
      run_id: id, item_idx: 0, domain: DOMAIN, lane: 'S7', check_id: 'history', gate: 'G6', rule_ids: ['X'], status: 'PASS', reason_code: null, reason: null,
      fields: JSON.stringify({ prior_history: 1, manual: true }), checked_at: new Date(), settings_label: 'v1', list_versions: '{}', duration_ms: 0, upstream_calls: 0, source: 'manual', recorded_by: 'gavriel',
    }).execute();
    const view = async () => (await x.get(`/screening/runs/${id}`)).json();
    expect((await view()).names[0].final_status).toBe('unknown'); // finished: the stale checks are missing
    expect((await view()).ranking).toEqual([]);
    await db.updateTable('screening_runs').set({ status: 'running', finished_at: null, heartbeat_at: new Date(x.clock.t) }).where('id', '=', id).execute();
    expect((await view()).names[0].final_status).toBe('running');
  });

  it('a tranche refuses a run that is still running (also one reopened for a recompute)', async () => {
    const { x, id } = await setup('price', {});
    await db.updateTable('screening_runs').set({ status: 'running', finished_at: null, heartbeat_at: new Date(x.clock.t) }).where('id', '=', id).execute();
    const t = (await x.post('/tranches', { name: `T-${randomUUID().slice(0, 6)}` })).json().id as string;
    const r = await x.post(`/tranches/${t}/members`, { action: 'add', domain: DOMAIN, run_id: id });
    expect([r.statusCode, r.json().error.code, r.json().error.details.reason]).toEqual([409, 'NOT_SCREENED_OK', 'RUNNING']);
  });

  it('race: a manual history with a LOWER id than the auto history a dependent read makes the dependent stale (inputs differ), and it is recomputed against the manual row', async () => {
    const { x, id: _ } = await setup('form', {}); // only the harness and stubs are used; the run below is a real live run
    const tierCalls: unknown[] = [];
    const hist = x.app.screeningWorker.checks.history!;
    x.app.screeningWorker.checks.history = { ...hist, async run() { return outcome('MANUAL_REQUIRED', 'MANUAL_SOURCE', null); } };
    const realTier = x.app.screeningWorker.checks.tier!;
    x.app.screeningWorker.checks.tier = { ...realTier, async run(ctx) { tierCalls.push(ctx.latest('history')?.source); return realTier.run(ctx); } };
    const seq = (await sql<{ seq: string }>`select pg_get_serial_sequence('screening_results', 'id') as seq`.execute(db)).rows[0]!.seq;
    const now0 = Number((await sql<{ v: string }>`select last_value as v from screening_results_id_seq`.execute(db)).rows[0]!.v);
    await sql`select setval(${seq}, ${now0 + 100})`.execute(db); // a gap: the run's rows get ids far above the ones the manual record gets below
    const { id: rid, res: created } = await x.run({ mode: 'live', names: [{ domain: DOMAIN, lane: 'S7' }] });
    expect(created.statusCode).toBe(202);
    await x.app.screeningWorker.runToEnd(rid);
    expect(await statusOf(rid)).toBe('done');
    const autoHist = (await rowsOf(rid, 'history')).at(-1)!;
    await sql`select setval(${seq}, ${now0 + 10})`.execute(db);
    const r = await x.post(`/screening/runs/${rid}/manual`, historyPass(x));
    expect(r.statusCode).toBe(201);
    expect(Number(r.json().id ?? 0) || 0).toBeLessThan(Number(autoHist.id)); // the manual row's id is lower than the auto history's
    expect(r.json().recompute).toBe(true);
    await sql`select setval(${seq}, ${now0 + 500})`.execute(db); // later rows get higher ids again
    await x.app.screeningWorker.runToEnd(rid);
    expect(tierCalls.at(-1)).toBe('manual');
    const t = await rowsOf(rid, 'tier');
    expect(t.at(-1)!.status).not.toBe('UNKNOWN');
    expect(await rowsOf(rid, 'price')).toHaveLength(1);
  });

  it('an off-plan dependency counts: a tm_eu FLAG posted after price ran makes price stale and it is recomputed with the risk flag', async () => {
    const { x, id } = await setup('price', {});
    x.app.screeningWorker.checks.price = { ...x.app.screeningWorker.checks.price!, async run(ctx) {
      return outcome('PASS', null, null, { risk: ctx.latest('tm_eu')?.status === 'FLAG' });
    } };
    const eu = { domain: DOMAIN, check: 'tm_eu', checked_at: new Date(x.clock.t - 3_600_000).toISOString(), evidence_url: 'https://euipo.europa.eu/eSearch/', result: {
      phrases_queried: ['OFFICEPREPEXAMPLE'], checked_by: 'dvir', registers: ['euipo', 'wipo', 'ukipo'], register_urls: ['https://euipo.europa.eu/eSearch/'], result: 'hits',
      exact_or_core_live: [], generic_live: [{ mark: 'EXAMPLE', number: '018912345', owner: 'X GmbH', status: 'registered', register: 'wipo' }] } };
    const r = await x.post(`/screening/runs/${id}/manual`, eu);
    expect(r.json()).toMatchObject({ status: 'FLAG', recompute: true });
    await x.app.screeningWorker.runToEnd(id);
    const p = await rowsOf(id, 'price');
    expect(p).toHaveLength(2);
    expect((p[1]!.fields as any).risk).toBe(true);
    expect(await statusOf(id)).toBe('done');
  });

  it('recompute follows the dependencies: history, then web_risk and tm_us records each reopen for price', async () => {
    const { x, id } = await setup();
    expect((await x.post(`/screening/runs/${id}/manual`, historyPass(x))).json().recompute).toBe(true);
    await x.app.screeningWorker.runToEnd(id);
    const wr = { domain: DOMAIN, check: 'web_risk', checked_at: new Date(x.clock.t - 3_600_000).toISOString(), evidence_url: 'https://transparencyreport.google.com/x', result: { raw_status: 1, threat_types: [] } };
    expect((await x.post(`/screening/runs/${id}/manual`, wr)).json().recompute).toBe(true); // price and history read web_risk
    await x.app.screeningWorker.runToEnd(id);
    const tm = { domain: DOMAIN, check: 'tm_us', checked_at: new Date(x.clock.t - 3_600_000).toISOString(), evidence_url: 'https://tmsearch.uspto.gov/x', result: { phrases_queried: ['OFFICEPREPEXAMPLE'], control_ok: true, exact_or_core_live: [], generic_live: [] } };
    expect((await x.post(`/screening/runs/${id}/manual`, tm)).json().recompute).toBe(true); // price reads tm_us
  });

  it('recompute is false for a record no planned check reads (tm_us with a plan of form and history)', async () => {
    const { x, id } = await setup('history', { history: 'MANUAL_REQUIRED' }, ['form', 'history']);
    const tm = { domain: DOMAIN, check: 'tm_us', checked_at: new Date(x.clock.t - 3_600_000).toISOString(), evidence_url: 'https://tmsearch.uspto.gov/x', result: { phrases_queried: ['OFFICEPREPEXAMPLE'], control_ok: true, exact_or_core_live: [], generic_live: [] } };
    const r = await x.post(`/screening/runs/${id}/manual`, tm);
    expect([r.statusCode, r.json().recompute]).toEqual([201, false]);
    expect(await statusOf(id)).toBe('done');
  });

  it('a verdict on a stale FLAG row is refused VERDICT_RESULT_STALE', async () => {
    const { x, id } = await setup('price', {});
    await db.insertInto('screening_results').values({
      run_id: id, item_idx: 0, domain: DOMAIN, lane: 'S7', check_id: 'tm_us', gate: 'G7', rule_ids: ['X'], status: 'FLAG', reason_code: 'TM_GENERIC_HITS', reason: null, generation: '1',
      fields: JSON.stringify({}), checked_at: new Date(), settings_label: 'v1', list_versions: '{}', duration_ms: 0, upstream_calls: 0, source: 'auto',
    }).execute();
    const flag = (await rowsOf(id, 'tm_us')).at(-1)!;
    // history changes after that FLAG was computed: it is stale (legacy row, newer dependency)
    await db.insertInto('screening_results').values({
      run_id: id, item_idx: 0, domain: DOMAIN, lane: 'S7', check_id: 'history', gate: 'G6', rule_ids: ['X'], status: 'PASS', reason_code: null, reason: null,
      fields: JSON.stringify({ prior_history: 1, manual: true }), checked_at: new Date(), settings_label: 'v1', list_versions: '{}', duration_ms: 0, upstream_calls: 0, source: 'manual', recorded_by: 'gavriel',
    }).execute();
    const r = await x.post(`/screening/runs/${id}/verdicts`, { domain: DOMAIN, check: 'tm_us', result_id: Number(flag.id), verdict: 'PASS', reason: 'ok', decided_by: 'dvir', decided_at: new Date(x.clock.t - 1000).toISOString() });
    expect([r.statusCode, r.json().error.code]).toEqual([409, 'VERDICT_RESULT_STALE']);
  });

  it('settings: a dependency listed after its dependent is refused SETTINGS_INVALID', async () => {
    const x = await screeningHarness();
    app = x.app;
    const r = await x.post('/selection/settings', { label: 'v-order', based_on: 'v1', set: { 'run.gates.default': ['form', 'tier', 'history'] } });
    expect(r.statusCode).toBe(422);
    expect(JSON.stringify(r.json())).toMatch(/must come before/);
  });

  it('reopenRun only reopens a finished run, with a fresh deadline', async () => {
    const { id } = await setup('history', { history: 'MANUAL_REQUIRED' }, ['form', 'history']);
    const now = new Date();
    expect(await reopenRun(db, id, now, 30)).toBe(true);
    const run = await db.selectFrom('screening_runs').select(['status', 'finished_at', 'deadline_at']).where('id', '=', id).executeTakeFirstOrThrow();
    expect([run.status, run.finished_at, run.deadline_at.getTime()]).toEqual(['running', null, now.getTime() + 30 * 60_000]);
    expect(await reopenRun(db, id, now, 30)).toBe(false);
  });

  it('DEPENDS_ON and staleChecks: chain staleness, manual never stale, newer dependency only', () => {
    expect(Object.keys(DEPENDS_ON).sort()).toEqual(['ext_dates', 'history', 'price', 'tier', 'tm_us']);
    const row = (check_id: CheckId, id: number, source: 'auto' | 'manual' | 'cache' = 'auto') => [check_id, { id, check_id, source } as ResultRow] as const;
    const plan: CheckId[] = ['form', 'history', 'ext_dates', 'tier', 'price'];
    const latest = new Map([row('form', 1), row('history', 9, 'manual'), row('ext_dates', 3), row('tier', 4), row('price', 5)]);
    expect([...staleChecks(latest, plan)]).toEqual(['ext_dates', 'tier', 'price']); // tier and price are stale through the chain
    latest.set('tier', { id: 20, check_id: 'tier', source: 'manual' } as ResultRow);
    expect([...staleChecks(latest, plan)]).toEqual(['ext_dates', 'price']); // a manual tier is never stale; price (5) is older than it (20)
  });
});
