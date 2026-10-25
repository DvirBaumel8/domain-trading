// v5.47.0 (F5): the lift table's training step, its stored rows and GET /engine/lift. Test ids LF547-12..16 (the maths: tests/modules/engine/unit/lift.test.ts, LF547-1..10;
// the shortlist use: tests/modules/ops/auction-shortlist.test.ts, LF547-11). Rules: docs/internal/engine.md "Lift model".
import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { LiftTrainJob } from '../../../src/modules/engine/index.js';
import { loadLiftSeed, loadOwnLiftRows, liftTable } from '../../../src/modules/engine/lift-train.js';
import { makeApp } from '../../helpers/app.js';
import { testDb as db } from '../../helpers/db.js';
import { seedEngineData } from '../../helpers/engine-data.js';
import { issueToken } from '../../helpers/tokens.js';

let app: FastifyInstance | undefined;
afterEach(async () => { await app?.close(); app = undefined; });
const NOW = Date.parse('2026-10-26T06:00:00Z');
const job = () => new LiftTrainJob({ db, now: () => NOW });
const stored = () => db.selectFrom('lift_models').selectAll().orderBy('id').execute();

describe('LF547 lift training step and route', () => {
  it('LF547-12: with no data of our own the seed alone trains the table (source seed, holdout AUC about 0.79); a second run with nothing new does nothing', async () => {
    const a = await job().runOnce() as Record<string, any>;
    expect(a).toMatchObject({ trained: true, source: 'seed', own_sold: 0, own_unsold: 0, seed_weight: 1 });
    expect(a.auc).toBeGreaterThan(0.74); expect(a.auc).toBeLessThan(0.84);
    const rows = await stored();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ version: 'lift-v1', source: 'seed', sold_n: 0, unsold_n: 0, seed_sold_n: 767, seed_unsold_n: 988, seed_weight: 1 });
    expect(rows[0]!.holdout_n).toBeGreaterThan(300);
    expect((rows[0]!.bins as any).bins.words['2'].lift).toBeGreaterThan(0.5);
    expect(await job().runOnce()).toMatchObject({ skipped: true });
    expect(await stored()).toHaveLength(1);
  });

  it('LF547-13: our own sales (>= $100) and unsold rows in the regime, not caught by a catcher, enter once there are 50 of each; the seed weight falls; new rows retrain, an unchanged set does not', async () => {
    await job().runOnce();
    const seeded = await seedEngineData(db, { soldTrain: 60, soldTest: 10, unsold: 120 });
    const table = await liftTable(db);
    const own = await loadOwnLiftRows(db, table);
    expect(own.filter((r) => r.sold)).toHaveLength(70);
    expect(own.filter((r) => !r.sold)).toHaveLength(120);
    const b = await job().runOnce() as Record<string, any>;
    expect(b).toMatchObject({ trained: true, source: 'blend', own_sold: 70, own_unsold: 120 });
    expect(b.seed_weight).toBeCloseTo(1 - (70 - 50) / 950, 6);
    const rows = await stored();
    expect(rows).toHaveLength(2);
    expect(rows[1]).toMatchObject({ source: 'blend', sold_n: 70, unsold_n: 120, seed_sold_n: 767 });
    expect(await job().runOnce()).toMatchObject({ skipped: true });
    // one more unsold row retrains
    const up = await db.selectFrom('engine_uploads').select('id').executeTakeFirstOrThrow();
    await db.insertInto('engine_unsold').values({ domain: `${seeded.unsold[0]!.slice(0, -4)}x.com`, type: 'dropped_after_held', observation_date: '2026-10-09', caught_by_catcher: null, upload_id: up.id }).execute();
    expect(await job().runOnce()).toMatchObject({ trained: true });
    expect(await stored()).toHaveLength(3);
  });

  it('LF547-14: rows outside the training set are left out: a sale under $100, a name caught by a catcher, a registered-unsold row and a name outside the regime', async () => {
    const s = await seedEngineData(db, { soldTrain: 5, soldTest: 5, unsold: 10 });
    const up = await db.selectFrom('engine_uploads').select('id').executeTakeFirstOrThrow();
    const base = s.sold[0]!.domain.slice(0, -4);
    await db.insertInto('engine_sales').values([
      { domain: `${base}z.com`, price_cents: 9_999, sale_date: '2026-09-01', venue: 'v', source: 's', source_url: null, upload_id: up.id },
      { domain: 'zzqqxx.com', price_cents: 500_000, sale_date: '2026-09-01', venue: 'v', source: 's', source_url: null, upload_id: up.id },
    ]).execute();
    await db.insertInto('engine_unsold').values([
      { domain: `${base}c.com`, type: 'dropped_after_held', observation_date: '2026-10-08', caught_by_catcher: true, upload_id: up.id },
      { domain: `${base}r.com`, type: 'registered_unsold', observation_date: '2026-10-08', caught_by_catcher: null, upload_id: up.id },
    ]).execute();
    const own = await loadOwnLiftRows(db, await liftTable(db));
    expect(own.filter((r) => r.sold)).toHaveLength(10);
    expect(own.filter((r) => !r.sold)).toHaveLength(10);
    // the inputs: the length and word count of the name, the endings as asked (the test data holds the .net answer; the seeded sold names also hold a .com row, which is not an other ending)
    const one = own.find((r) => r.key.startsWith(`${s.sold[0]!.domain}|`))!;
    expect(one.input).toMatchObject({ len: base.length, words: 2 });
    expect(one.input.registered_share === null || one.input.registered_share === 0 || one.input.registered_share === 1).toBe(true);
  });

  it('LF547-15: GET /engine/lift shows the newest table (patterns, bins, lifts, counts, AUC) to READ and bots tokens; before the first training the model is null', async () => {
    app = await makeApp({ now: () => NOW });
    const read = (await issueToken('read')).auth;
    const bots = (await issueToken('bots')).auth;
    const none = await app.inject({ method: 'GET', url: '/engine/lift', headers: read });
    expect(none.statusCode).toBe(200);
    expect(none.json().model).toBeNull();
    await job().runOnce();
    const r = await app.inject({ method: 'GET', url: '/engine/lift', headers: bots });
    expect(r.statusCode, r.body).toBe(200);
    const m = r.json().model;
    expect(m).toMatchObject({ version: 'lift-v1', source: 'seed', seed_weight: 1, cap: 2, counts: { own_sold: 0, own_unsold: 0, seed_sold: 767, seed_unsold: 988 }, age_days: 0 });
    expect(m.auc).toBeGreaterThan(0.74);
    expect(m.patterns.map((p: any) => p.pattern)).toEqual(['length', 'words', 'endings_before', 'registered_share', 'past_site']);
    const words = m.patterns.find((p: any) => p.pattern === 'words');
    expect(words.bins.map((b: any) => b.bin)).toEqual(['1', '2', '3', '4+']);
    expect(words.bins.find((b: any) => b.bin === '2')).toMatchObject({ sold: 515, unsold: 222 });
    expect(words.totals).toEqual({ sold: 685, unsold: 742 });
    expect((await app.inject({ method: 'GET', url: '/engine/lift', headers: (await issueToken('data')).auth })).statusCode).toBe(403);
    expect((await app.inject({ method: 'GET', url: '/engine/lift' })).statusCode).toBe(401);
  });

  it('LF547-16: the daily step liftTrain runs after engineTrain and trains; the table is append-only', async () => {
    app = await makeApp({ now: () => NOW });
    const plan = app.jobRunner.plan('daily');
    const names = plan.map((p) => p.name);
    expect(names.slice(-2)).toEqual(['engineTrain', 'liftTrain']);
    const out = await plan.find((p) => p.name === 'liftTrain')!.exec() as Record<string, unknown>;
    expect(out).toMatchObject({ trained: true, source: 'seed' });
    await expect(db.updateTable('lift_models').set({ auc: 0.5 }).execute()).rejects.toThrow();
    await expect(db.deleteFrom('lift_models').execute()).rejects.toThrow();
    expect(loadLiftSeed()!.sha256).toMatch(/^[0-9a-f]{64}$/);
  });
});
