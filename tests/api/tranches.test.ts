// Task 8: tranches (CAP-04, R6): one open at a time, geo cap on every addition, main-lane quota at close, read-only once closed.
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { GATE_OF } from '../../src/modules/selection/checks/index.js';
import { planFor } from '../../src/modules/selection/engine.js';
import type { Lane } from '../../src/modules/selection/types.js';
import { testDb as db } from '../helpers/db.js';
import { putBrandLists, screeningHarness, type ScreeningHarness } from '../helpers/screening.js';

let app: FastifyInstance | undefined;
afterEach(async () => app?.close());
async function h(): Promise<ScreeningHarness> {
  const x = await screeningHarness();
  app = x.app;
  return x;
}
const members = (id: string) => `/tranches/${id}/members`;

interface Seed { domain: string; lane: Lane; main?: boolean; fail?: boolean; source_lane?: string; city?: string; trade?: string }
/**
 * A finished live run on the FULL plan with every planned check seeded (no network): PASS everywhere, so the name is `would_buy`.
 * `fail` makes the first check FAIL (rejected). S3: `tier` PASS = main lane, FLAG = not. S7: `history` PASS with `source_lane`.
 */
async function seedRun(names: Seed[], over: { backtest?: boolean; checksSubset?: string[] } = {}): Promise<string> {
  const sel = await db.selectFrom('selection_settings').select(['id', 'label', 'values']).where('label', '=', 'v1').executeTakeFirstOrThrow();
  const values = sel.values as never;
  const id = `run_${randomUUID()}`;
  const gate_plan: Record<string, string[]> = {};
  for (const n of names) gate_plan[n.lane] ??= planFor(values, n.lane, over.checksSubset as never);
  await db.insertInto('screening_runs').values({
    id, created_by: 'test', mode: 'live', backtest: over.backtest ?? false, settings_id: sel.id, settings_label: 'v1', buy_hold: true, tranche_id: null,
    input: JSON.stringify({ names: names.map((n, idx) => ({ idx, domain: n.domain, lane: n.lane, leads_ab: 0 })), ...(over.checksSubset && { checks: over.checksSubset }) }),
    gate_plan: JSON.stringify(gate_plan), list_versions: '{}', status: 'done', deadline_at: new Date(Date.now() + 3_600_000), finished_at: new Date(),
  }).execute();
  for (const [idx, n] of names.entries()) {
    for (const [i, check] of gate_plan[n.lane]!.entries()) {
      const fail = n.fail && i === 0;
      const flag = check === 'tier' && n.lane === 'S3' && n.main === false;
      await db.insertInto('screening_results').values({
        run_id: id, item_idx: idx, domain: n.domain, lane: n.lane, check_id: check, gate: GATE_OF[check as keyof typeof GATE_OF], rule_ids: ['X'],
        status: fail ? 'FAIL' : flag ? 'FLAG' : 'PASS', reason_code: fail || flag ? 'X' : null, reason: null,
        fields: JSON.stringify(check === 'history' ? { source_lane: n.source_lane ?? 'unknown' } : {}),
        checked_at: new Date(), settings_label: 'v1', list_versions: '{}', duration_ms: 0, upstream_calls: 0, source: 'auto',
      }).execute();
    }
  }
  return id;
}
const geoSeed = (trade: string): Seed => ({ domain: `tulsa${trade}.com`, lane: 'S2' });
const s3 = (domain: string, main = true): Seed => ({ domain, lane: 'S3', main });

async function open(x: ScreeningHarness, name = 'T1', extra: object = {}) {
  const r = await x.post('/tranches', { name, ...extra });
  expect(r.statusCode).toBe(201);
  return r.json().id as string;
}
/** Direct seed of an active member (quota tests need 15 members with chosen lanes). */
async function seedMember(trancheId: string, runId: string, domain: string, o: { is_geo?: boolean; main_lane?: boolean } = {}) {
  await db.insertInto('tranche_members').values({
    tranche_id: trancheId, domain, lane: o.is_geo ? 'S2' : 'S7', is_geo: o.is_geo ?? false, main_lane: o.main_lane ?? false, run_id: runId, added_by: 'test',
  }).execute();
}

