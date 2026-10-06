// CAP-21a through the API: name registry, diagnostic vs holdout replay, hold-clearing gate (CR-002 CAP-21, Amendment A2/A3).
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
  return { post, get };
}

// Names made of two dictionary words, so the CAP-01 recompute in holdout mode splits them.
let wi = 0;
const WORDS = [...loadDataLexicon().dictionary].filter((x) => /^[a-z]{5,6}$/.test(x)).slice(0, 1000);
const nextName = () => { const a = WORDS[wi++]!; const b = WORDS[wi++]!; return `${a}${b}.com`; };

const G = { result: 'PASS', source: 'test fixture', date: '2026-01-01' };
const gates = { tm_us: G, tn: G, hist2: G, hist2_guard: G };
const accepted = { registered_share: 0.8, prior_history: 1, alt_tld_before_n: 0, pre_cls: 'parked', is_geo: 0, input_dates: { census: '2026-01-01' }, gates };
const rejected = { registered_share: 0.1, prior_history: 0, alt_tld_before_n: 0, pre_cls: null, is_geo: 0, input_dates: { census: '2026-01-01' }, gates };

interface Spec { label: 'sold' | 'dropped'; ok: boolean; role?: 'fit' | 'dev' | 'test'; slice: string; price_usd?: number; features?: object; as_of?: string | null }
const mk = (s: Spec) => ({
  domain: nextName(), role: s.role ?? 'test', label: s.label, source: 'unit', slice: s.slice, ...(s.price_usd !== undefined && { price_usd: s.price_usd }),
  as_of: s.as_of === undefined ? '2026-06-01' : s.as_of, features: s.features ?? (s.label === 'sold' ? (s.ok ? accepted : rejected) : (s.ok ? rejected : accepted)),
});
/** `sold` names accepted out of 60 sold; `dropped` names rejected out of 60 dropped. */
const suiteRows = (slice: string, soldOk = 46, droppedRejected = 47) => [
  ...Array.from({ length: 60 }, (_, i) => mk({ label: 'sold', ok: i < soldOk, slice, price_usd: 500 + i })),
  ...Array.from({ length: 60 }, (_, i) => mk({ label: 'dropped', ok: i < droppedRejected, slice })),
];

async function upload(post: Awaited<ReturnType<typeof setup>>['post'], rows: object[]) {
  for (let i = 0; i < rows.length; i += 200) {
    const r = await post('/selection/labelled-names', { rows: rows.slice(i, i + 200) });
    expect(r.statusCode, r.body).toBe(200);
  }
}
async function lists(post: Awaited<ReturnType<typeof setup>>['post']) {
  for (const name of ['brand', 'bigco']) expect((await post(`/selection/lists/${name}`, { replace: ['zzqx corp'] })).statusCode).toBe(201);
}

