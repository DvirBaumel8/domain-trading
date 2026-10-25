// CR-078 phase 1 (v5.43.0): the pure parts of the knowledge base: URL canonicalisation, MinHash, the weight formula, clusters, the verdict and its certainty steps.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { candidatePairs, estimatedJaccard, minhashOf, shingles } from '../../../../src/modules/knowledge/minhash.js';
import { claimKeyOf } from '../../../../src/modules/knowledge/rows.js';
import { KbValues, type KbSettings } from '../../../../src/modules/knowledge/settings.js';
import { canonicalUrl } from '../../../../src/modules/knowledge/url.js';
import { clusterOf, computeVerdict, weightOf, type Item } from '../../../../src/modules/knowledge/verdict.js';

/** The seed row v1, read from the migration so the test cannot drift from the numbers in the research (§2.3). */
function seed(): KbSettings {
  const sql = readFileSync('migrations/1766800000000_v5-43-0.sql', 'utf8');
  const json = /\$json\$([\s\S]*?)\$json\$/.exec(sql)![1]!;
  return { version: 1, values: KbValues.parse(JSON.parse(json)) };
}

let seq = 0;
function item(o: Partial<Item> & { source: number }): Item {
  seq++;
  return {
    evidenceId: seq, sourceUrl: `https://example.test/${o.source}`, sourceType: 'practitioner_blog', sourceStatus: 'graded', conflict: 'none', grade: 'A', claimKey: 'k', option: null,
    stance: 'supports', credibility: 1, sampleSize: 1000, kind: 'measured', populationMatch: 'direct', survivorship: false, effectValue: null, effectUnit: null, halfLifeDays: 730, ageDays: 100, ...o,
  };
}

