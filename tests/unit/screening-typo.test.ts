// TYPO-1 building blocks (CAP-02): the banded Damerau distance and the popularity CSV parser. Pure.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { editDistanceWithin, parsePopularityCsv, PopularityListError } from '../../src/screening/tranco.js';

const csv = readFileSync(new URL('../fixtures/screening/majestic-million-top.csv', import.meta.url), 'utf8');

describe('editDistanceWithin (optimal string alignment)', () => {
  it('counts substitution, insertion, deletion and adjacent transposition as one', () => {
    expect(editDistanceWithin('google', 'google', 1)).toBe(0);
    expect(editDistanceWithin('gooogle', 'google', 1)).toBe(1);
    expect(editDistanceWithin('amazn', 'amazon', 1)).toBe(1);
    expect(editDistanceWithin('gogole', 'google', 1)).toBe(1); // transposition
    expect(editDistanceWithin('goigle', 'google', 1)).toBe(1);
  });
  it('is null above the maximum, and exits early on a length gap', () => {
    expect(editDistanceWithin('gogle', 'google', 0)).toBeNull();
    expect(editDistanceWithin('goggle', 'amazon', 1)).toBeNull();
    expect(editDistanceWithin('abc', 'abcdef', 2)).toBeNull();
    expect(editDistanceWithin('abc', 'abcde', 2)).toBe(2);
    expect(editDistanceWithin('wikipedai', 'wikipedia', 1)).toBe(1);
  });
});

describe('parsePopularityCsv', () => {
  it('reads the recorded Majestic fixture: 1,000 rows, rank and domain', () => {
    const { rows } = parsePopularityCsv(csv, 10_000);
    expect(rows).toHaveLength(1000);
    expect(rows[0]).toEqual({ rank: 1, domain: 'google.com' });
    expect(parsePopularityCsv(csv, 150).rows).toHaveLength(150);
  });
  it('refuses a body that is not that CSV (header, row shape, too few rows)', () => {
    expect(() => parsePopularityCsv('<html>blocked</html>', 100)).toThrow(PopularityListError);
    expect(() => parsePopularityCsv('', 100)).toThrow(/GlobalRank/);
    expect(() => parsePopularityCsv('GlobalRank,TldRank,Domain\nx,1,google.com', 100)).toThrow(/malformed/);
    expect(() => parsePopularityCsv('GlobalRank,TldRank,Domain\n1,1,google.com', 100)).toThrow(/only 1 rows/);
  });
});
