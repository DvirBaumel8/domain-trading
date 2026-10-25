// v5.45.0 (G-127): the auction score v1 and the maximum-bid rule. Pure functions; test ids AS545-1..4 (rules: docs/internal/auctions.md "Shortlist").
import { describe, expect, it } from 'vitest';
import { AUCTION_SCORE_VERSION, maxBidRule, scoreAuction, seoFlag, shapeValue, type ScoreInput } from '../../../../src/modules/ops/auctions/shortlist-score.js';

const base: ScoreInput = { words: 2, letters: 10, price_cents: 5000, max_bid_cents: 25_000, bids: 5, domain_age: 5, pageviews: null, endings: {} };
const all = (v: boolean | null) => ({ net: v, co: v, org: v, io: v, ai: v });

describe('AS545 auction score v1', () => {
  it('AS545-1: the shape cell: 1-2 words beat 3 words beat 4+, shorter beats longer, and the score is 0-100 with a stored version', () => {
    expect(shapeValue(2, 8)).toBeGreaterThan(shapeValue(2, 12));
    expect(shapeValue(2, 12)).toBeGreaterThan(shapeValue(2, 14));
    expect(shapeValue(2, 14)).toBeGreaterThan(shapeValue(2, 20));
    expect(shapeValue(1, 8)).toBe(shapeValue(2, 8));
    expect(shapeValue(2, 10)).toBeGreaterThan(shapeValue(3, 10));
    expect(shapeValue(3, 10)).toBeGreaterThan(shapeValue(4, 10));
    const hi = scoreAuction({ ...base, words: 2, letters: 7 });
    const lo = scoreAuction({ ...base, words: 4, letters: 18 });
    expect(hi.score).toBeGreaterThan(lo.score);
    for (const s of [hi, lo, scoreAuction({ ...base, price_cents: 0, bids: 500, domain_age: 40, endings: all(true) })]) { expect(s.score).toBeGreaterThanOrEqual(0); expect(s.score).toBeLessThanOrEqual(100); expect(s.version).toBe(AUCTION_SCORE_VERSION); }
  });

  it('AS545-2: other endings: registered ones raise the name part; unknown stays unknown (the part is rescaled, never counted as 0); a free ending lowers it against a registered one', () => {
    const unknown = scoreAuction({ ...base, endings: {} });
    expect(unknown.parts.name).toMatchObject({ endings_known: 0, endings_value: null, known: true });
    // the name part with no endings data is the shape alone, scaled to the full 60 points
    expect(unknown.parts.name.points).toBeCloseTo(60 * shapeValue(2, 10), 1);
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
    expect(scoreAuction({ ...base, price_cents: 1000 }).parts.headroom.points).toBeGreaterThan(scoreAuction({ ...base, price_cents: 20_000 }).parts.headroom.points);
    expect(scoreAuction({ ...base, price_cents: 25_000 }).parts.headroom.points).toBe(0);
    expect(Object.keys(base)).not.toContain('valuation_cents');
  });

  it('AS545-4: the maximum bid = min(S8 cap, 20% of the S8 ladder BIN less the commission), rounded down to $5, in integer cents', () => {
    expect(maxBidRule({ capCents: 25_000, resaleCents: 100_000, commission: 0.2 })).toBe(16_000); // 20% of $800 = $160 (base, no score)
    expect(maxBidRule({ capCents: 25_000, resaleCents: 100_000, commission: 0.2, score: 70 })).toBe(16_000); // full at 70
    expect(maxBidRule({ capCents: 25_000, resaleCents: 100_000, commission: 0.2, score: 95 })).toBe(16_000); // never above the base
    expect(maxBidRule({ capCents: 25_000, resaleCents: 100_000, commission: 0.2, score: 35 })).toBe(8_000); // half the score, half the maximum
    expect(maxBidRule({ capCents: 25_000, resaleCents: 100_000, commission: 0.2, score: 10 })).toBe(2_000); // $22.85 -> $20
    expect(maxBidRule({ capCents: 25_000, resaleCents: 488_800, commission: 0.2 })).toBe(25_000); // a high resale stops at the cap
    expect(maxBidRule({ capCents: 6_000, resaleCents: 100_000, commission: 0.2 })).toBe(6_000);
    expect(Number.isInteger(maxBidRule({ capCents: 25_000, resaleCents: 99_999, commission: 0.175, score: 41.3 }))).toBe(true);
  });
});
