// CAP-01 word lists: committed data files (SCOWL dictionary, Census places) plus versioned lists from the database.
// Pure data loading; no network. The data files are rebuilt only by scripts/build-wordlists.ts.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** `unknown` is never stored in a Lexicon; the tokenizer uses it for a run of letters that no list explains. */
export type TokenType = 'city' | 'state' | 'trade' | 'regime' | 'tech' | 'generic_head' | 'legal' | 'dictionary' | 'unknown';

export interface Lexicon {
  /** Lowercase term -> every type it has (a term can be a city and a dictionary word). */
  types: Map<string, TokenType[]>;
  /** List versions used, for evidence: {"en-scowl-60": "sha256:<12>", "us-places": "sha256:<12>", trade: 3, ...}. */
  versions: Record<string, string | number>;
}

export interface DataLexicon {
  dictionary: Set<string>;
  /** Place names as one lowercase letters-only string (`losangeles`); `multiWord` marks names written with more than one word. */
  cities: Set<string>;
  multiWord: Set<string>;
  versions: Record<string, string>;
}

const DEFAULT_DIR = fileURLToPath(new URL('../../../data/wordlists/', import.meta.url));
const cache = new Map<string, DataLexicon>();

const digest = (text: string) => `sha256:${createHash('sha256').update(text).digest('hex').slice(0, 12)}`;

/** Reads data/wordlists once per process (cached by directory). */
export function loadDataLexicon(dir: string = DEFAULT_DIR): DataLexicon {
  const hit = cache.get(dir);
  if (hit) return hit;
  const path = (f: string) => (dir.endsWith('/') ? dir : `${dir}/`) + f;
  const wordsTxt = readFileSync(path('en-scowl-60.txt'), 'utf8');
  const placesTxt = readFileSync(path('us-places.txt'), 'utf8');
  const dictionary = new Set(wordsTxt.split('\n').filter(Boolean));
  const cities = new Set<string>();
  const single = new Set<string>();
  for (const line of placesTxt.split('\n')) {
    if (!line) continue;
    const [name, , words] = line.split('\t');
    if (!name) continue;
    cities.add(name);
    if (words === undefined || words === '1') single.add(name);
  }
  const multiWord = new Set([...cities].filter((c) => !single.has(c)));
  const out: DataLexicon = { dictionary, cities, multiWord, versions: { 'en-scowl-60': digest(wordsTxt), 'us-places': digest(placesTxt) } };
  cache.set(dir, out);
  return out;
}

const LIST_TYPES: Record<string, TokenType> = {
  trade: 'trade',
  regime: 'regime',
  tech: 'tech',
  generic_head: 'generic_head',
  legal: 'legal',
  state: 'state',
  city_extra: 'city',
  dictionary_extra: 'dictionary',
};

/**
 * Merges the data files and the versioned lists into one term -> types map.
 * A multi-word city name (`losangeles`, written "Los Angeles") enters only when `cityOneToken`; otherwise only
 * single-word city names do, and the words of the long name tokenise on their own.
 * A place name that is also a dictionary word enters as a city only through `cityWordAllowlist` (selection settings
 * `form.city_word_allowlist`) or the versioned `city_extra` list.
 */
export function buildLexicon(
  data: Pick<DataLexicon, 'dictionary' | 'cities' | 'versions'> & Partial<Pick<DataLexicon, 'multiWord'>>,
  lists: Record<string, { version: number; terms: string[] }>,
  opts: { cityOneToken: boolean; cityWordAllowlist?: readonly string[] },
): Lexicon {
  const types = new Map<string, TokenType[]>();
  const add = (term: string, type: TokenType) => {
    if (term.length < 2) return; // single letters are never tokens
    const have = types.get(term);
    if (!have) types.set(term, [type]);
    else if (!have.includes(type)) have.push(type);
  };
  for (const w of data.dictionary) add(w, 'dictionary');
  // A gazetteer place name that is also a dictionary word (dent, lime, mobile, law) is a city only when allowed.
  const allowed = new Set(opts.cityWordAllowlist ?? []);
  for (const c of data.cities) {
    if (data.dictionary.has(c) && !allowed.has(c)) continue;
    if (opts.cityOneToken || !data.multiWord?.has(c)) add(c, 'city');
  }
  const versions: Record<string, string | number> = { ...data.versions };
  for (const [name, list] of Object.entries(lists)) {
    versions[name] = list.version;
    const type = LIST_TYPES[name];
    if (!type) continue; // lists the tokenizer does not use (brand, bigco, ...) are versioned by their owners
    for (const raw of list.terms) {
      const term = raw.trim().toLowerCase();
      if (/^[a-z0-9]+$/.test(term)) add(term, type);
    }
  }
  return { types, versions };
}
