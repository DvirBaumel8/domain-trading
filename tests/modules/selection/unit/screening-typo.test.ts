// TYPO-1 building blocks (CAP-02): the banded Damerau distance and the popularity CSV parser. Pure.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { editDistanceWithin, parsePopularityCsv, PopularityListError, registrableLabel } from '../../../../src/modules/selection/popularity.js';

const csv = readFileSync(new URL('../../../fixtures/screening/majestic-million-top.csv', import.meta.url), 'utf8');

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
    expect(rows[0]).toEqual({ rank: 1, domain: 'google.com', tld: 'com' });
    expect(parsePopularityCsv(csv, 150).rows).toHaveLength(150);
  });
  it('refuses a body that is not that CSV (header, row shape, too few rows)', () => {
    expect(() => parsePopularityCsv('<html>blocked</html>', 100)).toThrow(PopularityListError);
    expect(() => parsePopularityCsv('', 100)).toThrow(/GlobalRank/);
    expect(() => parsePopularityCsv(`GlobalRank,TldRank,Domain\nx,1,google.com\n${Array.from({ length: 150 }, (_, i) => `${i + 2},1,site${i}.com`).join('\n')}`, 1000).rows).not.toThrow(); // 1 of 151 is under the 1% cap
    expect(() => parsePopularityCsv(`GlobalRank,TldRank,Domain\nx,1,a.com\ny,1,b.com\n${Array.from({ length: 150 }, (_, i) => `${i + 2},1,site${i}.com`).join('\n')}`, 1000)).toThrow(/malformed rows/);
    expect(() => parsePopularityCsv('GlobalRank,TldRank,Domain\n1,1,google.com', 100)).toThrow(/only 1 rows/);
  });
});

describe('parsePopularityCsv malformed rows', () => {
  it('skips a few bad rows (counted) and fails above 1%', () => {
    const good = Array.from({ length: 300 }, (_, i) => `${i + 2},1,site${i}.com,com`).join('\n');
    const r = parsePopularityCsv(`GlobalRank,TldRank,Domain,TLD\n1,1,bad domain!,com\n${good}`, 1000);
    expect(r).toMatchObject({ skipped: 1 });
    expect(r.rows).toHaveLength(300);
  });
});

describe('registrableLabel (the label left of the public suffix)', () => {
  it('uses the label just left of the suffix, not the host', () => {
    expect(registrableLabel('google.com', 'com')).toBe('google');
    expect(registrableLabel('play.google.com', 'com')).toBe('google');
    expect(registrableLabel('en.wikipedia.org', 'org')).toBe('wikipedia');
    expect(registrableLabel('en.wikipedia.org', null)).toBe('wikipedia');
  });
  it('handles the ccSLD set (co.uk, com.au, co.jp, gov.uk, gov.cn, com.br, co.in, org.uk, ac.uk, net.au)', () => {
    expect(registrableLabel('bbc.co.uk', 'uk')).toBe('bbc');
    expect(registrableLabel('news.bbc.co.uk', 'uk')).toBe('bbc');
    expect(registrableLabel('abc.net.au', 'au')).toBe('abc');
    expect(registrableLabel('ox.ac.uk', 'uk')).toBe('ox');
    expect(registrableLabel('rakuten.co.jp', null)).toBe('rakuten');
    expect(registrableLabel('uol.com.br', 'br')).toBe('uol');
    expect(registrableLabel('nic.gov.cn', 'cn')).toBe('nic');
    expect(registrableLabel('tata.co.in', 'in')).toBe('tata');
    expect(registrableLabel('charity.org.uk', 'uk')).toBe('charity');
  });
  it('www.gov.uk: gov.uk is the suffix and `www` is a host label, so it names no registrable site; a bare suffix gives nothing', () => {
    expect(registrableLabel('www.gov.uk', 'uk')).toBeNull();
    expect(registrableLabel('gov.uk', 'uk')).toBeNull();
    expect(registrableLabel('www.example.com', 'com')).toBe('example');
  });
});
