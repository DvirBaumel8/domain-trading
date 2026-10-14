// Histogram gradient boosting in plain TypeScript (CR-056, part 2). Built like LightGBM / scikit-learn's HistGradientBoosting:
//  - features are cut into at most 255 quantile bins on the training rows; a missing value (NaN) has its own bin;
//  - trees grow leaf-wise (best gain first) up to `maxLeafNodes`, with `minSamplesLeaf` rows in every leaf;
//  - every split learns a default direction for missing values (the side with the better gain; the larger side when the training rows had none);
//  - binary log-loss, or a softmax with K trees per iteration; sample weights are supported (recency);
//  - early stopping on a seeded validation slice of the training rows.
// Deterministic: the same rows, weights, parameters and seed give the same model. The model is plain JSON (bin edges + trees with raw thresholds).
import { makeRng, seededPermutation } from './rng.js';

export interface GbmParams {
  maxLeafNodes: number; minSamplesLeaf: number; learningRate: number; maxIter: number; maxBins: number; l2: number;
  /** Stop when the validation loss has not improved for this many iterations. */
  patience: number;
  /** Share of the training rows held out (seeded) for early stopping; 0 = no early stopping. */
  validationFraction: number;
}
export const GBM_DEFAULTS: GbmParams = { maxLeafNodes: 15, minSamplesLeaf: 20, learningRate: 0.1, maxIter: 300, maxBins: 255, l2: 0, patience: 20, validationFraction: 0.1 };

/** One tree as parallel arrays: node i is a leaf when f[i] is -1 (value v[i], learning rate already applied); else it goes left when x <= t[i] (a missing x goes left when m[i] is 1). */
export interface TreeJson { f: number[]; t: number[]; m: number[]; l: number[]; r: number[]; v: number[] }
export interface GbmModel {
  kind: 'gbm'; classes: number; featureNames: string[];
  /** Per feature the upper edges of its bins: bin j holds x <= edges[j] (and above edges[j-1]); the last bin holds the rest. */
  edges: number[][];
  init: number[];
  /** trees[iteration][class] */
  trees: TreeJson[][];
  /** Share of the total split gain per feature (sums to 1; all zero when no split was made). */
  importance: number[];
  bestIter: number; valLoss: number[]; trainedOn: number; validatedOn: number;
  params: GbmParams; seed: number;
}

export interface GbmFitInput {
  /** Row-major n x F, NaN = missing. */
  X: Float64Array; n: number; F: number;
  /** Class index per row (0/1 for the binary model). */
  y: Int32Array;
  w?: Float64Array | null;
  /** 2 = binary log-loss (one tree per iteration); more = softmax. */
  classes: number;
  featureNames: string[];
  params?: Partial<GbmParams>;
  seed: number;
  /** Called after every iteration: lets a long fit give the event loop a turn. */
  yieldFn?: () => Promise<void>;
  /** Throws when this returns true after an iteration (the training time budget). */
  expired?: () => boolean;
}

const MISSING_BIN = 255;
const MIN_HESS_LEAF = 1e-3;
const MIN_GAIN = 1e-7;

const sigmoid = (z: number): number => (z >= 0 ? 1 / (1 + Math.exp(-z)) : Math.exp(z) / (1 + Math.exp(z)));

/** Bin upper edges of one feature from its non-missing training values. */
function edgesOf(values: Float64Array, maxBins: number): number[] {
  const s = values.slice().sort();
  const cnt = s.length;
  if (cnt === 0) return [];
  const out: number[] = [];
  const distinct: number[] = [];
  for (let i = 0; i < cnt; i++) if (i === 0 || s[i] !== s[i - 1]) distinct.push(s[i]!);
  if (distinct.length <= maxBins) {
    for (let i = 0; i + 1 < distinct.length; i++) out.push((distinct[i]! + distinct[i + 1]!) / 2);
    return out;
  }
  for (let k = 1; k < maxBins; k++) {
    const idx = Math.floor((k * cnt) / maxBins);
    if (idx <= 0 || idx >= cnt) continue;
    const a = s[idx - 1]!; const b = s[idx]!;
    if (a < b) {
      const e = (a + b) / 2;
      if (out.length === 0 || e > out[out.length - 1]!) out.push(e);
    }
  }
  return out;
}

