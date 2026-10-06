// Task 8: tranches (CAP-04, R6): one open at a time, geo cap on every addition, main-lane quota at close, read-only once closed.
import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { testDb as db } from '../helpers/db.js';
import { screeningHarness, type ScreeningHarness } from '../helpers/screening.js';
import { putBrandLists } from '../helpers/screening.js';

let app: FastifyInstance | undefined;
afterEach(async () => app?.close());
async function h(): Promise<ScreeningHarness> {
  const x = await screeningHarness();
  app = x.app;
  return x;
}
const geo = (trade: string) => ({ domain: `tulsa${trade}.com`, lane: 'S2', city: 'tulsa', state: 'ok', trade });
const s3 = (domain: string) => ({ domain, lane: 'S3' });
const members = (id: string) => `/tranches/${id}/members`;

async function open(x: ScreeningHarness, name = 'T1', extra: object = {}) {
  const r = await x.post('/tranches', { name, ...extra });
  expect(r.statusCode).toBe(201);
  return r.json().id as string;
}
/** Names that pass `form` alone (the plan is cut to it): would_buy while buy_hold is on. */
async function screened(x: ScreeningHarness, names: object[]) {
  await putBrandLists();
  return (await x.runDone({ checks: ['form'], names })).id;
}
/** Direct seed of an active member (quota tests need 15 members with chosen lanes). */
async function seedMember(trancheId: string, runId: string, domain: string, o: { is_geo?: boolean; main_lane?: boolean | null } = {}) {
  await db.insertInto('tranche_members').values({
    tranche_id: trancheId, domain, lane: o.is_geo ? 'S2' : 'S7', is_geo: o.is_geo ?? false, main_lane: o.main_lane === undefined ? false : o.main_lane,
    run_id: runId, added_by: 'test',
  }).execute();
}

describe('tranches', () => {
  it('open: 201; a second open is 409 TRANCHE_ALREADY_OPEN; the name is unique', async () => {
    const x = await h();
    const id = await open(x);
    expect(id).toMatch(/^trn_[0-9a-f]{12}$/);
    const again = await x.post('/tranches', { name: 'T2' });
    expect(again.statusCode).toBe(409);
    expect(again.json().error.code).toBe('TRANCHE_ALREADY_OPEN');
    const list = (await x.get('/tranches')).json();
    expect(list.tranches).toHaveLength(1);
    expect(list.tranches[0]).toMatchObject({ id, name: 'T1', status: 'open', counts: { members: 0, geo: 0, main_lane: 0, non_main: 0 } });
  });

  it('geo cap on every addition: the default geo_max is 1, so the 2nd geo name is 409 GEO_CAP (a non-geo name still joins)', async () => {
    const x = await h();
    const id = await open(x);
    const run = await screened(x, [geo('roofing'), geo('plumbing'), s3('tampapoolsco.com')]);
    const a = await x.post(members(id), { action: 'add', domain: 'tulsaroofing.com', run_id: run });
    expect(a.statusCode).toBe(200);
    expect(a.json()).toMatchObject({ duplicate: false, counts: { members: 1, geo: 1 } });
    const b = await x.post(members(id), { action: 'add', domain: 'tulsaplumbing.com', run_id: run });
    expect(b.statusCode).toBe(409);
    expect(b.json().error).toMatchObject({ code: 'GEO_CAP', details: { geo_max: 1, geo_members: 1 } });
    expect((await x.post(members(id), { action: 'add', domain: 'tampapoolsco.com', run_id: run })).statusCode).toBe(200);
    // a duplicate add is a 200 no-op
    const dup = await x.post(members(id), { action: 'add', domain: 'tulsaroofing.com', run_id: run });
    expect(dup.json()).toMatchObject({ duplicate: true, counts: { members: 2 } });
  });

  it('NOT_SCREENED_OK: a rejected name; invalid domain, unknown run / name / tranche 404', async () => {
    const x = await h();
    const id = await open(x);
    const run = await screened(x, [s3('bad_name.com'), s3('tampapoolsco.com')]);
    const bad = await x.post(members(id), { action: 'add', domain: 'bad_name.com', run_id: run });
    expect(bad.statusCode).toBe(422); // not a valid domain at all
    const ok = await x.post(members(id), { action: 'add', domain: 'tampapoolsco.com', run_id: run });
    expect(ok.statusCode).toBe(200);
    const rej = await x.runDone({ checks: ['form'], names: [s3('hyphen-name.com')] });
    const r = await x.post(members(id), { action: 'add', domain: 'hyphen-name.com', run_id: rej.id });
    expect(r.statusCode).toBe(409);
    expect(r.json().error).toMatchObject({ code: 'NOT_SCREENED_OK', details: { final_status: 'rejected' } });
    expect((await x.post(members(id), { action: 'add', domain: 'newname.com', run_id: 'run_nope' })).json().error.code).toBe('RUN_NOT_FOUND');
    expect((await x.post(members('trn_000000000000'), { action: 'add', domain: 'tampapoolsco.com', run_id: run })).json().error.code).toBe('TRANCHE_NOT_FOUND');
    expect((await x.post(members(id), { action: 'add', domain: 'tampapoolsco.com' })).statusCode).toBe(422);
  });

  it('main lane: an S3 name counts when its tier result is PASS; S7 needs history PASS with source_lane expired_drop (unknown source lane = null)', async () => {
    const x = await h();
    const id = await open(x);
    const run = await screened(x, [s3('tampapoolsco.com'), s3('austinbarbers.com'), { domain: 'denverwidgets.com', lane: 'S7' }, { domain: 'miamiwidgets.com', lane: 'S7' }, { domain: 'reno-x.com', lane: 'S7' }]);
    const row = (domain: string, item_idx: number, check_id: string, fields: object) => db.insertInto('screening_results').values({
      run_id: run, item_idx, domain, lane: check_id === 'tier' ? 'S3' : 'S7', check_id, gate: 'G8', rule_ids: ['X'], status: 'PASS', reason_code: null, reason: null,
      fields: JSON.stringify(fields), checked_at: new Date(), settings_label: 'v1', list_versions: '{}', duration_ms: 0, upstream_calls: 0, source: 'auto',
    }).execute();
    await row('tampapoolsco.com', 0, 'tier', {});
    await row('denverwidgets.com', 2, 'history', { source_lane: 'expired_drop' });
    await row('miamiwidgets.com', 3, 'history', { source_lane: 'unknown' });
    for (const d of ['tampapoolsco.com', 'austinbarbers.com', 'denverwidgets.com', 'miamiwidgets.com']) {
      expect((await x.post(members(id), { action: 'add', domain: d, run_id: run })).statusCode).toBe(200);
    }
    const t = (await x.get('/tranches')).json().tranches[0];
    const m = Object.fromEntries(t.members.map((y: any) => [y.domain, y.main_lane]));
    expect(m).toEqual({ 'tampapoolsco.com': true, 'austinbarbers.com': false, 'denverwidgets.com': true, 'miamiwidgets.com': null });
    expect(t.counts).toMatchObject({ members: 4, main_lane: 2, non_main: 1, unknown_main_lane: 1 });
  });

  it('TRANCHE_FULL at size (15); remove frees a slot', async () => {
    const x = await h();
    const id = await open(x);
    const run = await screened(x, [s3('tampapoolsco.com')]);
    for (let i = 0; i < 15; i++) await seedMember(id, run, `m${i}.com`);
    const full = await x.post(members(id), { action: 'add', domain: 'tampapoolsco.com', run_id: run });
    expect(full.statusCode).toBe(409);
    expect(full.json().error).toMatchObject({ code: 'TRANCHE_FULL', details: { size: 15, members: 15 } });
    expect((await x.post(members(id), { action: 'remove', domain: 'm0.com' })).json().counts.members).toBe(14);
    expect((await x.post(members(id), { action: 'remove', domain: 'm0.com' })).json().error.code).toBe('MEMBER_NOT_FOUND');
    expect((await x.post(members(id), { action: 'add', domain: 'tampapoolsco.com', run_id: run })).statusCode).toBe(200);
  });
});

