// CAP-01 name form (CR-001 CAP-01 + CR-002 CAP-01: FORM-2, G-FORM-1, multi-word cities and compound trade words).
import { describe, expect, it } from 'vitest';
import { AppError } from '../../src/http/errors.js';
import { analyzeForm, gform1, type FormSettings, type Lane } from '../../src/modules/selection/form.js';
import { buildLexicon, loadDataLexicon } from '../../src/modules/selection/lexicon.js';
import { DEFAULT_SELECTION_VALUES } from '../../src/modules/selection/settings.js';

/** Fixed test lists (not the production lists). */
const LISTS = {
  trade: { version: 3, terms: ['roofing', 'roofers', 'roof', 'pools', 'pool', 'plumbing', 'hvac', 'epoxy', 'solar', 'countertops', 'kitchen'] },
  regime: { version: 1, terms: ['nis2', 'dora'] },
  tech: { version: 1, terms: ['mcp', 'pentest', 'prompt', 'injection', 'rag', 'ai'] },
  generic_head: { version: 1, terms: ['co', 'pros', 'hq', 'app', 'get', 'audit', 'security', 'compliance', 'floors', 'business', 'for'] },
  legal: { version: 1, terms: ['lawyer', 'lawyers', 'attorney', 'attorneys', 'law'] },
};
/** The Task 3 default selection settings for this check (copied; Task 3 owns the real defaults). */
const S: FormSettings = {
  geo_bands: [
    { max_chars: 12, raw: 10 },
    { max_chars: 16, raw: 7 },
    { max_chars: 20, raw: 4 },
    { max_chars: null, raw: 1 },
  ],
  unknown_token_fails: true,
  ambiguity_margin: 2,
  token_costs: { typed: 1, dict3: 2, dict2: 3 },
  short_max_words: 2,
  short_max_chars: 12,
  geo_max_words: 2,
  geo_max_chars: 16,
  geo_city_one_token: true,
  formB_max_words: 2,
  legal_terms_list: 'legal',
  short_token_flag_min: 2,
  city_word_allowlist: DEFAULT_SELECTION_VALUES.form.city_word_allowlist,
};
const data = loadDataLexicon();
const lex = buildLexicon(data, LISTS, { cityOneToken: true, cityWordAllowlist: S.city_word_allowlist });
const lexSplitCities = buildLexicon(data, LISTS, { cityOneToken: false, cityWordAllowlist: S.city_word_allowlist });
const run = (d: string, lane: Lane = 'S3', l = lex, s = S) => analyzeForm(d, lane, l, s);
const dots = (r: { tokens: string[] }) => r.tokens.join('·');

describe('CAP-01 acceptance tests (CR-001)', () => {
  it('1. tulsaroofingco.com: tokens tulsa·roofing·co, city, trade, length 14, band 7; v10 G-FORM-1 now fails it on words', () => {
    const r = run('tulsaroofingco.com', 'S2');
    expect(dots(r)).toBe('tulsa·roofing·co');
    expect(r.token_types).toEqual(['city', 'trade', 'generic_head']);
    expect([r.city, r.trade, r.sld_len, r.geo_length_band, r.word_count]).toEqual(['tulsa', 'roofing', 14, 7, 3]);
    expect([r.city_span, r.trade_span]).toEqual([[0, 5], [5, 12]]);
    expect([r.gform1_pass, r.status, r.reason_code]).toEqual([false, 'FAIL', 'GFORM1_WORDS']);
  });

  it('2. tampapoolsco.com: tampa·pools·co, never pool·s·co', () => {
    expect(dots(run('tampapoolsco.com', 'S2'))).toBe('tampa·pools·co');
  });

  it('3. cincinnatioroofpros.com: FAIL UNKNOWN_TOKEN naming cincinnatio (the stray letter stays with its word)', () => {
    const r = run('cincinnatioroofpros.com', 'S2');
    expect([r.status, r.reason_code]).toEqual(['FAIL', 'UNKNOWN_TOKEN']);
    expect(r.unknown_tokens).toContain('cincinnatio');
    expect(dots(r)).toBe('cincinnatio·roof·pros');
    expect(r.token_types[0]).toBe('unknown');
  });

  it('4. nis2complianceaudit.com: FAIL HAS_DIGIT (a regime name with digits still fails)', () => {
    const r = run('nis2complianceaudit.com');
    expect([r.status, r.reason_code, r.has_digit]).toEqual(['FAIL', 'HAS_DIGIT', true]);
  });

  it('5. mcpentest.com: FLAG AMBIGUOUS_SPLIT with alternative splits', () => {
    const r = run('mcpentest.com');
    expect([r.status, r.reason_code, r.ambiguous]).toEqual(['FLAG', 'AMBIGUOUS_SPLIT', true]);
    expect(r.alternative_splits.length).toBeGreaterThanOrEqual(1);
    expect([dots(r), r.alternative_splits.map((a) => a.join('·'))]).toEqual(['mc·pentest', ['mcp·en·test']]);
  });

  it('6. promptinjectionaudit.com: prompt·injection·audit, 3 words, not short, PASS', () => {
    const r = run('promptinjectionaudit.com');
    expect([dots(r), r.word_count, r.short, r.status, r.reason_code]).toEqual(['prompt·injection·audit', 3, 0, 'PASS', null]);
    expect(r.keywords).toEqual(['prompt', 'injection']);
  });

  it('7. a 21-character geo SLD: A-Form raw 1', () => {
    const r = run('albuquerquekitchenpro.com', 'S2');
    expect([r.sld_len, r.geo_length_band]).toEqual([21, 1]);
    expect(dots(r)).toBe('albuquerque·kitchen·pro');
  });

  it('8. dallaslawyerpros.com: city_plus_legal, FLAG CITY_PLUS_LEGAL', () => {
    const r = run('dallaslawyerpros.com');
    expect([r.city_plus_legal, r.status, r.reason_code]).toEqual([true, 'FLAG', 'CITY_PLUS_LEGAL']);
  });

  it('a legal term without a city is not city_plus_legal', () => {
    const r = run('lawyerpros.com');
    expect([r.city_plus_legal, r.status]).toEqual([false, 'PASS']);
  });

  it('a hyphen: FAIL HAS_HYPHEN', () => {
    const r = run('tulsa-roofing.com', 'S2');
    expect([r.status, r.reason_code, r.has_hyphen]).toEqual(['FAIL', 'HAS_HYPHEN', true]);
  });
});