/** The bin of x: the first j with x <= edges[j], else edges.length. */
export function binOf(x: number, edges: readonly number[]): number {
  let lo = 0; let hi = edges.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (x <= edges[mid]!) hi = mid; else lo = mid + 1; }
  return lo;
}

interface Hist { g: Float64Array; h: Float64Array; c: Int32Array }
const newHist = (F: number): Hist => ({ g: new Float64Array(F * 256), h: new Float64Array(F * 256), c: new Int32Array(F * 256) });

function buildHist(bins: Uint8Array, F: number, rows: Int32Array, grad: Float64Array, hess: Float64Array): Hist {
  const H = newHist(F);
  for (let k = 0; k < rows.length; k++) {
    const i = rows[k]!; const base = i * F; const gi = grad[i]!; const hi = hess[i]!;
    for (let f = 0; f < F; f++) {
      const idx = f * 256 + bins[base + f]!;
      H.g[idx]! += gi; H.h[idx]! += hi; H.c[idx]! += 1;
    }
  }
  return H;
}

function subtractHist(parent: Hist, child: Hist): Hist {
  const o: Hist = { g: new Float64Array(parent.g.length), h: new Float64Array(parent.h.length), c: new Int32Array(parent.c.length) };
  for (let i = 0; i < o.g.length; i++) { o.g[i] = parent.g[i]! - child.g[i]!; o.h[i] = parent.h[i]! - child.h[i]!; o.c[i] = parent.c[i]! - child.c[i]!; }
  return o;
}

interface Split { gain: number; f: number; bin: number; missLeft: boolean; GL: number; HL: number; CL: number }

function bestSplit(H: Hist, F: number, nbins: number[], G: number, Hs: number, C: number, p: GbmParams): Split | null {
  let best: Split | null = null;
  const parentTerm = (G * G) / (Hs + p.l2);
  for (let f = 0; f < F; f++) {
    const nb = nbins[f]!;
    if (nb < 2) continue;
    const base = f * 256;
    const gm = H.g[base + MISSING_BIN]!; const hm = H.h[base + MISSING_BIN]!; const cm = H.c[base + MISSING_BIN]!;
    let cg = 0; let ch = 0; let cc = 0;
    for (let b = 0; b < nb - 1; b++) {
      const cb = H.c[base + b]!;
      cg += H.g[base + b]!; ch += H.h[base + b]!; cc += cb;
      if (cb === 0) continue; // same partition as the previous cut
      for (let side = 0; side < (cm > 0 ? 2 : 1); side++) {
        const ml = side === 1;
        const GL = cg + (ml ? gm : 0); const HL = ch + (ml ? hm : 0); const CL = cc + (ml ? cm : 0);
        const GR = G - GL; const HR = Hs - HL; const CR = C - CL;
        if (CL < p.minSamplesLeaf || CR < p.minSamplesLeaf || HL < MIN_HESS_LEAF || HR < MIN_HESS_LEAF) continue;
        const gain = (GL * GL) / (HL + p.l2) + (GR * GR) / (HR + p.l2) - parentTerm;
        if (gain > MIN_GAIN && (best === null || gain > best.gain)) best = { gain, f, bin: b, missLeft: cm > 0 ? ml : CL >= CR, GL, HL, CL };
      }
    }
  }
  return best;
}

interface Leaf { node: number; rows: Int32Array; hist: Hist; G: number; H: number; C: number; split: Split | null }

