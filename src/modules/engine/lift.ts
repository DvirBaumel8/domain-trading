// v5.47.0 (F5): the lift model. Pure: no database, no clock, no network. Rules and test ids: docs/internal/engine.md "Lift model".
// A name is read into a few patterns (length band, word count, other endings registered before the as_of day, share of the other endings registered, had a past site).
// Every pattern has bins. The lift of a bin = ln( smoothed share of sold names in the bin / smoothed share of unsold names in the bin ), capped at +-LIFT_CAP.
//   share of sold in the bin = (sold in bin + 1) / (sold with this pattern known + 2), the same for unsold (Laplace smoothing; the +1/+2 keeps an empty bin at 0 and a
//   bin of one name from reaching the cap).
// A thin bin (fewer than LIFT_MIN_BIN_ROWS rows, weighted) takes the LOWEST lift of the pattern's other bins (0 when none has enough rows): what the data cannot show is read as no better than
// the worst it can show. Without this rule an empty bin gets ln((U+2)/(S+2)) from the smoothing alone (the two classes differ in size), which would reward a shape no training row has
// (a 4-word name, when training holds the engine's 2-3 word regime only), and a lift of 0 would put it above the 3-word names.
// A missing pattern is skipped (it adds nothing); a pattern with its own bin, such as "0 endings registered", counts as that bin.
// Score = the sum of the lifts of the name's bins (a log likelihood ratio, naive Bayes with equal class priors), turned into 0..100 by the logistic 100 / (1 + e^-sum).
import { auc } from './model/metrics.js';
import { hashUnit } from './model/rng.js';

export const LIFT_VERSION = 'lift-v1';
export const LIFT_CAP = 2;
/** Fewer rows than this in a bin (sold + unsold, weighted): the bin's lift is 0. */
export const LIFT_MIN_BIN_ROWS = 5;
/** Own rows needed in EACH class before our own data enters the table at all (below it the seed alone is used). */
export const LIFT_MIN_OWN_PER_CLASS = 50;
/** Own rows per class at which the seed has no weight left (the seed weight falls linearly from 1 at the minimum to 0 here). */
export const LIFT_SEED_FADE_ROWS = 1000;
/** Share of the primary source's rows held out for the stored AUC (chosen by a seeded hash of the row key). */
export const LIFT_HOLDOUT_SHARE = 0.2;
export const LIFT_HOLDOUT_SEED = 547;

export const PATTERNS = ['length', 'words', 'endings_before', 'registered_share', 'past_site'] as const;
export type Pattern = (typeof PATTERNS)[number];

/** The raw inputs of a name. null = not known (the pattern is skipped). */
export interface LiftInput {
  /** letters before .com */
  len: number | null;
  /** words by the engine's split */
  words: number | null;
  /** how many of the other endings were registered before the as_of day */
  endings_before: number | null;
  /** registered share of the other endings (any date), 0..1 */
  registered_share: number | null;
  /** had a website before this registration (known only for the seed) */
  past_site: boolean | null;
}

export const NO_INPUT: LiftInput = { len: null, words: null, endings_before: null, registered_share: null, past_site: null };

/** The bins of each pattern, in display order. */
export const BIN_ORDER: Readonly<Record<Pattern, readonly string[]>> = {
  length: ['<=7', '8-9', '10-11', '12-13', '14+'],
  words: ['1', '2', '3', '4+'],
  endings_before: ['0', '1', '2+'],
  registered_share: ['<0.25', '0.25-0.5', '0.5-0.75', '>=0.75'],
  past_site: ['no', 'yes'],
};

const finite = (x: number | null): x is number => x !== null && Number.isFinite(x);

export function binOf(pattern: Pattern, i: LiftInput): string | null {
  switch (pattern) {
    case 'length': { const l = i.len; if (!finite(l)) return null; return l <= 7 ? '<=7' : l <= 9 ? '8-9' : l <= 11 ? '10-11' : l <= 13 ? '12-13' : '14+'; }
    case 'words': { const w = i.words; if (!finite(w)) return null; return w <= 1 ? '1' : w === 2 ? '2' : w === 3 ? '3' : '4+'; }
    case 'endings_before': { const n = i.endings_before; if (!finite(n)) return null; return n <= 0 ? '0' : n === 1 ? '1' : '2+'; }
    case 'registered_share': { const s = i.registered_share; if (!finite(s)) return null; return s < 0.25 ? '<0.25' : s < 0.5 ? '0.25-0.5' : s < 0.75 ? '0.5-0.75' : '>=0.75'; }
    case 'past_site': return i.past_site === null ? null : i.past_site ? 'yes' : 'no';
  }
}

