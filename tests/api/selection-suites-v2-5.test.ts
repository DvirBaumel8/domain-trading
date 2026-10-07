// v2.5.0 (CR-007 §21, G-4c/G-4d): any suite id, gates_not_assessed, clears_hold, and hold clearing by the clears_hold suites.
import { sql } from 'kysely';
import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { loadDataLexicon } from '../../src/screening/lexicon.js';
import { makeApp } from '../helpers/app.js';
import { testDb as db } from '../helpers/db.js';
import { issueToken } from '../helpers/tokens.js';

let app: FastifyInstance;
afterEach(async () => app?.close());
const approval = (text: string) => ({ text, approved_at: new Date(Date.now() - 3_600_000).toISOString() });

async function setup() {
  wi = 0;
  let clock = Date.now();
  app = await makeApp({ now: () => clock });
  const w = await issueToken('write', 'gavriel');
  const r = await issueToken('read', 'gizbar');
  const post = (url: string, payload: object) => (clock += 7_000, app.inject({ method: 'POST', url, headers: { ...w.auth, 'idempotency-key': randomUUID() }, payload }));
  const get = (url: string) => app.inject({ method: 'GET', url, headers: r.auth });
  for (const name of ['brand', 'bigco']) expect((await post(`/selection/lists/${name}`, { replace: ['zzqx corp'] })).statusCode).toBe(201);
  return { post, get };
}
type P = Awaited<ReturnType<typeof setup>>['post'];

let wi = 0;
const WORDS = [...loadDataLexicon().dictionary].filter((x) => /^[a-z]{5,6}$/.test(x)).slice(0, 1000);
const nextName = () => { const a = WORDS[wi++]!; const b = WORDS[wi++]!; return `${a}${b}.com`; };
const G = { result: 'PASS', source: 'test fixture', date: '2026-01-01' };
const DATES = { census: '2026-01-01', ext_dates: '2026-01-01', history: '2026-01-01' };
const accepted = { registered_share: 0.8, prior_history: 1, alt_tld_before_n: 0, pre_cls: 'parked', is_geo: 0, input_dates: DATES };
const rejected = { registered_share: 0.1, prior_history: 0, alt_tld_before_n: 0, pre_cls: null, is_geo: 0, input_dates: DATES };
const withGates = (f: object, keys: string[]) => ({ ...f, gates: Object.fromEntries(keys.map((k) => [k, G])) });
const ALL = ['tm_us', 'tn', 'hist2', 'hist2_guard'];

/** 60 sold (soldOk accepted) and 60 dropped (droppedRejected rejected), as test rows with the given gate columns (none by default). */
async function upload(post: P, slice: string, opts: { soldOk?: number; droppedRejected?: number; gates?: string[] } = {}) {
  const { soldOk = 46, droppedRejected = 47, gates = [] } = opts;
  const mk = (label: 'sold' | 'dropped', ok: boolean, i: number) => ({
    domain: nextName(), role: 'test', label, source: 'unit', slice, ...(label === 'sold' && { price_usd: 500 + i }), as_of: '2026-06-01',
    features: withGates(label === 'sold' ? (ok ? accepted : rejected) : (ok ? rejected : accepted), gates),
  });
  const rows = [...Array.from({ length: 60 }, (_, i) => mk('sold', i < soldOk, i)), ...Array.from({ length: 60 }, (_, i) => mk('dropped', i < droppedRejected, i))];
  for (let i = 0; i < rows.length; i += 200) expect((await post('/selection/labelled-names', { rows: rows.slice(i, i + 200) })).statusCode).toBe(200);
}
const ALL_TEXT = 'Dvir: freeze SUITE, no tm_us, tn, hist2 or hist2_guard, clears hold';
const suite = (post: P, id: string, slice: string, extra: object = {}, text = `Dvir: freeze ${id}`) =>
  post('/selection/holdout-suites', { suite: id, slices: [slice], approval_ref: approval(text), ...extra });

