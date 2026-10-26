// v5.49.0 (improvement pass 26 Oct, P2/P3): auction score v4, the free demand fields, short split pieces, empty lift bins. Pure. Test ids AS549-1..5
// (rules: docs/internal/auctions.md "Auction score v4"); the database tests are AS549-6..14.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { BIN_ORDER, NO_INPUT, PATTERNS, scoreLift, trainBins, type LiftBins } from '../../../../src/modules/engine/lift.js';
import { demandFields } from '../../../../src/modules/ops/jobs/datasave/auction-fields.js';
import { AUCTION_SCORE_VERSION_V4, demandValue, fieldPercentile, scoreAuction, WEIGHTS_V4, type ScoreInput } from '../../../../src/modules/ops/auctions/shortlist-score.js';
import { nameQuality, SHORT_WORDS, wordLevel } from '../../../../src/modules/ops/auctions/word-quality.js';

const lift = { sum: 1, score: 73.1, parts: [{ pattern: 'length' as const, bin: '10-11', lift: 0.5 }] };
const v4in = (o: Partial<NonNullable<ScoreInput['v4']>> = {}, extra: Partial<ScoreInput> = {}): ScoreInput => ({
  words: ['cozy', 'fleece'], letters: 10, price_cents: 100, max_bid_cents: 5500, bids: 1, domain_age: 5, pageviews: null, endings: {}, lift,
  v4: { name_pct: 0.9, field_n: 100, developed_tlds: 2, exact_match_tlds: 5, ...o }, ...extra,
});