export interface BinStat { sold: number; unsold: number; lift: number; /** true = too few rows: the lift is the pattern's lowest */ thin?: boolean }
export interface LiftBins {
  /** the weighted counts that were smoothed (a blend has fractional counts) */
  totals: Record<Pattern, { sold: number; unsold: number }>;
  bins: Record<Pattern, Record<string, BinStat>>;
}

export interface LabelledInput { input: LiftInput; sold: boolean; /** weight of the row in the counts (1 = a row of our own, the seed weight for the seed) */ weight: number }

const r3 = (x: number): number => Math.round(x * 1000) / 1000;

/** One lift from the (weighted) counts of a bin and the pattern's class totals. */
export function liftOfCounts(soldInBin: number, unsoldInBin: number, soldTotal: number, unsoldTotal: number): number {
  const v = Math.log(((soldInBin + 1) / (soldTotal + 2)) / ((unsoldInBin + 1) / (unsoldTotal + 2)));
  return Math.max(-LIFT_CAP, Math.min(LIFT_CAP, v));
}

/** Builds the table from labelled rows. Every bin of every pattern is listed (an empty one has lift 0 by the smoothing). */
export function trainBins(rows: readonly LabelledInput[]): LiftBins {
  const totals = Object.fromEntries(PATTERNS.map((p) => [p, { sold: 0, unsold: 0 }])) as LiftBins['totals'];
  const counts = Object.fromEntries(PATTERNS.map((p) => [p, new Map<string, { sold: number; unsold: number }>(BIN_ORDER[p].map((b) => [b, { sold: 0, unsold: 0 }]))])) as Record<Pattern, Map<string, { sold: number; unsold: number }>>;
  for (const r of rows) {
    if (!(r.weight > 0)) continue;
    for (const p of PATTERNS) {
      const b = binOf(p, r.input);
      if (b === null) continue;
      const c = counts[p].get(b)!;
      if (r.sold) { c.sold += r.weight; totals[p].sold += r.weight; } else { c.unsold += r.weight; totals[p].unsold += r.weight; }
    }
  }
  const bins = Object.fromEntries(PATTERNS.map((p) => {
    const thick = [...counts[p]].filter(([, c]) => c.sold + c.unsold >= LIFT_MIN_BIN_ROWS).map(([, c]) => r3(liftOfCounts(c.sold, c.unsold, totals[p].sold, totals[p].unsold)));
    const floor = thick.length > 0 ? Math.min(...thick) : 0;
    return [p, Object.fromEntries([...counts[p]].map(([b, c]) => {
      const thin = c.sold + c.unsold < LIFT_MIN_BIN_ROWS;
      const stat: BinStat = { sold: r3(c.sold), unsold: r3(c.unsold), lift: thin ? floor : r3(liftOfCounts(c.sold, c.unsold, totals[p].sold, totals[p].unsold)) };
      if (thin) stat.thin = true;
      return [b, stat];
    }))];
  })) as LiftBins['bins'];
  for (const p of PATTERNS) totals[p] = { sold: r3(totals[p].sold), unsold: r3(totals[p].unsold) };
  return { totals, bins };
}

export interface LiftScore {
  /** sum of the lifts (log likelihood ratio) */
  sum: number;
  /** 0..100, the logistic of the sum */
  score: number;
  /** the pattern, its bin and the lift (patterns without a bin are left out) */
  parts: Array<{ pattern: Pattern; bin: string; lift: number }>;
}

export const logistic100 = (sum: number): number => Math.round((100 / (1 + Math.exp(-sum))) * 10) / 10;

