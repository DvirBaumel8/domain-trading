// v3.2.0 (CR-020 A): which kept lane a drop-list name fits, from the `form` token types. S2: a city and a trade token passing G-FORM-1 (at most geo_max_words words,
// at most geo_max_chars characters); S4: a tech token plus a trade or generic_head token; S6: a regime token. First match in the order S2, S4, S6; none = NO_KEPT_LANE.
import type { Kysely } from 'kysely';
import type { Database } from '../../db/types.js';
import { normalizeDomain } from '../../domain-name.js';
import { analyzeForm } from './form.js';
import { buildLexicon, loadDataLexicon } from './lexicon.js';
import { currentLists } from './lists.js';
import type { SelectionValuesT } from './settings.js';

export type KeptLane = 'S2' | 'S4' | 'S6';
export const KEPT_LANES: readonly KeptLane[] = ['S2', 'S4', 'S6'];
const FORM_LISTS = ['trade', 'regime', 'tech', 'generic_head', 'state', 'legal', 'city_extra', 'dictionary_extra'];

/** A function from a domain to the kept lane it fits (null = none), built from the current versioned word lists and the given settings. */
export async function laneFitter(db: Kysely<Database>, values: SelectionValuesT): Promise<(domain: string) => KeptLane | null> {
  const lists = await currentLists(db, FORM_LISTS);
  const lexicon = buildLexicon(loadDataLexicon(), lists, { cityOneToken: values.form.geo_city_one_token, cityWordAllowlist: values.form.city_word_allowlist });
  return (raw: string) => {
    let domain: string;
    try { domain = normalizeDomain(raw); } catch { return null; }
    const geo = analyzeForm(domain, 'S2', lexicon, values.form);
    if (geo.status !== 'FAIL' && geo.gform1_pass === true) return 'S2';
    const f = analyzeForm(domain, 'S7', lexicon, values.form);
    if (f.status === 'FAIL') return null;
    const has = (t: string) => f.token_types.includes(t as never);
    if (has('tech') && (has('trade') || has('generic_head'))) return 'S4';
    if (has('regime')) return 'S6';
    return null;
  };
}
