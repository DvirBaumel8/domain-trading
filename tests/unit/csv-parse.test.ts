import { describe, expect, it } from 'vitest';
import { parseCsv } from '../../src/csv-parse.js';

const rows = (t: string) => parseCsv(t).rows;
describe('parseCsv (RFC 4180)', () => {
  it('parses LF and CRLF, with or without a trailing newline (no phantom row)', () => {
    expect(rows('a,b\n1,2\n')).toEqual([['a', 'b'], ['1', '2']]);
    expect(rows('a,b\r\n1,2\r\n')).toEqual([['a', 'b'], ['1', '2']]);
    expect(rows('a,b\n1,2')).toEqual([['a', 'b'], ['1', '2']]);
    expect(rows('')).toEqual([]);
  });
  it('strips a BOM', () => expect(rows('﻿a,b\n')).toEqual([['a', 'b']]));
  it('handles quoted commas, escaped quotes and embedded newlines', () => {
    expect(rows('a,"x, y","say ""hi""","l1\r\nl2"\n')).toEqual([['a', 'x, y', 'say "hi"', 'l1\r\nl2']]);
  });
  it('keeps empty fields, including a trailing one and a blank line in the middle', () => {
    expect(rows('a,,c,\n\nd\n')).toEqual([['a', '', 'c', ''], [''], ['d']]);
  });
  it('reports the record where quoting broke', () => {
    expect(parseCsv('a,"b\n')).toEqual({ rows: [], badRecord: 0 });
    expect(parseCsv('h\nx\na,b"c"\n')).toEqual({ rows: [['h'], ['x']], badRecord: 2 });
    expect(parseCsv('a,"b"c\n').badRecord).toBe(0);
    expect(parseCsv('a,b\n').badRecord).toBeNull();
  });
});
