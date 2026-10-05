/** Strict RFC 4180 parser for tests: CRLF records, quoted fields, "" escapes. Throws on anything else. */
export function parseCsvStrict(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let i = 0;
  let quoted = false;
  let fieldStarted = false;
  while (i < text.length) {
    const c = text[i]!;
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 2; continue; }
        quoted = false; i++; continue;
      }
      field += c; i++; continue;
    }
    if (c === '"') {
      if (fieldStarted) throw new Error(`quote inside unquoted field at ${i}`);
      quoted = true; fieldStarted = true; i++; continue;
    }
    if (c === ',') { row.push(field); field = ''; fieldStarted = false; i++; continue; }
    if (c === '\r') {
      if (text[i + 1] !== '\n') throw new Error(`bare CR at ${i}`);
      row.push(field); rows.push(row); row = []; field = ''; fieldStarted = false; i += 2; continue;
    }
    if (c === '\n') throw new Error(`bare LF at ${i}`);
    field += c; fieldStarted = true; i++;
  }
  if (quoted) throw new Error('unterminated quote');
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows;
}
