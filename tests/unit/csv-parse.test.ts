import { describe, expect, it } from 'vitest';
import { parseCsv } from '../../src/csv-parse.js';

describe('parseCsv (RFC 4180)', () => {
  it('parses LF and CRLF, with or without a trailing newline (no phantom row)', () => {
    expect(parseCsv('a,b\n1,2\n')).toEqual([['a', 'b'], ['1', '2']]);
    expect(parseCsv('a,b\r\n1,2\r\n')).toEqual([['a', 'b'], ['1', '2']]);
    expect(parseCsv('a,b\n1,2')).toEqual([['a', 'b'], ['1', '2']]);
    expect(parseCsv('')).toEqual([]);
  });
  it('strips a BOM', () => expect(parseCsv('﻿a,b\n')).toEqual([['a', 'b']]));
  it('handles quoted commas, escaped quotes and embedded newlines', () => {
    expect(parseCsv('a,"x, y","say ""hi""","l1\r\nl2"\n')).toEqual([['a', 'x, y', 'say "hi"', 'l1\r\nl2']]);
  });
  it('keeps empty fields, including a trailing one and a blank line in the middle', () => {
    expect(parseCsv('a,,c,\n\nd\n')).toEqual([['a', '', 'c', ''], [''], ['d']]);
  });
  it('rejects malformed quoting', () => {
    expect(parseCsv('a,"b\n')).toBeNull();
    expect(parseCsv('a,b"c"\n')).toBeNull();
    expect(parseCsv('a,"b"c\n')).toBeNull();
  });
});
