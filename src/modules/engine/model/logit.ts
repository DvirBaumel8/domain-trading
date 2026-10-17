// L2-regularised logistic regression (lambda 1) on standardised features, fitted by Newton's method (IRLS): convex, so it converges to one answer,
// and nothing in it is random. It explains a score: contribution of a feature = coefficient x standardised value (plus its missing-indicator term).
// A missing value is replaced by the training mean and a 0/1 "missing" column is added for every feature that had any missing training value.

export interface LogitModel {
  kind: 'logit'; featureNames: string[];
  means: number[]; stds: number[];
  /** Indices of the features that carry a missing-indicator column. */
  missingCols: number[];
  /** One coefficient per standardised feature, then one per missing-indicator column. */
  coef: number[]; intercept: number; l2: number; iterations: number; trainedOn: number;
}

export interface LogitFitInput { X: Float64Array; n: number; F: number; y: Int32Array; featureNames: string[]; l2?: number; maxIter?: number }

const sigmoid = (z: number): number => (z >= 0 ? 1 / (1 + Math.exp(-z)) : Math.exp(z) / (1 + Math.exp(z)));

/** Solves A x = b for a symmetric positive definite A (n x n, row-major) by Cholesky; A is overwritten. */
function choleskySolve(A: Float64Array, b: Float64Array, n: number): Float64Array {
  for (let j = 0; j < n; j++) {
    let d = A[j * n + j]!;
    for (let k = 0; k < j; k++) d -= A[j * n + k]! * A[j * n + k]!;
    if (d <= 1e-12) d = 1e-12;
    const dj = Math.sqrt(d);
    A[j * n + j] = dj;
    for (let i = j + 1; i < n; i++) {
      let s = A[i * n + j]!;
      for (let k = 0; k < j; k++) s -= A[i * n + k]! * A[j * n + k]!;
      A[i * n + j] = s / dj;
    }
  }
  const z = new Float64Array(n);
  for (let i = 0; i < n; i++) { let s = b[i]!; for (let k = 0; k < i; k++) s -= A[i * n + k]! * z[k]!; z[i] = s / A[i * n + i]!; }
  const x = new Float64Array(n);
  for (let i = n - 1; i >= 0; i--) { let s = z[i]!; for (let k = i + 1; k < n; k++) s -= A[k * n + i]! * x[k]!; x[i] = s / A[i * n + i]!; }
  return x;
}

/** The design vector of one row: standardised features (missing = 0), then the missing indicators. */
function logitDesign(m: LogitModel, x: ArrayLike<number>): Float64Array {
  const F = m.means.length;
  const d = new Float64Array(F + m.missingCols.length);
  for (let f = 0; f < F; f++) {
    const v = x[f]!;
    d[f] = Number.isNaN(v) ? 0 : m.stds[f]! > 0 ? (v - m.means[f]!) / m.stds[f]! : 0;
  }
  for (let c = 0; c < m.missingCols.length; c++) d[F + c] = Number.isNaN(x[m.missingCols[c]!]!) ? 1 : 0;
  return d;
}

export function fitLogit(input: LogitFitInput): LogitModel {
  const { X, n, F, y } = input;
  const l2 = input.l2 ?? 1;
  const means = new Array<number>(F).fill(0); const stds = new Array<number>(F).fill(0);
  const missing = new Array<boolean>(F).fill(false);
  for (let f = 0; f < F; f++) {
    let s = 0; let c = 0;
    for (let i = 0; i < n; i++) { const v = X[i * F + f]!; if (Number.isNaN(v)) missing[f] = true; else { s += v; c++; } }
    means[f] = c > 0 ? s / c : 0;
    let q = 0;
    for (let i = 0; i < n; i++) { const v = X[i * F + f]!; if (!Number.isNaN(v)) q += (v - means[f]!) ** 2; }
    stds[f] = c > 1 ? Math.sqrt(q / c) : 0;
  }
  const missingCols = missing.map((b, f) => (b ? f : -1)).filter((f) => f >= 0);
  const shell: LogitModel = { kind: 'logit', featureNames: input.featureNames, means, stds, missingCols, coef: [], intercept: 0, l2, iterations: 0, trainedOn: n };
  const D = F + missingCols.length;
  const P = D + 1; // + intercept (last)
  const design = new Float64Array(n * D);
  for (let i = 0; i < n; i++) design.set(logitDesign(shell, X.subarray(i * F, (i + 1) * F)), i * D);
  const beta = new Float64Array(P);
  let ybar = 0;
  for (let i = 0; i < n; i++) ybar += y[i] === 1 ? 1 : 0;
  ybar = Math.min(1 - 1e-6, Math.max(1e-6, ybar / n));
  beta[D] = Math.log(ybar / (1 - ybar));
  const maxIter = input.maxIter ?? 30;
  let it = 0;
  for (; it < maxIter; it++) {
    const Hm = new Float64Array(P * P); const g = new Float64Array(P);
    for (let i = 0; i < n; i++) {
      let z = beta[D]!;
      for (let j = 0; j < D; j++) z += beta[j]! * design[i * D + j]!;
      const p = sigmoid(z); const wv = Math.max(p * (1 - p), 1e-9); const r = p - (y[i] === 1 ? 1 : 0);
      for (let a = 0; a < D; a++) {
        const xa = design[i * D + a]!;
        if (xa === 0) continue;
        g[a]! += r * xa;
        for (let b = 0; b <= a; b++) Hm[a * P + b]! += wv * xa * design[i * D + b]!;
        Hm[D * P + a]! += wv * xa;
      }
      g[D]! += r; Hm[D * P + D]! += wv;
    }
    for (let a = 0; a < D; a++) { g[a]! += l2 * beta[a]!; Hm[a * P + a]! += l2; }
    // the lower triangle is filled; mirror it for the Cholesky routine (it reads the lower part only)
    const step = choleskySolve(Hm, g, P);
    let mx = 0;
    for (let j = 0; j < P; j++) { beta[j]! -= step[j]!; mx = Math.max(mx, Math.abs(step[j]!)); }
    if (mx < 1e-7) { it++; break; }
  }
  return { ...shell, coef: Array.from(beta.subarray(0, D)), intercept: beta[D]!, iterations: it };
}

export function logitProba(m: LogitModel, x: ArrayLike<number>): number {
  const d = logitDesign(m, x);
  let z = m.intercept;
  for (let j = 0; j < d.length; j++) z += m.coef[j]! * d[j]!;
  return sigmoid(z);
}

/** Per feature: coefficient x standardised value, plus its missing-indicator term. Positive = toward the positive class. */
export function logitContributions(m: LogitModel, x: ArrayLike<number>): number[] {
  const d = logitDesign(m, x);
  const F = m.means.length;
  const out = new Array<number>(F).fill(0);
  for (let f = 0; f < F; f++) out[f] = m.coef[f]! * d[f]!;
  for (let c = 0; c < m.missingCols.length; c++) out[m.missingCols[c]!]! += m.coef[F + c]! * d[F + c]!;
  return out;
}
