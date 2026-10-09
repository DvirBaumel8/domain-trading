import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/** Strip comments and string/template literals in one left-to-right pass, then remove numeric separators. */
function code(src: string): string {
  let out = '';
  let i = 0;
  while (i < src.length) {
    const c = src[i]!;
    const n = src[i + 1];
    if (c === '/' && n === '/') {
      while (i < src.length && src[i] !== '\n') i++;
    } else if (c === '/' && n === '*') {
      const end = src.indexOf('*/', i + 2);
      i = end === -1 ? src.length : end + 2;
    } else if (c === "'" || c === '"' || c === '`') {
      i++;
      while (i < src.length && src[i] !== c) i += src[i] === '\\' ? 2 : 1;
      i++;
      out += c + c;
    } else {
      out += c;
      i++;
    }
  }
  return out.replace(/(\d)_(?=\d)/g, '$1');
}

describe('PR-10: no floats in the pricing module', () => {
  const dir = 'src/modules/listing/pricing';
  const files = readdirSync(dir).filter((f) => f.endsWith('.ts'));
  it('has files', () => expect(files.length).toBeGreaterThan(3));
  it('the stripper is not fooled by strings containing comment markers', () => {
    expect(code("const a = '//'; const b = 1.5; /* x */")).toMatch(/1\.5/);
    expect(code("const a = '/*'; const b = 7 / 2;")).toMatch(/\//);
  });
  it.each(files)('%s has no float literal', (f) => {
    const src = code(readFileSync(join(dir, f), 'utf8'));
    expect(src).not.toMatch(/\b\d+\.\d+\b/);
    expect(src).not.toMatch(/(^|[^\w.])\.\d/);
    expect(src).not.toMatch(/\d[eE][+-]?\d/);
  });
  it.each(files.filter((f) => f !== 'int.ts'))('%s has no division operator (only int.ts may divide)', (f) => {
    expect(code(readFileSync(join(dir, f), 'utf8'))).not.toMatch(/\//);
  });
  it.each(files)('%s hard-codes no pricing rule numbers (6500, 4800, 2000, 75000, 50000, 49900, 39900, 29900)', (f) => {
    expect(code(readFileSync(join(dir, f), 'utf8'))).not.toMatch(/\b(6500|4800|2000|75000|50000|49900|39900|29900)\b/);
  });
});
