// v4.2.0 (CR-044 item 3, CR-046 item 2): the pure parts of the keyword upload and the Companies House match. The fixture is a copy of the real
// Keyword Planner export (UTF-16LE with a BOM, tab-separated, Hebrew preamble).
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { decodeKeywordFile, keywordCandidates, parseKeywordExport } from '../../../../src/modules/selection/demand.js';
import { companyMatches, titleMatches } from '../../../../src/modules/selection/checks/companies.js';

const real = readFileSync(new URL('../../../fixtures/keywords/keyword-planner-stats-2026-10-13.csv', import.meta.url));
const HEAD = ['Keyword', 'Currency', 'Segmentation', 'Avg. monthly searches', 'Three month change', 'YoY change', 'Competition', 'Competition (indexed value)'];
const utf16 = (s: string, bom = true) => Buffer.concat([bom ? Buffer.from([0xff, 0xfe]) : Buffer.alloc(0), Buffer.from(s, 'utf16le')]);
const sheet = (rows: string[][], head = HEAD) => ['Keyword Stats', '1 Sep 2025 - 31 Aug 2026', head.join('\t'), ...rows.map((r) => r.join('\t'))].join('\n');
const code = (f: () => unknown) => { try { f(); } catch (e) { return e as { code: string; details: { missing_headers?: string[] } }; } return null; };

describe('KW-1 parseKeywordExport on the real export', () => {
  it('reads UTF-16LE with a BOM: preamble lines, 10 keywords, 2 segmentation rows skipped, values by header name', () => {
    expect(real[0]).toBe(0xff);
    const p = parseKeywordExport(real);
    expect(p.title_line).toBe('Keyword Stats 2026-10-13 at 20_38_51');
    expect(p.date_range_line).toBe('1 בספטמבר 2025 - 31 באוגוסט 2026');
    expect(p.skipped_n).toBe(2);
    expect(p.rows).toHaveLength(10);
    const by = (k: string) => p.rows.find((r) => r.keyword === k)!;
    expect(by('cbam compliance')).toEqual({ keyword: 'cbam compliance', avg_monthly_searches: 50, competition_index: 47, three_month_change: '0%', yoy_change: '0%' });
    expect(by('drs compliance')).toMatchObject({ avg_monthly_searches: 50, competition_index: 0 });
    expect(by('ets2 compliance')).toEqual({ keyword: 'ets2 compliance', avg_monthly_searches: null, competition_index: null, three_month_change: null, yoy_change: null });
  });
});

