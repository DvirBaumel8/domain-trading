import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, normalize, relative, sep } from 'node:path';
import { describe, expect, it } from 'vitest';

// R2 gate: code outside a module reaches it only through src/modules/<m>/index.ts; an index never reaches into another module.
const SRC = 'src';
const MODULES = join(SRC, 'modules');

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? files(p) : p.endsWith('.ts') ? [p] : [];
  });
}

export function specifiers(source: string): string[] {
  const out: string[] = [];
  const re = /(?:^|[\s;}])(?:import|export)\b[^'"`;]*?\bfrom\s*['"]([^'"]+)['"]|(?:^|[\s;}])import\s*['"]([^'"]+)['"]|\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
  for (const m of source.matchAll(re)) out.push((m[1] ?? m[2] ?? m[3])!);
  return out;
}

/** Module name of a path under src/modules, or null; `isIndex` when the path is that module's index.ts. */
function moduleOf(p: string): { name: string; isIndex: boolean } | null {
  const rel = relative(MODULES, p);
  if (rel.startsWith('..')) return null;
  const parts = rel.split(sep);
  return { name: parts[0]!, isIndex: parts.length === 2 && parts[1] === 'index.ts' };
}

export function violations(file: string, source: string): string[] {
  const own = moduleOf(file);
  const bad: string[] = [];
  for (const spec of specifiers(source)) {
    if (!spec.startsWith('.')) continue;
    const target = normalize(join(dirname(file), spec)).replace(/\.js$/, '.ts');
    const t = moduleOf(target);
    if (!t) continue;
    if (own && own.name === t.name) continue;
    if (own?.isIndex) bad.push(`${file}: a module index imports another module (${spec})`);
    else if (!t.isIndex) bad.push(`${file}: imports ${spec}, which is inside module ${t.name} but is not its index.ts`);
  }
  return bad;
}

describe('module boundaries (refactor R2)', () => {
  it('no file in src reaches into another module except through its index.ts', () => {
    expect(files(SRC).flatMap((f) => violations(f, readFileSync(f, 'utf8')))).toEqual([]);
  });

  it('the checker finds a deep import, allows an index import and flags a module index importing another module', () => {
    expect(violations('src/app.ts', "import { a } from './modules/selling/offers.js';")).toHaveLength(1);
    expect(violations('src/app.ts', "import { a } from './modules/selling/index.js';")).toEqual([]);
    expect(violations('src/modules/outreach/x.ts', "export { a } from '../selling/offers.js';")).toHaveLength(1);
    expect(violations('src/modules/outreach/x.ts', "import { a } from '../selling/index.js';")).toEqual([]);
    expect(violations('src/modules/outreach/index.ts', "export { a } from '../selling/index.js';")).toHaveLength(1);
    expect(violations('src/modules/outreach/index.ts', "export { a } from './api/x.js';")).toEqual([]);
    expect(violations('src/x.ts', "const m = await import('./modules/selling/sold.js');")).toHaveLength(1);
  });

  it('the three modules exist with an index.ts', () => {
    for (const m of ['outreach', 'reporting', 'selling']) expect(statSync(join(MODULES, m, 'index.ts')).isFile()).toBe(true);
  });
});
