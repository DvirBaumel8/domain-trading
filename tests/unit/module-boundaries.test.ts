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

  it('every module has an index.ts', () => {
    const mods = readdirSync(MODULES).filter((n) => statSync(join(MODULES, n)).isDirectory());
    expect(mods.sort()).toEqual(['buying', 'candidates', 'listing', 'ops', 'outreach', 'registrars', 'reporting', 'selection', 'selling']);
    for (const m of mods) expect(statSync(join(MODULES, m, 'index.ts')).isFile()).toBe(true);
  });

  it('every .ts under src is in core, modules, http, db or the top-level allow-list (no leftover services, screening, api, ...)', () => {
    const TOP = new Set(['app.ts', 'main.ts', 'config.ts', 'domain-name.ts']);
    const leftovers = files(SRC).map((f) => relative(SRC, f).split(sep)).filter((p) => !(p.length === 1 ? TOP.has(p[0]!) : ['core', 'modules', 'http', 'db'].includes(p[0]!)));
    expect(leftovers).toEqual([]);
  });

  it('core, http and db never import a module (shared code sits below the modules)', () => {
    const bad = ['core', 'http', 'db'].flatMap((d) => files(join(SRC, d))).filter((f) => /from\s*['"][^'"]*\/modules\//.test(readFileSync(f, 'utf8')));
    expect(bad).toEqual([]);
  });

  it('module indexes form no cycle (the dependency graph between modules is acyclic)', () => {
    const graph = new Map<string, Set<string>>();
    for (const f of files(MODULES)) {
      const own = moduleOf(f)!.name;
      for (const spec of specifiers(readFileSync(f, 'utf8'))) {
        if (!spec.startsWith('.')) continue;
        const t = moduleOf(normalize(join(dirname(f), spec)).replace(/\.js$/, '.ts'));
        if (t && t.name !== own) (graph.get(own) ?? graph.set(own, new Set()).get(own)!).add(t.name);
      }
    }
    const state = new Map<string, number>();
    const visit = (n: string, stack: string[]): string[] | null => {
      if (state.get(n) === 1) return [...stack, n];
      if (state.get(n) === 2) return null;
      state.set(n, 1);
      for (const m of graph.get(n) ?? []) { const c = visit(m, [...stack, n]); if (c) return c; }
      state.set(n, 2);
      return null;
    };
    for (const n of graph.keys()) expect(visit(n, [])).toBeNull();
  });
});
