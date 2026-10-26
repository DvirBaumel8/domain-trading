// v5.45.0 (G-127): the auction score and the maximum-bid rule. Pure functions; test ids AS545-1..4, v5.46.0 (auction-v2) AS546-1..4 (rules: docs/internal/auctions.md "Shortlist", "Auction score v2").
import { describe, expect, it } from 'vitest';
import { AUCTION_SCORE_VERSION, maxBidRule, SCORE_FULL_MAX, scoreAuction, seoFlag, shapeValue, UNCOMMON_CAP, type ScoreInput } from '../../../../src/modules/ops/auctions/shortlist-score.js';
import { COMMON_LEVEL, nameQuality, wordLevel } from '../../../../src/modules/ops/auctions/word-quality.js';

const base: ScoreInput = { words: ['cozy', 'fleece'], letters: 10, price_cents: 5000, max_bid_cents: 25_000, bids: 5, domain_age: 5, pageviews: null, endings: {} };
const all = (v: boolean | null) => ({ net: v, co: v, org: v, io: v, ai: v });

describe('AS545 auction score (shape, endings, bids, age, maximum bid)', () => {
  it('AS545-1: the shape cell: 1-2 words beat 3 words beat 4+, shorter beats longer, and the score is 0-100 with a stored version', () => {
    expect(shapeValue(2, 8)).toBeGreaterThan(shapeValue(2, 12));
    expect(shapeValue(2, 12)).toBeGreaterThan(shapeValue(2, 14));
    expect(shapeValue(2, 14)).toBeGreaterThan(shapeValue(2, 20));
    // v2: graded, not stepped: every extra letter inside a band costs a little
    expect(shapeValue(2, 9)).toBeGreaterThan(shapeValue(2, 10)); expect(shapeValue(2, 10)).toBeGreaterThan(shapeValue(2, 11));
    expect(shapeValue(1, 8)).toBe(shapeValue(2, 8));
    expect(shapeValue(2, 10)).toBeGreaterThan(shapeValue(3, 10));
    expect(shapeValue(3, 10)).toBeGreaterThan(shapeValue(4, 10));
    const hi = scoreAuction({ ...base, words: ['cozy', 'fleece'], letters: 7 });
    const lo = scoreAuction({ ...base, words: ['cozy', 'fleece', 'soft', 'wool'], letters: 18 });
    expect(hi.score).toBeGreaterThan(lo.score);
    for (const s of [hi, lo, scoreAuction({ ...base, price_cents: 0, bids: 500, domain_age: 40, endings: all(true) })]) { expect(s.score).toBeGreaterThanOrEqual(0); expect(s.score).toBeLessThanOrEqual(100); expect(s.version).toBe(AUCTION_SCORE_VERSION); }
  });

  it('AS545-2: other endings: registered ones raise the name part; unknown stays unknown (the part is rescaled, never counted as 0); a free ending lowers it against a registered one', () => {
    const unknown = scoreAuction({ ...base, endings: {} });
    expect(unknown.parts.name).toMatchObject({ endings_known: 0, endings_value: null, known: true });
    // the name part with no endings data is the shape alone, scaled to the full 60 points
    expect(unknown.parts.name.points).toBeCloseTo(60 * shapeValue(2, 10), 1); // both words common: word quality 1
    const none = scoreAuction({ ...base, endings: all(false) });
    const one = scoreAuction({ ...base, endings: { ...all(false), net: true } });
    const two = scoreAuction({ ...base, endings: { ...all(false), net: true, org: true } });
    expect(none.parts.name.endings_value).toBe(0);
    expect(one.parts.name.endings_value).toBe(0.5);
    expect(two.parts.name.endings_value).toBe(1);
    expect(two.score).toBeGreaterThan(one.score);
    expect(one.score).toBeGreaterThan(none.score);
    expect(none.score).toBeLessThan(unknown.score); // known-free is worse than unknown: unknown is not penalised
    // two of five known, both registered: counts at 2/5 of the ending weight
    const partial = scoreAuction({ ...base, endings: { net: true, org: true } });
    expect(partial.parts.name).toMatchObject({ endings_known: 2, endings_registered: 2, endings_value: 1 });
    expect(partial.parts.name.points).toBeGreaterThan(unknown.parts.name.points);
    expect(partial.parts.name.points).toBeLessThan(two.parts.name.points);
    expect(partial.reasons.join(' ')).toContain('.net, .org');
  });

  it('AS545-3: bids are log-scaled and halved by the SEO look (10+ years and page views); age unknown leaves the part out; a lower price has more headroom; GoDaddy valuation is not an input', () => {
    const b1 = scoreAuction({ ...base, bids: 1 }).parts.bids.points;
    const b5 = scoreAuction({ ...base, bids: 5 }).parts.bids.points;
    const b20 = scoreAuction({ ...base, bids: 20 }).parts.bids.points;
    const b99 = scoreAuction({ ...base, bids: 99 }).parts.bids.points;
    expect(b1).toBeLessThan(b5); expect(b5).toBeLessThan(b20); expect(b99).toBe(b20); expect(b20).toBe(10);
    expect(seoFlag(10, 100)).toBe(true); expect(seoFlag(9, 100)).toBe(false); expect(seoFlag(12, 0)).toBe(false); expect(seoFlag(12, null)).toBe(false); expect(seoFlag(null, 50)).toBe(false);
    const seo = scoreAuction({ ...base, bids: 20, domain_age: 12, pageviews: 400 });
    expect(seo.parts.bids).toMatchObject({ points: 5, seo_flag: true });
    expect(seo.seo_flag).toBe(true);
    expect(seo.reasons.join(' ')).toContain('SEO');
    const noAge = scoreAuction({ ...base, domain_age: null });
    expect(noAge.parts.age).toMatchObject({ known: false, points: 0 });
    const full = scoreAuction({ ...base, domain_age: 10 });
    expect(full.parts.age.points).toBe(10);
    // an unknown age is rescaled out, so it is not a 0-point penalty: all other parts equal, the score is not lower than with a young name
    expect(noAge.score).toBeGreaterThan(scoreAuction({ ...base, domain_age: 0 }).score);
    expect(scoreAuction({ ...base, price_cents: 1000 }).parts.headroom!.points).toBeGreaterThan(scoreAuction({ ...base, price_cents: 20_000 }).parts.headroom!.points);
    expect(scoreAuction({ ...base, price_cents: 25_000 }).parts.headroom!.points).toBe(0);
    expect(Object.keys(base)).not.toContain('valuation_cents');
  });

  it('AS545-4 (v5.48.0, F22): the maximum bid = expected value: sale chance x net resale - renewal, scaled by score, capped, never below 0, rounded down to $5, integer cents', () => {
    const ev = { capCents: 25_000, resaleCents: 100_000, commission: 0.2, saleChanceBp: 1000, renewalCents: 2300 };
    expect(maxBidRule(ev)).toBe(5_500); // 10% of $800 = $80, less $23 renewal = $57 -> $55 (base, no score; v5.49.0 P5: GoDaddy renews at about $23)
    expect(maxBidRule({ ...ev, score: 85 })).toBe(5_500); // full at 85
    expect(maxBidRule({ ...ev, score: 95 })).toBe(5_500); // never above the base
    expect(maxBidRule({ ...ev, score: 42.5 })).toBe(2_500); // half the score: $28.5 -> $25
    expect(maxBidRule({ ...ev, score: 10 })).toBe(500); // $6.7 -> $5
    expect(maxBidRule({ ...ev, saleChanceBp: 100 })).toBe(0); // 1% of $800 = $8 < the $23 renewal: never negative
    expect(maxBidRule({ ...ev, saleChanceBp: 5000, resaleCents: 488_800 })).toBe(25_000); // a high expected value stops at the cap
    expect(maxBidRule({ ...ev, capCents: 4_000 })).toBe(4_000);
    expect(Number.isInteger(maxBidRule({ ...ev, resaleCents: 99_999, commission: 0.175, score: 41.3 }))).toBe(true);
  });
});