describe('CAP-01 v10: multi-word cities, G-FORM-1 (CR-002 SEL10-3, SEL10-6)', () => {
  it('losangelesroofers.com: one city token + one trade word; 2 words, 17 chars: FAIL on length only', () => {
    const r = run('losangelesroofers.com', 'S2');
    expect([dots(r), r.city, r.trade, r.word_count, r.sld_len]).toEqual(['losangeles·roofers', 'losangeles', 'roofers', 2, 17]);
    expect([r.city_span, r.trade_span]).toEqual([[0, 10], [10, 17]]);
    expect([r.status, r.reason_code, r.gform1_pass]).toEqual(['FAIL', 'GFORM1_LENGTH', false]);
  });

  it('sanantoniobuysell.com: city sanantonio + 2 words: FAIL on words', () => {
    const r = run('sanantoniobuysell.com', 'S2');
    expect([r.city, r.word_count, r.status, r.reason_code]).toEqual(['sanantonio', 3, 'FAIL', 'GFORM1_WORDS']);
  });

  it('hvacchicago.com: PASS, 2 words, 11 chars', () => {
    const r = run('hvacchicago.com', 'S2');
    expect([dots(r), r.word_count, r.sld_len, r.gform1_pass, r.status, r.reason_code]).toEqual(['hvac·chicago', 2, 11, true, 'PASS', null]);
  });

  it('chicagohvacrepairpros.com: FAIL (4 words, 21 chars)', () => {
    const r = run('chicagohvacrepairpros.com', 'S2');
    expect([r.word_count, r.status, r.reason_code]).toEqual([4, 'FAIL', 'GFORM1_WORDS']);
  });

  it('geo_city_one_token false: losangelesroofers tokenises los·angeles·roofers (3 words)', () => {
    const r = run('losangelesroofers.com', 'S2', lexSplitCities, { ...S, geo_city_one_token: false });
    expect([dots(r), r.word_count, r.status, r.reason_code]).toEqual(['los·angeles·roofers', 3, 'FAIL', 'GFORM1_WORDS']);
  });

  it('a geo name with the right shape but no trade word is flagged, not failed (CAP-04: missing attribute is FLAG)', () => {
    const r = run('tulsabuyer.com', 'S2');
    expect([r.city, r.trade, r.word_count]).toEqual(['tulsa', null, 2]);
    expect([r.status, r.reason_code, r.gform1_pass]).toEqual(['FLAG', 'GEO_ATTR_MISSING', false]);
  });

  it('G-FORM-1 applies only to the geo lane (gform1_pass is null elsewhere)', () => {
    expect(run('hvacchicago.com', 'S3').gform1_pass).toBeNull();
    expect(run('tulsaroofingco.com', 'S3').status).toBe('PASS');
  });
});

describe('gform1', () => {
  const g = { geo_max_words: 2, geo_max_chars: 16 };
  it('null for a non-geo name; otherwise city+trade, <= 2 words and <= 16 chars', () => {
    expect(gform1(2, 11, false, true, g)).toBeNull();
    expect(gform1(2, 11, true, true, g)).toBe(true);
    expect(gform1(2, 16, true, true, g)).toBe(true);
    expect(gform1(2, 17, true, true, g)).toBe(false);
    expect(gform1(3, 14, true, true, g)).toBe(false);
    expect(gform1(2, 11, true, false, g)).toBe(false);
  });
  it('limits come from the settings', () => {
    expect(gform1(3, 20, true, true, { geo_max_words: 3, geo_max_chars: 20 })).toBe(true);
  });
});