describe('labelled names registry', () => {
  it('records once: an identical re-upload is a duplicate, any difference is a conflict, nothing is overwritten', async () => {
    const { post } = await setup();
    const row = mk({ label: 'sold', ok: true, slice: 'a' });
    expect((await post('/selection/labelled-names', { rows: [row] })).json()).toEqual({ inserted: 1, duplicates: 0, conflicts: [] });
    expect((await post('/selection/labelled-names', { rows: [row] })).json()).toEqual({ inserted: 0, duplicates: 1, conflicts: [] });
    const r = await post('/selection/labelled-names', { rows: [{ ...row, role: 'test' as const, slice: 'b' }, { ...row, domain: row.domain.toUpperCase(), label: 'dropped' }] });
    expect(r.json()).toEqual({ inserted: 0, duplicates: 0, conflicts: [{ domain: row.domain, existing_role: 'test' }, { domain: row.domain, existing_role: 'test' }] });
    const stored = await db.selectFrom('labelled_names').selectAll().execute();
    expect(stored).toHaveLength(1);
    expect([stored[0]!.slice, stored[0]!.label]).toEqual(['a', 'sold']);
  });

  it('the table is append-only in the database', async () => {
    const { post } = await setup();
    await post('/selection/labelled-names', { rows: [mk({ label: 'sold', ok: true, slice: 'a' })] });
    await expect(db.updateTable('labelled_names').set({ role: 'fit' }).execute()).rejects.toThrow();
    await expect(db.deleteFrom('labelled_names').execute()).rejects.toThrow();
  });

  it('invalid rows: 422 per row, nothing recorded', async () => {
    const { post } = await setup();
    const good = mk({ label: 'sold', ok: true, slice: 'a' });
    const r = await post('/selection/labelled-names', { rows: [good, { ...good, domain: 'bad domain.com' }, { ...good, domain: 'ok.com', role: 'maybe' }, { ...good, domain: 'other.org' }] });
    expect(r.statusCode).toBe(422);
    expect(r.json().error.code).toBe('ROWS_INVALID');
    expect(r.json().error.details.rows.map((x: { index: number }) => x.index)).toEqual([1, 2, 3]);
    expect(await db.selectFrom('labelled_names').select('domain').execute()).toEqual([]);
    expect((await post('/selection/labelled-names', { rows: [] })).statusCode).toBe(422);
  });

  it('accepts a CSV body in the features.csv columns', async () => {
    const { post } = await setup();
    const csv = 'domain,label,slice,role,registered_share,prior_history,pre_cls,alt_tld_before_n,n_words,sld_chars,geo_city,geo_trade,as_of\nnetextend.com,sold,fit-dataset,fit,0.65,1,content,0,2,9,,,2026-08-27\n';
    expect((await post('/selection/labelled-names', { csv })).json()).toEqual({ inserted: 1, duplicates: 0, conflicts: [] });
    const row = await db.selectFrom('labelled_names').selectAll().executeTakeFirstOrThrow();
    expect([row.role, row.source, row.as_of]).toEqual(['fit', 'fit-dataset', '2026-08-27']);
  });
});