/**
 * v5.49.0 (P2): `emptyBinZero` = a bin with no row at all on either side (sold + unsold = 0: a shape outside the seed's observed range, e.g. 1 word or 4+ words) counts 0, not the pattern's
 * lowest lift; a thin bin with some rows keeps the rule above. Off by default (the engine's own scoring is unchanged); the auction shortlist (auction-v4) turns it on.
 */
export function scoreLift(t: LiftBins, i: LiftInput, opts: { emptyBinZero?: boolean } = {}): LiftScore {
  const parts: LiftScore['parts'] = [];
  let sum = 0;
  for (const p of PATTERNS) {
    const b = binOf(p, i);
    if (b === null) continue;
    const st = t.bins[p]?.[b];
    const lift = opts.emptyBinZero && st && st.sold + st.unsold === 0 ? 0 : st?.lift ?? 0;
    parts.push({ pattern: p, bin: b, lift });
    sum += lift;
  }
  sum = r3(sum);
  return { sum, score: logistic100(sum), parts };
}

/** The share of the seed's weight when our own rows number `ownPerClass` in the smaller class: 1 below the minimum, then a straight line to 0 at LIFT_SEED_FADE_ROWS. */
export function seedWeight(ownPerClass: number): number {
  if (ownPerClass < LIFT_MIN_OWN_PER_CLASS) return 1;
  return Math.max(0, Math.min(1, 1 - (ownPerClass - LIFT_MIN_OWN_PER_CLASS) / (LIFT_SEED_FADE_ROWS - LIFT_MIN_OWN_PER_CLASS)));
}

/** Seeded 20% holdout: stable for a row key (domain|day) whatever the order or the other rows. */
export const inHoldout = (key: string): boolean => hashUnit(`${LIFT_HOLDOUT_SEED}:${key}`) < LIFT_HOLDOUT_SHARE;

/** AUC of the sum of lifts over labelled rows (null when a class is empty). */
export function liftAuc(t: LiftBins, rows: ReadonlyArray<{ input: LiftInput; sold: boolean }>): number | null {
  const sc = rows.map((r) => scoreLift(t, r.input).sum);
  const a = auc(sc, rows.map((r) => (r.sold ? 1 : 0)));
  return a === null ? null : Math.round(a * 10_000) / 10_000;
}

/** k-fold cross-validated AUC (deterministic folds by the hash of the row key): every row is scored by a table that never saw it. */
export function crossValidatedAuc(rows: ReadonlyArray<{ key: string; input: LiftInput; sold: boolean }>, folds = 5): number | null {
  const fold = (key: string): number => Math.min(folds - 1, Math.floor(hashUnit(`${LIFT_HOLDOUT_SEED}:cv:${key}`) * folds));
  const scores: number[] = [];
  const labels: number[] = [];
  for (let f = 0; f < folds; f++) {
    const train = rows.filter((r) => fold(r.key) !== f).map((r) => ({ input: r.input, sold: r.sold, weight: 1 }));
    const t = trainBins(train);
    for (const r of rows) if (fold(r.key) === f) { scores.push(scoreLift(t, r.input).sum); labels.push(r.sold ? 1 : 0); }
  }
  const a = auc(scores, labels);
  return a === null ? null : Math.round(a * 10_000) / 10_000;
}

// ---------- the frozen seed (data/lift-seed/cr002.jsonl) ----------

export interface SeedRow { label: 'sold' | 'dropped'; len: number | null; words: number | null; endings_before: number | null; registered_share: number | null; past_site: boolean | null }

/** Parses the seed file's text (one JSON object per line). A bad line is an error: the file is frozen and checked. */
export function parseSeed(text: string): SeedRow[] {
  const out: SeedRow[] = [];
  for (const [n, line] of text.split('\n').entries()) {
    if (line.trim() === '') continue;
    const o = JSON.parse(line) as Record<string, unknown>;
    const num = (k: string): number | null => (o[k] === null || o[k] === undefined ? null : Number(o[k]));
    if (o.label !== 'sold' && o.label !== 'dropped') throw new Error(`lift seed line ${n + 1}: label must be sold or dropped`);
    out.push({ label: o.label, len: num('len'), words: num('words'), endings_before: num('endings_before'), registered_share: num('registered_share'), past_site: o.past_site === null || o.past_site === undefined ? null : Boolean(o.past_site) });
  }
  return out;
}