describe('FORM-2 short preference (CR-002 SEL10-4)', () => {
  it('netextend.com: 2 words, 9 chars, short = 1, PASS', () => {
    const r = run('netextend.com');
    expect([dots(r), r.word_count, r.sld_len, r.short, r.status]).toEqual(['net·extend', 2, 9, 1, 'PASS']);
  });
  it('a 3-word 14-char name: short = 0 and still PASS (a preference, not a gate)', () => {
    const r = run('roofingpoolsco.com');
    expect([dots(r), r.word_count, r.sld_len, r.short, r.status, r.reason_code]).toEqual(['roofing·pools·co', 3, 14, 0, 'PASS', null]);
  });
  it('2 words but 13 chars is not short; limits come from the settings', () => {
    expect(run('plumbingsolar.com').short).toBe(0);
    expect(run('plumbingsolar.com', 'S3', lex, { ...S, short_max_chars: 13 }).short).toBe(1);
    expect(run('netextend.com', 'S3', lex, { ...S, short_max_words: 1 }).short).toBe(0);
  });
});

describe('segmentation mechanics', () => {
  it('a stray letter at the start stays with the next word; a fully unknown name is one unknown token', () => {
    expect(run('xroofpros.com').unknown_tokens).toEqual(['xroof']);
    const r = run('qzqzqz.com');
    expect([r.tokens, r.unknown_tokens, r.reason_code]).toEqual([['qzqzqz'], ['qzqzqz'], 'UNKNOWN_TOKEN']);
  });
  it('unknown_token_fails false: the unknown token is reported but does not fail the name', () => {
    const r = run('cincinnatioroofpros.com', 'S3', lex, { ...S, unknown_token_fails: false });
    expect([r.unknown_tokens, r.status]).toEqual([['cincinnatio'], 'PASS']);
  });
  it('input is normalised like every domain (case, trailing dot); a non-.com name is refused', () => {
    expect(run('TulsaRoofingCo.COM.').domain).toBe('tulsaroofingco.com');
    expect(() => run('tulsaroofingco.net')).toThrow(AppError);
  });
  it('is deterministic and does not depend on call order', () => {
    const a = run('promptinjectionaudit.com');
    run('mcpentest.com');
    expect(run('promptinjectionaudit.com')).toEqual(a);
  });
});

describe('CAP-01 carried items (Task 3): short-token flag and city-word allowlist', () => {
  it('animalitos.com splits animal·it·os (two dictionary-only 2-letter tokens): FLAG AMBIGUOUS_SPLIT', () => {
    const r = run('animalitos.com');
    expect(dots(r)).toBe('animal·it·os');
    expect([r.status, r.reason_code, r.ambiguous]).toEqual(['FLAG', 'AMBIGUOUS_SPLIT', true]);
  });

  it('short_token_flag_min 0 switches the flag off; 3 needs three tiny tokens', () => {
    expect(run('animalitos.com', 'S3', lex, { ...S, short_token_flag_min: 0 }).status).toBe('PASS');
    expect(run('animalitos.com', 'S3', lex, { ...S, short_token_flag_min: 3 }).status).toBe('PASS');
  });

  it('a typed 2-letter token (co, ai) is not a dictionary-only token', () => {
    expect(run('tulsaroofingco.com', 'S3').reason_code).not.toBe('AMBIGUOUS_SPLIT');
    expect(run('mcpai.com', 'S3').status).toBe('PASS');
  });

  it('dentstorm, limemob, mobilelawyer: a place name that is a dictionary word is not a city unless allowed', () => {
    for (const d of ['dentstorm.com', 'limemob.com']) expect(run(d, 'S2').city).toBeNull();
    const m = run('mobilelawyer.com', 'S3');
    expect([m.city, m.city_plus_legal, m.status]).toEqual([null, false, 'PASS']);
  });

  it('listing the word in the allowlist makes it a city (setting, not code)', () => {
    const allowed = buildLexicon(data, LISTS, { cityOneToken: true, cityWordAllowlist: [...S.city_word_allowlist, 'mobile'] });
    const m = run('mobilelawyer.com', 'S3', allowed);
    expect([m.city, m.city_plus_legal, m.reason_code]).toEqual(['mobile', true, 'CITY_PLUS_LEGAL']);
  });

  it('the city_extra list counts a word as a city without the allowlist', () => {
    const l = buildLexicon(data, { ...LISTS, city_extra: { version: 1, terms: ['dent'] } }, { cityOneToken: true, cityWordAllowlist: [] });
    expect(l.types.get('dent')).toContain('city');
  });
});
