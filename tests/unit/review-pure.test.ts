// v2.10.0 (CR-011 part B): the pure parts of the review feature (line diff, novelty words).
import { describe, expect, it } from 'vitest';
import { unifiedDiff } from '../../src/services/review/diff.js';
import { jaccard, noveltyTokens, REPEAT_JACCARD } from '../../src/services/review/novelty.js';
import { stripWalkaway } from '../../src/services/review/packet.js';

describe('unified diff', () => {
  it('equal texts give an empty diff', () => {
    expect(unifiedDiff('a\nb', 'a\nb', 'v1', 'v2')).toBe('');
  });
  it('a changed line shows as - and +, with the header and a hunk', () => {
    const d = unifiedDiff('one\ntwo\nthree\n', 'one\n2\nthree\n', 'v1', 'v2');
    expect(d).toContain('--- v1\n+++ v2\n@@ ');
    expect(d).toContain('-two\n+2\n');
    expect(d).toContain(' one\n');
  });
  it('added and removed lines, and far-apart changes become separate hunks', () => {
    const a = Array.from({ length: 30 }, (_, i) => `line ${i}`).join('\n');
    const b = a.replace('line 2\n', '').replace('line 27', 'line 27 changed');
    const d = unifiedDiff(a, b, 'v1', 'v2');
    expect(d.match(/^@@ /gm)).toHaveLength(2);
    expect(d).toContain('-line 2\n');
    expect(d).toContain('+line 27 changed\n');
    expect(d).not.toContain('line 15');
  });
});

describe('novelty words', () => {
  it('lower-cases, keeps letters and digits, drops stop words and words under 3 chars', () => {
    expect([...noveltyTokens('The Price is $1,488 and we go to AB!')].sort()).toEqual(['1488', 'price']);
  });
  it('Jaccard: identical 1, disjoint 0, empty 0; the threshold is 0.6', () => {
    expect(jaccard(new Set(['a', 'b']), new Set(['a', 'b']))).toBe(1);
    expect(jaccard(new Set(['a']), new Set(['b']))).toBe(0);
    expect(jaccard(new Set(), new Set())).toBe(0);
    expect(REPEAT_JACCARD).toBe(0.6);
  });
});

describe('walk-away stripping', () => {
  it('removes every field named like a walk-away at any depth', () => {
    expect(stripWalkaway({ a: 1, walkaway_cents: 2, n: [{ walkaway: 1, x: 2, Walk_Away_usd: 3 }] })).toEqual({ a: 1, n: [{ x: 2 }] });
  });
});
