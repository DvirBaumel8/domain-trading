// Features of the scoring engine (CR-056 part 2). Pure: nothing here reads the database; the loaders are in data.ts.
// Every feature is point-in-time: it is computed for a name and an `as_of` day and uses only what was dated before that day
// (sales rows, unsold rows, registry creation dates, keyword uploads). See docs/internal/engine.md for the table.
import { dayNumber } from '../../core/dates.js';
import { splitUnread, splitV2, type SplitV2Table } from '../selection/index.js';

export const ENDING_FEATURE_TLDS = ['net', 'co', 'org', 'io', 'ai'] as const;
type EndingFeatureTld = (typeof ENDING_FEATURE_TLDS)[number];
export type EngineTld = EndingFeatureTld | 'com';

/** The numeric columns of the model, in order. `acq` (text) is shown next to them in /score and enters the model as the three acq_* columns. */
export const FEATURE_NAMES = [
  'len', 'n_words', 'has_digit', 'has_hyphen', 'vowel_share', 'plural_end',
  'all_known', 'known_share', 'seg_cost_per_char', 'one_word', 'zipf_min', 'zipf_mean', 'zipf_max',
  'trend_pit_max', 'trend_pit_min', 'tok_rate_pit',
  'net_pit', 'co_pit', 'org_pit', 'io_pit', 'ai_pit', 'n_endings_pit',
  'acq_handreg', 'acq_aftermarket_or_old', 'acq_created_after', 'com_age_years', 'demand',
] as const;
export type FeatureName = (typeof FEATURE_NAMES)[number];
export type FeatureValues = Record<FeatureName, number | null>;

/** Features that depend on the .com's registry creation date. They are in the model only when enough dropped names have an answer (see train.ts). */
export const COM_FEATURES: readonly FeatureName[] = ['acq_handreg', 'acq_aftermarket_or_old', 'acq_created_after', 'com_age_years'];

const TREND_WINDOW_DAYS = 365;
/** A .com registered up to this many months before the as_of day counts as hand-registered; older = aftermarket or old. */
const HANDREG_MONTHS = 36;
const MONTH_MS = 30.4375 * 86_400_000;

/** Word-frequency proxy on a 0..8 scale from a piece's cost in the frozen split table (the table's costs come from SCOWL size levels): cost 8 -> 7, 10 -> 6.75, 22 -> 5.25, 40 -> 3, 60 -> 0.5. */
export const zipfOfCost = (cost: number): number => Math.max(0, Math.min(8, 8 - cost / 8));

/** The split table plus extra terms (the current `regime` and `tech` lists) at the cost of the table's curated class (8). A term already in the table keeps its cost. */
export function extendedTable(base: SplitV2Table, extraTerms: readonly string[]): SplitV2Table {
  const cost = new Map(base.cost);
  for (const t of extraTerms) if (/^[a-z]{2,24}$/.test(t) && !cost.has(t)) cost.set(t, 8);
  return { pieceCost: base.pieceCost, cost };
}

export interface EndingFact { registered: boolean | null; createdMs: number | null; /** the stored row (so an unanswered one can be updated in place) */ id?: number }

export interface TokenIndex {
  /** token -> sorted day numbers of the sales rows whose split holds it (one entry per row) */
  sales: Map<string, Int32Array>;
  /** the same for dropped-after-held rows */
  unsold: Map<string, Int32Array>;
  /** day numbers of every sales row, sorted */
  allSales: Int32Array;
  /** false = tok_rate_pit is left empty (the unsold side is not dated enough for a point-in-time rate) */
  tokRateEnabled: boolean;
}

export interface FeatureContext {
  table: SplitV2Table;
  tokens: TokenIndex;
  /** name (before .com) -> facts per ending */
  endings: Map<string, Partial<Record<EngineTld, EndingFact>>>;
  /** keyword -> measured searches by month, oldest first (month = YYYY-MM) */
  demand: Map<string, { month: string; searches: number }[]>;
}

/** The first index with a[i] >= x. */
function lowerBound(a: Int32Array, x: number): number {
  let lo = 0; let hi = a.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (a[mid]! < x) lo = mid + 1; else hi = mid; }
  return lo;
}

export const sldOf = (domain: string): string => (domain.endsWith('.com') ? domain.slice(0, -4) : domain);

/** The words of a name by the frozen split (letters only; [] when the name has no reading). */

/** In the regime the model was tested on: letters only, 6..20 characters, 2..3 real words, all of them known. */
export function inRegime(sld: string, table: SplitV2Table): boolean {
  if (!/^[a-z]{6,20}$/.test(sld)) return false;
  const w = splitV2(sld, table);
  return w.length >= 2 && w.length <= 3;
}

/** The token index from dated rows. */
export function buildTokenIndex(sales: { sld: string; day: number }[], unsold: { sld: string; day: number }[], table: SplitV2Table, tokRateEnabled: boolean): TokenIndex {
  const collect = (rows: { sld: string; day: number }[]): Map<string, Int32Array> => {
    const tmp = new Map<string, number[]>();
    for (const r of rows) for (const t of new Set(splitV2(r.sld, table))) (tmp.get(t) ?? tmp.set(t, []).get(t)!).push(r.day);
    const out = new Map<string, Int32Array>();
    for (const [t, days] of tmp) out.set(t, Int32Array.from(days).sort());
    return out;
  };
  return { sales: collect(sales), unsold: collect(unsold), allSales: Int32Array.from(sales.map((r) => r.day)).sort(), tokRateEnabled };
}

function endingPit(f: EndingFact | undefined, asOfMs: number): number | null {
  if (!f || f.registered === null) return null;
  if (!f.registered) return 0;
  if (f.createdMs === null) return null;
  return f.createdMs < asOfMs ? 1 : 0;
}

