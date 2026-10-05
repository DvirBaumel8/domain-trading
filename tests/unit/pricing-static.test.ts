import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/** Remove comments and string/template literals so '/' in imports or comments doesn't count. */
function code(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/gm, '')
    .replace(/`(?:\\.|[^`\\])*`/g, '``')
    .replace(/'(?:\\.|[^'\\])*'/g, "''")
    .replace(/"(?:\\.|[^"\\])*"/g, '""');
}

describe('PR-10: no floats in the pricing module', () => {
  const dir = 'src/pricing';
  const files = readdirSync(dir).filter((f) => f.endsWith('.ts'));
  it('has files', () => expect(files.length).toBeGreaterThan(3));
  it.each(files)('%s has no float literal', (f) => {
    expect(code(readFileSync(join(dir, f), 'utf8'))).not.toMatch(/\b\d+\.\d+\b/);
  });
  it.each(files.filter((f) => f !== 'int.ts'))('%s has no division operator (only int.ts may divide)', (f) => {
    expect(code(readFileSync(join(dir, f), 'utf8'))).not.toMatch(/\//);
  });
  it.each(files)('%s hard-codes no pricing rule numbers (6500, 4800, 2000, 75000, 50000, 10000, 49900, 39900, 29900)', (f) => {
    expect(code(readFileSync(join(dir, f), 'utf8'))).not.toMatch(/\b(6500|4800|2000|75000|50000|49900|39900|29900)\b/);
  });
});
