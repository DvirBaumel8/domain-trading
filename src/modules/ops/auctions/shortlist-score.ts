// v5.49.0 (P2, P3): auction score v4 (input `v4` given): weights name 70, demand 15, age 10, bids 5. Headroom is no points any more (it is only the filter "the maximum bid is above the price": a single bidder's hidden
// maximum is invisible, so a $1 price says "uncontested so far", not "cheap"). The name part is the name's POSITION in the day's field (percentile of quality x lift/100 among all candidates,
// `v4.name_pct`), not the raw value, which bunched every top name at 95-99. Demand (P3, free fields of the GoDaddy file) = 0.6 x developed endings (0 -> 0, 1 -> 0.5, 2+ -> 1) + 0.4 x exact-match
// endings (log-scaled, 10+ full); one of the two missing: the other alone; both missing: the part leaves the score (rescaled like age).
// v5.47.0 (F5): auction score v3 = v2 with the hand shape + endings part replaced by the engine's lift score (`lift` in the input, 0..100 from a trained lift table: length band, word count,
// other endings registered, registered share); word quality stays the gate (the name part is quality x lift/100 and the uncommon-word cap stays). Without a lift table the score is v2.
// v5.46.0: auction score v2 (word quality, graded shape, uncommon-word cap, SCORE_FULL_MAX 85); v5.45.0 (G-127): the auction score v1 (0-100) and the maximum-bid rule. Pure: no database, no clock, no network. Rules and test ids: docs/internal/auctions.md "Shortlist".
//   name part 60   (v2) word quality x (shape and the other endings). Word quality (`word-quality.ts`) is 0..1: half the weakest word, half the mean; a name with a word that is not common
//                  (level < 0.7) is capped at 50 in total. Shape is graded by letters (linear between the band anchors, not a step) per word count (hand bands until the engine's lift table
//                  exists, round-2 research 3.3). The other endings registered (R, from engine_endings).
//                  An ending nobody asked yet stays unknown: its weight leaves the part (the part is rescaled), it never counts as 0.
//   headroom 20    how far the current price is under the maximum bid.
//   bids 10 (5 in v3) log-scaled; halved when the name looks like an SEO buy (domain age 10+ years and page views in the file): bids are reseller and SEO demand at our price.
//   age 10         the .com's age in years, 10 or more is full. Unknown age leaves the part out (rescaled).
// GoDaddy's own valuation is stored and shown, but never scored (research: appraisals are unreliable).
import { formatUsd } from '../../../core/money.js';
import type { LiftScore } from '../../engine/index.js';
import { nameQuality } from './word-quality.js';

export const AUCTION_SCORE_VERSION = 'auction-v2';
/** v5.47.0: the version stored when a lift table scored the name part. */
export const AUCTION_SCORE_VERSION_LIFT = 'auction-v3';
/** v5.49.0: the version stored when the name part is the position in the day's field and the demand part exists. */
export const AUCTION_SCORE_VERSION_V4 = 'auction-v4';
/** A name with any word below the common level never scores above this. */
export const UNCOMMON_CAP = 50;

export const WEIGHTS = { name: 60, headroom: 20, bids: 10, age: 10 } as const;
/** v3 (F8, investors-deep research): high bid counts are investors competing, not end users (bidder pairs inflate them), so the bids part is worth 5 points, not 10. */
export const BIDS_WEIGHT_V3 = 5;
/** v5.49.0: auction-v4 weights (sum 100; an unknown part is rescaled out). v5.51.0 (backtest on our own 148 sold / 553 unsold names, docs/research/backtest-production-2026-10-26.md):
 * demand 15 -> 40 and age 10 -> 25, name 70 -> 30. developedTlds alone reached AUC 0.78 (0.80 on names aged 5+), age + developed + exact-match together 0.84-0.88, while the name part
 * (word quality x length/words lift) was near a coin toss (0.47-0.60) on these auction names. Set before any auction-v4 shortlist was stored, so the version stays auction-v4. */