describe('AS549 auction-v4 (pure)', () => {
  it('AS549-1: the demand fields of GoDaddy rows are read as integers (CPC in cents); missing, non-numeric, negative or past int4 is null, never 0', () => {
    const fx = JSON.parse(readFileSync('tests/fixtures/datasave/godaddy-demand-fields.sample.json', 'utf8')) as { data: Array<Record<string, unknown> & { domainName: string }>; expected: Record<string, unknown> };
    for (const r of fx.data) expect(demandFields(r as Parameters<typeof demandFields>[0]), r.domainName).toEqual(fx.expected[r.domainName]);
    expect(demandFields({ semrushCpc: Number.NaN, exactMatchTlds: Number.POSITIVE_INFINITY })).toEqual({ exact_match_tlds: null, developed_tlds: null, keyword_registrations: null, search_volume: null, cpc_cents: null });
  });

  it('AS549-2: v4 weights name 30 / demand 40 / age 25 / bids 5 (v5.51.0 backtest); headroom is not a part; the name part is the position in the field; the reason says where the name stands', () => {
    expect(WEIGHTS_V4).toEqual({ name: 30, bids: 5, age: 25, demand: 40 });
    const s = scoreAuction(v4in());
    expect(s.version).toBe(AUCTION_SCORE_VERSION_V4);
    expect(Object.keys(s.parts).sort()).toEqual(['age', 'bids', 'demand', 'name']);
    expect(s.parts.headroom).toBeUndefined();
    expect(s.parts.name).toMatchObject({ max: 30, points: 27, field_pct: 0.9 }); // 30 x 0.9
    expect(s.parts.demand).toMatchObject({ max: 40, known: true, developed_tlds: 2, exact_match_tlds: 5 });
    expect(s.reasons.join(' | ')).toContain("name in the top 10% of today's field");
    expect(s.reasons.join(' | ')).not.toContain('sold-like');
    // a $1 price and a $54 price score the same: headroom is a filter, not points
    expect(scoreAuction(v4in({}, { price_cents: 5400 })).score).toBe(scoreAuction(v4in({}, { price_cents: 100 })).score);
    // the position decides, not the raw value: the same name in a weaker field position scores lower
    expect(scoreAuction(v4in({ name_pct: 0.3 })).score).toBeLessThan(scoreAuction(v4in({ name_pct: 0.9 })).score);
    // without a field position (the pre-score) the raw quality x lift value is used and reported
    const pre = scoreAuction(v4in({ name_pct: null }));
    expect(pre.parts.name.field_pct).toBeNull();
    expect(pre.parts.name.raw).toBeCloseTo(0.731, 3);
    // without `v4` the older versions are untouched (auction-v3 keeps its headroom part)
    expect(scoreAuction({ ...v4in(), v4: undefined }).version).toBe('auction-v3');
    expect(scoreAuction({ ...v4in(), v4: undefined }).parts.headroom).toBeDefined();
  });

  it('AS549-3: demand = 0.6 x developed endings (0, 0.5, 1) + 0.4 x exact-match endings (log, 10+ full); one missing counts alone; both missing leaves the part out (rescaled like age); the field percentile is share below + half the ties', () => {
    expect(demandValue(0, 0)).toBe(0);
    expect(demandValue(1, 0)).toBeCloseTo(0.3, 6);
    expect(demandValue(2, 10)).toBe(1);
    expect(demandValue(9, 40)).toBe(1);
    expect(demandValue(0, 5)).toBeCloseTo(0.4 * (Math.log(6) / Math.log(11)), 6);
    expect(demandValue(1, null)).toBe(0.5);
    expect(demandValue(null, 10)).toBe(1);
    expect(demandValue(null, null)).toBeNull();
    const unknown = scoreAuction(v4in({ developed_tlds: null, exact_match_tlds: null }));
    expect(unknown.parts.demand).toMatchObject({ known: false, points: 0 });
    expect(unknown.reasons.join(' | ')).toContain('demand unknown');
    // rescaled out: unknown demand is not a penalty against a name with zero demand
    expect(unknown.score).toBeGreaterThan(scoreAuction(v4in({ developed_tlds: 0, exact_match_tlds: 0 })).score);
    expect(scoreAuction(v4in({ developed_tlds: 3, exact_match_tlds: 12 })).score).toBeGreaterThan(scoreAuction(v4in({ developed_tlds: 0, exact_match_tlds: 1 })).score);
    expect(fieldPercentile([], 1)).toBeNull();
    expect(fieldPercentile([1, 2, 3, 4], 5)).toBe(1);
    expect(fieldPercentile([1, 2, 3, 4], 0)).toBe(0);
    expect(fieldPercentile([1, 2, 2, 2, 5], 2)).toBeCloseTo((1 + 1.5) / 5, 6);
  });

  it('AS549-4: a piece of 3 letters or fewer that is not a short brand word counts at most 0.5; insare (ins + are) scores below vetday and gymnest; the short list is small and real words keep 1', () => {
    expect(SHORT_WORDS.size).toBeLessThanOrEqual(60);
    for (const w of SHORT_WORDS) expect(w.length).toBeLessThanOrEqual(3);
    for (const w of ['ins', 'are', 'ver']) expect(wordLevel(w)).toBeLessThanOrEqual(0.5);
    for (const w of ['vet', 'day', 'gym', 'pro', 'app', 'hub']) expect(wordLevel(w)).toBe(1);
    expect(wordLevel('nest')).toBe(1); // 4 letters: not a short piece
    const q = (w: string[]) => nameQuality(w).quality;
    expect(q(['ins', 'are'])).toBeLessThan(q(['vet', 'day']));
    expect(q(['ins', 'are'])).toBeLessThan(q(['gym', 'nest']));
    const score = (words: string[], letters: number) => scoreAuction({ words, letters, price_cents: 100, max_bid_cents: 5500, bids: 1, domain_age: 5, pageviews: null, endings: {} }).score;
    expect(score(['ins', 'are'], 6)).toBeLessThan(score(['vet', 'day'], 6));
    expect(score(['ins', 'are'], 6)).toBeLessThan(score(['gym', 'nest'], 7));
    expect(nameQuality(['ins', 'are']).allCommon).toBe(false);
  });

  it('AS549-5: lift with emptyBinZero: a bin with no row at all counts 0 (not the pattern lowest); a thin bin with some rows keeps the lowest; off by default', () => {
    const rows: LiftBins = trainBins([
      ...Array.from({ length: 30 }, () => ({ sold: true, weight: 1, input: { ...NO_INPUT, words: 2 } })),
      ...Array.from({ length: 10 }, () => ({ sold: false, weight: 1, input: { ...NO_INPUT, words: 2 } })),
      ...Array.from({ length: 10 }, () => ({ sold: true, weight: 1, input: { ...NO_INPUT, words: 3 } })),
      ...Array.from({ length: 30 }, () => ({ sold: false, weight: 1, input: { ...NO_INPUT, words: 3 } })),
      ...Array.from({ length: 2 }, () => ({ sold: true, weight: 1, input: { ...NO_INPUT, words: 4 } })), // thin, not empty
    ]);
    expect(PATTERNS).toContain('words'); expect(BIN_ORDER.words).toContain('1');
    const lowest = Math.min(rows.bins.words['2']!.lift, rows.bins.words['3']!.lift);
    expect(rows.bins.words['1']).toMatchObject({ sold: 0, unsold: 0, thin: true, lift: lowest });
    const one = { ...NO_INPUT, words: 1 };
    expect(scoreLift(rows, one).sum).toBe(lowest); // today's rule
    expect(scoreLift(rows, one, { emptyBinZero: true }).sum).toBe(0); // v4: outside the seed's range
    const four = { ...NO_INPUT, words: 4 };
    expect(scoreLift(rows, four, { emptyBinZero: true }).sum).toBe(lowest); // some rows: the thin rule stays
    expect(scoreLift(rows, { ...NO_INPUT, words: 2 }, { emptyBinZero: true }).sum).toBe(rows.bins.words['2']!.lift);
  });
});

describe('AS557 auction-v4 without word quality (v5.57.0)', () => {
  const v4 = { name_pct: null, field_n: null, developed_tlds: null, exact_match_tlds: null };
  const lift = { sum: 1, score: 73.1, parts: [{ pattern: 'length' as const, bin: '8-9', lift: 1 }] };
  const base = { letters: 8, price_cents: 1000, max_bid_cents: 6500, bids: 3, domain_age: 12, pageviews: null, endings: {}, lift };
  it('AS557-1: in v4 the name raw value is the lift alone and an uncommon word neither lowers it nor caps the score; v3 still applies both', () => {
    const common = scoreAuction({ ...base, words: ['gym', 'nest'], v4 });
    const coined = scoreAuction({ ...base, words: ['ghostry'], v4 });
    expect(coined.parts.name.raw).toBe(common.parts.name.raw);
    expect(coined.score).toBeGreaterThan(50);
    expect(coined.reasons.join(' ')).not.toContain('capped');
    const v3 = scoreAuction({ ...base, words: ['ghostry'] });
    expect(v3.score).toBeLessThanOrEqual(50);
  });
});
