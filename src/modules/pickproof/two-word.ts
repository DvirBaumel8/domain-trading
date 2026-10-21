// v5.33.0 (CR-073a PP-V2): the pick-proof two-word rule pickproof-v2. A name is two-word when its SLD (letters only, at most 10) splits into exactly
// two parts that are both common words: at least 3 letters, a vowel (a e i o u y) in each, both on data/wordlists/en-scowl-35-lower.txt (SCOWL size 35,
// only the entries the source writes in lowercase, so no proper names and no upper-case abbreviations such as DHS or AR). Any one valid split counts.
// The SPELL-1 part of the rule is checked by the caller (pool.ts). The list is checked against its sha256 on load, like the bt1 pools.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { COMMON_WORDS_FILE, COMMON_WORDS_SHA256 } from './recipe.js';

const FILE = fileURLToPath(new URL(`../../../data/wordlists/${COMMON_WORDS_FILE}`, import.meta.url));
let words: Set<string> | null = null;

export function commonWords(): Set<string> {
  if (words) return words;
  const txt = readFileSync(FILE, 'utf8');
  const got = createHash('sha256').update(txt).digest('hex');
  if (got !== COMMON_WORDS_SHA256) throw new Error(`${COMMON_WORDS_FILE} sha256 ${got} is not the frozen ${COMMON_WORDS_SHA256}`);
  words = new Set(txt.split('\n').filter(Boolean));
  return words;
}

const part = (w: string, set: Set<string>): boolean => w.length >= 3 && /[aeiouy]/.test(w) && set.has(w);

/** The first valid split of the SLD into two common words, or null. */
export function twoWordSplitV2(sld: string, set: Set<string> = commonWords()): [string, string] | null {
  if (!/^[a-z]+$/.test(sld) || sld.length > 10) return null;
  for (let i = 3; i <= sld.length - 3; i++) {
    const a = sld.slice(0, i), b = sld.slice(i);
    if (part(a, set) && part(b, set)) return [a, b];
  }
  return null;
}