export const WEIGHTS_V4 = { name: 30, bids: 5, age: 25, demand: 40 } as const;
/** Exact-match endings at which the log-scaled part is full. */
export const EXACT_FULL = 10;
const DEMAND_DEVELOPED_W = 0.6;
const DEMAND_EXACT_W = 0.4;
/** Inside the name part, shape and the other endings weigh 25 : 30 (round-2 S and R weights); only the known share of the five endings counts. */
const SHAPE_W = 25;
const ENDINGS_W = 30;
const BIDS_FULL = 20;
const AGE_FULL_YEARS = 10;
const SEO_AGE_YEARS = 10;

/** Shape by words (1-2 / 3 / 4+) and letters before .com (<= 8 / 9-12 / 13-15 / 16+): 1 is best. Hand bands from the round-2 gap (about 3x, nearly flat up to 12 letters). */
const SHAPE: readonly (readonly number[])[] = [
  [1.0, 0.85, 0.55, 0.25],
  [0.5, 0.45, 0.3, 0.1],
  [0.2, 0.15, 0.1, 0.05],
];
const wordsBand = (w: number): number => (w <= 2 ? 0 : w === 3 ? 1 : 2);
/** v2: the length axis is graded: the band value sits at these letter counts and is interpolated linearly between them (flat before the first, flat after the last). */
const LEN_ANCHORS = [6, 11, 14, 18] as const;
export function shapeValue(words: number, letters: number): number {
  const row = SHAPE[wordsBand(Math.max(1, words))]!;
  if (letters <= LEN_ANCHORS[0]) return row[0]!;
  for (let i = 1; i < LEN_ANCHORS.length; i++) {
    if (letters <= LEN_ANCHORS[i]!) { const a = LEN_ANCHORS[i - 1]!, b = LEN_ANCHORS[i]!; return row[i - 1]! + (row[i]! - row[i - 1]!) * ((letters - a) / (b - a)); }
  }
  return row[3]!;
}

/** The five other endings as asked: true registered, false free, null unknown. A missing key is unknown. */
export type EndingsKnown = Partial<Record<'net' | 'co' | 'org' | 'io' | 'ai', boolean | null>>;

export interface ScoreInput {
  /** The words the name was read into (the form tokens); an empty list reads as the whole name being one unknown piece. */
  words: readonly string[];
  letters: number;
  price_cents: number;
  /** The maximum bid of the rule below (cents); the headroom is measured against it. */
  max_bid_cents: number;
  bids: number;
  domain_age: number | null;
  pageviews: number | null;
  endings: EndingsKnown;
  /** v5.47.0: the lift score of the name (engine lift table); when given, it replaces the hand shape + endings part and the version is auction-v3 */
  lift?: LiftScore | null;
  /** v5.49.0: given = auction-v4. `name_pct` 0..1 = the name's position in the day's field (null = the field is not known yet, the raw value is used: the pre-score that picks the pool); `field_n` = names in the field. */
  v4?: { name_pct: number | null; field_n: number | null; developed_tlds: number | null; exact_match_tlds: number | null };
}

export interface Part { points: number; max: number; known: boolean }
export interface ScoreResult {
  score: number;
  version: string;
  parts: { name: Part & { shape: number; word_quality: number; word_levels: number[]; all_common: boolean; endings_known: number; endings_registered: number; endings_value: number | null; lift?: { sum: number; score: number; bins: Array<{ pattern: string; bin: string; lift: number }> }; /** v4: quality x lift/100 before the position; field_pct = share of the field below it */ raw?: number; field_pct?: number | null }; /** not in v4 */ headroom?: Part; bids: Part & { seo_flag: boolean }; age: Part; /** v4 only */ demand?: Part & { developed_tlds: number | null; exact_match_tlds: number | null } };
  seo_flag: boolean;
  reasons: string[];
}

/** v5.49.0 (P3): 0..1 from the two free fields, or null when neither is known. Developed: 0 -> 0, 1 -> 0.5, 2+ -> 1. Exact-match: ln(1 + n) / ln(1 + EXACT_FULL), 1 at 10+. */
export function demandValue(developed: number | null, exact: number | null): number | null {
  const d = developed === null ? null : developed <= 0 ? 0 : developed === 1 ? 0.5 : 1;
  const e = exact === null ? null : clamp01(Math.log(1 + Math.max(0, exact)) / Math.log(1 + EXACT_FULL));
  if (d === null && e === null) return null;
  if (d === null) return e;
  if (e === null) return d;
  return DEMAND_DEVELOPED_W * d + DEMAND_EXACT_W * e;
}

