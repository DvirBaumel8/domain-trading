// v3.4.0 (CR-027): the scout's `words` are the form tokens; a piece the lexicon lacks is known for that name only.
import { describe, expect, it } from 'vitest';
import { analyzeForm, type FormSettings } from '../../../../src/modules/selection/form.js';
import { buildLexicon, loadDataLexicon } from '../../../../src/modules/selection/lexicon.js';
import { DEFAULT_SELECTION_VALUES } from '../../../../src/modules/selection/settings.js';

const S: FormSettings = { ...DEFAULT_SELECTION_VALUES.form };
const lex = buildLexicon(loadDataLexicon(), {
  trade: { version: 1, terms: ['roofing'] }, regime: { version: 1, terms: [] }, tech: { version: 1, terms: ['ai'] },
  generic_head: { version: 1, terms: ['compliance', 'consulting'] }, legal: { version: 1, terms: ['lawyer'] },
}, { cityOneToken: true, cityWordAllowlist: S.city_word_allowlist });
const form = (d: string, words?: string[], lane: 'S2' | 'S3' | 'S6' = 'S3', s = S) => analyzeForm(d, lane, lex, s, { ...(words && { words }) });

describe('CR-027 scout words in the form check', () => {
  it('T27-1 a piece the lexicon does not know is a known term for this name: PASS_WITH_NOTE SCOUT_WORDS, tokens are the words, nothing is an unknown token', () => {
    const r = form('ukcbamcompliance.com', ['uk', 'cbam', 'compliance'], 'S6');
    expect(r.tokens).toEqual(['uk', 'cbam', 'compliance']);
    expect(r.word_count).toBe(3);
    expect(r.unknown_tokens).toEqual([]);
    expect([r.status, r.reason_code]).toEqual(['PASS_WITH_NOTE', 'SCOUT_WORDS']);
    expect(r.scout_words).toEqual(['uk', 'cbam', 'compliance']);
    expect(r.scout_unknown).toContain('cbam');
    expect(r.scout_unknown).not.toContain('compliance');
    expect(r.sld_len).toBe(16);
    // without the words the same name does not pass cleanly
    expect(form('ukcbamcompliance.com', undefined, 'S6').status).not.toBe('PASS');
  });

  it('T27-2 every piece known: still PASS, with the scout fields set and an empty scout_unknown', () => {
    const r = form('roofingcompliance.com', ['roofing', 'compliance']);
    expect([r.status, r.reason_code, r.scout_unknown, r.word_count]).toEqual(['PASS', null, [], 2]);
    expect(r.token_types).toEqual(['trade', 'generic_head']);
  });

  it('T27-3 the other form rules still apply to the scout tokens: digits, hyphens, G-FORM-1 word count, city+legal', () => {
    expect(form('ai4evals.com', ['ai', '4', 'evals']).reason_code).toBe('HAS_DIGIT');
    expect(form('ai-evals.com', ['ai', 'evals']).reason_code).toBe('HAS_HYPHEN');
    const geo = form('tulsaroofingcompliance.com', ['tulsa', 'roofing', 'compliance'], 'S2');
    expect([geo.status, geo.reason_code]).toEqual(['FAIL', 'GFORM1_WORDS']);
    const legal = form('tulsalawyer.com', ['tulsa', 'lawyer']);
    expect([legal.status, legal.reason_code]).toEqual(['FLAG', 'CITY_PLUS_LEGAL']);
  });

  it('T27-4 words that do not join to the name are ignored (the dictionary split decides)', () => {
    const r = form('roofingcompliance.com', ['roof', 'compliance']);
    expect(r.scout_words).toBeUndefined();
    expect(r.tokens.join('')).toBe('roofingcompliance');
  });
});
