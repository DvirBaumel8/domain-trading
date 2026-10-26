// v5.46.0 (auction score v2): how common is each word the name was read into. Pure given the frozen files; the evidence is offline and frozen:
//   - the curated `special` class of the frozen split file bt1@v3 (trade, tech and regime words the form lexicon knew on 2026-10-07: cleaning, coffee, attorney, api, hq) = 1.0
//   - data/wordlists/en-scowl-35-lower.txt (`commonWord`, SCOWL size 35, lowercase entries of 3+ letters) = 1.0
//   - the SCOWL level the split file gives every other piece (the engine's zipf proxy is the same data: zipf = 8 - cost/8): 35 (names and abbreviations) 0.6, 40 0.5,
//     50 (large dictionary: well-known places and names) 0.7, 60 0.35, 70 0.2, a place-name-only piece 0.5
//   - a piece the split file does not know = 0.05; a 2-letter piece is at most 0.3 (0.75 on the curated list: ai, hq, tv), because fragments such as ms, ne, id, pi are what coined strings split into.
//   - v5.49.0 (P2): a piece of 3 letters or fewer that is NOT on SHORT_WORDS counts at most SHORT_PIECE_MAX (0.5): split fragments such as ins, are, outs, ver are what coined strings
//     break into (insare = ins + are); SHORT_WORDS are short words that really carry brand names.
// "Common" = level 0.7 or more. Rules and examples: docs/internal/auctions.md "Auction score v2".
import { commonWord, loadSplitV2, splitClasses } from '../../selection/index.js';

export const COMMON_LEVEL = 0.7;
const CLASS_LEVEL: Readonly<Record<string, number>> = { '35': 0.6, '40': 0.5, '50': 0.7, '60': 0.35, '70': 0.2, city: 0.5, dictionary: 0.5 };
const UNKNOWN_LEVEL = 0.05;
const SHORT_MAX = 0.3;
const SHORT_SPECIAL = 0.75;

/** v5.49.0 (P2): short words (3 letters or fewer) that real brand names are built from; any other piece of 3 letters or fewer counts at most SHORT_PIECE_MAX. Keep it small. */
export const SHORT_WORDS: ReadonlySet<string> = new Set([
  'app', 'pro', 'hub', 'lab', 'box', 'car', 'pet', 'art', 'bio', 'eco', 'go', 'my', 'the', 'top', 'web', 'net', 'max', 'fit', 'now', 'one', 'get', 'buy', 'hq', 'ai', 'tv', 'usa', 'tax', 'law', 'bar',
  'vet', 'day', 'gym', 'dog', 'cat', 'sun', 'air', 'pay', 'job', 'toy', 'spa', 'tea', 'bed', 'bus', 'fix', 'fun', 'map', 'tip', 'win', 'zen', 'dev', 'ski', 'bet', 'cab', 'oil', 'gas',
]);
const SHORT_PIECE_MAX = 0.5;

let classes: Map<string, string> | null = null;

/** 0..1: how common one word is (see the header). */
export function wordLevel(word: string): number {
  const level = baseLevel(word);
  return word.length <= 3 && !SHORT_WORDS.has(word) ? Math.min(level, SHORT_PIECE_MAX) : level;
}

function baseLevel(word: string): number {
  if (!classes) { loadSplitV2('bt1@v3'); classes = splitClasses('bt1@v3'); }
  const cls = classes.get(word);
  if (word.length <= 2) return cls === 'special' ? SHORT_SPECIAL : cls === undefined ? 0.05 : SHORT_MAX;
  if (cls === 'special') return 1;
  if (commonWord(word)) return 1;
  if (cls === undefined) return UNKNOWN_LEVEL;
  return CLASS_LEVEL[cls] ?? UNKNOWN_LEVEL;
}

export interface NameQuality { levels: number[]; min: number; mean: number; /** 0..1, half the weakest word, half the mean */ quality: number; allCommon: boolean }

export function nameQuality(words: readonly string[]): NameQuality {
  const levels = (words.length > 0 ? words : []).map(wordLevel);
  if (levels.length === 0) return { levels, min: 0, mean: 0, quality: 0, allCommon: false };
  const min = Math.min(...levels);
  const mean = levels.reduce((a, b) => a + b, 0) / levels.length;
  return { levels, min, mean, quality: 0.5 * min + 0.5 * mean, allCommon: min >= COMMON_LEVEL };
}
