import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { placeKey } from '../../../../scripts/build-wordlists.js';
import { buildLexicon, loadDataLexicon } from '../../../../src/modules/selection/lexicon.js';

const ROOT = join(import.meta.dirname, '..', '..');

describe('data files', () => {
  it('stay under the committed-data cap (1.5 MB for both word lists) and are documented', () => {
    const a = statSync(join(ROOT, 'data/wordlists/en-scowl-60.txt')).size;
    const b = statSync(join(ROOT, 'data/wordlists/us-places.txt')).size;
    expect(a + b).toBeLessThan(1_500_000);
    const readme = readFileSync(join(ROOT, 'data/README.md'), 'utf8');
    expect(readme).toContain(a.toLocaleString('en-US'));
    expect(readme).toContain(b.toLocaleString('en-US'));
    for (const f of ['LICENSE-SCOWL.txt', 'LICENSE-CENSUS.txt']) expect(statSync(join(ROOT, 'data/wordlists', f)).size).toBeGreaterThan(200);
  });
});

describe('loadDataLexicon', () => {
  const data = loadDataLexicon();
  it('reads the files once per process and reports content versions', () => {
    expect(loadDataLexicon()).toBe(data);
    expect(data.versions['en-scowl-60']).toMatch(/^sha256:[0-9a-f]{12}$/);
    expect(data.versions['us-places']).toMatch(/^sha256:[0-9a-f]{12}$/);
  });
  it('has dictionary words and places, and knows which place names are written with several words', () => {
    expect(data.dictionary.has('roofing')).toBe(true);
    expect(data.dictionary.has('x')).toBe(false); // length >= 2
    for (const c of ['tulsa', 'chicago', 'losangeles', 'sanantonio', 'newyork']) expect(data.cities.has(c), c).toBe(true);
    expect(data.multiWord.has('losangeles')).toBe(true);
    expect(data.multiWord.has('tulsa')).toBe(false);
  });
});

describe('buildLexicon', () => {
  const data = loadDataLexicon();
  const lists = {
    trade: { version: 3, terms: ['Roofing', ' pools ', 'x'] },
    legal: { version: 2, terms: ['lawyer'] },
    brand: { version: 9, terms: ['zzbrandx'] },
  };
  it('merges every type a term has, skips single letters, and versions every list', () => {
    const lex = buildLexicon(data, lists, { cityOneToken: true });
    expect(lex.types.get('roofing')).toEqual(['dictionary', 'trade']);
    expect(lex.types.get('pools')).toContain('trade');
    expect(lex.types.has('x')).toBe(false);
    expect(lex.types.get('lawyer')).toContain('legal');
    expect(lex.types.has('zzbrandx')).toBe(false); // brand lists are not tokenizer lists
    expect(lex.versions).toMatchObject({ trade: 3, legal: 2, brand: 9, 'en-scowl-60': data.versions['en-scowl-60'] });
  });
  it('a multi-word city is one token only when cityOneToken', () => {
    const one = buildLexicon(data, lists, { cityOneToken: true, cityWordAllowlist: ['tulsa'] });
    const split = buildLexicon(data, lists, { cityOneToken: false, cityWordAllowlist: ['tulsa'] });
    expect(one.types.get('losangeles')).toContain('city');
    expect(split.types.get('losangeles')).toBeUndefined();
    expect(split.types.get('tulsa')).toContain('city');
  });
});

describe('placeKey (Gazetteer builder)', () => {
  it.each([
    ['Los Angeles city', 'losangeles', 2],
    ['St. Louis city', 'stlouis', 2],
    ['Abanda CDP', 'abanda', 1],
    ['Milford city (balance)', 'milford', 1],
    ['Winston-Salem city', 'winstonsalem', 2],
    ['El Paso de Robles (Paso Robles) city', 'elpasoderobles', 4],
    ['Athens-Clarke County unified government (balance)', 'athensclarke', 2],
    ['Tulsa city', 'tulsa', 1],
  ])('%s -> %s (%i words)', (name, key, words) => {
    expect(placeKey(name)).toEqual({ key, words });
  });
});