/** Searches of the newest upload month at or before the as_of month that measured this keyword; null when none. */
function demandAt(ctx: FeatureContext, keyword: string, asOf: string): number | null {
  const rows = ctx.demand.get(keyword);
  if (!rows) return null;
  const m = asOf.slice(0, 7); // the as_of month, YYYY-MM
  for (let i = rows.length - 1; i >= 0; i--) if (rows[i]!.month <= m) return rows[i]!.searches;
  return null;
}

export interface NameFeatures { values: FeatureValues; acq: 'handreg' | 'aftermarket_or_old' | 'created_after' | null; words: string[]; inRegime: boolean; comCreatedMs: number | null }

/** All features of a `.com` name as of a day (YYYY-MM-DD). */
export function computeFeatures(ctx: FeatureContext, domain: string, asOf: string): NameFeatures {
  const sld = sldOf(domain);
  const asOfDay = dayNumber(asOf);
  const asOfMs = Date.parse(`${asOf}T00:00:00Z`);
  const lettersOnly = /^[a-z]+$/.test(sld);
  const words = lettersOnly ? splitV2(sld, ctx.table) : [];
  const v = Object.fromEntries(FEATURE_NAMES.map((n) => [n, null])) as FeatureValues;
  const len = sld.length;
  v.len = len;
  v.has_digit = /[0-9]/.test(sld) ? 1 : 0;
  v.has_hyphen = sld.includes('-') ? 1 : 0;
  const letters = sld.replace(/[^a-z]/g, '');
  v.vowel_share = letters.length ? [...letters].filter((c) => 'aeiou'.includes(c)).length / letters.length : null;
  v.plural_end = sld.endsWith('s') && !sld.endsWith('ss') ? 1 : 0;
  const known = words.length > 0;
  v.all_known = known ? 1 : 0;
  if (lettersOnly) {
    const unread = splitUnread(sld, ctx.table);
    v.known_share = (len - (unread?.length ?? 0)) / len;
  } else v.known_share = 0;
  v.n_words = known ? words.length : null;
  v.one_word = known ? (words.length === 1 ? 1 : 0) : null;
  if (known) {
    const costs = words.map((w) => ctx.table.cost.get(w) ?? 60);
    v.seg_cost_per_char = costs.reduce((a, c) => a + c + ctx.table.pieceCost, 0) / len;
    const z = costs.map(zipfOfCost);
    v.zipf_min = Math.min(...z); v.zipf_max = Math.max(...z); v.zipf_mean = z.reduce((a, b) => a + b, 0) / z.length;
    // word trend: share of the sales of the 365 days before as_of that hold the word
    const ix = ctx.tokens;
    const winTotal = lowerBound(ix.allSales, asOfDay) - lowerBound(ix.allSales, asOfDay - TREND_WINDOW_DAYS);
    if (winTotal > 0) {
      const shares = [...new Set(words)].map((t) => {
        const a = ix.sales.get(t);
        return a ? (lowerBound(a, asOfDay) - lowerBound(a, asOfDay - TREND_WINDOW_DAYS)) / winTotal : 0;
      });
      v.trend_pit_max = Math.max(...shares); v.trend_pit_min = Math.min(...shares);
    }
    if (ix.tokRateEnabled) {
      const rates = [...new Set(words)].map((t) => {
        const s = ix.sales.get(t); const u = ix.unsold.get(t);
        const sc = s ? lowerBound(s, asOfDay) : 0; const uc = u ? lowerBound(u, asOfDay) : 0;
        return (sc + 1) / (sc + uc + 2);
      });
      v.tok_rate_pit = rates.reduce((a, b) => a + b, 0) / rates.length;
    }
    const d = demandAt(ctx, words.join(' '), asOf);
    v.demand = d;
  }
  // endings registered before as_of
  const facts = ctx.endings.get(sld) ?? {};
  let known5 = 0; let sum = 0;
  for (const tld of ENDING_FEATURE_TLDS) {
    const p = endingPit(facts[tld], asOfMs);
    v[`${tld}_pit`] = p;
    if (p !== null) { known5++; sum += p; }
  }
  v.n_endings_pit = known5 > 0 ? sum : null;
  // the .com's own registry creation date
  const com = facts.com;
  let acq: NameFeatures['acq'] = null;
  let comCreatedMs: number | null = null;
  if (com && com.registered === true && com.createdMs !== null) {
    comCreatedMs = com.createdMs;
    if (com.createdMs >= asOfMs) acq = 'created_after';
    else acq = (asOfMs - com.createdMs) / MONTH_MS <= HANDREG_MONTHS ? 'handreg' : 'aftermarket_or_old';
    // v5.46.0: whole years (floor), no sub-year information. A dropped name is dated at its expiry anniversary, so a fractional age (N.0 / N.2) gave the label away (engine lab, 25 Oct 2026).
    v.com_age_years = acq === 'created_after' ? null : Math.floor((asOfMs - com.createdMs) / (365.25 * 86_400_000));
  }
  if (acq !== null) {
    v.acq_handreg = acq === 'handreg' ? 1 : 0;
    v.acq_aftermarket_or_old = acq === 'aftermarket_or_old' ? 1 : 0;
    v.acq_created_after = acq === 'created_after' ? 1 : 0;
  }
  return { values: v, acq, words, inRegime: inRegime(sld, ctx.table), comCreatedMs };
}

/** The model's input row: the chosen features in order, NaN for a missing value. */
export function toVector(values: FeatureValues, names: readonly FeatureName[]): Float64Array {
  const out = new Float64Array(names.length);
  for (let i = 0; i < names.length; i++) { const x = values[names[i]!]; out[i] = x === null ? Number.NaN : x; }
  return out;
}