function growTree(bins: Uint8Array, F: number, trainRows: Int32Array, grad: Float64Array, hess: Float64Array, edges: number[][], nbins: number[], p: GbmParams, gainOut: Float64Array): { tree: TreeJson; leaves: { rows: Int32Array; value: number }[] } {
  const tree: TreeJson = { f: [-1], t: [0], m: [0], l: [-1], r: [-1], v: [0] };
  const rootHist = buildHist(bins, F, trainRows, grad, hess);
  let G = 0; let Hs = 0;
  for (let k = 0; k < trainRows.length; k++) { G += grad[trainRows[k]!]!; Hs += hess[trainRows[k]!]!; }
  const root: Leaf = { node: 0, rows: trainRows, hist: rootHist, G, H: Hs, C: trainRows.length, split: null };
  root.split = bestSplit(root.hist, F, nbins, root.G, root.H, root.C, p);
  const leaves: Leaf[] = [root];
  while (leaves.length < p.maxLeafNodes) {
    let pick = -1;
    for (let i = 0; i < leaves.length; i++) {
      const s = leaves[i]!.split;
      if (s && (pick < 0 || s.gain > leaves[pick]!.split!.gain)) pick = i;
    }
    if (pick < 0) break;
    const leaf = leaves[pick]!;
    const s = leaf.split!;
    gainOut[s.f]! += s.gain;
    // partition the rows
    let nLeft = 0;
    const goesLeft = new Uint8Array(leaf.rows.length);
    for (let k = 0; k < leaf.rows.length; k++) {
      const b = bins[leaf.rows[k]! * F + s.f]!;
      const left = b === MISSING_BIN ? s.missLeft : b <= s.bin;
      if (left) { goesLeft[k] = 1; nLeft++; }
    }
    const leftRows = new Int32Array(nLeft); const rightRows = new Int32Array(leaf.rows.length - nLeft);
    let li = 0; let ri = 0;
    for (let k = 0; k < leaf.rows.length; k++) { if (goesLeft[k]) leftRows[li++] = leaf.rows[k]!; else rightRows[ri++] = leaf.rows[k]!; }
    // children histograms: build the smaller side, subtract for the other
    const smallLeft = leftRows.length <= rightRows.length;
    const small = buildHist(bins, F, smallLeft ? leftRows : rightRows, grad, hess);
    const large = subtractHist(leaf.hist, small);
    const leftHist = smallLeft ? small : large; const rightHist = smallLeft ? large : small;
    const lNode = tree.f.length; const rNode = lNode + 1;
    for (let q = 0; q < 2; q++) { tree.f.push(-1); tree.t.push(0); tree.m.push(0); tree.l.push(-1); tree.r.push(-1); tree.v.push(0); }
    tree.f[leaf.node] = s.f; tree.t[leaf.node] = edges[s.f]![s.bin]!; tree.m[leaf.node] = s.missLeft ? 1 : 0; tree.l[leaf.node] = lNode; tree.r[leaf.node] = rNode;
    const L: Leaf = { node: lNode, rows: leftRows, hist: leftHist, G: s.GL, H: s.HL, C: s.CL, split: null };
    const R: Leaf = { node: rNode, rows: rightRows, hist: rightHist, G: leaf.G - s.GL, H: leaf.H - s.HL, C: leaf.C - s.CL, split: null };
    L.split = bestSplit(L.hist, F, nbins, L.G, L.H, L.C, p);
    R.split = bestSplit(R.hist, F, nbins, R.G, R.H, R.C, p);
    leaves.splice(pick, 1, L, R);
  }
  const out: { rows: Int32Array; value: number }[] = [];
  for (const l of leaves) {
    const value = (-l.G / Math.max(l.H + p.l2, MIN_HESS_LEAF)) * p.learningRate;
    tree.v[l.node] = value;
    out.push({ rows: l.rows, value });
    l.hist = undefined as unknown as Hist; // free
  }
  return { tree, leaves: out };
}

