/**
 * Small RFC 4180 parser: quoted fields, "" escapes, CRLF or LF records, a leading BOM is dropped,
 * a trailing newline does not make a phantom row. A bare CR is not a record separator.
 * On malformed quoting (an unterminated quote, or a quote in the middle of an unquoted field) parsing stops:
 * `rows` holds the records before it and `badRecord` is the 0-based index of the record where quoting broke.
 */
export function parseCsv(input: string): { rows: string[][]; badRecord: number | null } {
  const text = input.charCodeAt(0) === 0xfeff ? input.slice(1) : input;
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  let wasQuoted = false;
  let pending = false; // anything seen since the last record break
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else quoted = false;
      } else field += c;
      continue;
    }
    if (c === '"') {
      if (field !== '' || wasQuoted) return { rows, badRecord: rows.length };
      quoted = true; wasQuoted = true; pending = true; continue;
    }
    if (wasQuoted && c !== ',' && c !== '\n' && !(c === '\r' && text[i + 1] === '\n')) return { rows, badRecord: rows.length };
    if (c === ',') { row.push(field); field = ''; wasQuoted = false; pending = true; continue; }
    if (c === '\n' || (c === '\r' && text[i + 1] === '\n')) {
      if (c === '\r') i++;
      row.push(field); rows.push(row);
      row = []; field = ''; wasQuoted = false; pending = false; continue;
    }
    field += c; pending = true;
  }
  if (quoted) return { rows, badRecord: rows.length };
  if (pending) { row.push(field); rows.push(row); }
  return { rows, badRecord: null };
}