describe('replay', () => {
  it('diagnostic: 46/60 sold accepted and 47/60 dropped rejected is reported but can never count toward the hold', async () => {
    const { post, get } = await setup();
    await upload(post, suiteRows('s1').map((r) => ({ ...r, features: { ...r.features, gates: undefined } })));
    const r = await post('/selection/replays', { suite: 'BT10-1', mode: 'diagnostic', slices: ['s1'] });
    expect(r.statusCode, r.body).toBe(201);
    const b = r.json();
    expect([b.mode, b.gates_applied, b.pass, b.report.gates_applied, b.report.counts_toward_buy_hold]).toEqual(['diagnostic', false, false, false, false]);
    expect(b.report.pooled.sold).toMatchObject({ n: 60, accepted: 46, undecided: 0 });
    expect(b.report.pooled.dropped).toMatchObject({ n: 60, rejected: 47 });
    expect(b.report.pooled.meets_thresholds).toBe(true);
    expect(Object.keys(b.report.by_band).sort()).toEqual(['<$1000']);
    const bh = (await get('/selection/buy-hold')).json();
    expect(bh.required_suites.find((s: { suite: string }) => s.suite === 'BT10-1')).toMatchObject({ replay_id: null, pass: false });
    expect(bh.clearable).toBe(false);
    expect((await get(`/selection/replays/${b.replay_id}`)).json()).toMatchObject({ replay_id: b.replay_id, suite: 'BT10-1', mode: 'diagnostic', pass: false });
    expect((await get('/selection/replays/rpl_000000000000')).json().error.code).toBe('REPLAY_NOT_FOUND');
  });

  it('holdout: passes at 46/60 and 47/60, shows accept/reject before and after the gates', async () => {
    const { post } = await setup();
    await lists(post);
    await upload(post, suiteRows('s1'));
    const r = await post('/selection/replays', { suite: 'BT10-1', mode: 'holdout', slices: ['s1'] });
    expect(r.statusCode, r.body).toBe(201);
    const b = r.json();
    expect([b.mode, b.gates_applied, b.pass, b.settings_version]).toEqual(['holdout', true, true, 'v1']);
    expect(b.report.pooled.sold).toMatchObject({ n: 60, accepted: 46, accept_rate: 46 / 60 });
    expect(b.report.before_gates.pooled.sold.accepted).toBe(46);
    expect(b.report.leakage_lint).toMatchObject({ rows_checked: 120, rows_leaking: 0 });
    expect(b.report.precision_at).toBeUndefined();
    expect(Object.keys(b.report.pooled.precision_at)).toEqual(['0.01', '0.02']);
  });

  it('holdout: a failing gate turns an accept into a reject; before/after differ', async () => {
    const { post } = await setup();
    await lists(post);
    const bad = { ...accepted, gates: { ...gates, tm_us: { ...G, result: 'FAIL' } } };
    await upload(post, [
      ...Array.from({ length: 50 }, () => mk({ label: 'sold', ok: true, slice: 'g' })),
      ...Array.from({ length: 10 }, () => mk({ label: 'sold', ok: true, slice: 'g', features: bad })),
      ...Array.from({ length: 50 }, () => mk({ label: 'dropped', ok: true, slice: 'g', features: rejected })),
    ]);
    const b = (await post('/selection/replays', { suite: 'BT10-1', mode: 'holdout', slices: ['g'] })).json();
    expect(b.report.before_gates.pooled.sold.accepted).toBe(60);
    expect(b.report.pooled.sold).toMatchObject({ accepted: 50, rejected: 10 });
  });

  it('holdout: a brand list hit rejects, and a missing brand list makes an accept undecided', async () => {
    const { post } = await setup();
    const name = nextName();
    const sld = name.slice(0, -4);
    await upload(post, [{ ...mk({ label: 'sold', ok: true, slice: 'b' }), domain: name }]);
    const noLists = (await post('/selection/replays', { suite: 'X', mode: 'holdout', slices: ['b'] })).json();
    expect(noLists.report.pooled.sold).toMatchObject({ accepted: 0, undecided: 1 });
    expect(noLists.report.before_gates.pooled.sold.accepted).toBe(1);
    expect((await post('/selection/lists/brand', { replace: [sld] })).statusCode).toBe(201);
    expect((await post('/selection/lists/bigco', { replace: ['zzqx corp'] })).statusCode).toBe(201);
    const hit = (await post('/selection/replays', { suite: 'Y', mode: 'holdout', slices: ['b'] })).json();
    expect(hit.report.pooled.sold).toMatchObject({ accepted: 0, rejected: 1 });
  });

  it('holdout without gate columns: 422 REPLAY_INVALID_NO_GATES; without as_of: 422 AS_OF_REQUIRED; diagnostic still runs', async () => {
    const { post } = await setup();
    await upload(post, [mk({ label: 'sold', ok: true, slice: 'n', features: { ...accepted, gates: undefined } }), mk({ label: 'dropped', ok: true, slice: 'n', features: { ...rejected, gates: { tm_us: G } } })]);
    const r = await post('/selection/replays', { suite: 'BT10-1', mode: 'holdout', slices: ['n'] });
    expect([r.statusCode, r.json().error.code]).toEqual([422, 'REPLAY_INVALID_NO_GATES']);
    expect(r.json().error.details.count).toBe(2);
    expect(r.json().error.details.rows.map((x: { missing: string[] }) => x.missing.length)).toEqual([4, 3]);
    await upload(post, [mk({ label: 'sold', ok: true, slice: 'na', as_of: null })]);
    expect((await post('/selection/replays', { suite: 'BT10-1', mode: 'holdout', slices: ['na'] })).json().error.code).toBe('AS_OF_REQUIRED');
    expect((await post('/selection/replays', { suite: 'BT10-1', mode: 'diagnostic', slices: ['n'] })).statusCode).toBe(201);
  });

  it('holdout containing a fit or dev name is refused (HOLDOUT_CONTAMINATED); REPLAY_EMPTY when nothing matches', async () => {
    const { post } = await setup();
    const fit = mk({ label: 'sold', ok: true, slice: 'f', role: 'fit' });
    const dev = mk({ label: 'dropped', ok: true, slice: 'f', role: 'dev' });
    await upload(post, [fit, dev, ...suiteRows('t', 5, 5)]);
    const r = await post('/selection/replays', { suite: 'BT10-1', mode: 'holdout', domains: [fit.domain, dev.domain] });
    expect([r.statusCode, r.json().error.code]).toEqual([422, 'HOLDOUT_CONTAMINATED']);
    expect(r.json().error.details.domains.sort()).toEqual([fit.domain, dev.domain].sort());
    expect((await post('/selection/replays', { suite: 'BT10-1', mode: 'holdout', slices: ['f', 't'] })).json().error.code).toBe('HOLDOUT_CONTAMINATED');
    expect((await post('/selection/replays', { suite: 'BT10-1', mode: 'diagnostic', slices: ['f'] })).statusCode).toBe(201);
    expect((await post('/selection/replays', { suite: 'BT10-1', mode: 'diagnostic', slices: ['nothing'] })).json().error.code).toBe('REPLAY_EMPTY');
  });

  it('leakage: a gate or input dated at or after as_of makes the holdout fail even at 100% / 100%', async () => {
    const { post } = await setup();
    await lists(post);
    const late = { ...accepted, input_dates: { census: '2026-06-01' } };
    await upload(post, [
      ...Array.from({ length: 50 }, () => mk({ label: 'sold', ok: true, slice: 'l', features: late })),
      ...Array.from({ length: 50 }, () => mk({ label: 'dropped', ok: false, slice: 'l', features: rejected })),
    ]);
    const b = (await post('/selection/replays', { suite: 'BT10-1', mode: 'holdout', slices: ['l'] })).json();
    expect([b.report.pooled.meets_thresholds, b.report.leakage_lint.rows_leaking, b.pass]).toEqual([true, 50, false]);
  });

  it('profit report: PROFIT_REPORT_INCOMPLETE without prices; four figures with them', async () => {
    const { post } = await setup();
    await upload(post, [
      ...Array.from({ length: 6 }, (_, i) => mk({ label: 'sold', ok: true, slice: 'p', price_usd: 5000 - i * 100, features: { ...accepted, gates: undefined } })),
      ...Array.from({ length: 4 }, (_, i) => mk({ label: 'dropped', ok: i < 2, slice: 'p', features: { ...(i < 2 ? rejected : accepted), gates: undefined } })),
      mk({ label: 'sold', ok: true, slice: 'q', features: { ...accepted, gates: undefined } }),
    ]);
    const bad = await post('/selection/replays', { suite: 'P', mode: 'diagnostic', slices: ['q'], profit: true });
    expect([bad.statusCode, bad.json().error.code]).toEqual([422, 'PROFIT_REPORT_INCOMPLETE']);
    const ok = await post('/selection/replays', { suite: 'P', mode: 'diagnostic', slices: ['p'], profit: true });
    expect(ok.statusCode, ok.body).toBe(201);
    const p = ok.json().report.profit;
    expect(p.as_computed.gross_cents).toBe(2_850_000);
    expect(p.without_top3.gross_cents).toBe(4700 * 100 + 4600 * 100 + 4500 * 100 - 0);
    expect(p.bin_capped.gross_cents).toBe(6 * 148_800);
    expect(p.as_computed.break_even_base_rate).toBeGreaterThan(0);
  });
});

