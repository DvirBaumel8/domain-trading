// CR-073 (v5.28.0): the pick-proof statistics, pure and dependency-free (apart from the seeded MT19937 of src/core): Fisher exact (one-sided), the
// Cochran-Mantel-Haenszel test over strata, Holm adjustment and a seeded within-day permutation test. Every p-value here is a proxy test, not profit.
import { MT19937 } from '../../core/mt19937.js';

/** A 2x2 table: arm 1 (events a, non-events b) against arm 2 (events c, non-events d). */
export interface Table2x2 { a: number; b: number; c: number; d: number }

const lf: number[] = [0];
/** log(n!) from a cached running sum of logs (exact enough: relative error ~1e-15 for n up to millions). */
function logFact(n: number): number {
  for (let i = lf.length; i <= n; i++) lf.push(lf[i - 1]! + Math.log(i));
  return lf[n]!;
}
const logChoose = (n: number, k: number): number => logFact(n) - logFact(k) - logFact(n - k);

/** One-sided Fisher exact p-value that arm 1 has a higher event rate: P(X >= a) under the hypergeometric distribution given the margins. Log-space. */
export function fisherGreater(t: Table2x2): number {
  const n1 = t.a + t.b, n2 = t.c + t.d, events = t.a + t.c, total = n1 + n2;
  if (n1 === 0 || n2 === 0) return 1;
  const lo = Math.max(t.a, Math.max(0, events - n2));
  const hi = Math.min(n1, events);
  const denom = logChoose(total, events);
  let p = 0;
  for (let x = lo; x <= hi; x++) p += Math.exp(logChoose(n1, x) + logChoose(n2, events - x) - denom);
  return Math.min(1, p);
}

/** Standard normal survival function P(Z > z) (erfc by the Numerical Recipes Chebyshev fit, fractional error below 1.2e-7). */
export function normalSf(z: number): number {
  const x = Math.abs(z) / Math.SQRT2;
  const t = 1 / (1 + 0.5 * x);
  const erfc = t * Math.exp(-x * x - 1.26551223 + t * (1.00002368 + t * (0.37409196 + t * (0.09678418 + t * (-0.18628806 + t * (0.27886807 + t * (-1.13520398 + t * (1.48851587 + t * (-0.82215223 + t * 0.17087277)))))))));
  const sfAbs = 0.5 * erfc; // P(Z > |z|)
  return z >= 0 ? sfAbs : 1 - sfAbs;
}

export interface CmhResult {
  /** CMH chi-square (1 df, no continuity correction) and the signed z; null when no stratum has variance. */
  chi2: number | null;
  z: number | null;
  /** One-sided p (arm 1 higher). */
  p_value: number | null;
  /** Mantel-Haenszel common odds ratio, null when undefined. */
  odds_ratio: number | null;
  used_strata_n: number;
}

/** Cochran-Mantel-Haenszel over 2x2 strata. Strata with fewer than 2 names or no variance add nothing. */
export function cmh(strata: Table2x2[]): CmhResult {
  let sa = 0, se = 0, sv = 0, used = 0, rNum = 0, rDen = 0;
  for (const t of strata) {
    const n1 = t.a + t.b, n2 = t.c + t.d, m1 = t.a + t.c, m2 = t.b + t.d, n = n1 + n2;
    if (n < 2) continue;
    rNum += (t.a * t.d) / n;
    rDen += (t.b * t.c) / n;
    const v = (n1 * n2 * m1 * m2) / (n * n * (n - 1));
    if (v <= 0) continue;
    sa += t.a; se += (n1 * m1) / n; sv += v; used++;
  }
  const odds_ratio = rDen > 0 ? rNum / rDen : null;
  if (sv <= 0) return { chi2: null, z: null, p_value: null, odds_ratio, used_strata_n: 0 };
  const z = (sa - se) / Math.sqrt(sv);
  return { chi2: z * z, z, p_value: normalSf(z), odds_ratio, used_strata_n: used };
}

/** Holm step-down adjusted p-values, returned in the input order. */
export function holm(ps: number[]): number[] {
  const m = ps.length;
  const order = ps.map((p, i) => ({ p, i })).sort((x, y) => x.p - y.p);
  const out = new Array<number>(m).fill(1);
  let running = 0;
  order.forEach((o, k) => {
    running = Math.max(running, Math.min(1, (m - k) * o.p));
    out[o.i] = running;
  });
  return out;
}

export interface PermDay { /** outcomes (1 = event) of this day's labelled names of arm 1 then arm 2 */ outcomes: number[]; n1: number }

/**
 * Within-day permutation test, one-sided (arm 1 has more events): every day's pooled outcomes keep their size and the number of arm 1 slots,
 * the arm assignment is shuffled (Fisher-Yates on the seeded MT19937), the statistic is the total events landing in arm 1.
 * p = (1 + #{permuted >= observed}) / (1 + shuffles). The same days, seed and shuffles give the same p.
 */
export function permutationTest(days: PermDay[], seed: number, shuffles = 10_000): { p_value: number; observed: number; shuffles: number } {
  const rng = new MT19937([seed >>> 0]);
  let observed = 0;
  for (const d of days) for (let i = 0; i < d.n1; i++) observed += d.outcomes[i]!;
  const work = days.map((d) => d.outcomes.slice());
  let ge = 0;
  for (let s = 0; s < shuffles; s++) {
    let stat = 0;
    for (let k = 0; k < days.length; k++) {
      const arr = work[k]!, n1 = days[k]!.n1;
      // partial Fisher-Yates: only the first n1 positions are needed
      for (let i = 0; i < n1; i++) {
        const j = i + rng.below(arr.length - i);
        const t = arr[i]!; arr[i] = arr[j]!; arr[j] = t;
        stat += arr[i]!;
      }
    }
    if (stat >= observed) ge++;
  }
  return { p_value: (1 + ge) / (1 + shuffles), observed, shuffles };
}
