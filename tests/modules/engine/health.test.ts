// v5.6.0 (CR-056 part 3): drift per year and quarter, the ablation without the endings, the bars report and the health shape. Test IDs EN-80..EN-89.
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { makeApp } from '../../helpers/app.js';
import { testDb as db } from '../../helpers/db.js';
import { FAST_TRAIN, namesFrom, seedEngineData, wordPool } from '../../helpers/engine-data.js';
import { FakeAdapter } from '../../helpers/fake-adapter.js';
import { issueToken } from '../../helpers/tokens.js';
import { baseSplitTable, tokenContext } from '../../../src/modules/engine/data.js';
import { computeDrift } from '../../../src/modules/engine/drift.js';
import type { EndingFact, EngineTld, FeatureContext } from '../../../src/modules/engine/features.js';
import { computeBars } from '../../../src/modules/engine/health.js';
import { makeRng } from '../../../src/modules/engine/model/rng.js';

let app: FastifyInstance | undefined;
afterEach(async () => { await app?.close(); app = undefined; });

const ms = (d: string): number => Date.parse(`${d}T00:00:00Z`);

describe('drift (pure, hand-computed)', () => {
  const table = baseSplitTable();
  const pool = wordPool(20);
  const names = namesFrom(pool, pool, 8, makeRng(5), new Set());
  const [n1, n2, n3, n4, n5, n6, d1, d2] = names as [string, string, string, string, string, string, string, string];
  const fact = (registered: boolean, created: string | null): EndingFact => ({ registered, createdMs: created ? ms(created) : null });
  const endings = new Map<string, Partial<Record<EngineTld, EndingFact>>>([
    [n1, { net: fact(true, '2018-01-01'), com: fact(true, '2024-01-01') }], // .net before the sale, .com 14 months old: handreg
    [n2, { net: fact(true, '2018-01-01'), com: fact(true, '2010-01-01') }], // aftermarket_or_old
    [n3, { net: fact(true, '2025-06-01') }], // .net created AFTER the 2025-03 sale: not counted (point in time)
    [n4, { net: fact(false, null) }],
    [n5, { net: fact(true, '2018-01-01') }], [n6, { net: fact(false, null) }],
    [d1, { net: fact(false, null) }], [d2, { net: fact(true, '2020-01-01') }],
  ]);
  const ctx = (): FeatureContext => ({ table, tokens: tokenContext([], [], table), endings, demand: new Map() });
  const sales = [
    { domain: `${n1}.com`, price_cents: 10_000, sale_date: '2025-03-01' }, { domain: `${n2}.com`, price_cents: 20_000, sale_date: '2025-03-02' },
    { domain: `${n3}.com`, price_cents: 30_000, sale_date: '2025-03-03' }, { domain: `${n4}.com`, price_cents: 50_000, sale_date: '2025-03-04' },
    { domain: `${n5}.com`, price_cents: 70_000, sale_date: '2026-08-05' }, { domain: `${n6}.com`, price_cents: 90_000, sale_date: '2026-09-05' },
  ];
  const unsold = [
    { domain: `${d1}.com`, type: 'dropped_after_held' as const, observation_date: '2025-05-05', caught_by_catcher: null },
    { domain: `${d2}.com`, type: 'dropped_after_held' as const, observation_date: '2025-05-06', caught_by_catcher: null },
    { domain: `${n6}x.com`, type: 'dropped_after_held' as const, observation_date: '2025-05-06', caught_by_catcher: true }, // caught: left out
  ];

  it('EN-80: per-year numbers, point in time (a later .net never counts), dropped block, last_quarter', () => {
    const d = computeDrift(ctx(), sales, unsold, '2026-10-14');
    expect(Object.keys(d).sort()).toEqual(['2025', '2026', 'last_quarter']);
    const y = d['2025']!;
    const len = [n1, n2, n3, n4].map((n) => n.length).sort((a, b) => a - b);
    expect(y.sold).toMatchObject({
      n: 4, net_pit_share: 0.5, two_word_share: 1, median_length: (len[1]! + len[2]!) / 2, com_date_known_share: 0.5, handreg_share: 0.5, median_price_cents: 25_000,
      median_price_by: { net_pit: { yes: 15_000, no: 40_000 }, words: { two: 25_000, three: null }, acq: { handreg: 10_000, other: 20_000 } },
    });
    expect(y.dropped).toMatchObject({ n: 2, net_pit_share: 0.5, two_word_share: 1 });
    expect(y.dropped).not.toHaveProperty('median_price_cents');
    expect(y.dropped!.handreg_share).toBeNull(); // no .com date known
    expect(d['2026']!.sold).toMatchObject({ n: 2, median_price_cents: 80_000 });
    expect(d['2026']!.dropped).toBeNull();
    expect(d.last_quarter!.window).toEqual({ from: '2026-07-01', to_exclusive: '2026-10-01', label: '2026-Q3' });
    expect(d.last_quarter!.sold).toMatchObject({ n: 2, net_pit_share: 0.5 });
  });

  it('EN-81: a quarter that has not ended is not last_quarter', () => {
    expect(computeDrift(ctx(), sales.slice(4), unsold, '2026-09-20').last_quarter).toBeUndefined();
    expect(computeDrift(ctx(), sales, unsold, '2026-09-20').last_quarter!.window.label).toBe('2025-Q1');
  });
});

