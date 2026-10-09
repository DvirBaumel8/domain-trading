// CR-008 C-2 / AC-4 / AC-5: the sibling method bt1@v1, every one of the 1,900 reference vectors, and the frozen pools.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { KNOWN_METHODS, loadPools, siblingsBt1 } from '../../../../src/modules/selection/siblings.js';

const REF = new URL('../../../../docs/requests/CR-008-reference/', import.meta.url);
const vectors = readFileSync(new URL('bt1_vectors.csv', REF), 'utf8').split(/\r?\n/).filter((l) => l.trim() !== '').slice(1)
  .map((l) => { const c = l.split(','); return { domain: c[0]!, tokens: c[1]!.split(' '), want: c.slice(2) }; });

describe('bt1@v1 siblings (CR-008 Appendix B)', () => {
  it('BT1-1 the reference file has 1,900 vectors of 20 siblings', () => {
    expect(vectors).toHaveLength(1900);
    expect(vectors.every((v) => v.want.length === 20)).toBe(true);
  });
  it('BT1-2 AC-4: for every vector, the siblings equal s01..s20 in order (1,900 of 1,900)', () => {
    const bad = vectors.filter((v) => siblingsBt1(v.tokens).join() !== v.want.join());
    expect(bad.map((v) => v.domain)).toEqual([]);
  });
  it('BT1-3 the same input twice gives the same list, and the function does not mutate the frozen pools', () => {
    const before = JSON.stringify(loadPools('bt1@v1'));
    for (const v of vectors.slice(0, 100)) expect(siblingsBt1(v.tokens)).toEqual(siblingsBt1(v.tokens));
    expect(JSON.stringify(loadPools('bt1@v1'))).toBe(before);
  });
  it('BT1-4 a split of fewer than 2 words has no siblings; the name itself is never a sibling and there are no duplicates', () => {
    expect(siblingsBt1(['mountain'])).toEqual([]);
    for (const v of vectors.slice(0, 200)) {
      const l = siblingsBt1(v.tokens);
      expect(l).not.toContain(v.tokens.join(''));
      expect(new Set(l).size).toBe(l.length);
    }
  });
  it('BT1-5 AC-5: the pools file matches its frozen sha256, and the pools read back equal the reference JSON (order, the duplicate cyber)', () => {
    const refBytes = readFileSync(new URL('bt1_pools_v1.json', REF));
    expect(createHash('sha256').update(refBytes).digest('hex')).toBe(KNOWN_METHODS['bt1@v1']!.sha256);
    const ref = JSON.parse(refBytes.toString('utf8')) as Record<string, string[]>;
    const p = loadPools('bt1@v1');
    expect(p).toEqual({ first_pool: ref.first_pool, last_pool: ref.last_pool, tech: ref.tech, trades: ref.trades });
    expect([p.first_pool.length, p.last_pool.length, p.tech.length, p.trades.length]).toEqual([300, 300, 100, 137]);
    expect(p.tech.filter((w) => w === 'cyber')).toHaveLength(2);
    expect([p.tech.indexOf('cyber'), p.tech.lastIndexOf('cyber')]).toEqual([7, 95]);
  });
});