describe('tranches', () => {
  it('open: 201; a second open is 409 TRANCHE_ALREADY_OPEN; the view says what it opened under', async () => {
    const x = await h();
    const id = await open(x);
    expect(id).toMatch(/^trn_[0-9a-f]{12}$/);
    const again = await x.post('/tranches', { name: 'T2' });
    expect(again.statusCode).toBe(409);
    expect(again.json().error.code).toBe('TRANCHE_ALREADY_OPEN');
    const list = (await x.get('/tranches')).json();
    expect(list.tranches).toHaveLength(1);
    expect(list.tranches[0]).toMatchObject({ id, name: 'T1', status: 'open', opened_under: 'v1', counts: { members: 0, geo: 0, main_lane: 0, non_main: 0 } });
    expect(list.tranches[0].settings_version).toBeUndefined();
  });

  it('geo cap on every addition: the default geo_max is 1, so the 2nd geo name is 409 GEO_CAP (a non-geo name still joins)', async () => {
    const x = await h();
    const id = await open(x);
    const run = await seedRun([geoSeed('roofing'), geoSeed('plumbing'), s3('tampapoolsco.com')]);
    const a = await x.post(members(id), { action: 'add', domain: 'tulsaroofing.com', run_id: run });
    expect(a.statusCode).toBe(200);
    expect(a.json()).toMatchObject({ duplicate: false, counts: { members: 1, geo: 1 } });
    const b = await x.post(members(id), { action: 'add', domain: 'tulsaplumbing.com', run_id: run });
    expect(b.statusCode).toBe(409);
    expect(b.json().error).toMatchObject({ code: 'GEO_CAP', details: { geo_max: 1, geo_members: 1 } });
    expect((await x.post(members(id), { action: 'add', domain: 'tampapoolsco.com', run_id: run })).statusCode).toBe(200);
    const dup = await x.post(members(id), { action: 'add', domain: 'tulsaroofing.com', run_id: run });
    expect(dup.json()).toMatchObject({ duplicate: true, counts: { members: 2 } });
  });

  it('NOT_SCREENED_OK: a rejected name, a backtest run, a cut-plan run (PARTIAL_PLAN); unknown run / name / tranche 404, bad domain 422', async () => {
    const x = await h();
    const id = await open(x);
    const run = await seedRun([s3('tampapoolsco.com'), { ...s3('hyphenname.com'), fail: true }]);
    expect((await x.post(members(id), { action: 'add', domain: 'tampapoolsco.com', run_id: run })).statusCode).toBe(200);
    const rej = await x.post(members(id), { action: 'add', domain: 'hyphenname.com', run_id: run });
    expect(rej.statusCode).toBe(409);
    expect(rej.json().error).toMatchObject({ code: 'NOT_SCREENED_OK', details: { final_status: 'rejected' } });
    const bt = await seedRun([s3('austinbarbers.com')], { backtest: true });
    const b = await x.post(members(id), { action: 'add', domain: 'austinbarbers.com', run_id: bt });
    expect(b.statusCode).toBe(409);
    expect(b.json().error).toMatchObject({ code: 'NOT_SCREENED_OK', details: { reason: 'BACKTEST' } });
    // a real run with a checks subset (the engine stores it): form alone passes, but the plan is cut
    await putBrandLists();
    const cut = await x.runDone({ checks: ['form'], names: [{ domain: 'denverwidgets.com', lane: 'S3' }] });
    const c = await x.post(members(id), { action: 'add', domain: 'denverwidgets.com', run_id: cut.id });
    expect(c.statusCode).toBe(409);
    expect(c.json().error).toMatchObject({ code: 'NOT_SCREENED_OK', details: { reason: 'PARTIAL_PLAN' } });
    // a seeded run whose lane plan is narrower than the settings' plan, with no `checks` key, is cut too
    const narrow = await seedRun([s3('miamiwidgets.com')], { checksSubset: ['form'] });
    await db.updateTable('screening_runs').set({ input: JSON.stringify({ names: [{ idx: 0, domain: 'miamiwidgets.com', lane: 'S3', leads_ab: 0 }] }) }).where('id', '=', narrow).execute().catch(() => {});
    expect((await x.post(members(id), { action: 'add', domain: 'miamiwidgets.com', run_id: narrow })).json().error.details.reason).toBe('PARTIAL_PLAN');
    expect((await x.post(members(id), { action: 'add', domain: 'newname.com', run_id: 'run_nope' })).json().error.code).toBe('RUN_NOT_FOUND');
    expect((await x.post(members(id), { action: 'add', domain: 'newname.com', run_id: run })).json().error.code).toBe('NAME_NOT_IN_RUN');
    expect((await x.post(members('trn_000000000000'), { action: 'add', domain: 'tampapoolsco.com', run_id: run })).json().error.code).toBe('TRANCHE_NOT_FOUND');
    expect((await x.post(members(id), { action: 'add', domain: 'tampapoolsco.com' })).statusCode).toBe(422);
    expect((await x.post(members(id), { action: 'add', domain: 'bad_name.com', run_id: run })).statusCode).toBe(422);
  });

  it('main lane: S3 counts when tier PASS; S7 needs history PASS with source_lane expired_drop (fresh and unknown are NOT main-lane)', async () => {
    const x = await h();
    const id = await open(x);
    const run = await seedRun([
      s3('tampapoolsco.com', true), s3('austinbarbers.com', false),
      { domain: 'denverwidgets.com', lane: 'S7', source_lane: 'expired_drop' }, { domain: 'miamiwidgets.com', lane: 'S7', source_lane: 'unknown' },
      { domain: 'renowidgets.com', lane: 'S7', source_lane: 'fresh' },
    ]);
    for (const d of ['tampapoolsco.com', 'austinbarbers.com', 'denverwidgets.com', 'miamiwidgets.com', 'renowidgets.com']) {
      expect((await x.post(members(id), { action: 'add', domain: d, run_id: run })).statusCode).toBe(200);
    }
    const t = (await x.get('/tranches')).json().tranches[0];
    const m = Object.fromEntries(t.members.map((y: any) => [y.domain, y.main_lane]));
    expect(m).toEqual({ 'tampapoolsco.com': true, 'austinbarbers.com': false, 'denverwidgets.com': true, 'miamiwidgets.com': false, 'renowidgets.com': false });
    expect(t.counts).toEqual({ members: 5, geo: 0, main_lane: 2, non_main: 3 });
  });

  it('TRANCHE_FULL at size (15); remove frees a slot', async () => {
    const x = await h();
    const id = await open(x);
    const run = await seedRun([s3('tampapoolsco.com')]);
    for (let i = 0; i < 15; i++) await seedMember(id, run, `m${i}.com`);
    const full = await x.post(members(id), { action: 'add', domain: 'tampapoolsco.com', run_id: run });
    expect(full.statusCode).toBe(409);
    expect(full.json().error).toMatchObject({ code: 'TRANCHE_FULL', details: { size: 15, members: 15 } });
    expect((await x.post(members(id), { action: 'remove', domain: 'm0.com' })).json().counts.members).toBe(14);
    expect((await x.post(members(id), { action: 'remove', domain: 'm0.com' })).json().error.code).toBe('MEMBER_NOT_FOUND');
    expect((await x.post(members(id), { action: 'add', domain: 'tampapoolsco.com', run_id: run })).statusCode).toBe(200);
  });

  it('concurrent adds against geo_max: one wins, one is 409 GEO_CAP', async () => {
    const x = await h();
    const id = await open(x);
    const run = await seedRun([geoSeed('roofing'), geoSeed('plumbing')]);
    const [a, b] = await Promise.all(['tulsaroofing.com', 'tulsaplumbing.com'].map((domain) => x.post(members(id), { action: 'add', domain, run_id: run })));
    expect([a!.statusCode, b!.statusCode].sort()).toEqual([200, 409]);
    expect([a!, b!].find((r) => r.statusCode === 409)!.json().error.code).toBe('GEO_CAP');
  });

  it('concurrent adds against the spend cap: one wins, one is 409 TRANCHE_SPEND_CAP; a concurrent duplicate add is reported as a duplicate', async () => {
    const x = await h();
    const id = await open(x, 'T1', { spend_cap: 30 });
    const run = await seedRun([s3('tampapoolsco.com'), s3('austinbarbers.com')]);
    const doms = ['tampapoolsco.com', 'austinbarbers.com'] as const;
    const rs = await Promise.all(doms.map((domain) => x.post(members(id), { action: 'add', domain, run_id: run, est_cost: 20 })));
    // which add wins the race is not fixed: read the winner from the responses, then assert per winner and per loser
    expect(rs.map((r) => r.statusCode).sort()).toEqual([200, 409]);
    const w = rs.findIndex((r) => r.statusCode === 200);
    const winner = doms[w]!;
    const loser = doms[1 - w]!;
    expect(rs[1 - w]!.json().error.code).toBe('TRANCHE_SPEND_CAP');
    expect(rs[w]!.json()).toMatchObject({ duplicate: false });
    expect((await db.selectFrom('tranche_members').select('domain').where('tranche_id', '=', id).where('removed_at', 'is', null).execute()).map((m) => m.domain)).toEqual([winner]);
    const [d1, d2] = await Promise.all([1, 2].map(() => x.post(members(id), { action: 'add', domain: winner, run_id: run, est_cost: 5 })));
    expect([d1!.statusCode, d2!.statusCode]).toEqual([200, 200]);
    expect([d1!, d2!].map((r) => r.json().duplicate)).toEqual([true, true]);
    const e1 = await Promise.all([1, 2].map(() => x.post(members(id), { action: 'add', domain: loser, run_id: run, est_cost: 5 })));
    expect(e1.map((r) => r.statusCode).sort()).toEqual([200, 200]);
    expect(e1.map((r) => r.json().duplicate).sort()).toEqual([false, true]);
  });

  it('spend_cap and est_cost above the POC cap are 422, never a 500', async () => {
    const x = await h();
    expect((await x.post('/tranches', { name: 'big', spend_cap: 99_999_999_999 })).statusCode).toBe(422);
    expect((await x.post('/tranches', { name: 'big', spend_cap: 1501 })).statusCode).toBe(422);
    const id = await open(x, 'T1', { spend_cap: 1500 });
    const run = await seedRun([s3('tampapoolsco.com')]);
    expect((await x.post(members(id), { action: 'add', domain: 'tampapoolsco.com', run_id: run, est_cost: 99_999_999_999 })).statusCode).toBe(422);
  });
});