describe('hold-clearing gate', () => {
  it('clears only when all three suites pass for that draft AND Dvir approves; DOM never clears it itself', async () => {
    const { post, get } = await setup();
    await lists(post);
    await upload(post, [...suiteRows('s1'), ...suiteRows('s2'), ...suiteRows('s3')]);
    const d = await post('/selection/settings', { label: 'v2', set: { buy_hold: false }, note: 'clear the hold' });
    expect(d.statusCode, d.body).toBe(201);
    const run = (suite: string, slice: string, settings = 'v2') => post('/selection/replays', { suite, mode: 'holdout', slices: [slice], settings });

    const one = await run('BT10-1', 's1');
    expect([one.statusCode, one.json().pass]).toEqual([201, true]);
    const early = await post('/selection/settings/v2/activate', { approval_ref: approval('Dvir: activate v2') });
    expect([early.statusCode, early.json().error.code]).toEqual([409, 'HOLDOUT_NOT_PASSED']);
    const suites = early.json().error.details.suites as { suite: string; pass: boolean; replay_id: string | null }[];
    expect(suites.map((s) => [s.suite, s.pass])).toEqual([['BT10-1', true], ['BT10-9', false], ['BT10-11', false]]);
    expect(suites[1]!.replay_id).toBeNull();

    // a suite that fails (45/60 accepted is 75%, still fine; 40/60 is 66.7%) does not count
    await upload(post, suiteRows('s4', 40, 47));
    const failed = await run('BT10-9', 's4');
    expect([failed.statusCode, failed.json().pass]).toEqual([201, false]);
    expect((await post('/selection/settings/v2/activate', { approval_ref: approval('Dvir: activate v2') })).json().error.details.suites[1]).toMatchObject({ suite: 'BT10-9', pass: false });
    expect((await get('/selection/buy-hold?settings=v2')).json()).toMatchObject({ buy_hold: true, settings_version: 'v2', clearable: false });

    expect((await run('BT10-9', 's2')).json().pass).toBe(true);
    expect((await run('BT10-11', 's3')).json().pass).toBe(true);
    const bh = (await get('/selection/buy-hold?settings=v2')).json();
    expect(bh).toMatchObject({ buy_hold: true, clearable: true });
    expect(bh.required_suites).toEqual([
      expect.objectContaining({ suite: 'BT10-1', pass: true, n_sold: 60, n_dropped: 60, sold_accept_rate: 46 / 60, drop_reject_rate: 47 / 60 }),
      expect.objectContaining({ suite: 'BT10-9', pass: true }), expect.objectContaining({ suite: 'BT10-11', pass: true }),
    ]);

    const noApproval = await post('/selection/settings/v2/activate', {});
    expect([noApproval.statusCode, noApproval.json().error.code]).toEqual([422, 'APPROVAL_REQUIRED']);
    expect((await get('/selection/buy-hold')).json().buy_hold).toBe(true);
    const ok = await post('/selection/settings/v2/activate', { approval_ref: approval('Dvir: activate v2') });
    expect(ok.statusCode, ok.body).toBe(200);
    const after = (await get('/selection/buy-hold')).json();
    expect([after.buy_hold, after.settings_version, after.clearable]).toEqual([false, 'v2', true]);
  });

  it('a draft created after the first holdout replay of a suite: 409 VARIANT_NOT_PREREGISTERED', async () => {
    const { post } = await setup();
    await lists(post);
    await upload(post, suiteRows('s1'));
    expect((await post('/selection/settings', { label: 'v2', set: { buy_hold: false } })).statusCode).toBe(201);
    expect((await post('/selection/replays', { suite: 'BT10-1', mode: 'holdout', slices: ['s1'], settings: 'v2' })).statusCode).toBe(201);
    expect((await post('/selection/replays', { suite: 'BT10-1', mode: 'holdout', slices: ['s1'], settings: 'v2' })).statusCode).toBe(201); // same variant again is fine
    expect((await post('/selection/settings', { label: 'v3', set: { 'thresholds.registered_share_min': 0.45 } })).statusCode).toBe(201);
    const r = await post('/selection/replays', { suite: 'BT10-1', mode: 'holdout', slices: ['s1'], settings: 'v3' });
    expect([r.statusCode, r.json().error.code]).toEqual([409, 'VARIANT_NOT_PREREGISTERED']);
    expect((await post('/selection/replays', { suite: 'BT10-1', mode: 'diagnostic', slices: ['s1'], settings: 'v3' })).statusCode).toBe(201);
  });

  it('the latest holdout replay counts: a later failing run on the same draft withdraws a pass', async () => {
    const { post, get } = await setup();
    await lists(post);
    await upload(post, [...suiteRows('s1'), ...suiteRows('s2', 30, 47)]);
    await post('/selection/settings', { label: 'v2', set: { buy_hold: false } });
    await post('/selection/replays', { suite: 'BT10-1', mode: 'holdout', slices: ['s1'], settings: 'v2' });
    await post('/selection/replays', { suite: 'BT10-1', mode: 'holdout', slices: ['s2'], settings: 'v2' });
    const bh = (await get('/selection/buy-hold?settings=v2')).json();
    expect(bh.required_suites[0]).toMatchObject({ suite: 'BT10-1', pass: false });
  });

  it('replay_runs is append-only in the database', async () => {
    const { post } = await setup();
    await upload(post, suiteRows('s1', 5, 5));
    await post('/selection/replays', { suite: 'BT10-1', mode: 'diagnostic', slices: ['s1'] });
    await expect(db.updateTable('replay_runs').set({ pass: true }).execute()).rejects.toThrow();
    await expect(db.deleteFrom('replay_runs').execute()).rejects.toThrow();
  });
});
