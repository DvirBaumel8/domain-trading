// v2.13.0 (CR-012): the bt1@v3 word split (the bt1 recipe on data/bt1/bt1_v3_split.json).
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { SPLIT_V3_SHA256, loadSplitV2, splitV2, splitV2OfDomain } from '../../src/modules/selection/split-v2.js';
import { KNOWN_METHODS, siblingsBt1, usesSplitV2 } from '../../src/modules/selection/siblings.js';

const vectors = readFileSync(new URL('../../docs/requests/CR-008-reference/bt1_vectors.csv', import.meta.url), 'utf8').split(/\r?\n/).filter((l) => l.trim() !== '').slice(1)
  .map((l) => { const c = l.split(','); return { domain: c[0]!, tokens: c[1]!.split(' ') }; });
const v3 = (sld: string) => splitV2(sld, loadSplitV2('bt1@v3'));

describe('split-v3', () => {
  it('SV3-1 the frozen file matches its sha256 and bt1@v3 names pools and split hashes', () => {
    const bytes = readFileSync(new URL('../../data/bt1/bt1_v3_split.json', import.meta.url));
    expect(createHash('sha256').update(bytes).digest('hex')).toBe('a76396a60d25d38c699ae94194b28d6ea354551419c4baf9c9b70d1d33f70d5e');
    expect(SPLIT_V3_SHA256).toBe('a76396a60d25d38c699ae94194b28d6ea354551419c4baf9c9b70d1d33f70d5e');
    expect(KNOWN_METHODS['bt1@v3']).toMatchObject({ sha256: KNOWN_METHODS['bt1@v1']!.sha256, split: SPLIT_V3_SHA256 });
    expect(usesSplitV2('bt1@v3')).toBe(true);
  });

  it('SV3-2 over the 1900 research vectors the v3 split equals the tokens column on exactly 1826 rows', () => {
    expect(vectors).toHaveLength(1900);
    expect(vectors.filter((v) => splitV2OfDomain(v.domain, 'bt1@v3').join(' ') === v.tokens.join(' ')).length).toBe(1826);
    expect(vectors.filter((v) => splitV2OfDomain(v.domain).join(' ') === v.tokens.join(' ')).length).toBe(1810); // v2 is unchanged
  });

  it('SV3-3 the 8 names that now split, the 3 that still do not, and the names read as in v2', () => {
    expect(v3('aluminiumcasthouse')).toEqual(['aluminium', 'cast', 'house']);
    for (const [sld, words] of Object.entries({ buysellcbd: 3, freightbuzzllc: 3, monarchyllc: 2, skybrosllc: 3, thaixxxfilms: 3, thatsjustjunk: 3, uaelloyd: 2 })) {
      expect(v3(sld).length, sld).toBe(words);
      expect(v3(sld).join(''), sld).toBe(sld);
      expect(splitV2(sld), `${sld} in v2`).toEqual([]);
    }
    for (const sld of ['cryvonlabs', 'spotifyheadstart', 'uberfrance']) expect(v3(sld), sld).toEqual([]);
    for (const sld of ['theeventhouse', 'ballstart', 'achievehire']) expect(v3(sld)).toEqual(splitV2(sld));
    expect(siblingsBt1(v3('uaelloyd'))).toHaveLength(20);
  });
});