/** v5.49.0 (P2): the position of `x` among the sorted field values: (share below + half the share equal), 0..1. An empty field gives null. */
export function fieldPercentile(sortedAsc: readonly number[], x: number): number | null {
  const n = sortedAsc.length;
  if (n === 0) return null;
  let lo = 0, hi = n;
  while (lo < hi) { const m = (lo + hi) >> 1; if (sortedAsc[m]! < x) lo = m + 1; else hi = m; }
  const below = lo;
  hi = n;
  while (lo < hi) { const m = (lo + hi) >> 1; if (sortedAsc[m]! <= x) lo = m + 1; else hi = m; }
  return (below + 0.5 * (lo - below)) / n;
}

const r1 = (n: number): number => Math.round(n * 10) / 10;
const clamp01 = (n: number): number => Math.max(0, Math.min(1, n));

/** The SEO-buy look: an old name that already had page views. */
export const seoFlag = (age: number | null, pageviews: number | null): boolean => age !== null && age >= SEO_AGE_YEARS && pageviews !== null && pageviews > 0;

export function scoreAuction(i: ScoreInput): ScoreResult {
  const reasons: string[] = [];
  const q = nameQuality(i.words);
  const shape = shapeValue(Math.max(1, i.words.length), i.letters);
  const tlds = ['net', 'co', 'org', 'io', 'ai'] as const;
  const known = tlds.filter((t) => i.endings[t] === true || i.endings[t] === false);
  const registered = known.filter((t) => i.endings[t] === true);
  // 0 elsewhere = 0, one = 0.5, two or more = 1
  const endingsValue = known.length === 0 ? null : registered.length === 0 ? 0 : registered.length === 1 ? 0.5 : 1;
  const endingsW = ENDINGS_W * (known.length / tlds.length);
  const shapeEndings = (SHAPE_W * shape + (endingsValue === null ? 0 : endingsW * endingsValue)) / (SHAPE_W + (endingsValue === null ? 0 : endingsW));
  const shapePart = i.lift ? i.lift.score / 100 : shapeEndings;
  // v5.57.0 (v4): word quality no longer multiplies the name part. On 12,644 retail outcomes (Gavriel's D2 dev split: retail sales $500+ vs closeout leftovers) word quality had
  // AUC 0.47 and the lift alone 0.82, while quality x lift fell to 0.62; on our own auction labels word quality was 0.48 (backtest-production-2026-10-26.md). v2/v3 keep it.
  const nameRaw = i.v4 ? shapePart : q.quality * shapePart;
  const v4 = i.v4;
  const nameValue = v4 && v4.name_pct !== null ? v4.name_pct : nameRaw;
  const nameW = v4 ? WEIGHTS_V4.name : WEIGHTS.name;
  const name: ScoreResult['parts']['name'] = { points: r1(nameW * nameValue), max: nameW, known: true, shape, word_quality: r1(q.quality * 100) / 100, word_levels: q.levels.map((x) => r1(x * 100) / 100), all_common: q.allCommon, endings_known: known.length, endings_registered: registered.length, endings_value: endingsValue };
  if (v4) { name.raw = Math.round(nameRaw * 1000) / 1000; name.field_pct = v4.name_pct === null ? null : Math.round(v4.name_pct * 1000) / 1000; }
  if (i.lift) name.lift = { sum: i.lift.sum, score: i.lift.score, bins: i.lift.parts.map((p) => ({ pattern: p.pattern, bin: p.bin, lift: p.lift })) };
  const wc = Math.max(1, i.words.length);
  reasons.push(`${wc === 1 ? '1 word' : `${wc} words`} (${i.words.join(' + ') || 'unread'}), ${i.letters} letters`);
  if (!q.allCommon && !i.v4) reasons.push(`not every word is a common word (${i.words.filter((w, k) => q.levels[k]! < 0.7).join(', ') || 'unread'}): the score is capped at ${r1(UNCOMMON_CAP * (0.5 + 0.5 * q.quality))}`);
  const liftText = i.lift ? `lift ${i.lift.sum >= 0 ? '+' : ''}${i.lift.sum} (${i.lift.parts.map((p) => `${p.pattern} ${p.bin} ${p.lift >= 0 ? '+' : ''}${p.lift}`).join(', ') || 'no pattern known'})` : '';
  // v4: the reason says where the name stands in the day's field, not a "sold-like" number that every top name shared
  if (i.lift && v4) reasons.push(v4.name_pct === null ? liftText : `${liftText}: name in the top ${Math.max(1, Math.round((1 - v4.name_pct) * 100))}% of today's field${v4.field_n ? ` (${v4.field_n} names)` : ''}`);
  else if (i.lift) reasons.push(`${liftText}: ${i.lift.score} of 100 sold-like`);
  if (known.length === 0) reasons.push(i.lift ? 'other endings not checked yet (the lift uses length and word count only)' : 'other endings not checked yet (name part from the shape alone)');
  else if (registered.length > 0) reasons.push(`also registered on ${registered.map((t) => `.${t}`).join(', ')}${known.length < tlds.length ? ` (${known.length} of 5 endings checked)` : ''}`);
  else reasons.push(`no other ending registered${known.length < tlds.length ? ` (${known.length} of 5 checked)` : ''}`);

  const headroomRaw = i.max_bid_cents > 0 ? clamp01(1 - i.price_cents / i.max_bid_cents) : 0;
  const headroom: Part = { points: r1(WEIGHTS.headroom * headroomRaw), max: WEIGHTS.headroom, known: true };

  const seo = seoFlag(i.domain_age, i.pageviews);
  const bidsRaw = clamp01(Math.log(1 + i.bids) / Math.log(1 + BIDS_FULL)) * (seo ? 0.5 : 1);
  const bidsW = v4 ? WEIGHTS_V4.bids : i.lift ? BIDS_WEIGHT_V3 : WEIGHTS.bids;
  const bids: ScoreResult['parts']['bids'] = { points: r1(bidsW * bidsRaw), max: bidsW, known: true, seo_flag: seo };
  reasons.push(`${i.bids} bid${i.bids === 1 ? '' : 's'}${seo ? ` (halved: ${i.domain_age} years old with page views looks like an SEO buy)` : ''}`);

  const ageKnown = i.domain_age !== null;
  const age: Part = { points: ageKnown ? r1((v4 ? WEIGHTS_V4.age : WEIGHTS.age) * clamp01(i.domain_age! / AGE_FULL_YEARS)) : 0, max: v4 ? WEIGHTS_V4.age : WEIGHTS.age, known: ageKnown };
  if (ageKnown) reasons.push(`${i.domain_age} year${i.domain_age === 1 ? '' : 's'} old`); else reasons.push('age unknown (part left out)');

  let demand: ScoreResult['parts']['demand'];
  if (v4) {
    const dv = demandValue(v4.developed_tlds, v4.exact_match_tlds);
    demand = { points: dv === null ? 0 : r1(WEIGHTS_V4.demand * dv), max: WEIGHTS_V4.demand, known: dv !== null, developed_tlds: v4.developed_tlds, exact_match_tlds: v4.exact_match_tlds };
    reasons.push(dv === null ? 'demand unknown (part left out)' : `${v4.developed_tlds ?? '?'} other ending${v4.developed_tlds === 1 ? '' : 's'} with a live site, ${v4.exact_match_tlds ?? '?'} exact-match registered`);
  } else reasons.push(`price ${formatUsd(i.price_cents)} of a maximum bid ${formatUsd(i.max_bid_cents)}`);
  const parts = (v4 ? [name, bids, age, demand!] : [name, headroom, bids, age]).filter((p) => p.known);
  const max = parts.reduce((s, p) => s + p.max, 0);
  const raw = r1(100 * parts.reduce((s, p) => s + p.points, 0) / max);
  // a name with an uncommon word is capped at UNCOMMON_CAP x (0.5 + 0.5 x word quality): 50 at most, about 35 for a coined string, so the cap itself spreads
  const cap = r1(UNCOMMON_CAP * (0.5 + 0.5 * q.quality));
  // v5.51.0 (v4): the cap is skipped when another ending of the exact name has a live site: the word is real to someone (the backtest's sold names include foreign and brand words)
  // v5.57.0: v4 has no uncommon-word cap (all-common had AUC 0.51 on D2: no signal; short brandables sell). v2/v3 keep it.
  const capped = !v4 && !q.allCommon;
  const score = capped ? Math.min(raw, cap) : raw;
  const version = v4 ? AUCTION_SCORE_VERSION_V4 : i.lift ? AUCTION_SCORE_VERSION_LIFT : AUCTION_SCORE_VERSION;
  return { score, version, parts: v4 ? { name, bids, age, demand } : { name, headroom, bids, age }, seo_flag: seo, reasons };
}

