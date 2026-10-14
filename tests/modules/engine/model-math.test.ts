// v5.5.0 (CR-056 part 2): the engine's own models on tiny synthetic data (pure; no database). Test IDs EN-21..EN-30.
import { describe, expect, it } from 'vitest';
import { binOf, fitGbm, gbmPredictAll, gbmProba, gbmRaw } from '../../../src/modules/engine/model/gbm.js';
import { fitLogit, logitContributions, logitProba } from '../../../src/modules/engine/model/logit.js';
import { auc, aucWithCi, percentileIn, precisionAtBaseRate, precisionAtTop, quantiles101, wilson } from '../../../src/modules/engine/model/metrics.js';
import { makeRng } from '../../../src/modules/engine/model/rng.js';

/** n rows x 3 features; label = 1 when f0 > 0.5 (f1 is noise, f2 is partly missing). */
function synthetic(n: number, seed: number, noise = 0) {
  const rng = makeRng(seed);
  const X = new Float64Array(n * 3); const y = new Int32Array(n);
  for (let i = 0; i < n; i++) {
    const f0 = rng(); X[i * 3] = f0; X[i * 3 + 1] = rng(); X[i * 3 + 2] = rng() < 0.3 ? Number.NaN : rng();
    y[i] = (f0 > 0.5) !== (rng() < noise) ? 1 : 0;
  }
  return { X, y, n };
}
const small = { minSamplesLeaf: 5, maxIter: 60 };

