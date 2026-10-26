// v5.56.0: the PERSON_NAME filter of the auction shortlist (26 Oct 2026: teresaperez.com was shortlisted). A personal name is a poor resale (one possible buyer, who usually
// owns another ending already) and a privacy risk. Rule: the letters-only name splits, at some point, into a first name on the frozen given-names list and a surname on the
// frozen surnames list, and the first name is not a common English word (so markwood, willpower and rosegarden pass; teresaperez and johnsmith are caught).
// Lists (public domain, data/wordlists/LICENSE-CENSUS.txt): given-names-census1990.txt (US Census 1990, 600 most frequent male + 600 female first names) and
// surnames-census2010.txt (US Census 2010 surnames, ranks 1-5,000). Pure after the first load; no database, no network.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { commonWord } from '../../selection/index.js';

const GIVEN_FILE = fileURLToPath(new URL('../../../../data/wordlists/given-names-census1990.txt', import.meta.url));
const SURNAME_FILE = fileURLToPath(new URL('../../../../data/wordlists/surnames-census2010.txt', import.meta.url));
let given: Set<string> | null = null;
let surnames: Set<string> | null = null;
const load = (f: string): Set<string> => new Set(readFileSync(f, 'utf8').split('\n').map((x) => x.trim()).filter(Boolean));

/** The first name + surname split of a second-level label, or null when it is not a personal name by the rule above. */
export function personName(sld: string): { first: string; last: string } | null {
  if (!/^[a-z]{6,}$/.test(sld)) return null;
  given ??= load(GIVEN_FILE);
  surnames ??= load(SURNAME_FILE);
  for (let i = 3; i <= sld.length - 3; i++) {
    const first = sld.slice(0, i);
    const last = sld.slice(i);
    if (given.has(first) && surnames.has(last) && !commonWord(first)) return { first, last };
  }
  return null;
}