describe('suite definitions (G-4c, G-4d)', () => {
  it('SU-1 any well-formed id is frozen with the approval naming it; the response and GET carry gates_not_assessed [] and clears_hold false; SUITE_UNKNOWN is gone', async () => {
    const { post, get } = await setup();
    await upload(post, 's1', { gates: ALL });
    const r = await suite(post, 'EASY-1', 's1');
    expect(r.statusCode, r.body).toBe(201);
    expect(r.json()).toMatchObject({ suite: 'EASY-1', version: 1, gates_not_assessed: [], clears_hold: false, member_count: 120 });
    expect((await get('/selection/holdout-suites')).json().suites[0]).toMatchObject({ suite: 'EASY-1', gates_not_assessed: [], clears_hold: false });
    for (const bad of ['easy-1', 'E', 'A'.repeat(33), '-X', 'A.B']) {
      const b = await suite(post, bad, 's1', {}, `Dvir: freeze ${bad}`);
      expect([b.statusCode, b.json().error.code], bad).toEqual([422, 'VALIDATION_ERROR']);
    }
    const wrong = await suite(post, 'EASY-2', 's1', {}, 'Dvir: freeze EASY-1');
    expect([wrong.statusCode, wrong.json().error.code]).toEqual([422, 'APPROVAL_INVALID']);
  });

  it('SU-2 gates_not_assessed: the approval must name every gate (label boundary), no repeats, only the four gate ids; clears_hold needs the words "clears hold"', async () => {
    const { post, get } = await setup();
    await upload(post, 's1');
    const some = await suite(post, 'NEW-1', 's1', { gates_not_assessed: ['tm_us', 'tn'] }, 'Dvir: freeze NEW-1, tm_us not assessed');
    expect([some.statusCode, some.json().error.code, some.json().error.details]).toEqual([422, 'APPROVAL_INVALID', { gates_not_named: ['tn'] }]);
    const near = await suite(post, 'NEW-1', 's1', { gates_not_assessed: ['hist2'] }, 'Dvir: freeze NEW-1, hist2_guard not assessed');
    expect(near.json().error.details).toEqual({ gates_not_named: ['hist2'] });
    for (const bad of [['tm_us', 'tm_us'], ['tm'], 'tm_us']) expect((await suite(post, 'NEW-1', 's1', { gates_not_assessed: bad })).json().error.code, JSON.stringify(bad)).toBe('VALIDATION_ERROR');
    const noHold = await suite(post, 'NEW-1', 's1', { clears_hold: true });
    expect([noHold.statusCode, noHold.json().error.code, noHold.json().error.details]).toEqual([422, 'APPROVAL_INVALID', { missing_phrase: 'clears hold' }]);
    const ok = await suite(post, 'NEW-1', 's1', { gates_not_assessed: ['tm_us', 'tn'], clears_hold: true }, 'Dvir: freeze NEW-1; tm_us and tn not assessed; it Clears Hold');
    expect(ok.statusCode, ok.body).toBe(201);
    expect(ok.json()).toMatchObject({ gates_not_assessed: ['tm_us', 'tn'], clears_hold: true });
    expect((await get('/selection/holdout-suites')).json().suites[0]).toMatchObject({ gates_not_assessed: ['tm_us', 'tn'], clears_hold: true });
    const row = await db.selectFrom('holdout_suites').select(['gates_not_assessed', 'clears_hold']).executeTakeFirstOrThrow();
    expect(row).toEqual({ gates_not_assessed: ['tm_us', 'tn'], clears_hold: true });
  });

  it('SU-3 a suite needs a frozen definition for a holdout replay: required suite without one SUITE_NOT_DEFINED, any other id SUITE_UNKNOWN (with required_suites)', async () => {
    const { post } = await setup();
    const a = await post('/selection/replays', { suite: 'BT10-1', mode: 'holdout' });
    expect([a.statusCode, a.json().error.code]).toEqual([422, 'SUITE_NOT_DEFINED']);
    const b = await post('/selection/replays', { suite: 'NOPE-1', mode: 'holdout' });
    expect([b.statusCode, b.json().error.code, b.json().error.details.required_suites]).toEqual([422, 'SUITE_UNKNOWN', ['BT10-1', 'BT10-9', 'BT10-11']]);
  });

  it('SU-4 holdout replay with all four gates not assessed: no gate columns needed, report names them and accepts_at_risk; only the assessed gates are required otherwise', async () => {
    const { post } = await setup();
    await upload(post, 'g0'); // no gate columns at all
    await upload(post, 'g0b');
    await upload(post, 'g3', { gates: ['tm_us', 'hist2', 'hist2_guard'] }); // all but tn
    expect((await suite(post, 'NG-ALL', 'g0', { gates_not_assessed: ALL }, ALL_TEXT.replace('SUITE', 'NG-ALL'))).statusCode).toBe(201);
    const r = await post('/selection/replays', { suite: 'NG-ALL', mode: 'holdout' });
    expect(r.statusCode, r.body).toBe(201);
    expect(r.json()).toMatchObject({ gates_applied: true, pass: true });
    // 46 sold accepted + 13 dropped accepted (60 - 47 rejected)
    expect(r.json().report).toMatchObject({ gates_not_assessed: ALL, accepts_at_risk: 59, judged: { sold: { accepted: 46, undecided: 0 }, dropped: { rejected: 47, undecided: 0 } } });

    // one gate left out: the other three are still required (and apply), REPLAY_INVALID_NO_GATES lists only those
    expect((await suite(post, 'NG-TN', 'g0b', { gates_not_assessed: ['tn'] }, 'Dvir: freeze NG-TN, tn not assessed')).statusCode).toBe(201);
    const miss = await post('/selection/replays', { suite: 'NG-TN', mode: 'holdout' });
    expect([miss.statusCode, miss.json().error.code]).toEqual([422, 'REPLAY_INVALID_NO_GATES']);
    expect(miss.json().error.details.required.slice(0, 3)).toEqual(['tm_us', 'hist2', 'hist2_guard']);
    expect(miss.json().error.details.rows[0].missing).toEqual(['tm_us', 'hist2', 'hist2_guard']);
    expect((await suite(post, 'NG-TN3', 'g3', { gates_not_assessed: ['tn'] }, 'Dvir: freeze NG-TN3, tn not assessed')).statusCode).toBe(201);
    const ok = await post('/selection/replays', { suite: 'NG-TN3', mode: 'holdout' });
    expect(ok.statusCode, ok.body).toBe(201);
    expect(ok.json().report).toMatchObject({ gates_not_assessed: ['tn'], accepts_at_risk: 59 });

    // a plain suite (no gates left out) still needs all four and reports none at risk
    await upload(post, 'g4', { gates: ALL });
    expect((await suite(post, 'PLAIN-1', 'g4')).statusCode).toBe(201);
    const plain = await post('/selection/replays', { suite: 'PLAIN-1', mode: 'holdout' });
    expect(plain.json().report).toMatchObject({ gates_not_assessed: [], accepts_at_risk: 0 });
    expect(plain.json().pass).toBe(true);
  });

  it('SU-5 a gate left out is neither applied nor makes a row undecided: a failing gate result on it does not reject, a missing one does not hold the accept back', async () => {
    const { post } = await setup();
    const fail = { result: 'FAIL', source: 'fixture', date: '2026-01-01' };
    await upload(post, 'x1', { gates: ['tm_us', 'hist2', 'hist2_guard'] });
    // every row of the slice also carries a FAILing tn result; leaving tn out must ignore it
    await db.connection().execute(async (c) => {
      await sql`SET session_replication_role = replica`.execute(c);
      await sql`UPDATE labelled_names SET features = jsonb_set(features, '{gates,tn}', ${JSON.stringify(fail)}::jsonb) WHERE slice = 'x1'`.execute(c);
      await sql`SET session_replication_role = origin`.execute(c);
    });
    expect((await suite(post, 'IGN-TN', 'x1', { gates_not_assessed: ['tn'] }, 'Dvir: freeze IGN-TN, tn not assessed')).statusCode).toBe(201);
    const r = await post('/selection/replays', { suite: 'IGN-TN', mode: 'holdout' });
    expect(r.json().report.judged).toMatchObject({ sold: { accepted: 46, undecided: 0 }, dropped: { rejected: 47 } });
  });
});

