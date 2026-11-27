/**
 * render.yaml buildFilter.ignoredPaths must skip paths that never change the API,
 * so docs-only, Apify-only and AVC-only commits do not redeploy DOM.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(import.meta.dirname, '..', '..');

function ignoredPaths(): string[] {
  const lines = readFileSync(join(ROOT, 'render.yaml'), 'utf8').split('\n');
  const start = lines.findIndex((l) => /^\s*ignoredPaths:\s*$/.test(l));
  if (start < 0) return [];
  const out: string[] = [];
  for (const l of lines.slice(start + 1)) {
    const m = /^\s*-\s+(\S+)\s*$/.exec(l);
    if (!m) break;
    out.push(m[1]!);
  }
  return out;
}

describe('contract: render.yaml ignoredPaths', () => {
  it('skips docs, ai-visibility-check and apify-actors', () => {
    const paths = ignoredPaths();
    for (const p of ['docs/**', 'ai-visibility-check/**', 'apify-actors/**']) {
      expect(paths).toContain(p);
    }
  });
});
