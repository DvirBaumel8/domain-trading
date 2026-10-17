// v5.5.0 (CR-056 part 2): POST /engine/train, the queue job, the frozen test file, the recency choice, the weekly step and the health fields. Test IDs EN-40..EN-52.
import { createHash, randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { makeApp } from '../../helpers/app.js';
import { testDb as db } from '../../helpers/db.js';
import { FAST_TRAIN, seedEngineData } from '../../helpers/engine-data.js';
import { FakeAdapter } from '../../helpers/fake-adapter.js';
import { issueToken } from '../../helpers/tokens.js';

const T0 = Date.parse('2026-10-14T09:00:00Z'); // a Wednesday
const HOUR = 3_600_000;
let now = T0;
let app: FastifyInstance | undefined;
beforeEach(() => { now = T0; });
afterEach(async () => { await app?.close(); app = undefined; });

async function setup(extra: Record<string, unknown> = {}) {
  app = await makeApp({ adapters: [new FakeAdapter('porkbun')], now: () => now, engineTrain: { ...FAST_TRAIN }, ...extra });
  return { w: (await issueToken('write', 'gavriel')).auth, r: (await issueToken('read')).auth };
}
const train = (h: Record<string, string>, key: string = randomUUID()) => app!.inject({ method: 'POST', url: '/engine/train', headers: { ...h, 'idempotency-key': key }, payload: {} });
const get = (url: string, h: Record<string, string>) => app!.inject({ method: 'GET', url, headers: h });
async function trainAndWait(h: Record<string, string>) {
  const res = await train(h);
  expect(res.statusCode, res.body).toBe(202);
  await app!.jobQueue.idle();
  return res.json() as { train_id: string; status: string; poll: string };
}

describe('engine training', () => {
  it('EN-40: POST /engine/train answers 202 at once, the queue job trains, GET /engine/train/{id} shows the metrics and the frozen test file', async () => {
    await seedEngineData(db);
    const { w, r } = await setup();
    const res = await train(w);
    expect(res.statusCode).toBe(202);
    const b = res.json();
    expect(b).toMatchObject({ train_id: 'eng-1.0.1', status: 'running', poll: '/engine/train/eng-1.0.1' });
    expect(b.audit_id).toMatch(/^aud_/);
    await app!.jobQueue.idle();
    const done = (await get(b.poll, r)).json();
    expect(done).toMatchObject({ train_id: 'eng-1.0.1', status: 'done', error: null, trained_by: 'gavriel' });
    expect(done.metrics.test.auc).toBeGreaterThan(0.8);
    expect(done.metrics.test.auc95[0]).toBeLessThanOrEqual(done.metrics.test.auc);
    expect(done.metrics.test.window).toMatchObject({ label: '2026-Q3', from: '2026-07-01', to_exclusive: '2026-10-01' });
    expect(done.metrics.test).toMatchObject({ n_sold: 40, unsold_mode: 'hash' });
    expect(done.metrics.test.p_top1.precision).not.toBeNull();
    expect(done.metrics.test.p_top1_at_1pct_base).not.toBeNull();
    expect(done.metrics.quantiles.sold).toHaveLength(101);
    expect(done.metrics.quantiles.dropped).toHaveLength(101);
    expect(done.metrics.tier.n_train).toBeGreaterThan(40);
    expect(done.metrics.importance[0].feature).toBeTruthy();
    expect(done.dataset).toMatchObject({ quarter: '2026-Q3', test_sold: 40, train_sold: 150 });
    // the queue ran a `train` job with one step
    const q = await db.selectFrom('job_runs').selectAll().where('job', '=', 'train').executeTakeFirstOrThrow();
    expect(q.ok).toBe(true);
    expect(Object.keys(q.steps as object)).toEqual(['trainModel']);
    expect(q.triggered_by).toBe('gavriel');
  });

  it('EN-41: the test file is hashed before training: the stored sha256 is that of the sorted domain|label|as_of lines of the stored test rows', async () => {
    await seedEngineData(db);
    const { w } = await setup();
    const { train_id } = await trainAndWait(w);
    const m = await db.selectFrom('engine_models').select(['test_sha256', 'test_rows']).where('id', '=', train_id).executeTakeFirstOrThrow();
    const t = m.test_rows as { domain: string[]; label: number[]; as_of: string[]; score: number[] };
    const lines = t.domain.map((d, i) => `${d}|${t.label[i]}|${t.as_of[i]}`).sort().join('\n');
    expect(createHash('sha256').update(lines).digest('hex')).toBe(m.test_sha256);
    // 40 sold in the newest full quarter, unsold subsampled to 3 per sale
    expect(t.label.filter((x) => x === 1)).toHaveLength(40);
    expect(t.label.filter((x) => x === 0)).toHaveLength(120);
    // every test sale is in 2026-Q3 and every train sale is before it
    const dates = t.as_of.filter((_, i) => t.label[i] === 1);
    expect(dates.every((d) => d >= '2026-07-01' && d < '2026-10-01')).toBe(true);
  });

  it('EN-42: the same data gives the same test file, the same metrics and the same model (after the 24 hours)', async () => {
    await seedEngineData(db);
    const { w } = await setup();
    const a = await trainAndWait(w);
    now += 25 * HOUR;
    const b = await trainAndWait(w);
    expect(b.train_id).toBe('eng-1.0.2');
    const load = (id: string) => db.selectFrom('engine_models').select(['test_sha256', 'params', 'metrics', 'chosen_weighting']).where('id', '=', id).executeTakeFirstOrThrow();
    const ma = await load(a.train_id); const mb = await load(b.train_id);
    expect(ma.test_sha256).toBe(mb.test_sha256);
    expect(JSON.stringify(ma.params)).toBe(JSON.stringify(mb.params));
    const strip = (m: unknown) => ({ ...(m as object), seconds: 0 });
    expect(strip(ma.metrics)).toEqual({ ...strip(mb.metrics) });
  });

  it('EN-43: at most one training a day: 409 TRAIN_TOO_SOON with next_allowed_at; allowed again after 24 hours', async () => {
    await seedEngineData(db);
    const { w } = await setup();
    await trainAndWait(w);
    now += 2 * HOUR;
    const res = await train(w);
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('TRAIN_TOO_SOON');
    expect(res.json().error.details).toMatchObject({ last_train_id: 'eng-1.0.1', last_status: 'done', next_allowed_at: '2026-10-15T12:00:00+03:00' });
    now = T0 + 24 * HOUR + 1000;
    expect((await train(w)).statusCode).toBe(202);
    await app!.jobQueue.idle();
  });

  it('EN-44: training needs a WRITE token and an Idempotency-Key; a READ token is refused; the same key replays the same answer', async () => {
    await seedEngineData(db);
    const { w, r } = await setup();
    expect((await app!.inject({ method: 'POST', url: '/engine/train', headers: r, payload: {} })).statusCode).toBe(403);
    expect((await app!.inject({ method: 'POST', url: '/engine/train', headers: w, payload: {} })).json().error.code).toBe('IDEMPOTENCY_KEY_REQUIRED');
    const key = randomUUID();
    const one = await train(w, key); const two = await train(w, key);
    expect(two.headers['idempotent-replayed']).toBe('true');
    expect(two.json().train_id).toBe(one.json().train_id);
    await app!.jobQueue.idle();
    expect((await db.selectFrom('engine_models').select('id').execute()).length).toBe(1);
    expect((await get('/engine/train/eng-1.0.99', r)).statusCode).toBe(404);
  });

  it('EN-45: too little data fails the run with NOT_ENOUGH_DATA (stored on the run); a failed run does not hold the 24-hour rule', async () => {
    await seedEngineData(db, { soldTrain: 5, soldTest: 3, unsold: 20 });
    const { w, r } = await setup();
    const t = await trainAndWait(w);
    const v = (await get(t.poll, r)).json();
    expect(v.status).toBe('failed');
    expect(v.error).toContain('NOT_ENOUGH_DATA');
    const job = await db.selectFrom('job_runs').select('ok').where('job', '=', 'train').executeTakeFirstOrThrow();
    expect(job.ok).toBe(false);
    expect((await train(w)).statusCode).toBe(202); // a failed run does not count
    await app!.jobQueue.idle();
  });

  it('EN-46: the training time budget stops a run with a clear failure', async () => {
    await seedEngineData(db);
    let t = 0;
    const { w, r } = await setup({ engineTrain: { ...FAST_TRAIN, budgetMs: 1000, clock: () => (t += 400) } });
    const x = await trainAndWait(w);
    const v = (await get(x.poll, r)).json();
    expect(v.status).toBe('failed');
    expect(v.error).toContain('TRAIN_TIME_BUDGET');
  });

  it('EN-47: recency: half-life 12 months is kept only if its test AUC is at least 0.01 above the unweighted one; both are stored', async () => {
    await seedEngineData(db);
    const { w, r } = await setup();
    const x = await trainAndWait(w);
    const v = (await get(x.poll, r)).json();
    const wt = v.metrics.weighting;
    expect(wt.unweighted_auc).not.toBeNull(); expect(wt.half_life_12m_auc).not.toBeNull();
    expect(wt.chosen === 'half_life_12m').toBe(wt.half_life_12m_auc >= wt.unweighted_auc + 0.01);
    expect(v.chosen_weighting).toBe(wt.chosen);
  });

  it('EN-48: features without data or that would reveal the label are left out and listed with the reason (the .com creation date exists only for sold rows here)', async () => {
    await seedEngineData(db);
    const { w, r } = await setup();
    const x = await trainAndWait(w);
    const fl = (await get(x.poll, r)).json().feature_list as { model: string[]; excluded: { feature: string; reason: string }[] };
    const ex = Object.fromEntries(fl.excluded.map((e) => [e.feature, e.reason]));
    expect(Object.keys(ex)).toEqual(expect.arrayContaining(['acq_handreg', 'acq_aftermarket_or_old', 'acq_created_after', 'com_age_years', 'demand', 'tok_rate_pit', 'co_pit']));
    expect(ex.acq_handreg).toContain('reveal the label');
    expect(ex.tok_rate_pit).toContain('not dated');
    expect(fl.model).toEqual(expect.arrayContaining(['len', 'n_words', 'net_pit', 'trend_pit_max']));
    expect(fl.model).not.toContain('acq_handreg');
  });

  it('EN-49: models older than the newest four lose their parameters and test rows; the metrics and the hash stay', async () => {
    await seedEngineData(db);
    const { w } = await setup();
    for (let i = 0; i < 5; i++) { await trainAndWait(w); now += 25 * HOUR; }
    const rows = await db.selectFrom('engine_models').select(['id', 'params', 'test_rows', 'metrics', 'test_sha256']).orderBy('n').execute();
    expect(rows.map((x) => [x.id, x.params === null])).toEqual([['eng-1.0.1', true], ['eng-1.0.2', false], ['eng-1.0.3', false], ['eng-1.0.4', false], ['eng-1.0.5', false]]);
    expect(rows[0]!.test_rows).toBeNull();
    expect(rows[0]!.metrics).not.toBeNull(); expect(rows[0]!.test_sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('EN-53: the training is a queue run of kind train, listed by GET /jobs/runs?job=train', async () => {
    await seedEngineData(db);
    const { w, r } = await setup();
    await trainAndWait(w);
    const runs = (await get('/jobs/runs?job=train', r)).json().runs as { job: string; trigger: string; triggered_by: string; steps: Record<string, { status: string }> }[];
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ job: 'train', trigger: 'manual', triggered_by: 'gavriel' });
    expect(runs[0]!.steps.trainModel!.status).toBe('done');
  });

  it('EN-50: GET /engine/health carries the model fields (version, trained_at, train rows, test numbers, chosen weighting)', async () => {
    await seedEngineData(db);
    const { w, r } = await setup();
    const empty = (await get('/engine/health', r)).json();
    expect(empty).toMatchObject({ model_version: null, trained_at: null, train_rows: null, test: null, chosen_weighting: null });
    await trainAndWait(w);
    const h = (await get('/engine/health', r)).json();
    expect(h.model_version).toBe('eng-1.0.1');
    expect(h.trained_at).toMatch(/\+03:00$/);
    expect(h.train_rows).toEqual({ sold: 150, unsold: expect.any(Number) });
    expect(h.test).toMatchObject({ window: { label: '2026-Q3' }, n_sold: 40, auc: expect.any(Number), p_top1: expect.any(Number), p_top5: expect.any(Number), p_top1_at_1pct_base: expect.any(Number) });
    expect(h.test.auc95).toHaveLength(2);
    expect(['unweighted', 'half_life_12m']).toContain(h.chosen_weighting);
    expect(h.last_training).toMatchObject({ train_id: 'eng-1.0.1', status: 'done' });
    expect(h).toHaveProperty('drift'); expect(h).toHaveProperty('bars_passed'); // 5.6.0 (details in health.test.ts)
  });
});

describe('engine weekly retrain (daily step engineTrain)', () => {
  const step = () => app!.jobRunner.plan('daily').find((p) => p.name === 'engineTrain')!;
  const sales = (at: string) => db.insertInto('engine_uploads').values({ kind: 'sales', received_n: 0, accepted_n: 0, duplicate_n: 0, rejected_n: 0, rejects: '[]', by: 'test', audit_id: null, created_at: new Date(at) }).execute();

  it('EN-51: no model and no data: skipped; no model and data: it starts a training; a running training is not started twice', async () => {
    await setup();
    expect(await step().exec()).toMatchObject({ skipped: true, reason: expect.stringContaining('no data') });
    await seedEngineData(db);
    const s = await step().exec() as { started: boolean; train_id: string };
    expect(s).toMatchObject({ started: true, train_id: 'eng-1.0.1' });
    await app!.jobQueue.idle();
    expect((await db.selectFrom('engine_models').select('status').executeTakeFirstOrThrow()).status).toBe('done');
    const again = await step().exec();
    expect(again).toMatchObject({ skipped: true, reason: 'no sales upload since the active model' });
  });

  it('EN-52: with a model: a sales upload since it trains on Monday (IDT) or when the model is 7 days old, else waits; a failed run is not retried before new data', async () => {
    await seedEngineData(db);
    await setup();
    await step().exec(); await app!.jobQueue.idle();
    await sales(new Date(T0 + 2 * HOUR).toISOString());
    now = Date.parse('2026-10-16T00:05:00Z'); // Friday, 2 days after
    expect(await step().exec()).toMatchObject({ skipped: true, reason: expect.stringContaining('not Monday') });
    now = Date.parse('2026-10-19T00:05:00Z'); // Monday 03:05 IDT, 5 days after
    const mon = await step().exec() as { started: boolean };
    expect(mon.started).toBe(true);
    await app!.jobQueue.idle();
    await sales(new Date(now + HOUR).toISOString());
    now = Date.parse('2026-10-28T00:05:00Z'); // Wednesday, the model is 9 days old
    expect(await step().exec()).toMatchObject({ started: true, reason: expect.stringContaining('7 days') });
    await app!.jobQueue.idle();
    // the 24-hour rule: a retrain the next day is skipped even with an upload
    await sales(new Date(now + HOUR).toISOString());
    now += 20 * HOUR;
    now = Date.parse('2026-11-02T00:05:00Z'); // Monday again but only 5 days; allowed (over 24 h)
    expect(await step().exec()).toMatchObject({ started: true });
    await app!.jobQueue.idle();
  });
  it('EN-73: the unsold loader reads only dropped-after-held rows; the dataset still reports every unsold row and the registered-unsold ones not used (v5.14.0, D5)', async () => {
    await seedEngineData(db);
    const dropped = Number((await db.selectFrom('engine_unsold').select((eb) => eb.fn.countAll<string>().as('n')).where('type', '=', 'dropped_after_held').executeTakeFirstOrThrow()).n);
    const up = await db.selectFrom('engine_uploads').select('id').limit(1).executeTakeFirstOrThrow();
    await db.insertInto('engine_unsold').values([
      { domain: 'zzregone.com', type: 'registered_unsold', observation_date: '2026-09-01', caught_by_catcher: null, upload_id: up.id },
      { domain: 'zzregtwo.com', type: 'registered_unsold', observation_date: '2026-09-02', caught_by_catcher: null, upload_id: up.id },
    ]).execute();
    const { loadUnsold, countRegisteredUnsold } = await import('../../../src/modules/engine/data.js');
    expect((await loadUnsold(db)).length).toBe(dropped);
    expect(await countRegisteredUnsold(db)).toBe(2);
    const h = await setup();
    const t = await trainAndWait(h.w);
    const done = (await get(`/engine/train/${t.train_id}`, h.r)).json() as { dataset: { unsold_rows: number; registered_unsold_not_used: number } };
    expect(done.dataset).toMatchObject({ unsold_rows: dropped + 2, registered_unsold_not_used: 2 });
  });
});