// ---- v5.46.0: auction-v2 ----
const SAMPLE: Array<[string, string[]]> = [
  ['comphost', ['comp', 'host']], ['gymnest', ['gym', 'nest']], ['laptopi', ['laptop', 'pi']], ['vetday', ['vet', 'day']], ['gatherms', ['gather', 'ms']], ['thrune', ['thru', 'ne']],
  ['reachhq', ['reach', 'hq']], ['foamira', ['foam', 'ira']], ['cozyfleece', ['cozy', 'fleece']], ['brooklynair', ['brooklyn', 'air']], ['makeplastic', ['make', 'plastic']],
  ['kingscapes', ['kings', 'capes']], ['idward', ['id', 'ward']], ['finsplat', ['fin', 'splat']], ['dnasays', ['dna', 'says']],
];
const typical = (name: string, words: string[]) => scoreAuction({ words, letters: name.length, price_cents: 5000, max_bid_cents: 16_000, bids: 5, domain_age: 5, pageviews: null, endings: all(null) });

describe('AS546 auction score v2', () => {
  it('AS546-1: word quality: a common word is 1, a 2-letter fragment at most 0.3 (0.75 on the curated list), a rare or unknown word low; the version is auction-v2', () => {
    expect(AUCTION_SCORE_VERSION).toBe('auction-v2');
    for (const w of ['cozy', 'fleece', 'kings', 'make', 'plastic', 'vet', 'day', 'reach']) expect(wordLevel(w)).toBe(1);
    expect(wordLevel('hq')).toBe(0.75);
    for (const w of ['ms', 'ne', 'id', 'pi']) expect(wordLevel(w)).toBeLessThanOrEqual(0.3);
    expect(wordLevel('qzxv')).toBeLessThan(0.1);
    expect(wordLevel('comp')).toBeLessThan(COMMON_LEVEL);
    expect(nameQuality(['cozy', 'fleece'])).toMatchObject({ quality: 1, allCommon: true });
    expect(nameQuality(['thru', 'ne']).allCommon).toBe(false);
    expect(nameQuality(['thru', 'ne']).quality).toBeLessThan(0.5);
  });

  it('AS546-2: real phrases rank above coined strings (cozyfleece, makeplastic, kingscapes, brooklynair, gymnest, vetday above thrune, foamira, idward, comphost, gatherms, laptopi, dnasays); a name with a word that is not common never scores above 50', () => {
    const s = Object.fromEntries(SAMPLE.map(([n, w]) => [n, typical(n, w)]));
    const real = ['cozyfleece', 'makeplastic', 'kingscapes', 'brooklynair', 'gymnest', 'vetday'];
    const coined = ['thrune', 'foamira', 'idward', 'comphost', 'gatherms', 'laptopi', 'dnasays'];
    expect(Math.min(...real.map((n) => s[n]!.score))).toBeGreaterThan(Math.max(...coined.map((n) => s[n]!.score)) + 15);
    for (const n of coined) { expect(s[n]!.score).toBeLessThanOrEqual(UNCOMMON_CAP); expect(s[n]!.parts.name.all_common).toBe(false); expect(s[n]!.reasons.join(' ')).toContain('capped'); }
    for (const n of real) expect(s[n]!.parts.name.all_common).toBe(true);
    // the cap grades too: the more coined the string, the lower
    expect(s.thrune!.score).toBeLessThan(s.comphost!.score);
    // a perfect name with a coined word is still held down even with every other part full
    expect(scoreAuction({ ...base, words: ['thru', 'ne'], letters: 6, price_cents: 100, bids: 50, domain_age: 20, endings: all(true) }).score).toBeLessThanOrEqual(UNCOMMON_CAP);
  });

  it('AS546-3: the scores spread: the sample runs from about 30 to 85 and real phrases are not all equal; a strong name (short, common words, bids, age, other endings registered) reaches the top of the scale', () => {
    const scores = SAMPLE.map(([n, w]) => typical(n, w).score);
    expect(Math.min(...scores)).toBeLessThan(40);
    expect(Math.max(...scores)).toBeGreaterThan(80);
    const real = ['cozyfleece', 'makeplastic', 'kingscapes', 'brooklynair', 'gymnest', 'vetday'].map((n) => typical(n, SAMPLE.find((x) => x[0] === n)![1]).score);
    expect(new Set(real).size).toBeGreaterThanOrEqual(5);
    expect(Math.max(...real) - Math.min(...real)).toBeGreaterThan(8);
    const strong = scoreAuction({ words: ['gym', 'nest'], letters: 7, price_cents: 1000, max_bid_cents: 16_000, bids: 20, domain_age: 12, pageviews: null, endings: { net: true, org: true, co: false, io: false, ai: false } });
    expect(strong.score).toBeGreaterThan(90);
  });

  it('AS546-4: SCORE_FULL_MAX is 85: only a strong name gets the full maximum bid; a typical real phrase gets 90-95% of it, an uncommon-word name at most 59%', () => {
    expect(SCORE_FULL_MAX).toBe(85);
    const full = maxBidRule({ capCents: 25_000, resaleCents: 100_000, commission: 0.2, saleChanceBp: 1000, renewalCents: 1100 });
    const bid = (n: string) => maxBidRule({ capCents: 25_000, resaleCents: 100_000, commission: 0.2, saleChanceBp: 1000, renewalCents: 1100, score: typical(n, SAMPLE.find((x) => x[0] === n)![1]).score });
    expect(bid('cozyfleece')).toBeLessThan(full);
    expect(bid('cozyfleece')).toBeGreaterThanOrEqual(full * 0.85);
    expect(bid('thrune')).toBeLessThanOrEqual(full * 0.59);
    expect(bid('thrune')).toBeLessThan(bid('makeplastic'));
  });
});

