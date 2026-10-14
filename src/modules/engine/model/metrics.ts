// Metrics of the engine (pure): AUC with a seeded bootstrap interval, precision at the top share with a Wilson interval, a precision at a stated
// base rate, and score quantiles. Ties in a score are broken by input order (the caller sorts its rows), so a result never depends on chance.
import { makeRng } from './rng.js';

const r4 = (x: number): number => Math.round(x * 10_000) / 10_000;

/** Wilson score interval, z = 1.96, 4 decimals. null when n is 0. */
export function wilson(k: number, n: number): [number, number] | null {
  if (n === 0) return null;
  const z = 1.96;
  const p = k / n;
  const den = 1 + (z * z) / n;
  const centre = (p + (z * z) / (2 * n)) / den;
  const half = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / den;
  return [r4(Math.max(0, centre - half)), r4(Math.min(1, centre + half))];
}

/** AUC by ranks (Mann-Whitney, ties count half). null when a class is empty. */
export function auc(scores: ArrayLike<number>, labels: ArrayLike<number>): number | null {
  return aucWeighted(scores, labels, null);
}

function sortedOrder(scores: ArrayLike<number>): Int32Array {
  const idx = Int32Array.from({ length: scores.length }, (_, i) => i);
  return idx.sort((a, b) => scores[a]! - scores[b]! || a - b);
}

/** AUC with integer multiplicities per row (a bootstrap draw); `mult` null = every row once. */
function aucWeighted(scores: ArrayLike<number>, labels: ArrayLike<number>, mult: ArrayLike<number> | null, order?: Int32Array): number | null {
  const ord = order ?? sortedOrder(scores);
  let pos = 0; let neg = 0;
  for (let i = 0; i < scores.length; i++) { const m = mult ? mult[i]! : 1; if (labels[i] === 1) pos += m; else neg += m; }
  if (pos === 0 || neg === 0) return null;
  let negSeen = 0; let sum = 0;
  let i = 0;
  while (i < ord.length) {
    let j = i;
    while (j < ord.length && scores[ord[j]!] === scores[ord[i]!]) j++;
    let gp = 0; let gn = 0;
    for (let k = i; k < j; k++) { const m = mult ? mult[ord[k]!]! : 1; if (labels[ord[k]!] === 1) gp += m; else gn += m; }
    sum += gp * (negSeen + gn / 2);
    negSeen += gn;
    i = j;
  }
  return sum / (pos * neg);
}

/** AUC and its 95% percentile bootstrap interval (seeded; `n` resamples of the rows). */
export function aucWithCi(scores: ArrayLike<number>, labels: ArrayLike<number>, seed: number, resamples = 1000): { auc: number | null; ci: [number, number] | null } {
  const point = auc(scores, labels);
  if (point === null) return { auc: null, ci: null };
  const n = scores.length;
  const order = sortedOrder(scores);
  const rng = makeRng(seed);
  const vals: number[] = [];
  const mult = new Float64Array(n);
  for (let b = 0; b < resamples; b++) {
    mult.fill(0);
    for (let i = 0; i < n; i++) mult[Math.floor(rng() * n)]! += 1;
    const a = aucWeighted(scores, labels, mult, order);
    if (a !== null) vals.push(a);
  }
  if (vals.length === 0) return { auc: r4(point), ci: null };
  vals.sort((x, y) => x - y);
  const q = (p: number) => vals[Math.min(vals.length - 1, Math.max(0, Math.floor(p * vals.length)))]!;
  return { auc: r4(point), ci: [r4(q(0.025)), r4(q(0.975))] };
}

/** Rows ordered best score first; equal scores keep input order. */
export function bestFirst(scores: ArrayLike<number>): Int32Array {
  const idx = Int32Array.from({ length: scores.length }, (_, i) => i);
  return idx.sort((a, b) => scores[b]! - scores[a]! || a - b);
}

export interface PrecisionAtTop { share: number; n_top: number; positives: number; precision: number | null; ci: [number, number] | null }

/** Precision among the top `share` of rows by score (at least one row). */
export function precisionAtTop(scores: ArrayLike<number>, labels: ArrayLike<number>, share: number): PrecisionAtTop {
  const n = scores.length;
  if (n === 0) return { share, n_top: 0, positives: 0, precision: null, ci: null };
  const top = Math.max(1, Math.ceil(n * share));
  const ord = bestFirst(scores);
  let k = 0;
  for (let i = 0; i < top; i++) if (labels[ord[i]!] === 1) k++;
  return { share, n_top: top, positives: k, precision: r4(k / top), ci: wilson(k, top) };
}

/**
 * Precision among the top `share` of a population re-weighted to one sold name per `oneIn` others: every unsold row counts `oneIn * sold / unsold` times.
 * The top share is taken by weight (the last row may count in part). null when a class is empty.
 */
export function precisionAtBaseRate(scores: ArrayLike<number>, labels: ArrayLike<number>, share: number, oneIn: number): number | null {
  let pos = 0; let neg = 0;
  for (let i = 0; i < labels.length; i++) { if (labels[i] === 1) pos++; else neg++; }
  if (pos === 0 || neg === 0) return null;
  const wNeg = (oneIn * pos) / neg;
  const total = pos + oneIn * pos;
  const budget = total * share;
  const ord = bestFirst(scores);
  let used = 0; let tp = 0;
  for (const i of ord) {
    const w = labels[i] === 1 ? 1 : wNeg;
    const take = Math.min(w, budget - used);
    if (take <= 0) break;
    if (labels[i] === 1) tp += take;
    used += take;
  }
  return used === 0 ? null : r4(tp / used);
}

/** 101 quantiles (0%..100%) of a list by linear interpolation; [] for an empty list. Values are kept to 6 decimals. */
export function quantiles101(values: ArrayLike<number>): number[] {
  const n = values.length;
  if (n === 0) return [];
  const s = Array.from({ length: n }, (_, i) => values[i]!).sort((a, b) => a - b);
  const out: number[] = [];
  for (let q = 0; q <= 100; q++) {
    const pos = (q / 100) * (n - 1);
    const lo = Math.floor(pos);
    const hi = Math.min(n - 1, lo + 1);
    out.push(Math.round((s[lo]! + (s[hi]! - s[lo]!) * (pos - lo)) * 1e6) / 1e6);
  }
  return out;
}

/** The percentile (0..100, one decimal) of `x` among the 101 quantiles of a class: the share of that class scoring at or below x. */
export function percentileIn(q: readonly number[], x: number): number | null {
  if (q.length !== 101) return null;
  if (x <= q[0]!) return 0;
  if (x >= q[100]!) return 100;
  let lo = 0; let hi = 100;
  while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (q[mid]! <= x) lo = mid; else hi = mid; }
  const span = q[hi]! - q[lo]!;
  const frac = span > 0 ? (x - q[lo]!) / span : 0;
  return Math.round((lo + frac) * 10) / 10;
}
