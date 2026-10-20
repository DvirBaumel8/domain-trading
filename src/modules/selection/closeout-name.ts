// v5.26.0 (CR-072): the pure name filters of the closeout candidates, built on the screening code. No network, no clock.
//   SPELL-1  = the `form` check (analyzeForm, non-geo lane S7) FAILs: a digit outside a regime code, a hyphen, a token no list explains, too long.
//   BRAND-1  = the `brand_lists` check's rule: the active `brand` list (a term equals one token or a run of consecutive non-geo tokens).
//   BIGCO-1  = the same rule for the active `bigco` list plus the loaded `bigco_names` table (terms given by the caller).
//   TM_KILL  = the same rule for the loaded `tm_kills` terms (given by the caller; geo tokens are not skipped); also an exact match of the whole name.
// The set lookup below finds the same hits as `matchTerms` in checks/brand-lists.ts, without a pass over every term for every name (125,000 names a day).
import type { Kysely } from 'kysely';
import type { Database } from '../../db/types.js';
import { normalizeDomain } from '../../domain-name.js';
import { analyzeForm } from './form.js';
import { buildLexicon, loadDataLexicon } from './lexicon.js';
import { currentLists } from './lists.js';
import { activeSelectionSettings } from './settings.js';

const FORM_LISTS = ['trade', 'regime', 'tech', 'generic_head', 'state', 'legal', 'city_extra', 'dictionary_extra'];

export type CloseoutNameCode = 'SPELL-1' | 'BRAND-1' | 'BIGCO-1' | 'TM_KILL';
export interface CloseoutNameVerdict { code: CloseoutNameCode | null; words: string[] }
export interface CloseoutNameChecker { check(domain: string): CloseoutNameVerdict; settings: string }

/** A list term as stored (any case, spaces, punctuation) to the form compared with the name: lowercase letters and digits only. */
export const termKey = (t: string): string => t.toLowerCase().replace(/[^a-z0-9]/g, '');

function toSet(terms: readonly string[]): { set: Set<string>; max: number } {
  const set = new Set<string>();
  let max = 0;
  for (const t of terms) { const k = termKey(t); if (k) { set.add(k); max = Math.max(max, k.length); } }
  return { set, max };
}

/** True when a term equals one token or the concatenation of consecutive tokens (a skipped token breaks a run). */
function runHit(tokens: string[], skip: boolean[] | null, t: { set: Set<string>; max: number }): boolean {
  if (t.set.size === 0) return false;
  for (let i = 0; i < tokens.length; i++) {
    let acc = '';
    for (let j = i; j < tokens.length && acc.length < t.max; j++) {
      if (skip?.[j]) break;
      acc += tokens[j];
      if (t.set.has(acc)) return true;
    }
  }
  return false;
}

/** The checker for the current word lists and the active selection settings; `extra` are the loaded bigco_names names and tm_kills terms. */
export async function closeoutNameChecker(db: Kysely<Database>, extra: { bigcoNames: readonly string[]; tmKills: readonly string[] }): Promise<CloseoutNameChecker> {
  const active = await activeSelectionSettings(db);
  const form = active.values.form;
  const lists = await currentLists(db, [...FORM_LISTS, 'brand', 'bigco']);
  const lexicon = buildLexicon(loadDataLexicon(), lists, { cityOneToken: form.geo_city_one_token, cityWordAllowlist: form.city_word_allowlist });
  const brand = toSet(lists.brand?.terms ?? []);
  const bigco = toSet([...(lists.bigco?.terms ?? []), ...extra.bigcoNames]);
  const tm = toSet(extra.tmKills);
  return {
    settings: active.label,
    check(raw: string): CloseoutNameVerdict {
      let domain: string;
      try { domain = normalizeDomain(raw); } catch { return { code: 'SPELL-1', words: [] }; }
      const f = analyzeForm(domain, 'S7', lexicon, form);
      const words = f.tokens;
      if (f.status === 'FAIL') return { code: 'SPELL-1', words };
      const tokens = words.length > 0 ? words : [f.sld];
      const geo = f.token_types.map((t) => t === 'city' || t === 'state');
      if (runHit(tokens, geo, brand)) return { code: 'BRAND-1', words };
      if (runHit(tokens, geo, bigco) || bigco.set.has(f.sld)) return { code: 'BIGCO-1', words };
      if (runHit(tokens, null, tm) || tm.set.has(f.sld)) return { code: 'TM_KILL', words };
      return { code: null, words };
    },
  };
}