describe('knowledge base, pure parts (CR-078)', () => {
  it('KB543-1: URL canonicalisation lowercases the host, drops utm_*/fbclid and the fragment, sorts the query, trims the trailing slash; refuses non-http and credentials', () => {
    expect(canonicalUrl('HTTPS://Example.COM/Post/?utm_source=x&b=2&a=1&fbclid=z#frag')).toBe('https://example.com/Post?a=1&b=2');
    expect(canonicalUrl('https://example.com/')).toBe('https://example.com');
    expect(canonicalUrl('https://example.com/a//')).toBe('https://example.com/a');
    expect(canonicalUrl('https://example.com:443/a')).toBe('https://example.com/a');
    expect(canonicalUrl('ftp://example.com/a')).toBeNull();
    expect(canonicalUrl('https://user:pw@example.com/a')).toBeNull();
    expect(canonicalUrl('not a url')).toBeNull();
    expect(canonicalUrl('https://example.com/a?utm_medium=1')).toBe(canonicalUrl('https://example.com/a#x'));
  });

  it('KB543-2: MinHash is deterministic; near-copies score high, unrelated text low; banding finds the near-copy pair', () => {
    const a = 'Hand-registered dot com names sell through at about one percent a year according to a portfolio of two thousand names held for five years.';
    const b = 'Hand-registered dot com names sell through at about one percent a year according to a portfolio of two thousand names held for six years.';
    const c = 'The quick brown fox jumps over the lazy dog while the registrar updates its closeout price list every morning at nine.';
    expect(shingles('one two three')).toEqual(['one two three']);
    expect(shingles('')).toEqual([]);
    expect(minhashOf('')).toBeNull();
    expect(minhashOf(a)).toBe(minhashOf(a));
    expect(minhashOf(a)).toMatch(/^[0-9a-f]{512}$/);
    expect(estimatedJaccard(minhashOf(a)!, minhashOf(a)!)).toBe(1);
    expect(estimatedJaccard(minhashOf(a)!, minhashOf(b)!)).toBeGreaterThanOrEqual(0.5);
    expect(estimatedJaccard(minhashOf(a)!, minhashOf(c)!)).toBeLessThan(0.2);
    const pairs = candidatePairs([minhashOf(a)!, minhashOf(c)!, minhashOf(b)!]);
    expect(pairs).toContainEqual([0, 2]);
  });

  it('KB543-3: the weight is G x C x N x R x K from the settings row: A, credibility 1, n 1000, measured, fresh = 1; D weighs 0; opinion gets the fixed N; one reported sale gets 0.1; a rejected source weighs 0', () => {
    const s = seed();
    const fresh = { ageDays: 0 };
    expect(weightOf(item({ source: 1, ...fresh }), s).w).toBeCloseTo(1, 10);
    const b = weightOf(item({ source: 1, grade: 'B', credibility: 2, sampleSize: 100, kind: 'measured', ...fresh }), s);
    expect(b.G).toBe(0.6); expect(b.C).toBe(0.8); expect(b.N).toBeCloseTo(Math.log10(101) / 3, 10); expect(b.K).toBe(1);
    expect(b.w).toBeCloseTo(0.6 * 0.8 * (Math.log10(101) / 3), 10);
    expect(weightOf(item({ source: 1, grade: 'D', ...fresh }), s).w).toBe(0);
    expect(weightOf(item({ source: 1, grade: 'F', ...fresh }), s).w).toBe(0);
    expect(weightOf(item({ source: 1, sourceStatus: 'rejected', ...fresh }), s).w).toBe(0);
    expect(weightOf(item({ source: 1, kind: 'opinion', sampleSize: null, ...fresh }), s)).toMatchObject({ N: 0.3, K: 0.4 });
    expect(weightOf(item({ source: 1, kind: 'reported_sale', sampleSize: 1, ...fresh }), s)).toMatchObject({ N: 0.1, K: 0.8 });
    expect(weightOf(item({ source: 1, ageDays: 730, halfLifeDays: 730 }), s).R).toBeCloseTo(0.5, 10);
    expect(weightOf(item({ source: 1, ageDays: -5 }), s).R).toBe(1);
    expect(weightOf(item({ source: 1, sampleSize: 10, ...fresh }), s).N).toBeCloseTo(0.347, 3);
  });

  it('KB543-4: clusters join echo_of, syndicated, same_author and aggregator_of links transitively; the cluster id is the smallest member', () => {
    const c = clusterOf([1, 2, 3, 4, 5, 6], [[2, 1], [3, 2], [5, 4]]);
    expect([1, 2, 3].map((x) => c.get(x))).toEqual([1, 1, 1]);
    expect([4, 5].map((x) => c.get(x))).toEqual([4, 4]);
    expect(c.get(6)).toBe(6);
  });

  it('KB543-5: three independent A/B clusters that agree give moderate or high; two B plus one A without a second A stays moderate; A, A, A with n 1000 is high', () => {
    const s = seed();
    const three = computeVerdict({ options: [], edges: [], settings: s, items: [item({ source: 1 }), item({ source: 2 }), item({ source: 3 })] });
    expect(three.certainty).toBe('high');
    expect(three.verdict).toMatchObject({ clusters_n: 3, a_clusters_n: 3, agreement: 1, direction: 'supported' });
    const mixed = computeVerdict({ options: [], edges: [], settings: s, items: [item({ source: 1 }), item({ source: 2, grade: 'B' }), item({ source: 3, grade: 'B' })] });
    expect(mixed.certainty).toBe('moderate');
    expect(['moderate', 'high']).toContain(three.certainty);
  });

  it('KB543-6: the same evidence as 5 echoes of one post is 1 cluster and very low; D-grade only weighs 0 and is very low', () => {
    const s = seed();
    const echoes = [1, 2, 3, 4, 5].map((n) => item({ source: n }));
    const r = computeVerdict({ options: [], edges: [[2, 1], [3, 1], [4, 1], [5, 1]], settings: s, items: echoes });
    expect(r.verdict.clusters_n).toBe(1);
    expect(r.certainty).toBe('very_low');
    expect(r.downgrades.join(' ')).toMatch(/1 cluster/);
    expect(r.weight_for).toBeCloseTo(weightOf(echoes[0]!, s).w, 1);
    const d = computeVerdict({ options: [], edges: [], settings: s, items: [1, 2, 3].map((n) => item({ source: n, grade: 'D' })) });
    expect(d.certainty).toBe('very_low');
    expect(d.weight_for).toBe(0);
    expect(d.items.every((i) => i.weight.w === 0)).toBe(true);
    expect(d.downgrades[0]).toMatch(/no evidence with a weight above 0/);
  });

  it('KB543-7: each step down is named in plain words: inconsistency, indirectness, imprecision (few clusters, small samples), bias, staleness; and the gate needs 3 clusters with 2 A/B', () => {
    const s = seed();
    const base = [item({ source: 1 }), item({ source: 2 }), item({ source: 3 })];
    const mixed = computeVerdict({ options: [], edges: [], settings: s, items: [...base, item({ source: 4, stance: 'contradicts' }), item({ source: 5, stance: 'contradicts' })] });
    expect(mixed.downgrades.join(' ')).toMatch(/inconsistent: only 60%/);
    const ind = computeVerdict({ options: [], edges: [], settings: s, items: base.map((i) => ({ ...i, populationMatch: 'indirect' as const })) });
    expect(ind.downgrades.join(' ')).toMatch(/indirect: 100% of the weight/);
    expect(ind.certainty).toBe('moderate');
    const small = computeVerdict({ options: [], edges: [], settings: s, items: [1, 2, 3].map((n) => item({ source: n, sampleSize: 3 })) });
    expect(small.downgrades.join(' ')).toMatch(/imprecise: the samples are small/);
    const biased = computeVerdict({ options: [], edges: [], settings: s, items: base.map((i) => ({ ...i, survivorship: true })) });
    expect(biased.downgrades.join(' ')).toMatch(/biased: 100%/);
    const old = computeVerdict({ options: [], edges: [], settings: s, items: base.map((i) => ({ ...i, ageDays: 2000 })) });
    expect(old.downgrades.join(' ')).toMatch(/stale:/);
    const two = computeVerdict({ options: [], edges: [], settings: s, items: [item({ source: 1 }), item({ source: 2 })] });
    expect(two.certainty).toBe('very_low');
    expect(two.downgrades.join(' ')).toMatch(/imprecise: only 2 independent clusters/);
    const cs = computeVerdict({ options: [], edges: [], settings: s, items: [item({ source: 1, grade: 'C' }), item({ source: 2, grade: 'C' }), item({ source: 3, grade: 'C' })] });
    expect(cs.certainty).toBe('very_low');
    expect(cs.downgrades.join(' ')).toMatch(/3 clusters, 0 of them graded A or B/);
  });

  it('KB543-8: an own_analysis source that agrees steps the level up; options pick the leading option and a tie has none; numbers use the weighted median of one value per cluster', () => {
    const s = seed();
    const own = computeVerdict({ options: [], edges: [], settings: s, items: [item({ source: 1, grade: 'B', kind: 'experience', sampleSize: null }), item({ source: 2, grade: 'B', kind: 'experience', sampleSize: null }), item({ source: 3, sourceType: 'own_analysis', grade: 'B', kind: 'experience', sampleSize: null })] });
    const without = computeVerdict({ options: [], edges: [], settings: s, items: [item({ source: 1, grade: 'B', kind: 'experience', sampleSize: null }), item({ source: 2, grade: 'B', kind: 'experience', sampleSize: null }), item({ source: 3, grade: 'B', kind: 'experience', sampleSize: null })] });
    expect(LEVEL(own.certainty)).toBe(LEVEL(without.certainty) + 1);
    const opts = ['auctions', 'closeouts'];
    const lead = computeVerdict({ options: opts, edges: [], settings: s, items: [1, 2, 3].map((n) => item({ source: n, option: 'auctions' })).concat([item({ source: 4, option: 'closeouts', grade: 'C' })]) });
    expect(lead.verdict.leading_option).toBe('auctions');
    expect(lead.verdict.options.map((o) => o.option)).toEqual(opts);
    const tie = computeVerdict({ options: opts, edges: [], settings: s, items: [item({ source: 1, option: 'auctions' }), item({ source: 2, option: 'closeouts' })] });
    expect(tie.verdict.leading_option).toBeNull();
    const num = computeVerdict({ options: [], edges: [], settings: s, items: [item({ source: 1, effectValue: 1.0, effectUnit: '%/yr' }), item({ source: 2, effectValue: 0.5 }), item({ source: 3, effectValue: 1.1, grade: 'B' }), item({ source: 4, effectValue: 900, grade: 'D' })] });
    expect(num.verdict.numeric).toMatchObject({ low: 0.5, high: 1.1, unit: '%/yr', clusters: 3 });
    expect(num.verdict.numeric!.median).toBe(1.0);
  });

  it('KB543-9: the claim key is topic | variable | population, lowercased with collapsed spaces', () => {
    expect(claimKeyOf('sell_through', '  Sell-Through of 2-word .com ', 'Hand-regs,  .com.')).toBe('sell_through|sell-through of 2-word .com|hand-regs, .com');
  });
});

const LEVEL = (c: string) => ['very_low', 'low', 'moderate', 'high'].indexOf(c);
