// The cheap name cuts of the pre-filter (issue #76): a person's name, a local business, a name that is not plain words. Pure code, no outside call.
// Bundled lists, in src/prefilter/lists/:
//  - words.txt: lower-case words of 3 or more letters (plus 24 two-letter ones) from SCOWL 2020.12.07 as packaged by Debian `wamerican`.
//    Source http://wordlist.sourceforge.net/ . Licence: Kevin Atkinson's permissive SCOWL licence (use, copy, modify, distribute and sell, with the notice kept).
//    Capitalised entries (proper names, places) are left out, so `joe` and `houston` are not words.
//  - given-names.txt: US given names of 3 to 10 letters seen in the US Social Security Administration baby-name data 1880-2008
//    (in the hadley/data-baby-names copy). Public domain (US government work). Names with a total share of at least 0.04 are kept.
//  - places.txt: about 170 big US (and a few other) cities, states and local abbreviations such as `sfl`, written by hand. No licence issue.
//  - trades.txt: about 95 trade words of local businesses, written by hand.
// A cut is made only for a clear shape. Whatever is unclear is left in.
import { readFileSync } from 'node:fs';

export interface NameLists { words: ReadonlySet<string>; given: ReadonlySet<string>; places: ReadonlySet<string>; trades: ReadonlySet<string> }
export type NameCut = 'person_name' | 'local_business' | 'not_plain_word';

const MIN_PART = 3;
const read = (file: string): Set<string> => new Set(readFileSync(new URL(`./lists/${file}`, import.meta.url), 'utf8').split('\n').map((l) => l.trim()).filter(Boolean));

let bundled: NameLists | null = null;
/** Read on first use only, so the web service never loads them. */
export function bundledLists(): NameLists {
  bundled ??= { words: read('words.txt'), given: read('given-names.txt'), places: read('places.txt'), trades: read('trades.txt') };
  return bundled;
}

/** True when `s` is one word of the set, or a concatenation of up to `maxParts` of them. */
export function splits(s: string, set: ReadonlySet<string>, maxParts: number): boolean {
  if (maxParts < 1 || s.length === 0) return false;
  if (set.has(s)) return true;
  for (let i = 1; i < s.length; i++) if (set.has(s.slice(0, i)) && splits(s.slice(i), set, maxParts - 1)) return true;
  return false;
}

/** The first cut that applies to a second-level name (letters only), or null when the name stays. Order: person, local business, plain words. */
export function nameCut(sld: string, lists: NameLists): NameCut | null {
  const whole = splits(sld, lists.words, 3);
  const trade = (s: string) => s.length >= MIN_PART && splits(s, lists.trades, 2);
  const around = (set: ReadonlySet<string>, rest: (s: string, listedFirst: boolean) => boolean): boolean => {
    for (let i = MIN_PART; i <= sld.length - MIN_PART; i++) {
      if (set.has(sld.slice(0, i)) && rest(sld.slice(i), true)) return true; // the listed name first
      if (set.has(sld.slice(i)) && rest(sld.slice(0, i), false)) return true; // and last
    }
    return false;
  };
  // a given name beside a trade word is a person's business; beside anything else only when the name is not plain words anyway (before the name: any rest; after it: the rest must be words)
  if (around(lists.given, (rest, first) => trade(rest) || (!whole && rest.length >= MIN_PART && (first || splits(rest, lists.words, 2))))) return 'person_name';
  if (around(lists.places, (rest) => trade(rest))) return 'local_business';
  return whole ? null : 'not_plain_word';
}