describe('engine model math', () => {
  it('EN-21: separable data gives AUC 1 and the loss goes down', async () => {
    const d = synthetic(400, 1);
    const m = await fitGbm({ X: d.X, n: d.n, F: 3, y: d.y, classes: 2, featureNames: ['f0', 'f1', 'f2'], seed: 1, params: small });
    const p = gbmPredictAll(m, d.X, d.n, 3);
    expect(auc(p, d.y)).toBe(1);
    expect(m.valLoss.length).toBeGreaterThan(2);
    expect(m.valLoss[m.valLoss.length - 1]!).toBeLessThan(m.valLoss[0]!);
    expect(m.importance[0]!).toBeGreaterThan(0.9); // the split gain is on f0
    expect(m.importance.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 4);
  });

  it('EN-22: the same data and seed give an identical model; another seed changes the validation slice', async () => {
    const d = synthetic(300, 2, 0.1);
    const run = (seed: number) => fitGbm({ X: d.X, n: d.n, F: 3, y: d.y, classes: 2, featureNames: ['a', 'b', 'c'], seed, params: small });
    const a = await run(7); const b = await run(7); const c = await run(8);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect(JSON.stringify(c)).not.toBe(JSON.stringify(a));
  });

  it('EN-23: missing values: a split learns a default direction, and a model trained with missing values predicts them', async () => {
    // the label is carried by whether f0 is missing: missing -> 1
    const rng = makeRng(3);
    const n = 300; const X = new Float64Array(n); const y = new Int32Array(n);
    for (let i = 0; i < n; i++) { const miss = rng() < 0.5; X[i] = miss ? Number.NaN : rng(); y[i] = miss ? 1 : 0; }
    const m = await fitGbm({ X, n, F: 1, y, classes: 2, featureNames: ['f0'], seed: 3, params: small });
    expect(gbmProba(m, [Number.NaN])[0]!).toBeGreaterThan(0.9);
    expect(gbmProba(m, [0.4])[0]!).toBeLessThan(0.1);
    expect(auc(gbmPredictAll(m, X, n, 1), y)).toBe(1);
  });

  it('EN-24: bins: at most 255, a value falls in the bin of its edge, and missing values are not binned', () => {
    expect(binOf(0.5, [0.2, 0.4, 0.6])).toBe(2);
    expect(binOf(0.4, [0.2, 0.4, 0.6])).toBe(1);
    expect(binOf(9, [0.2, 0.4, 0.6])).toBe(3);
  });

  it('EN-25: sample weights move the fit: a heavily weighted noisy label pulls the prediction', async () => {
    const n = 200; const X = new Float64Array(n).fill(1); const y = new Int32Array(n); const w = new Float64Array(n);
    for (let i = 0; i < n; i++) { y[i] = i < 100 ? 1 : 0; w[i] = i < 100 ? 3 : 1; }
    const flat = await fitGbm({ X, n, F: 1, y, classes: 2, featureNames: ['c'], seed: 1, params: { validationFraction: 0 } });
    const wtd = await fitGbm({ X, n, F: 1, y, w, classes: 2, featureNames: ['c'], seed: 1, params: { validationFraction: 0 } });
    expect(gbmProba(flat, [1])[0]!).toBeCloseTo(0.5, 2);
    expect(gbmProba(wtd, [1])[0]!).toBeCloseTo(0.75, 2);
  });

  it('EN-26: the softmax model separates four classes and its probabilities sum to 1', async () => {
    const rng = makeRng(5); const n = 600; const X = new Float64Array(n); const y = new Int32Array(n);
    for (let i = 0; i < n; i++) { const v = rng(); X[i] = v; y[i] = Math.min(3, Math.floor(v * 4)); }
    const m = await fitGbm({ X, n, F: 1, y, classes: 4, featureNames: ['v'], seed: 5, params: { minSamplesLeaf: 5, maxIter: 40 } });
    const p = gbmProba(m, [0.1]);
    expect(p).toHaveLength(4);
    expect(p.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 6);
    expect(p.indexOf(Math.max(...p))).toBe(0);
    expect(gbmProba(m, [0.9]).indexOf(Math.max(...gbmProba(m, [0.9])))).toBe(3);
    expect(gbmRaw(m, [0.1])).toHaveLength(4);
  });

  it('EN-27: logistic regression: separable direction, mean imputation with a missing indicator, and contributions that add up', () => {
    const d = synthetic(500, 9, 0.05);
    const m = fitLogit({ X: d.X, n: d.n, F: 3, y: d.y, featureNames: ['f0', 'f1', 'f2'] });
    expect(m.missingCols).toEqual([2]);
    expect(m.coef[0]!).toBeGreaterThan(1); // f0 drives the label
    expect(Math.abs(m.coef[1]!)).toBeLessThan(0.5);
    const scores = Float64Array.from({ length: d.n }, (_, i) => logitProba(m, d.X.subarray(i * 3, i * 3 + 3)));
    expect(auc(scores, d.y)!).toBeGreaterThan(0.9);
    const x = [0.9, 0.2, Number.NaN];
    const c = logitContributions(m, x);
    const z = m.intercept + c.reduce((a, b) => a + b, 0);
    expect(1 / (1 + Math.exp(-z))).toBeCloseTo(logitProba(m, x), 8);
    // the same data gives the same coefficients
    expect(fitLogit({ X: d.X, n: d.n, F: 3, y: d.y, featureNames: ['f0', 'f1', 'f2'] }).coef).toEqual(m.coef);
  });

  it('EN-28: AUC, ties and the seeded bootstrap interval', () => {
    expect(auc([0.1, 0.2, 0.8, 0.9], [0, 0, 1, 1])).toBe(1);
    expect(auc([0.9, 0.8, 0.2, 0.1], [0, 0, 1, 1])).toBe(0);
    expect(auc([0.5, 0.5, 0.5, 0.5], [0, 1, 0, 1])).toBe(0.5);
    expect(auc([0.1, 0.2], [1, 1])).toBeNull();
    const rng = makeRng(11); const s: number[] = []; const l: number[] = [];
    for (let i = 0; i < 400; i++) { const lab = i % 2; l.push(lab); s.push(rng() + lab * 0.5); }
    const a = aucWithCi(s, l, 42, 300); const b = aucWithCi(s, l, 42, 300);
    expect(a).toEqual(b);
    expect(a.ci![0]).toBeLessThan(a.auc!); expect(a.ci![1]).toBeGreaterThan(a.auc!);
  });

  it('EN-29: precision at the top share with a Wilson interval, and at a 1:100 base rate', () => {
    const scores = Array.from({ length: 100 }, (_, i) => 100 - i);
    const labels = scores.map((_, i) => (i < 20 ? 1 : 0)); // 20 sold at the top, 80 unsold below
    const p = precisionAtTop(scores, labels, 0.1);
    expect(p).toMatchObject({ n_top: 10, positives: 10, precision: 1 });
    expect(p.ci![0]).toBeGreaterThan(0.69);
    expect(precisionAtTop(scores, labels, 0.5).precision).toBe(0.4);
    expect(wilson(0, 0)).toBeNull();
    // 20 sold vs 80 unsold re-weighted to 1:100: each unsold counts 25 times; the top 1% of the mass is 2020 * 0.01 = 20.2: the 20 sold plus 0.2 of an unsold
    expect(precisionAtBaseRate(scores, labels, 0.01, 100)).toBe(0.9901);
    // sold ranked below every unsold: precision at the top falls to zero
    expect(precisionAtBaseRate(scores, labels.map((v) => 1 - v), 0.01, 100)).toBe(0);
  });

  it('EN-30: 101 quantiles and the percentile of a score among them', () => {
    const q = quantiles101(Array.from({ length: 101 }, (_, i) => i / 100));
    expect(q).toHaveLength(101);
    expect(q[0]).toBe(0); expect(q[100]).toBe(1); expect(q[50]).toBe(0.5);
    expect(percentileIn(q, 0.5)).toBe(50);
    expect(percentileIn(q, 0.375)).toBe(37.5);
    expect(percentileIn(q, -1)).toBe(0); expect(percentileIn(q, 2)).toBe(100);
    expect(percentileIn([], 0.5)).toBeNull();
  });
});