describe('close, the main-lane quota and read-only', () => {
  async function full(x: ScreeningHarness, n: number, mainN: number) {
    const id = await open(x);
    const run = await seedRun([s3('tampapoolsco.com')]);
    for (let i = 0; i < n; i++) await seedMember(id, run, `m${i}.com`, { main_lane: i < mainN });
    return id;
  }

  it('15 members with 9 main-lane: 409 MAIN_LANE_QUOTA, no waiver (a reason does not help)', async () => {
    const x = await h();
    const id = await full(x, 15, 9);
    const no = await x.post(`/tranches/${id}/close`, {});
    expect(no.statusCode).toBe(409);
    expect(no.json().error).toMatchObject({ code: 'MAIN_LANE_QUOTA', details: { required_main_lane: 10, main_lane: 9, non_main: 6 } });
    expect((await x.post(`/tranches/${id}/close`, { allow_below_target: true, reason: 'please' })).json().error.code).toBe('MAIN_LANE_QUOTA');
  });

  it('15 members with 10 main-lane: 200 with a close report; then read-only (service and database); the next tranche can open', async () => {
    const x = await h();
    const id = await full(x, 15, 10);
    const ok = await x.post(`/tranches/${id}/close`, {});
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ status: 'closed', close_report: { members: 15, main_lane: 10, required_main_lane: 10, below_target: false, settings_version_used: 'v1' } });
    expect(ok.json().close_report.main_lane_quota).toBeUndefined();
    expect((await x.post(`/tranches/${id}/close`, {})).json().error.code).toBe('TRANCHE_CLOSED');
    expect((await x.post(members(id), { action: 'remove', domain: 'm0.com' })).json().error.code).toBe('TRANCHE_CLOSED');
    // the database refuses too
    await db.connection().execute(async (conn) => {
      await expect(conn.updateTable('tranche_members').set({ removed_at: new Date() }).where('domain', '=', 'm0.com').execute()).rejects.toThrow(/closed and read-only/);
      await expect(conn.updateTable('tranches').set({ name: 'renamed' }).where('id', '=', id).execute()).rejects.toThrow(/closed and read-only/);
    });
    expect((await x.get('/tranches')).json().tranches[0].status).toBe('closed');
    expect((await x.post('/tranches', { name: 'T2' })).statusCode).toBe(201);
  });

  it('on an open tranche the database allows only a one-time removal', async () => {
    const x = await h();
    const id = await full(x, 2, 0);
    await expect(db.updateTable('tranche_members').set({ main_lane: true }).where('domain', '=', 'm0.com').execute()).rejects.toThrow(/can only be removed/);
    await db.updateTable('tranche_members').set({ removed_at: new Date(), removed_by: 'x' }).where('domain', '=', 'm0.com').execute();
    await expect(db.updateTable('tranche_members').set({ removed_by: 'y' }).where('domain', '=', 'm0.com').execute()).rejects.toThrow(/can only be removed/);
    expect(id).toBeTruthy();
  });

  it('below target needs allow_below_target + reason; the share still applies to the members present (3 members need 2 main-lane)', async () => {
    const x = await h();
    const id = await full(x, 3, 1);
    expect((await x.post(`/tranches/${id}/close`, {})).json().error.code).toBe('TRANCHE_BELOW_TARGET');
    expect((await x.post(`/tranches/${id}/close`, { allow_below_target: true })).statusCode).toBe(422);
    const share = await x.post(`/tranches/${id}/close`, { allow_below_target: true, reason: 'only three survived' });
    expect(share.statusCode).toBe(409);
    expect(share.json().error).toMatchObject({ code: 'MAIN_LANE_QUOTA', details: { required_main_lane: 2, main_lane: 1 } });
  });

  it('3 members with 2 main-lane close below target with a reason; /report lists the closed tranche without members', async () => {
    const x = await h();
    const id = await full(x, 3, 2);
    const ok = await x.post(`/tranches/${id}/close`, { allow_below_target: true, reason: 'small batch' });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().close_report).toMatchObject({ below_target: true, reason: 'small batch', main_lane: 2, required_main_lane: 2 });
    const rep = (await x.get('/report')).json();
    expect(rep.tranches).toHaveLength(1);
    expect(rep.tranches[0]).toMatchObject({ id, status: 'closed', counts: { members: 3, main_lane: 2 }, close_report: { below_target: true } });
    expect(rep.tranches[0].members).toBeUndefined();
  });

  it('spend cap: est_cost is required and the sum may not pass the cap; it shows in the view', async () => {
    const x = await h();
    const id = await open(x, 'T1', { spend_cap: 30 });
    const run = await seedRun([s3('tampapoolsco.com'), s3('austinbarbers.com'), s3('denverwidgets.com')]);
    expect((await x.post(members(id), { action: 'add', domain: 'tampapoolsco.com', run_id: run })).statusCode).toBe(422);
    expect((await x.post(members(id), { action: 'add', domain: 'tampapoolsco.com', run_id: run, est_cost: 14 })).statusCode).toBe(200);
    expect((await x.post(members(id), { action: 'add', domain: 'austinbarbers.com', run_id: run, est_cost: 14 })).statusCode).toBe(200);
    expect((await x.post(members(id), { action: 'add', domain: 'denverwidgets.com', run_id: run, est_cost: 14 })).json().error.code).toBe('TRANCHE_SPEND_CAP');
    expect((await x.get('/tranches')).json().tranches[0]).toMatchObject({ spend_cap_cents: 3000, committed_cents: 2800 });
  });
});

