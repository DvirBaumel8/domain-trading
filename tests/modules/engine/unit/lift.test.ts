// v5.47.0 (F5): the lift model maths (pure). Test ids LF547-1..10. Rules: docs/internal/engine.md "Lift model".
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  binOf, crossValidatedAuc, inHoldout, LIFT_CAP, LIFT_MIN_BIN_ROWS, LIFT_MIN_OWN_PER_CLASS, liftOfCounts, logistic100, NO_INPUT, parseSeed, scoreLift, seedWeight, trainBins, type LabelledInput, type LiftInput,
} from '../../../../src/modules/engine/lift.js';
import { liftInputFor, loadLiftSeed, seedCrossValidatedAuc, trainLift } from '../../../../src/modules/engine/lift-train.js';

const row = (sold: boolean, i: Partial<LiftInput>, weight = 1): LabelledInput => ({ sold, weight, input: { ...NO_INPUT, ...i } });

describe('LF547 lift model (pure)', () => {
  it('LF547-1 bins: length, words, endings, share and past-site bands; null is not a bin', () => {
    expect(['length'].map((p) => [7, 8, 9, 10, 11, 12, 13, 14, 30].map((l) => binOf(p as 'length', { ...NO_INPUT, len: l })))[0]).toEqual(['<=7', '8-9', '8-9', '10-11', '10-11', '12-13', '12-13', '14+', '14+']);
    expect([1, 2, 3, 4, 5].map((w) => binOf('words', { ...NO_INPUT, words: w }))).toEqual(['1', '2', '3', '4+', '4+']);
    expect([0, 1, 2, 5].map((n) => binOf('endings_before', { ...NO_INPUT, endings_before: n }))).toEqual(['0', '1', '2+', '2+']);
    expect([0, 0.24, 0.25, 0.5, 0.75, 1].map((s) => binOf('registered_share', { ...NO_INPUT, registered_share: s }))).toEqual(['<0.25', '<0.25', '0.25-0.5', '0.5-0.75', '>=0.75', '>=0.75']);
    expect([true, false, null].map((h) => binOf('past_site', { ...NO_INPUT, past_site: h }))).toEqual(['yes', 'no', null]);
    expect(binOf('length', NO_INPUT)).toBeNull();
  });

  it('LF547-2 the math on a tiny fixture: lift = ln(((s+1)/(S+2)) / ((u+1)/(U+2))) with S and U the rows that have the pattern', () => {
    // words: sold 6 x "2", 2 x "3"; unsold 2 x "2", 6 x "3"
    const many = (n: number, sold: boolean, words: number) => Array.from({ length: n }, () => row(sold, { words }));
    const t = trainBins([...many(6, true, 2), ...many(2, true, 3), ...many(2, false, 2), ...many(6, false, 3)]);
    expect(t.totals.words).toEqual({ sold: 8, unsold: 8 });
    expect(t.bins.words['2']).toEqual({ sold: 6, unsold: 2, lift: Math.round(Math.log((7 / 10) / (3 / 10)) * 1000) / 1000 });
    expect(t.bins.words['3']!.lift).toBeCloseTo(Math.log((3 / 10) / (7 / 10)), 3);
    expect(t.bins.words['2']!.lift).toBeCloseTo(0.847, 3);
    // the score is the sum of the lifts of the bins the name has
    const s = scoreLift(t, { ...NO_INPUT, words: 2 });
    expect(s.parts).toEqual([{ pattern: 'words', bin: '2', lift: t.bins.words['2']!.lift }]);
    expect(s.sum).toBe(t.bins.words['2']!.lift);
  });

  it('LF547-3 smoothing: an empty bin has lift 0 when the classes are as big, one row does not reach the cap, equal shares give 0', () => {
    expect(liftOfCounts(0, 0, 10, 10)).toBe(0);
    expect(liftOfCounts(5, 5, 10, 10)).toBe(0);
    const one = liftOfCounts(1, 0, 100, 100);
    expect(one).toBeCloseTo(Math.log((2 / 102) / (1 / 102)), 6); // ln 2, far below the cap
    expect(one).toBeLessThan(LIFT_CAP);
    const t = trainBins([row(true, { len: 9 }), row(false, { len: 20 })]);
    expect(t.bins.length['10-11']).toEqual({ sold: 0, unsold: 0, lift: 0, thin: true }); // listed, empty; nothing thick to take a floor from: 0
    // classes of different size: an empty bin must NOT get ln((U+2)/(S+2)) from the smoothing; a bin under the minimum rows says nothing
    const big = trainBins([...Array.from({ length: 50 }, () => row(true, { words: 2 })), ...Array.from({ length: 5000 }, () => row(false, { words: 2 })), row(true, { words: 4 }), row(true, { words: 4 })]);
    // 2 is the only bin with enough rows; 50 sold of 52 against 5000 of 5000: its lift is negative, and every thin bin takes that lowest lift (not a lift made of the smoothing)
    expect(big.bins.words['2']!.lift).toBeLessThan(0);
    expect(big.bins.words['3']).toEqual({ sold: 0, unsold: 0, lift: big.bins.words['2']!.lift, thin: true });
    expect(big.bins.words['4+']).toEqual({ sold: 2, unsold: 0, lift: big.bins.words['2']!.lift, thin: true }); // 2 rows < LIFT_MIN_BIN_ROWS
    expect(LIFT_MIN_BIN_ROWS).toBe(5);
  });

  it('LF547-4 the cap: a bin that only one class has stays within +-2', () => {
    expect(liftOfCounts(500, 0, 500, 500)).toBe(LIFT_CAP);
    expect(liftOfCounts(0, 500, 500, 500)).toBe(-LIFT_CAP);
    const t = trainBins([...Array(300).fill(0).map(() => row(true, { endings_before: 3 })), ...Array(300).fill(0).map(() => row(false, { endings_before: 0 }))]);
    expect(t.bins.endings_before['2+']!.lift).toBe(LIFT_CAP);
    expect(t.bins.endings_before['0']!.lift).toBe(-LIFT_CAP);
  });

  it('LF547-5 unknown: a missing pattern adds nothing, "0 endings registered" is a bin of its own, an unknown share is skipped', () => {
    const t = trainBins([row(true, { endings_before: 0, len: 9 }), row(true, { endings_before: 2, len: 9 }), row(false, { endings_before: 0, len: 9 }), row(false, { len: 9 })]);
    expect(t.totals.endings_before).toEqual({ sold: 2, unsold: 1 }); // the 4th row has no endings pattern
    expect(t.totals.length).toEqual({ sold: 2, unsold: 2 });
    const zero = scoreLift(t, { ...NO_INPUT, endings_before: 0 });
    expect(zero.parts).toHaveLength(1);
    expect(zero.parts[0]).toMatchObject({ pattern: 'endings_before', bin: '0' });
    const unknown = scoreLift(t, NO_INPUT);
    expect(unknown).toEqual({ sum: 0, score: 50, parts: [] });
    // a bin that was never trained is 0, not an error
    expect(scoreLift({ ...t, bins: { ...t.bins, words: {} as never } }, { ...NO_INPUT, words: 2 }).sum).toBe(0);
  });

  it('LF547-6 the score is the logistic of the sum, 0..100, 50 at 0', () => {
    expect(logistic100(0)).toBe(50);
    expect(logistic100(2)).toBeCloseTo(88.1, 1);
    expect(logistic100(-2)).toBeCloseTo(11.9, 1);
    expect(logistic100(20)).toBeLessThanOrEqual(100);
    expect(logistic100(-20)).toBeGreaterThanOrEqual(0);
  });

  it('LF547-7 the CR-002 seed reproduces the backtest: 5-fold cross-validated AUC about 0.78-0.80 on 767 sold and 988 dropped names', () => {
    const seed = loadLiftSeed()!;
    expect(seed).not.toBeNull();
    expect(seed.rows).toHaveLength(1755);
    expect(seed.rows.filter((r) => r.label === 'sold')).toHaveLength(767);
    const a = seedCrossValidatedAuc(seed.rows)!;
    expect(a).toBeGreaterThan(0.76);
    expect(a).toBeLessThan(0.82);
    // the file is the frozen copy of docs/requests/CR-002-reference/features.csv (columns kept as given, empty = null)
    const first = parseSeed(readFileSync('data/lift-seed/cr002.jsonl', 'utf8'))[0]!;
    expect(first).toEqual({ label: 'sold', len: 9, words: 2, endings_before: 0, registered_share: 0.65, past_site: true });
  });

  it('LF547-8 seed weight: 1 below the minimum own rows per class, then a straight fall to 0; the holdout is a stable 20% by key', () => {
    expect(seedWeight(0)).toBe(1);
    expect(seedWeight(LIFT_MIN_OWN_PER_CLASS - 1)).toBe(1);
    expect(seedWeight(LIFT_MIN_OWN_PER_CLASS)).toBe(1);
    expect(seedWeight(525)).toBeCloseTo(0.5, 6);
    expect(seedWeight(1000)).toBe(0);
    expect(seedWeight(5000)).toBe(0);
    const keys = Array.from({ length: 5000 }, (_, i) => `name${i}.com|2026-10-${(i % 28) + 1}`);
    const held = keys.filter(inHoldout).length;
    expect(held).toBeGreaterThan(900); expect(held).toBeLessThan(1100);
    expect(keys.filter(inHoldout)).toEqual(keys.filter(inHoldout));
  });

  it('LF547-9 trainLift: seed alone below 50 own rows per class; a blend above it with the seed weight falling; nothing without both', () => {
    const seed = loadLiftSeed()!.rows;
    const own = (sold: number, unsold: number) => [
      ...Array.from({ length: sold }, (_, i) => ({ key: `s${i}|d`, sold: true, input: { ...NO_INPUT, len: 9, words: 2, endings_before: 1, registered_share: 0.8 } })),
      ...Array.from({ length: unsold }, (_, i) => ({ key: `u${i}|d`, sold: false, input: { ...NO_INPUT, len: 15, words: 3, endings_before: 0, registered_share: 0.1 } })),
    ];
    const few = trainLift(own(49, 5000), seed)!;
    expect(few).toMatchObject({ source: 'seed', seed_weight: 1, own_sold: 49, own_unsold: 5000 });
    expect(few.auc).toBeGreaterThan(0.7);
    const some = trainLift(own(100, 100), seed)!;
    expect(some.source).toBe('blend');
    expect(some.seed_weight).toBeCloseTo(1 - 50 / 950, 6);
    const seedSoldWithWords = seed.filter((r) => r.label === 'sold' && r.words !== null).length;
    expect(some.bins.totals.words.sold).toBeCloseTo(100 + some.seed_weight * seedSoldWithWords, 2); // counts are weighted: our rows 1, the seed's rows by the seed weight
    const lots = trainLift(own(1000, 1000), seed)!;
    expect(lots.seed_weight).toBe(0);
    expect(lots.bins.totals.words).toEqual({ sold: 1000, unsold: 1000 }); // the seed has no weight left: our own rows alone
    // our own rows alone are perfectly separable here: holdout AUC 1
    expect(lots.auc).toBe(1);
    expect(trainLift(own(10, 10), null)).toBeNull();
    expect(trainLift(own(60, 60), null)!).toMatchObject({ source: 'blend', seed_weight: 0 });
  });

  it('LF547-10 inputs of a name: endings registered before the as_of day (a registered ending without a date is not placed), share of the asked endings registered', () => {
    const asOf = Date.parse('2026-06-01T00:00:00Z');
    const before = Date.parse('2020-01-01T00:00:00Z'); const after = Date.parse('2026-09-01T00:00:00Z');
    expect(liftInputFor('abcdef', 2, { net: { registered: true, createdMs: before }, org: { registered: true, createdMs: after }, io: { registered: false, createdMs: null }, co: { registered: true, createdMs: null } }, asOf))
      .toEqual({ len: 6, words: 2, endings_before: 1, registered_share: 3 / 4, past_site: null });
    expect(liftInputFor('abcdef', 2, undefined, asOf)).toEqual({ len: 6, words: 2, endings_before: null, registered_share: null, past_site: null });
    expect(liftInputFor('abcdef', 2, { net: { registered: null, createdMs: null } }, asOf).registered_share).toBeNull();
    // cross-validation is deterministic
    const rows = Array.from({ length: 60 }, (_, i) => ({ key: `k${i}`, sold: i % 2 === 0, input: { ...NO_INPUT, len: i % 2 === 0 ? 8 : 16 } }));
    expect(crossValidatedAuc(rows)).toBe(crossValidatedAuc(rows));
  });
});