function treeValue(t: TreeJson, x: ArrayLike<number>): number {
  let i = 0;
  while (t.f[i]! >= 0) {
    const v = x[t.f[i]!]!;
    i = Number.isNaN(v) ? (t.m[i] === 1 ? t.l[i]! : t.r[i]!) : v <= t.t[i]! ? t.l[i]! : t.r[i]!;
  }
  return t.v[i]!;
}

/** Raw scores (log-odds for the binary model, one logit per class otherwise) of one feature vector, using the first `iterations` iterations (default: all kept). */
export function gbmRaw(m: GbmModel, x: ArrayLike<number>, iterations: number = m.trees.length): number[] {
  const out = m.init.slice();
  const T = Math.min(iterations, m.trees.length);
  for (let it = 0; it < T; it++) for (let k = 0; k < m.classes - (m.classes === 2 ? 1 : 0); k++) out[k]! += treeValue(m.trees[it]![k]!, x);
  return out;
}

/** Probabilities: [P(class 1)] for the binary model, K class probabilities otherwise. */
export function gbmProba(m: GbmModel, x: ArrayLike<number>): number[] {
  const raw = gbmRaw(m, x);
  if (m.classes === 2) return [sigmoid(raw[0]!)];
  return softmax(raw);
}

function softmax(z: number[]): number[] {
  const mx = Math.max(...z);
  const e = z.map((v) => Math.exp(v - mx));
  const s = e.reduce((a, b) => a + b, 0);
  return e.map((v) => v / s);
}

/** Probability of the positive class for every row of a row-major matrix (binary model). */
export function gbmPredictAll(m: GbmModel, X: Float64Array, n: number, F: number): Float64Array {
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) out[i] = gbmProba(m, X.subarray(i * F, (i + 1) * F))[0]!;
  return out;
}