describe('bars (each status path)', () => {
  const test = { window: { label: '2026-Q3' }, n_sold: 40, n_unsold: 120, auc: 0.9, p_top1: { precision: 0.95 }, p_top1_at_1pct_base: 0.4 };
  const abl = { auc_without_endings: 0.86, auc95: [0.8, 0.9] as [number, number], delta: 0.04, p_top1_at_1pct_base: 0.3 };
  const byId = (bars: ReturnType<typeof computeBars>) => Object.fromEntries(bars.map((b) => [b.id, b.status]));

  it('EN-82: no model: 1, 3, 4, 5, 6 not measured, 2 fails on small counts', () => {
    expect(byId(computeBars({ salesN: 5, unsoldN: 5, test: undefined, ablation: undefined, hasModel: false }))).toEqual({ 1: 'not_measured', 2: 'fail', 3: 'not_measured', 4: 'not_measured', 5: 'not_measured', 6: 'not_measured' });
  });
  it('EN-83: all pass; bar 2 needs 10,000 of each; bars 1 and 5 never pass', () => {
    const ok = computeBars({ salesN: 10_000, unsoldN: 10_000, test, ablation: abl, hasModel: true });
    expect(byId(ok)).toEqual({ 1: 'not_measured', 2: 'pass', 3: 'pass', 4: 'pass', 5: 'not_measured', 6: 'pass' });
    expect(ok.find((b) => b.id === 4)!.detail).toContain('0.4');
    expect(byId(computeBars({ salesN: 10_000, unsoldN: 9_999, test, ablation: abl, hasModel: true }))[2]).toBe('fail');
  });
  it('EN-84: bar 3 fails on a mix under 3:1 even with a great AUC, and on a low p@top1%; bar 4 fails above 0.05; bar 6 fails under 0.850', () => {
    const b = byId(computeBars({ salesN: 1, unsoldN: 1, test: { ...test, n_unsold: 100 }, ablation: { ...abl, delta: 0.051 }, hasModel: true }));
    expect(b[3]).toBe('fail'); expect(b[4]).toBe('fail');
    expect(byId(computeBars({ salesN: 1, unsoldN: 1, test: { ...test, p_top1: { precision: 0.8 } }, ablation: abl, hasModel: true }))[3]).toBe('fail');
    const six = computeBars({ salesN: 1, unsoldN: 1, test: { ...test, auc: 0.83 }, ablation: abl, hasModel: true }).find((x) => x.id === 6)!;
    expect(six.status).toBe('fail'); expect(six.detail).toContain('0.809'); expect(six.detail).toContain('different split');
  });
  it('EN-85: a model without an ablation leaves bar 4 not measured', () => {
    expect(byId(computeBars({ salesN: 1, unsoldN: 1, test, ablation: null, hasModel: true }))[4]).toBe('not_measured');
  });
});

describe('training stores drift and ablation; health shows them', () => {
  async function setup() {
    app = await makeApp({ adapters: [new FakeAdapter('porkbun')], now: () => Date.parse('2026-10-14T09:00:00Z'), engineTrain: { ...FAST_TRAIN } });
    return { w: (await issueToken('write', 'gavriel')).auth, r: (await issueToken('read')).auth };
  }

  it('EN-86: before a model: drift and ablation null, bars present, bars_passed empty', async () => {
    const { r } = await setup();
    const h = (await app!.inject({ method: 'GET', url: '/engine/health', headers: r })).json();
    expect(h).toMatchObject({ drift: null, ablation: null, bar4_pass: null, bars_passed: [] });
    expect(h.bars.map((b: { id: number }) => b.id)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(h.bars.find((b: { id: number }) => b.id === 2).status).toBe('fail');
  });

  it('EN-87: after training: drift by year and last_quarter, ablation with delta and bar4_pass, bars shape, data age kept', async () => {
    await seedEngineData(db);
    const { w, r } = await setup();
    const res = await app!.inject({ method: 'POST', url: '/engine/train', headers: { ...w, 'idempotency-key': randomUUID() }, payload: {} });
    expect(res.statusCode).toBe(202);
    await app!.jobQueue.idle();
    const h = (await app!.inject({ method: 'GET', url: '/engine/health', headers: r })).json();
    expect(Object.keys(h.drift).sort()).toEqual(['2025', '2026', 'last_quarter']);
    expect(h.drift.last_quarter.window.label).toBe('2026-Q3');
    expect(h.drift.last_quarter.sold.n).toBe(40);
    expect(h.drift['2025'].sold.n + h.drift['2026'].sold.n).toBe(190);
    expect(h.drift.last_quarter.sold.net_pit_share).toBeGreaterThan(0.5); // seeded: 85% of sold names have a long-standing .net
    expect(h.ablation).toMatchObject({ auc_without_endings: expect.any(Number), delta: expect.any(Number), removed: expect.arrayContaining(['net_pit']) });
    expect(h.ablation.auc95).toHaveLength(2);
    expect(h.ablation.delta).toBeCloseTo(h.test.auc - h.ablation.auc_without_endings, 3);
    expect(h.bar4_pass).toBe(h.ablation.delta <= 0.05);
    expect(h.bars).toHaveLength(6);
    for (const b of h.bars) expect(b).toMatchObject({ id: expect.any(Number), name: expect.any(String), status: expect.stringMatching(/^(pass|fail|not_measured)$/), detail: expect.any(String) });
    expect(h.bars.find((b: { id: number }) => b.id === 3).value.unsold_per_sale).toBeGreaterThanOrEqual(3);
    expect(h.bars_passed).toEqual(h.bars.filter((b: { status: string }) => b.status === 'pass').map((b: { id: number }) => b.id));
    expect(h.data.data_age_days).toBeDefined(); expect(h.data.last_upload.sales).not.toBeNull();
    // stored on the model's metrics too
    const m = (await app!.inject({ method: 'GET', url: '/engine/train/eng-1.0.1', headers: r })).json();
    expect(m.metrics.ablation.delta).toBe(h.ablation.delta); expect(m.metrics.drift['2025']).toBeDefined();
  });
});