describe('hold clearing with clears_hold suites (G-4d)', () => {
  const draft = async (post: P) => expect((await post('/selection/settings', { label: 'v2', set: { buy_hold: false }, note: 'clear the hold' })).statusCode).toBe(201);

  it('HC-1 without clears_hold suites the required suites decide (hold_suites_source required_suites)', async () => {
    const { get } = await setup();
    expect((await get('/selection/buy-hold')).json()).toMatchObject({ hold_suites: ['BT10-1', 'BT10-9', 'BT10-11'], hold_suites_source: 'required_suites', clearable: false });
  });

  it('HC-2 the latest definitions with clears_hold are the hold suites; one passing suite clears the draft for activation; the required suites are not consulted', async () => {
    const { post, get } = await setup();
    await upload(post, 's1');
    await draft(post);
    expect((await suite(post, 'HOLD-1', 's1', { gates_not_assessed: ALL, clears_hold: true }, 'Dvir: freeze HOLD-1, tm_us tn hist2 hist2_guard not assessed, clears hold')).statusCode).toBe(201);
    const before = (await get('/selection/buy-hold?settings=v2')).json();
    expect(before).toMatchObject({ hold_suites: ['HOLD-1'], hold_suites_source: 'clears_hold', clearable: false });
    expect(before.required_suites).toEqual([expect.objectContaining({ suite: 'HOLD-1', pass: false, replay_id: null })]);
    const early = await post('/selection/settings/v2/activate', { approval_ref: approval('Dvir: activate v2') });
    expect([early.statusCode, early.json().error.code]).toEqual([409, 'HOLDOUT_NOT_PASSED']);
    const rep = await post('/selection/replays', { suite: 'HOLD-1', mode: 'holdout', settings: 'v2' });
    expect([rep.statusCode, rep.json().pass]).toEqual([201, true]);
    expect((await get('/selection/buy-hold?settings=v2')).json()).toMatchObject({ clearable: true, hold_suites: ['HOLD-1'], required_suites: [expect.objectContaining({ suite: 'HOLD-1', pass: true })] });
    const ok = await post('/selection/settings/v2/activate', { approval_ref: approval('Dvir: activate v2') });
    expect(ok.statusCode, ok.body).toBe(200);
    expect((await get('/selection/buy-hold')).json()).toMatchObject({ buy_hold: false, settings_version: 'v2' });
  });

  it('HC-3 a failed replay of a clears_hold suite sticks; with two clears_hold suites both must pass; a later definition without clears_hold takes the suite out', async () => {
    const { post, get } = await setup();
    await upload(post, 's1');
    await upload(post, 'hard', { soldOk: 40 });
    await draft(post);
    const t = (id: string) => `Dvir: freeze ${id}, tm_us tn hist2 hist2_guard not assessed, clears hold`;
    expect((await suite(post, 'HOLD-1', 's1', { gates_not_assessed: ALL, clears_hold: true }, t('HOLD-1'))).statusCode).toBe(201);
    expect((await suite(post, 'HOLD-2', 'hard', { gates_not_assessed: ALL, clears_hold: true }, t('HOLD-2'))).statusCode).toBe(201);
    expect((await post('/selection/replays', { suite: 'HOLD-1', mode: 'holdout', settings: 'v2' })).json().pass).toBe(true);
    const failed = await post('/selection/replays', { suite: 'HOLD-2', mode: 'holdout', settings: 'v2' });
    expect([failed.statusCode, failed.json().pass]).toEqual([201, false]);
    const bh = (await get('/selection/buy-hold?settings=v2')).json();
    expect(bh).toMatchObject({ hold_suites: ['HOLD-1', 'HOLD-2'], clearable: false });
    expect(bh.required_suites[1]).toMatchObject({ suite: 'HOLD-2', pass: false, failed_before: true });
    const act = await post('/selection/settings/v2/activate', { approval_ref: approval('Dvir: activate v2') });
    expect([act.statusCode, act.json().error.code]).toEqual([409, 'HOLDOUT_NOT_PASSED']);
    // the definition of a scored suite is final (SUITE_ALREADY_SCORED), so the failure cannot be dropped by redefining it
    const redo = await suite(post, 'HOLD-2', 's1', { gates_not_assessed: ALL, clears_hold: false }, 'Dvir: freeze HOLD-2, tm_us tn hist2 hist2_guard not assessed');
    expect([redo.statusCode, redo.json().error.code]).toEqual([409, 'SUITE_ALREADY_SCORED']);
  });

  it('HC-4 a not yet scored suite can be redefined without clears_hold (latest definition wins): the other suites decide', async () => {
    const { post, get } = await setup();
    await upload(post, 's1');
    await upload(post, 's2');
    await draft(post);
    const t = (id: string) => `Dvir: freeze ${id}, tm_us tn hist2 hist2_guard not assessed, clears hold`;
    expect((await suite(post, 'HOLD-1', 's1', { gates_not_assessed: ALL, clears_hold: true }, t('HOLD-1'))).statusCode).toBe(201);
    expect((await suite(post, 'HOLD-2', 's2', { gates_not_assessed: ALL, clears_hold: true }, t('HOLD-2'))).statusCode).toBe(201);
    expect((await get('/selection/buy-hold?settings=v2')).json().hold_suites).toEqual(['HOLD-1', 'HOLD-2']);
    expect((await suite(post, 'HOLD-2', 's2', { gates_not_assessed: ALL }, 'Dvir: freeze HOLD-2, tm_us tn hist2 hist2_guard not assessed')).json()).toMatchObject({ version: 2, clears_hold: false });
    expect((await get('/selection/buy-hold?settings=v2')).json()).toMatchObject({ hold_suites: ['HOLD-1'], hold_suites_source: 'clears_hold' });
  });
});