// ---- v5.47.0: auction-v3 ----
describe('LF547 auction-v3 (lift name part, bids worth 5)', () => {
  const lift = { sum: 1, score: 73.1, parts: [{ pattern: 'length' as const, bin: '8-9', lift: 1 }] };
  it('LF547-17: a lift score switches the version to auction-v3 and replaces the shape + endings part; word quality stays the gate', () => {
    const v2 = scoreAuction(base);
    const v3 = scoreAuction({ ...base, lift });
    expect(v2.version).toBe('auction-v2');
    expect(v3.version).toBe('auction-v3');
    expect(v3.parts.name.lift).toMatchObject({ sum: 1, score: 73.1 });
    expect(v3.parts.name.points).toBeCloseTo(60 * 1 * 0.731, 1); // both words common: quality 1
    const rare = scoreAuction({ ...base, words: ['cozy', 'zxqvk'], lift });
    expect(rare.parts.name.points).toBeLessThan(v3.parts.name.points);
    expect(rare.score).toBeLessThanOrEqual(UNCOMMON_CAP);
  });
  it('LF547-18 (F8): the bids part is worth 5 points in v3 and still 10 in v2; the suggested-maximum rule is unchanged', () => {
    expect(scoreAuction({ ...base, bids: 20 }).parts.bids.max).toBe(10);
    const v3 = scoreAuction({ ...base, bids: 20, lift });
    expect(v3.parts.bids).toMatchObject({ max: 5, points: 5 });
    expect(scoreAuction({ ...base, bids: 5, lift }).parts.bids.points).toBeCloseTo(5 * Math.log(6) / Math.log(21), 1);
    expect(maxBidRule({ capCents: 25_000, resaleCents: 100_000, commission: 0.2, saleChanceBp: 1000, renewalCents: 1100 })).toBe(maxBidRule({ capCents: 25_000, resaleCents: 100_000, commission: 0.2, saleChanceBp: 1000, renewalCents: 1100 }));
  });
});