describe('close and the main-lane quota', () => {
  async function full(x: ScreeningHarness, n: number, mainN: number) {
    const id = await open(x);
    const run = await screened(x, [s3('tampapoolsco.com')]);
    for (let i = 0; i < n; i++) await seedMember(id, run, `m${i}.com`, { main_lane: i < mainN });
    return id;
  }

  it('15 members with 9 main-lane: 409 MAIN_LANE_QUOTA; with 10: 200 and a close report; then read-only', async () => {
    const x = await h();
    const id = await full(x, 15, 9);
    const no = await x.post(`/tranches/${id}/close`, {});
    expect(no.statusCode).toBe(409);
    expect(no.json().error).toMatchObject({ code: 'MAIN_LANE_QUOTA', details: { required_main_lane: 10, main_lane: 9, non_main: 6, status: 'FAIL' } });
    await db.updateTable('tranche_members').set({ main_lane: true }).where('domain', '=', 'm14.com').execute();
    const ok = await x.post(`/tranches/${id}/close`, {});
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ status: 'closed', close_report: { members: 15, main_lane: 10, required_main_lane: 10, below_target: false, main_lane_quota: 'MET' } });
    expect((await x.post(`/tranches/${id}/close`, {})).json().error.code).toBe('TRANCHE_CLOSED');
    expect((await x.post(members(id), { action: 'remove', domain: 'm0.com' })).json().error.code).toBe('TRANCHE_CLOSED');
    // a closed tranche is listed, and a new one can open
    expect((await x.get('/tranches')).json().tranches[0].status).toBe('closed');
    expect((await x.post('/tranches', { name: 'T2' })).statusCode).toBe(201);
  });

  it('below target needs allow_below_target + reason; the share still applies to the members present (3 members need 2 main-lane)', async () => {
    const x = await h();
    const id = await full(x, 3, 1);
    const plain = await x.post(`/tranches/${id}/close`, {});
    expect(plain.json().error.code).toBe('TRANCHE_BELOW_TARGET');
    expect((await x.post(`/tranches/${id}/close`, { allow_below_target: true })).statusCode).toBe(422);
    const share = await x.post(`/tranches/${id}/close`, { allow_below_target: true, reason: 'only three survived' });
    expect(share.statusCode).toBe(409);
    expect(share.json().error).toMatchObject({ code: 'MAIN_LANE_QUOTA', details: { required_main_lane: 2, main_lane: 1 } });
    await db.updateTable('tranche_members').set({ main_lane: true }).where('domain', '=', 'm1.com').execute();
    const ok = await x.post(`/tranches/${id}/close`, { allow_below_target: true, reason: 'only three survived' });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().close_report).toMatchObject({ below_target: true, reason: 'only three survived', main_lane: 2, required_main_lane: 2 });
  });

  it('an unknown main-lane share (source lane unknown) needs a reason to close; the report records it', async () => {
    const x = await h();
    const id = await open(x);
    const run = await screened(x, [s3('tampapoolsco.com')]);
    for (let i = 0; i < 2; i++) await seedMember(id, run, `u${i}.com`, { main_lane: null });
    await seedMember(id, run, 'u9.com', { main_lane: true });
    const unk = await x.post(`/tranches/${id}/close`, { allow_below_target: true, reason: 'three names' });
    expect(unk.statusCode).toBe(200); // reason given: accepted unknown
    expect(unk.json().close_report).toMatchObject({ main_lane_quota: 'UNKNOWN_ACCEPTED', unknown_main_lane: 2 });
  });

  it('close without a reason while the share is unknown: 409 MAIN_LANE_QUOTA status UNKNOWN', async () => {
    const x = await h();
    const id = await open(x);
    const run = await screened(x, [s3('tampapoolsco.com')]);
    for (let i = 0; i < 15; i++) await seedMember(id, run, `u${i}.com`, { main_lane: i < 5 ? true : i < 12 ? null : false });
    const r = await x.post(`/tranches/${id}/close`, {});
    expect(r.statusCode).toBe(409);
    expect(r.json().error).toMatchObject({ code: 'MAIN_LANE_QUOTA', details: { status: 'UNKNOWN', required_main_lane: 10 } });
  });

  it('spend cap: est_cost is required and the sum may not pass the cap; it shows in the view', async () => {
    const x = await h();
    const id = await open(x, 'T1', { spend_cap: 30 });
    const run = await screened(x, [s3('tampapoolsco.com'), s3('austinbarbers.com'), s3('denverwidgets.com')]);
    expect((await x.post(members(id), { action: 'add', domain: 'tampapoolsco.com', run_id: run })).statusCode).toBe(422);
    expect((await x.post(members(id), { action: 'add', domain: 'tampapoolsco.com', run_id: run, est_cost: 14 })).statusCode).toBe(200);
    expect((await x.post(members(id), { action: 'add', domain: 'austinbarbers.com', run_id: run, est_cost: 14 })).statusCode).toBe(200);
    const over = await x.post(members(id), { action: 'add', domain: 'denverwidgets.com', run_id: run, est_cost: 14 });
    expect(over.statusCode).toBe(409);
    expect(over.json().error.code).toBe('TRANCHE_SPEND_CAP');
    expect((await x.get('/tranches')).json().tranches[0]).toMatchObject({ spend_cap_cents: 3000, committed_cents: 2800 });
  });

  it('/report lists tranches (closed ones with their close report), without members', async () => {
    const x = await h();
    const id = await full(x, 3, 3);
    await x.post(`/tranches/${id}/close`, { allow_below_target: true, reason: 'small batch' });
    const rep = (await x.get('/report')).json();
    expect(rep.tranches).toHaveLength(1);
    expect(rep.tranches[0]).toMatchObject({ id, status: 'closed', counts: { members: 3, main_lane: 3 }, close_report: { below_target: true } });
    expect(rep.tranches[0].members).toBeUndefined();
  });
});

describe('screening runs and the geo cap with real members', () => {
  it('an unknown tranche_id on a run: 404 TRANCHE_NOT_FOUND; a run with tranche_id and 1 geo member fails a new geo name with GEO_CAP', async () => {
    const x = await h();
    await putBrandLists();
    const bad = await x.run({ checks: ['form', 'concentration'], tranche_id: 'trn_000000000000', names: [geo('roofing')] });
    expect(bad.res.statusCode).toBe(404);
    expect(bad.res.json().error.code).toBe('TRANCHE_NOT_FOUND');
    const id = await open(x);
    const first = await x.runDone({ checks: ['form'], names: [geo('roofing')] });
    expect((await x.post(members(id), { action: 'add', domain: 'tulsaroofing.com', run_id: first.id })).statusCode).toBe(200);
    const { body } = await x.runDone({ checks: ['form', 'concentration'], tranche_id: id, names: [geo('plumbing')] });
    const n = body.names.find((y: any) => y.domain === 'tulsaplumbing.com');
    expect(n.results.find((r: any) => r.check === 'concentration')).toMatchObject({ status: 'FAIL', reason_code: 'GEO_CAP', fields: { details: { tranche_members: 1, cap: 1 } } });
  });
});
