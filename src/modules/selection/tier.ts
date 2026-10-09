// CAP-24 rule tier and DEMAND-2: three-valued evaluation of the tier clauses in the selection settings. Pure.
// A missing feature (null) makes its condition `unknown`; it is never read as a pass or a fail (CR-002 CAP-21 missing-data rule).
import type { ClauseT, CondT, SelectionValuesT } from './settings.js';

export type Tri = 'true' | 'false' | 'unknown';

export interface TierFeatures {
  registered_share: number | null; prior_history: 0 | 1 | null; alt_tld_before_n: number | null; n_words: number | null;
  sld_chars: number | null; is_geo: 0 | 1; gform1_pass: 0 | 1 | null; short: 0 | 1 | null;
  /** v3.3.0 (CR-023 A): the name's lane (intake lane, or the lane a drop-list name fit); null = unknown. */
  lane?: string | null;
  /** v3.3.0 (CR-023 B): how many of the name's listed sellers are verified (0 = no list); null = unknown (e.g. a stale record). */
  sellers_verified_n?: number | null;
  /** v3.4.1 (CR-028): how many of the listed sellers could not be read (HTTP 401/403/429, timeout); 0 = no list; null = unknown (stale record). */
  sellers_unknown_n?: number | null;
}
type TierName = 'A' | 'I' | 'B' | 'G' | 'L';
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

/** The one comparison of a tier condition (also used by the tier check to tell which conditions decided a clause). */
export function cmp(op: string, a: number, b: number): boolean {
  switch (op) {
    case '>=': return a >= b;
    case '<=': return a <= b;
    case '>': return a > b;
    case '<': return a < b;
    case '==': return a === b;
    default: return a !== b;
  }
}

export type Thresholds = SelectionValuesT['thresholds'];

/**
 * A condition's comparison value: the number itself, or the named threshold for a "$name" string.
 * `undefined` = unknown (the threshold is missing, or it is a per-lane map and the lane is unknown); `null` = the name's lane is not in the per-lane map (the condition is false, CR-023 C).
 */
export const condValue = (v: string | number, thresholds: Thresholds, lane: string | null = null): number | null | undefined => {
  if (typeof v !== 'string') return v;
  const t = thresholds[v.slice(1)];
  if (t === undefined || typeof t === 'number') return t;
  if (lane === null) return undefined;
  return (t as Record<string, number | undefined>)[lane] ?? null;
};

/** One condition against one feature value: `in` with a list, else a comparison (a lane, a string, can only be tested with `in`). */
export function condHolds(c: Extract<Cond, { f: string }>, x: number | string, thresholds: Thresholds, lane: string | null): boolean | undefined {
  if (c.op === 'in') return (c.v as (string | number)[]).includes(x);
  if (typeof x !== 'number') return false;
  const v = condValue(c.v, thresholds, lane);
  if (v === undefined) return undefined;
  return v === null ? false : cmp(c.op, x, v);
}

function evalCond(c: Cond, f: TierFeatures, done: Record<string, Tri>, thresholds: Thresholds): Tri {
  if ('tier' in c) return done[c.tier] ?? 'unknown';
  const x = (f as unknown as Record<string, number | string | null>)[c.f];
  // A lane that is not in the per-lane map makes the condition false, whatever the feature is (never a pass, never unknown).
  if (c.op !== 'in' && typeof c.v === 'string' && f.lane != null && condValue(c.v, thresholds, f.lane) === null) return 'false';
  if (x === null || x === undefined) return 'unknown';
  const r = condHolds(c, x, thresholds, f.lane ?? null);
  return r === undefined ? 'unknown' : r ? 'true' : 'false';
}

/** all: false if any false, else unknown if any unknown, else true. any: true if any true, else unknown if any unknown, else false. */
function evalClause(clause: Clause, f: TierFeatures, done: Record<string, Tri>, thresholds: Thresholds): Tri {
  const isAll = 'all' in clause;
  const rs = (isAll ? clause.all : clause.any).map((c) => evalCond(c, f, done, thresholds));
  if (isAll) return rs.includes('false') ? 'false' : rs.includes('unknown') ? 'unknown' : 'true';
  return rs.includes('true') ? 'true' : rs.includes('unknown') ? 'unknown' : 'false';
}

export function evaluateTier(f: TierFeatures, t: SelectionValuesT['tier'], thresholds: Thresholds): TierResult {
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

/**
 * v2.16.0 (CR-014 N-3): the tier inputs that kept DEMAND-2 undecided: the null features read by a clause that came out `unknown`
 * (references to other tiers are followed). A null feature that only an already-false clause reads is not listed.
 */
export function unknownInputsOf(r: Pick<TierResult, 'clauses' | 'inputs'>, t: SelectionValuesT['tier']): string[] {
  const out = new Set<string>();
  const seen = new Set<string>();
  const walk = (name: string): void => {
    if (seen.has(name) || r.clauses[name] !== 'unknown') return;
    seen.add(name);
    const c = (t.clauses as Record<string, ClauseT | undefined>)[name];
    if (!c) return;
    for (const cond of 'all' in c ? c.all : c.any) {
      if ('tier' in cond) walk(cond.tier);
      else if ((r.inputs as unknown as Record<string, number | null | undefined>)[cond.f] == null) out.add(cond.f);
    }
  };
  for (const name of t.demand2_pass_tiers) walk(name);
  return [...out].sort();
}