/**
 * The maximum bid we suggest. v5.48.0 (F22, Dvir 26 Oct 2026: option (b), expected value): the chance that a name sells within our hold (`saleChanceBp`,
 * `settings.shortlist_sale_chance_bp`, default 10%) times the expected net resale (`resaleCents`, `settings.shortlist_expected_resale_cents`, a realistic end-user price, less the
 * marketplace commission), less the one renewal we pay while holding (`renewalCents`, `settings.shortlist_renewal_cents`). Defaults: 10% x $800 - $23 = $57 -> $55 (v5.49.0, P5; was $11 renewal and $65).
 * The 10% is about 3x the published rate for a 2-year hold (sell-through about 1.7% a year, knowledge base `sell-through-yearly`): it assumes our picks sell better, and is raised
 * only by our own results. Scaled by the name's score (full at `SCORE_FULL_MAX` = 85 and above, proportionally less below), never above the S8 cap, never below 0, rounded down to $5.
 * v5.55.0: `positionFactor` (default 1) multiplies the score-scaled amount before the cap and the rounding. Integer cents; `commission` is a share (0.2 = 20%). Without `score` it is the base (used for the headroom part and the headroom filter).
 * History: v5.45.0-v5.47.0 used 20% of the net resale ($160 at full score); the round-3 research showed that loses money on average under the 2-year hold (F22).
 * v5.45.0 review (DOM): the first draft used the S8 ladder BIN (our list price), which put every name at the $250 cap.
 */