describe('screening runs and the geo cap with real members', () => {
  it('an unknown tranche_id on a run: 404; a geo name already in the tranche is not counted against itself; a second geo name fails GEO_CAP', async () => {
    const x = await h();
    await putBrandLists();
    const geo = (trade: string) => ({ domain: `tulsa${trade}.com`, lane: 'S2', city: 'tulsa', state: 'ok', trade });
    const bad = await x.run({ checks: ['form', 'concentration'], tranche_id: 'trn_000000000000', names: [geo('roofing')] });
    expect(bad.res.statusCode).toBe(404);
    expect(bad.res.json().error.code).toBe('TRANCHE_NOT_FOUND');
    const id = await open(x);
    const first = await seedRun([geoSeed('roofing')]);
    expect((await x.post(members(id), { action: 'add', domain: 'tulsaroofing.com', run_id: first })).statusCode).toBe(200);
    const { body } = await x.runDone({ checks: ['form', 'concentration'], tranche_id: id, names: [geo('plumbing'), geo('roofing')] });
    const res = (d: string) => body.names.find((y: any) => y.domain === d).results.find((r: any) => r.check === 'concentration');
    expect(res('tulsaplumbing.com')).toMatchObject({ status: 'FAIL', reason_code: 'GEO_CAP', fields: { details: { tranche_members: 1, cap: 1 } } });
    // the member itself, re-screened: its own membership does not count against it
    expect(res('tulsaroofing.com').reason_code).not.toBe('GEO_CAP');
  });
});
