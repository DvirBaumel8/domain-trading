import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { msUntilNextUtc, scheduleDailyUtc } from '../../src/jobs/daily-timer.js';

const at = (iso: string) => Date.parse(iso);

describe('msUntilNextUtc', () => {
  it('1 s before the boundary', () => expect(msUntilNextUtc(at('2026-10-05T00:29:59Z'), 0, 30)).toBe(1000));
  it('exactly at the boundary waits 24 h', () => expect(msUntilNextUtc(at('2026-10-05T00:30:00Z'), 0, 30)).toBe(86_400_000));
  it('23:00Z -> 1 h 30 m', () => expect(msUntilNextUtc(at('2026-10-05T23:00:00Z'), 0, 30)).toBe(5_400_000));
  it('across a month end', () => expect(msUntilNextUtc(at('2026-10-31T23:30:00Z'), 0, 30)).toBe(3_600_000));
});

describe('scheduleDailyUtc', () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(at('2026-10-05T00:29:59Z')); });
  afterEach(() => vi.useRealTimers());

  it('fires at the boundary, then 24 h later', async () => {
    const fn = vi.fn().mockResolvedValue(undefined);
    scheduleDailyUtc(fn, 0, 30);
    await vi.advanceTimersByTimeAsync(999);
    expect(fn).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(fn).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(86_400_000);
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('stop cancels', async () => {
    const fn = vi.fn().mockResolvedValue(undefined);
    const stop = scheduleDailyUtc(fn, 0, 30);
    stop();
    await vi.advanceTimersByTimeAsync(2 * 86_400_000);
    expect(fn).not.toHaveBeenCalled();
  });

  it('a rejected fn does not stop the chain', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('boom'));
    scheduleDailyUtc(fn, 0, 30);
    await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(86_400_000);
    expect(fn).toHaveBeenCalledTimes(2);
  });
});
