// G1 brand, big-company and sensitive-event lists (CAP-02: BRAND-1, BIGCO-1, EVENT-1). Typo (TYPO-1) is a separate check.
import { outcome, type Check } from '../types.js';
import { formFieldsOf } from './form.js';

const LISTS = [['brand', 'BRAND_HIT', 'brand_hits'], ['bigco', 'BIGCO_HIT', 'bigco_hits'], ['event', 'EVENT_HIT', 'event_hits']] as const;

/** Terms (written with spaces, stored lowercase) that equal one token or the space-stripped run of consecutive tokens. */
export function matchTerms(tokens: string[], skip: boolean[], terms: string[]): { term: string; tokens: string[] }[] {
  const hits: { term: string; tokens: string[] }[] = [];
  for (const term of terms) {
    const want = term.replace(/\s+/g, '');
    if (!want) continue;
    for (let i = 0; i < tokens.length; i++) {
      let acc = '';
      for (let j = i; j < tokens.length && acc.length < want.length; j++) {
        if (skip[j]) break;
        acc += tokens[j];
        if (acc === want) { hits.push({ term, tokens: tokens.slice(i, j + 1) }); i = tokens.length; break; }
      }
    }
  }
  return hits;
}

export const brandListsCheck: Check = {
  id: 'brand_lists',
  gate: 'G1',
  ruleIds: ['BRAND-1', 'BIGCO-1', 'EVENT-1'],
  lists: ['brand', 'bigco', 'event'],
  async run(ctx) {
    const form = formFieldsOf(ctx);
    const tokens = form.tokens.length > 0 ? form.tokens : [form.sld];
    const geo = form.token_types.map((t) => t === 'city' || t === 'state'); // brand and big-company: non-geo tokens only
    const none = tokens.map(() => false);
    const fields: Record<string, unknown> = { tokens, list_versions: {} as Record<string, number> };
    const missing: string[] = [];
    let hitCode: string | null = null;
    let hitReason = '';
    for (const [name, code, key] of LISTS) {
      const list = ctx.lists[name];
      if (!list) { missing.push(name); fields[key] = null; continue; }
      (fields.list_versions as Record<string, number>)[name] = list.version;
      const hits = matchTerms(tokens, name === 'event' ? none : geo, list.terms);
      fields[key] = hits;
      if (hits.length > 0 && !hitCode) {
        hitCode = code;
        hitReason = `${name} list ${hits.length === 1 ? 'hit' : 'hits'}: ${hits.map((h) => h.term).join(', ')}`;
      }
    }
    fields.lists_missing = missing;
    if (hitCode) return outcome('FAIL', hitCode, hitReason, fields);
    if (missing.length > 0) return outcome('UNKNOWN', 'LIST_MISSING', `No uploaded list: ${missing.join(', ')} (a missing list is never a clean result)`, fields);
    return outcome('PASS', null, null, fields);
  },
};
