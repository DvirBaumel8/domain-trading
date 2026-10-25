// v5.44.0 (research funnel-names-safety-2026-10 §5 item 4): BRAND-TYPO-2, the typo / look-alike / combosquat check of a name against the brand labels of the stored
// popularity list (Majestic top `typo.top_n`, see popularity.ts: Tranco is not used, its licence is open, gap G-30). Pure and deterministic; no network.
// Rules (docs/internal/auctions.md §Safety checks):
//  - brand labels: the registrable labels of the list, lowercase, hyphens removed, at least 4 letters or digits (shorter labels are TYPO-1's job and too noisy);
//  - typo: edit distance (Damerau, adjacent swap = 1) of the name's label to a brand label, at most 1 for a brand of 10 letters or fewer, at most 2 for a longer brand;
//  - look-alike: the same distance rule after folding look-alike letters on both sides: rn -> m, vv -> w, 0 -> o, 1 -> l, i -> l;
//  - combosquat: a brand label of 5 or more letters is contained in the name and the name is longer than the brand;
//  - exact: the name's label is a brand label (TYPO-1 fails it too);
//  - severity: FAIL, except FLAG when the thing is also an ordinary word of the frozen common-word list (data/wordlists/en-scowl-35-lower.txt, `commonWord`: lowercase SCOWL 35 entries, so brand names such as paypal, google, amazon are not words): the brand label for a combosquat
//    (a name that contains "apple" or "target" is read by a human), the name's own label for a typo or look-alike (a real word one letter from a brand). An exact
//    brand match is always FAIL.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { editDistanceWithin } from './popularity.js';

const COMMON_FILE = fileURLToPath(new URL('../../../data/wordlists/en-scowl-35-lower.txt', import.meta.url));
let common: Set<string> | null = null;
/** The ordinary-word test: SCOWL size 35, lowercase entries only (no proper names: "paypal", "google", "amazon" are not on it; "apple", "target", "time" are). Read once. */
export function commonWord(w: string): boolean {
  common ??= new Set(readFileSync(COMMON_FILE, 'utf8').split('\n').filter(Boolean));
  return common.has(w);
}

export type BrandMatchKind = 'exact' | 'edit' | 'lookalike' | 'contains';
export interface BrandMatch { brand: string; rank: number; kind: BrandMatchKind; distance: number | null; brand_is_word: boolean; name_is_word: boolean; severity: 'FAIL' | 'FLAG' }

export const MIN_BRAND_LEN = 4;
export const MIN_CONTAINED_LEN = 5;
/** A brand of this many letters or fewer allows one edit; a longer brand allows two. */
export const SHORT_BRAND_MAX = 10;

/** Look-alike folding: rn -> m, vv -> w, 0 -> o, 1 -> l, i -> l (applied to both strings before the distance). */
export function foldLookalikes(s: string): string {
  return s.replace(/rn/g, 'm').replace(/vv/g, 'w').replace(/0/g, 'o').replace(/[1i]/g, 'l');
}

const clean = (s: string): string => s.toLowerCase().replace(/-/g, '');

/** All brand matches of one name label, worst first (FAIL before FLAG, then exact, edit, lookalike, contains, then rank). At most `max` are returned. */
export function brandMatches(sld: string, brands: ReadonlyMap<string, number>, isWord: (w: string) => boolean, max = 10): BrandMatch[] {
  const name = clean(sld);
  const foldedName = foldLookalikes(name);
  const nameIsWord = isWord(name);
  const out: BrandMatch[] = [];
  for (const [raw, rank] of brands) {
    const brand = clean(raw);
    if (brand.length < MIN_BRAND_LEN) continue;
    const brandIsWord = isWord(brand);
    const k = brand.length <= SHORT_BRAND_MAX ? 1 : 2;
    let kind: BrandMatchKind | null = null;
    let distance: number | null = null;
    if (name === brand) { kind = 'exact'; distance = 0; }
    else {
      const d = editDistanceWithin(name, brand, k);
      if (d !== null) { kind = 'edit'; distance = d; }
      else {
        const f = editDistanceWithin(foldedName, foldLookalikes(brand), k);
        if (f !== null) { kind = 'lookalike'; distance = f; }
        else if (brand.length >= MIN_CONTAINED_LEN && name.length > brand.length && name.includes(brand)) kind = 'contains';
      }
    }
    if (kind === null) continue;
    const word = kind === 'contains' ? brandIsWord : kind === 'exact' ? false : nameIsWord;
    out.push({ brand: raw, rank, kind, distance, brand_is_word: brandIsWord, name_is_word: nameIsWord, severity: word ? 'FLAG' : 'FAIL' });
  }
  const order: Record<BrandMatchKind, number> = { exact: 0, edit: 1, lookalike: 2, contains: 3 };
  out.sort((a, b) => (a.severity === b.severity ? 0 : a.severity === 'FAIL' ? -1 : 1) || order[a.kind] - order[b.kind] || a.rank - b.rank);
  return out.slice(0, max);
}