export const SCORE_FULL_MAX = 85;
/** v5.55.0 (AS555-1): the share of the score-scaled maximum a name gets by its position in the day's field: 1 up to the top 1%, falling linearly to 0.4 at the top 9%, 0.4 below. null (position unknown) = 1. */
export const POSITION_FULL_PCT = 1;
export const POSITION_FLOOR_PCT = 9;
export const POSITION_FLOOR_FACTOR = 0.4;
export function positionFactor(topPct: number | null): number {
  if (topPct === null || !Number.isFinite(topPct) || topPct <= POSITION_FULL_PCT) return 1;
  if (topPct >= POSITION_FLOOR_PCT) return POSITION_FLOOR_FACTOR;
  return 1 - ((1 - POSITION_FLOOR_FACTOR) * (topPct - POSITION_FULL_PCT)) / (POSITION_FLOOR_PCT - POSITION_FULL_PCT);
}

export function maxBidRule(o: { capCents: number; resaleCents: number; commission: number; saleChanceBp: number; renewalCents: number; score?: number; positionFactor?: number }): number {
  const bp = Math.round(o.commission * 10_000);
  let raw = Math.floor((o.resaleCents * (10_000 - bp) * o.saleChanceBp) / 100_000_000) - o.renewalCents;
  if (o.score !== undefined) raw = Math.floor((raw * Math.min(SCORE_FULL_MAX, Math.max(0, o.score))) / SCORE_FULL_MAX);
  if (o.positionFactor !== undefined) raw = Math.floor(raw * Math.max(0, Math.min(1, o.positionFactor)));
  return Math.floor(Math.max(0, Math.min(o.capCents, raw)) / 500) * 500;
}
