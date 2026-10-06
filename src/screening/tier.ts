// CAP-24 rule tier and DEMAND-2: three-valued evaluation of the tier clauses in the selection settings. Pure.
// A missing feature (null) makes its condition `unknown`; it is never read as a pass or a fail (CR-002 CAP-21 missing-data rule).
import type { ClauseT, CondT, SelectionValuesT } from './settings.js';

export type Tri = 'true' | 'false' | 'unknown';

export interface TierFeatures {
  registered_share: number | null; prior_history: 0 | 1 | null; alt_tld_before_n: number | null; n_words: number | null;
  sld_chars: number | null; is_geo: 0 | 1; gform1_pass: 0 | 1 | null; short: 0 | 1 | null;
}
type TierName = 'A' | 'I' | 'B' | 'G';
export interface TierResult {
  tier: TierName | 'none';
  /** False when an earlier tier in the order was `unknown`: a later tier decided, but the earlier one could still have applied. */
  tier_exact: boolean;
  clauses: Record<string, Tri>;
  demand2: 'PASS' | 'FAIL' | 'UNKNOWN';
  fired: string | null;
  inputs: TierFeatures;
}

type Clause = ClauseT;
type Cond = CondT;

function cmp(op: string, a: number, b: number): boolean {
  switch (op) {
    case '>=': return a >= b;
    case '<=': return a <= b;
    case '>': return a > b;
    case '<': return a < b;
    case '==': return a === b;
    default: return a !== b;
  }
}

function evalCond(c: Cond, f: TierFeatures, done: Record<string, Tri>, thresholds: Record<string, number>): Tri {
  if ('tier' in c) return done[c.tier] ?? 'unknown';
  const x = (f as unknown as Record<string, number | null>)[c.f];
  if (x === null || x === undefined) return 'unknown';
  const v = typeof c.v === 'string' ? thresholds[c.v.slice(1)] : c.v;
  if (v === undefined) return 'unknown';
  return cmp(c.op, x, v) ? 'true' : 'false';
}

/** all: false if any false, else unknown if any unknown, else true. any: true if any true, else unknown if any unknown, else false. */
function evalClause(clause: Clause, f: TierFeatures, done: Record<string, Tri>, thresholds: Record<string, number>): Tri {
  const isAll = 'all' in clause;
  const rs = (isAll ? clause.all : clause.any).map((c) => evalCond(c, f, done, thresholds));
  if (isAll) return rs.includes('false') ? 'false' : rs.includes('unknown') ? 'unknown' : 'true';
  return rs.includes('true') ? 'true' : rs.includes('unknown') ? 'unknown' : 'false';
}

export function evaluateTier(f: TierFeatures, t: SelectionValuesT['tier'], thresholds: Record<string, number>): TierResult {
  const clauses: Record<string, Tri> = {};
  for (const name of t.order) {
    const clause = t.clauses[name];
    clauses[name] = clause ? evalClause(clause, f, clauses, thresholds) : 'false';
  }
  const firstTrue = t.order.findIndex((n) => clauses[n] === 'true');
  const tier: TierResult['tier'] = firstTrue >= 0 ? t.order[firstTrue]! : 'none';
  const earlier = firstTrue >= 0 ? t.order.slice(0, firstTrue) : t.order;
  const tier_exact = !earlier.some((n) => clauses[n] === 'unknown');
  const d = t.demand2_pass_tiers.map((n) => clauses[n] ?? 'false');
  const demand2 = d.includes('true') ? 'PASS' : d.includes('unknown') ? 'UNKNOWN' : 'FAIL';
  return { tier, tier_exact, clauses, demand2, fired: tier === 'none' ? null : tier, inputs: f };
}
