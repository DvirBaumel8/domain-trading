// v5.45.0 (G-127): the auction score v1 (0-100) and the maximum-bid rule. Pure: no database, no clock, no network. Rules and test ids: docs/internal/auctions.md "Shortlist".
//   name part 60   shape (one joint cell of words x length, hand bands until the engine's lift table exists, round-2 research 3.3) and the other endings registered (R, from engine_endings).
//                  An ending nobody asked yet stays unknown: its weight leaves the part (the part is rescaled), it never counts as 0.
//   headroom 20    how far the current price is under the maximum bid.
//   bids 10        log-scaled; halved when the name looks like an SEO buy (domain age 10+ years and page views in the file): bids are reseller and SEO demand at our price.
//   age 10         the .com's age in years, 10 or more is full. Unknown age leaves the part out (rescaled).
// GoDaddy's own valuation is stored and shown, but never scored (research: appraisals are unreliable).
import { formatUsd } from '../../../core/money.js';

export const AUCTION_SCORE_VERSION = 'auction-v1';

export const WEIGHTS = { name: 60, headroom: 20, bids: 10, age: 10 } as const;
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
const lenBand = (n: number): number => (n <= 8 ? 0 : n <= 12 ? 1 : n <= 15 ? 2 : 3);
export const shapeValue = (words: number, letters: number): number => SHAPE[wordsBand(Math.max(1, words))]![lenBand(letters)]!;

/** The five other endings as asked: true registered, false free, null unknown. A missing key is unknown. */
export type EndingsKnown = Partial<Record<'net' | 'co' | 'org' | 'io' | 'ai', boolean | null>>;

export interface ScoreInput {
  words: number;
  letters: number;
  price_cents: number;
  /** The maximum bid of the rule below (cents); the headroom is measured against it. */
  max_bid_cents: number;
  bids: number;
  domain_age: number | null;
  pageviews: number | null;
  endings: EndingsKnown;
}

export interface Part { points: number; max: number; known: boolean }
export interface ScoreResult {
  score: number;
  version: string;
  parts: { name: Part & { shape: number; endings_known: number; endings_registered: number; endings_value: number | null }; headroom: Part; bids: Part & { seo_flag: boolean }; age: Part };
  seo_flag: boolean;
  reasons: string[];
}

const r1 = (n: number): number => Math.round(n * 10) / 10;
const clamp01 = (n: number): number => Math.max(0, Math.min(1, n));

/** The SEO-buy look: an old name that already had page views. */
export const seoFlag = (age: number | null, pageviews: number | null): boolean => age !== null && age >= SEO_AGE_YEARS && pageviews !== null && pageviews > 0;

export function scoreAuction(i: ScoreInput): ScoreResult {
  const reasons: string[] = [];
  const shape = shapeValue(i.words, i.letters);
  const tlds = ['net', 'co', 'org', 'io', 'ai'] as const;
  const known = tlds.filter((t) => i.endings[t] === true || i.endings[t] === false);
  const registered = known.filter((t) => i.endings[t] === true);
  // 0 elsewhere = 0, one = 0.5, two or more = 1
  const endingsValue = known.length === 0 ? null : registered.length === 0 ? 0 : registered.length === 1 ? 0.5 : 1;
  const endingsW = ENDINGS_W * (known.length / tlds.length);
  const nameRaw = (SHAPE_W * shape + (endingsValue === null ? 0 : endingsW * endingsValue)) / (SHAPE_W + (endingsValue === null ? 0 : endingsW));
  const name: ScoreResult['parts']['name'] = { points: r1(WEIGHTS.name * nameRaw), max: WEIGHTS.name, known: true, shape, endings_known: known.length, endings_registered: registered.length, endings_value: endingsValue };
  reasons.push(`${i.words <= 1 ? '1 word' : `${i.words} words`}, ${i.letters} letters`);
  if (known.length === 0) reasons.push('other endings not checked yet (name part from the shape alone)');
  else if (registered.length > 0) reasons.push(`also registered on ${registered.map((t) => `.${t}`).join(', ')}${known.length < tlds.length ? ` (${known.length} of 5 endings checked)` : ''}`);
  else reasons.push(`no other ending registered${known.length < tlds.length ? ` (${known.length} of 5 checked)` : ''}`);

  const headroomRaw = i.max_bid_cents > 0 ? clamp01(1 - i.price_cents / i.max_bid_cents) : 0;
  const headroom: Part = { points: r1(WEIGHTS.headroom * headroomRaw), max: WEIGHTS.headroom, known: true };
  reasons.push(`price ${formatUsd(i.price_cents)} of a maximum bid ${formatUsd(i.max_bid_cents)}`);

  const seo = seoFlag(i.domain_age, i.pageviews);
  const bidsRaw = clamp01(Math.log(1 + i.bids) / Math.log(1 + BIDS_FULL)) * (seo ? 0.5 : 1);
  const bids: ScoreResult['parts']['bids'] = { points: r1(WEIGHTS.bids * bidsRaw), max: WEIGHTS.bids, known: true, seo_flag: seo };
  reasons.push(`${i.bids} bid${i.bids === 1 ? '' : 's'}${seo ? ` (halved: ${i.domain_age} years old with page views looks like an SEO buy)` : ''}`);

  const ageKnown = i.domain_age !== null;
  const age: Part = { points: ageKnown ? r1(WEIGHTS.age * clamp01(i.domain_age! / AGE_FULL_YEARS)) : 0, max: WEIGHTS.age, known: ageKnown };
  if (ageKnown) reasons.push(`${i.domain_age} year${i.domain_age === 1 ? '' : 's'} old`); else reasons.push('age unknown (part left out)');

  const parts = [name, headroom, bids, age].filter((p) => p.known);
  const max = parts.reduce((s, p) => s + p.max, 0);
  const score = r1(100 * parts.reduce((s, p) => s + p.points, 0) / max);
  return { score, version: AUCTION_SCORE_VERSION, parts: { name, headroom, bids, age }, seo_flag: seo, reasons };
}

/**
 * The maximum bid we suggest: 20% of the expected net resale (`resaleCents`, a realistic end-user price, `settings.shortlist_expected_resale_cents`, less the marketplace
 * commission), scaled by the name's score (full at `SCORE_FULL_MAX` and above, proportionally less below), never above the S8 cap, rounded down to a whole $5.
 * Integer cents; `commission` is a share (0.2 = 20%). Without `score` it is the base (used for the headroom part and the headroom filter).
 * v5.45.0 review (DOM): the first draft used the S8 ladder BIN (our list price, $2,488-$4,888), which put every name at the $250 cap; the list price is not what names sell for
 * (knowledge base `end-user-price-band`: median about $595-$1,300).
 */
export const SCORE_FULL_MAX = 70;
export function maxBidRule(o: { capCents: number; resaleCents: number; commission: number; score?: number }): number {
  const bp = Math.round(o.commission * 10_000);
  let raw = Math.floor((o.resaleCents * (10_000 - bp) * 20) / 1_000_000);
  if (o.score !== undefined) raw = Math.floor((raw * Math.min(SCORE_FULL_MAX, Math.max(0, o.score))) / SCORE_FULL_MAX);
  return Math.floor(Math.min(o.capCents, raw) / 500) * 500;
}