describe('KW-2 decoding and header handling', () => {
  it('UTF-8 (with and without a BOM), UTF-16LE without a BOM and UTF-16BE all read the same rows', () => {
    const text = sheet([['seo audit', 'USD', '', '1,200', '10%', '5%', 'High', '88']]);
    const want = { keyword: 'seo audit', avg_monthly_searches: 1200, competition_index: 88, three_month_change: '10%', yoy_change: '5%' };
    expect(parseKeywordExport(Buffer.from(text, 'utf8')).rows).toEqual([want]);
    expect(parseKeywordExport(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(text, 'utf8')])).rows).toEqual([want]);
    expect(parseKeywordExport(utf16(text, false)).rows).toEqual([want]);
    expect(parseKeywordExport(Buffer.concat([Buffer.from([0xfe, 0xff]), Buffer.from(utf16(text, false)).swap16()])).rows).toEqual([want]);
    expect(decodeKeywordFile(utf16('a\tb'))).toBe('a\tb');
  });

  it('columns are found by name in any order; the localized Competition text and extra columns are ignored; CRLF is read', () => {
    const head = ['Competition (indexed value)', 'Extra', 'Avg. monthly searches', 'Competition', 'Keyword'];
    const p = parseKeywordExport(utf16(['Title', 'Range', head.join('\t'), '55\tx\t300\tגבוהה\t Roof  Drone '].join('\r\n')));
    expect(p.rows).toEqual([{ keyword: 'roof drone', avg_monthly_searches: 300, competition_index: 55, three_month_change: null, yoy_change: null }]);
  });

  it('empty numbers are null; a competition above 100 or text is null; a repeated keyword keeps the first; blank lines are ignored', () => {
    const p = parseKeywordExport(utf16(sheet([['a b', '', '', '', '', '', '', ''], ['c d', '', '', '10-100', '', '', '', '150'], ['a b', '', '', '99', '', '', '', '1'], ['']])));
    expect(p.rows).toEqual([
      { keyword: 'a b', avg_monthly_searches: null, competition_index: null, three_month_change: null, yoy_change: null },
      { keyword: 'c d', avg_monthly_searches: null, competition_index: null, three_month_change: null, yoy_change: null },
    ]);
    expect(p.skipped_n).toBe(1);
  });

  it('a missing required header is KEYWORD_CSV_INVALID with the missing names; no header row, an empty file and no keyword rows too', () => {
    const e = code(() => parseKeywordExport(utf16(sheet([['a b', 'USD', '', '1', '', '', '', '1']], ['Keyword', 'Currency', 'Segmentation', 'Three month change']))));
    expect(e).toMatchObject({ code: 'KEYWORD_CSV_INVALID', details: { missing_headers: ['Avg. monthly searches', 'Competition (indexed value)'] } });
    expect(code(() => parseKeywordExport(Buffer.from('nothing here\nat all')))).toMatchObject({ code: 'KEYWORD_CSV_INVALID', details: { missing_headers: ['Keyword', 'Avg. monthly searches', 'Competition (indexed value)'] } });
    expect(code(() => parseKeywordExport(Buffer.alloc(0)))?.code).toBe('KEYWORD_CSV_INVALID');
    expect(code(() => parseKeywordExport(utf16(sheet([['', 'USD', 'All', '100', '', '', '', '']]))))).toMatchObject({ code: 'KEYWORD_CSV_INVALID', details: { missing_headers: [] } });
  });

  it('keywordCandidates: split tokens first, then the scout words, no duplicates of empty strings', () => {
    expect(keywordCandidates(['Roofing', 'Voice', 'Agent'], ['roofing', 'voiceagent'])).toEqual(['roofing voice agent', 'roofing voiceagent']);
    expect(keywordCandidates(['a'], null)).toEqual(['a']);
  });
});

describe('CH-1 Companies House title match', () => {
  it('a company matches when its title contains every token as a whole word, case-insensitively', () => {
    expect(titleMatches('ROOFING VOICE AGENT LTD', ['roofing', 'voice', 'agent'])).toBe(true);
    expect(titleMatches('Agent Voice & Roofing Limited', ['roofing', 'voice', 'agent'])).toBe(true);
    expect(titleMatches('Roofing Voices Agent Ltd', ['roofing', 'voice', 'agent'])).toBe(false); // voices is not voice
    expect(titleMatches('Reroofing Voice Agent', ['roofing', 'voice'])).toBe(false);
    expect(titleMatches('Anything', [])).toBe(false);
    expect(titleMatches('A+B (UK) LTD', ['a+b'])).toBe(true); // regex characters in a token are literal
  });

  it('keeps title, number and status only; active first; at most five; the count is all matches', () => {
    const items = [
      ...Array.from({ length: 4 }, (_, i) => ({ title: `Roof Drone ${i} Ltd`, company_number: `0000000${i}`, company_status: 'dissolved', address_snippet: 'x', officers: ['y'] })),
      { title: 'Roof Drone Co', company_number: '123', company_status: 'active', address: { line: 'z' } },
      { title: 'Roof Drone Plc', company_number: '124', company_status: 'active' },
      { title: 'Other Co', company_number: '9', company_status: 'active' },
      { title: 'Roof Drone Odd', company_number: 5 },
    ];
    const m = companyMatches(items, ['roof', 'drone']);
    expect(m.n).toBe(7);
    expect(m.items).toHaveLength(5);
    expect(m.items.slice(0, 2).map((x) => x.company_number)).toEqual(['123', '124']);
    expect(Object.keys(m.items[0]!).sort()).toEqual(['company_number', 'company_status', 'title']);
    expect(companyMatches(undefined, ['a'])).toEqual({ n: 0, items: [] });
  });
});
