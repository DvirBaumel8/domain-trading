// v5.44.0: BRAND-TYPO-2 rules (pure): edit distance 1 (brand <= 10 letters) or 2 (longer), look-alike letters, a brand of 5+ letters inside the name, dictionary-word allow-list.
import { describe, expect, it } from 'vitest';
import { brandMatches, foldLookalikes } from '../../../../src/modules/selection/brand-typo.js';

const WORDS = new Set(['apple', 'target', 'applepie', 'stack', 'haystack', 'forbes']);
const isWord = (w: string) => WORDS.has(w);
const brands = new Map<string, number>([['paypal', 1], ['amazon', 2], ['apple', 3], ['target', 4], ['microsoftonline', 5], ['bbc', 6], ['stack', 7], ['microsoft', 8]]);
const top = (sld: string) => brandMatches(sld, brands, isWord)[0];

describe('SF544 brand typo rules', () => {
  it('SF544-1: one edit of a short brand is FAIL (typo), the same label is exact; a transposition is one edit', () => {
    expect(top('paypall')).toMatchObject({ brand: 'paypal', kind: 'edit', distance: 1, severity: 'FAIL' });
    expect(top('paypal')).toMatchObject({ kind: 'exact', severity: 'FAIL' });
    expect(top('amazno')).toMatchObject({ brand: 'amazon', kind: 'edit', distance: 1, severity: 'FAIL' });
    expect(top('paypxxl')).toBeUndefined(); // two edits of a short brand: allowed
  });

  it('SF544-2: a brand of more than 10 letters allows two edits', () => {
    expect(top('microsoftonlinxx')).toMatchObject({ brand: 'microsoftonline', kind: 'edit', distance: 2, severity: 'FAIL' });
    expect(brandMatches('microsoftonlinxxx', new Map([['microsoftonline', 5]]), isWord)).toEqual([]);
  });

  it('SF544-3: look-alike letters are folded (rn/m, vv/w, 0/o, 1/l, i/l) before the distance', () => {
    expect(foldLookalikes('rnicrosoft')).toBe(foldLookalikes('microsoft')); // both fold to mlcrosoft
    expect(foldLookalikes('vvord0ne1')).toBe('wordonel');
    expect(top('amaz0n')).toMatchObject({ brand: 'amazon', severity: 'FAIL' });
    expect(top('paypai')).toMatchObject({ brand: 'paypal', severity: 'FAIL' });
    expect(top('rnicrosoft')).toMatchObject({ brand: 'microsoft', kind: 'lookalike', severity: 'FAIL' }); // two raw edits, one after folding
  });

  it('SF544-4: a brand of 5+ letters inside a longer name is a combosquat FAIL; a brand shorter than 5 letters inside a name is not', () => {
    expect(top('paypalsecure')).toMatchObject({ brand: 'paypal', kind: 'contains', severity: 'FAIL' });
    expect(top('securebbcnews')).toBeUndefined(); // bbc: 3 letters, below the minimum brand length
    expect(top('myamazonshop')).toMatchObject({ brand: 'amazon', kind: 'contains', severity: 'FAIL' });
  });

  it('SF544-5: allow-list: a brand that is an ordinary word (contained) and a name that is itself an ordinary word (typo) are FLAG, not FAIL', () => {
    expect(top('targetmarketing')).toMatchObject({ brand: 'target', kind: 'contains', brand_is_word: true, severity: 'FLAG' });
    expect(top('haystack')).toMatchObject({ brand: 'stack', kind: 'contains', severity: 'FLAG' });
    expect(top('applepie')).toMatchObject({ brand: 'apple', severity: 'FLAG' });
    expect(top('forbez')).toBeUndefined(); // not in the brand list used here
    // a name that is a dictionary word one edit from a non-word brand is a FLAG
    expect(brandMatches('apples', new Map([['appleb', 9]]), (w) => w === 'apples')[0]).toMatchObject({ kind: 'edit', name_is_word: true, severity: 'FLAG' });
  });

  it('SF544-6: worst first: a FAIL sorts before a FLAG', () => {
    const m = brandMatches('applepaypalx', brands, isWord);
    expect(m[0]!.severity).toBe('FAIL');
    expect(m.map((x) => x.brand)).toEqual(expect.arrayContaining(['paypal', 'apple']));
  });

  it('SF544-7: a clean name has no match', () => {
    expect(brandMatches('brightwidgets', brands, isWord)).toEqual([]);
  });
});
