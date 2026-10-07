// CR-009 N-8: the bt1@v2 word split (pure, frozen cost table).
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { SPLIT_V2_SHA256, loadSplitV2, splitV2, splitV2OfDomain } from '../../src/screening/split-v2.js';
import { KNOWN_METHODS, siblingsBt1 } from '../../src/screening/siblings.js';

const vectors = readFileSync(new URL('../../docs/requests/CR-008-reference/bt1_vectors.csv', import.meta.url), 'utf8').split(/\r?\n/).filter((l) => l.trim() !== '').slice(1)
  .map((l) => { const c = l.split(','); return { domain: c[0]!, tokens: c[1]!.split(' ') }; });

describe('split-v2', () => {
  it('SV2-1 the frozen split file matches its sha256 and bt1@v2 names both hashes', () => {
    const bytes = readFileSync(new URL('../../data/bt1/bt1_v2_split.json', import.meta.url));
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(SPLIT_V2_SHA256);
    expect(SPLIT_V2_SHA256).toBe('69e659c242ef3a6ea7f55c76dba5680db2199c81ef281d0e80adaf1547f80d73');
    expect(loadSplitV2().pieceCost).toBe(5);
    expect(KNOWN_METHODS['bt1@v2']).toMatchObject({ sha256: KNOWN_METHODS['bt1@v1']!.sha256, split: SPLIT_V2_SHA256 });
    expect(KNOWN_METHODS['bt1@v1']!.split).toBeNull();
  });

  it('SV2-2 over the 1900 research vectors the split equals the tokens column on exactly 1810 rows', () => {
    expect(vectors).toHaveLength(1900);
    const agree = vectors.filter((v) => splitV2OfDomain(v.domain).join(' ') === v.tokens.join(' ')).length;
    expect(agree).toBe(1810);
  });

  it('SV2-3 named words: theeventhouse, ballstart, achievehire', () => {
    expect(splitV2('theeventhouse')).toEqual(['the', 'event', 'house']);
    expect(splitV2('ballstart')).toEqual(['ball', 'start']);
    expect(splitV2('achievehire')).toEqual(['achieve', 'hire']);
  });

  it('SV2-4 anything but lower-case letters, or no reading, has no split; siblings need 2 tokens', () => {
    for (const s of ['', 'a1b', 'Super', 'super-pro', 'zzqxjkvv']) expect(splitV2(s), s).toEqual([]);
    expect(splitV2OfDomain('superpro.net')).toEqual([]);
    expect(siblingsBt1(splitV2('zzqxjkvv'))).toEqual([]);
  });
});
