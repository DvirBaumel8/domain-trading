import { describe, expect, it } from 'vitest';
import { SlidingWindowLimiter } from '../../src/http/rate-limit.js';

describe('SlidingWindowLimiter', () => {
  it('allows `limit` hits per window, then reports the wait', () => {
    let t = 1_000_000;
    const l = new SlidingWindowLimiter(3, 60_000, () => t);
    expect([l.take('a'), l.take('a'), l.take('a')]).toEqual([0, 0, 0]);
    expect(l.take('a')).toBe(60_000);
    t += 30_000;
    expect(l.take('a')).toBe(30_000);
    t += 30_000;
    expect(l.take('a')).toBe(0); // first hit fell out of the window
  });

  it('keys are independent', () => {
    const l = new SlidingWindowLimiter(1, 60_000, () => 0);
    expect(l.take('a')).toBe(0);
    expect(l.take('b')).toBe(0);
    expect(l.take('a')).toBeGreaterThan(0);
  });
});
