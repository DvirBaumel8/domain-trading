// CAP-11 parser. The sample is SYNTHETIC (NameBio is disabled and its real header could not be read: docs/internal/sources.md).
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseRetailStats, refreshNameBio } from '../../src/screening/namebio.js';
import { DEFAULT_SELECTION_VALUES } from '../../src/screening/settings.js';

const csv = readFileSync(new URL('../fixtures/screening/namebio/retailstats-sample.csv', import.meta.url), 'utf8');

describe('parseRetailStats', () => {
  it('reads keyword counts; an empty price is left out', () => {
    const m = parseRetailStats(csv);
    expect(m.size).toBe(5);
    expect(m.get('plumbing')).toEqual({ keyword: 'plumbing', start_count: 73, end_count: 22, exact_count: 4, avg_price_cents: 145000 });
    expect(m.get('solar')?.avg_price_cents).toBeNull();
  });
  it('a changed header throws (a refresh must stop, never guess columns)', () => {
    expect(() => parseRetailStats('word,starts,ends\nplumbing,1,2')).toThrow(/lacks required column/);
    expect(() => parseRetailStats('')).toThrow(/lacks required column/);
  });
  it('the refresh is a disabled stub: it never fetches', async () => {
    const boom = (() => { throw new Error('network'); }) as never;
    expect(await refreshNameBio(undefined as never, { fetch: boom } as never, DEFAULT_SELECTION_VALUES)).toEqual({ skipped: true, reason: 'SOURCE_DISABLED' });
    const on = { ...DEFAULT_SELECTION_VALUES, sources: { ...DEFAULT_SELECTION_VALUES.sources, namebio: true } };
    expect(await refreshNameBio(undefined as never, { fetch: boom } as never, on)).toEqual({ skipped: true, reason: 'NO_FETCHER' });
  });
});