export async function fitGbm(input: GbmFitInput): Promise<GbmModel> {
  const { X, n, F, y, classes, featureNames, seed } = input;
  if (n === 0) throw new Error('GBM: no rows');
  const p: GbmParams = { ...GBM_DEFAULTS, ...input.params };
  const K = classes === 2 ? 1 : classes;
  const w = input.w ?? null;
  // seeded validation slice
  const perm = seededPermutation(n, makeRng(seed));
  const nVal = p.validationFraction > 0 && n >= 50 ? Math.floor(n * p.validationFraction) : 0;
  const valRows = Int32Array.from(perm.subarray(0, nVal)).sort();
  const trainRows = Int32Array.from(perm.subarray(nVal)).sort();
  // bins from the training rows only
  const edges: number[][] = [];
  const nbins: number[] = [];
  for (let f = 0; f < F; f++) {
    const vals: number[] = [];
    for (let k = 0; k < trainRows.length; k++) { const v = X[trainRows[k]! * F + f]!; if (!Number.isNaN(v)) vals.push(v); }
    const e = edgesOf(Float64Array.from(vals), Math.min(p.maxBins, 255));
    edges.push(e); nbins.push(e.length + 1);
  }
  const bins = new Uint8Array(n * F);
  for (let i = 0; i < n; i++) for (let f = 0; f < F; f++) { const v = X[i * F + f]!; bins[i * F + f] = Number.isNaN(v) ? MISSING_BIN : binOf(v, edges[f]!); }
  const wt = (i: number): number => (w ? w[i]! : 1);
  // initial scores from the weighted class shares of the training rows
  const init: number[] = [];
  if (K === 1) {
    let sw = 0; let sy = 0;
    for (const i of trainRows) { sw += wt(i); sy += wt(i) * (y[i] === 1 ? 1 : 0); }
    const q = Math.min(1 - 1e-6, Math.max(1e-6, sy / sw));
    init.push(Math.log(q / (1 - q)));
  } else {
    const cs = new Float64Array(K); let sw = 0;
    for (const i of trainRows) { cs[y[i]!]! += wt(i); sw += wt(i); }
    for (let k = 0; k < K; k++) init.push(Math.log(Math.max(cs[k]! / sw, 1e-6)));
  }
  const Fx = new Float64Array(n * K); // current raw scores for every row (train and validation)
  for (let i = 0; i < n; i++) for (let k = 0; k < K; k++) Fx[i * K + k] = init[k]!;
  const grad = new Float64Array(n); const hess = new Float64Array(n);
  const gainByFeature = new Float64Array(F);
  const trees: TreeJson[][] = [];
  const valLoss: number[] = [];
  let bestLoss = Infinity; let bestIter = 0;
  const rowOf = (i: number): Float64Array => X.subarray(i * F, (i + 1) * F);

  const lossOn = (rows: Int32Array): number => {
    let s = 0; let sw = 0;
    for (const i of rows) {
      const wi = wt(i);
      if (K === 1) { const pr = Math.min(1 - 1e-12, Math.max(1e-12, sigmoid(Fx[i]!))); s += -wi * (y[i] === 1 ? Math.log(pr) : Math.log(1 - pr)); } else {
        const pr = softmax(Array.from(Fx.subarray(i * K, (i + 1) * K)));
        s += -wi * Math.log(Math.max(pr[y[i]!]!, 1e-12));
      }
      sw += wi;
    }
    return sw > 0 ? s / sw : 0;
  };

  for (let it = 0; it < p.maxIter; it++) {
    // gradients for all classes from the current scores
    const probs: Float64Array[] = [];
    if (K === 1) {
      for (const i of trainRows) {
        const pr = sigmoid(Fx[i]!); const wi = wt(i);
        grad[i] = wi * (pr - (y[i] === 1 ? 1 : 0)); hess[i] = wi * Math.max(pr * (1 - pr), 1e-6);
      }
    } else {
      for (let k = 0; k < K; k++) probs.push(new Float64Array(n));
      for (const i of trainRows) {
        const pr = softmax(Array.from(Fx.subarray(i * K, (i + 1) * K)));
        for (let k = 0; k < K; k++) probs[k]![i] = pr[k]!;
      }
    }
    const iterTrees: TreeJson[] = [];
    for (let k = 0; k < K; k++) {
      if (K > 1) {
        const pk = probs[k]!;
        for (const i of trainRows) { const wi = wt(i); grad[i] = wi * (pk[i]! - (y[i] === k ? 1 : 0)); hess[i] = wi * Math.max((K / (K - 1)) * pk[i]! * (1 - pk[i]!), 1e-6); }
      }
      const { tree, leaves } = growTree(bins, F, trainRows, grad, hess, edges, nbins, p, gainByFeature);
      iterTrees.push(tree);
      for (const lf of leaves) for (let q = 0; q < lf.rows.length; q++) Fx[lf.rows[q]! * K + k]! += lf.value;
      for (const i of valRows) Fx[i * K + k]! += treeValue(tree, rowOf(i));
    }
    trees.push(iterTrees);
    if (nVal > 0) {
      const l = lossOn(valRows);
      valLoss.push(l);
      if (l < bestLoss - 1e-12) { bestLoss = l; bestIter = it; }
      else if (it - bestIter >= p.patience) break;
    } else bestIter = it;
    if (input.expired?.()) throw new Error('TRAIN_TIME_BUDGET');
    if (input.yieldFn) await input.yieldFn();
  }
  const kept = trees.slice(0, bestIter + 1);
  const tot = gainByFeature.reduce((a, b) => a + b, 0);
  const importance = Array.from(gainByFeature, (g) => (tot > 0 ? Math.round((g / tot) * 1e6) / 1e6 : 0));
  return { kind: 'gbm', classes, featureNames, edges, init, trees: kept, importance, bestIter: kept.length, valLoss, trainedOn: trainRows.length, validatedOn: nVal, params: p, seed };
}
