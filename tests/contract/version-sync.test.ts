/**
 * v3.9.0: the version is written in four places; they must agree (npm run release moves them together).
 * package.json "version" == the README line "**Version X**" == the newest CHANGELOG entry, and docs/releases/v<version>.md exists.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(import.meta.dirname, '..', '..');
const read = (...p: string[]) => readFileSync(join(ROOT, ...p), 'utf8');
const version = (JSON.parse(read('package.json')) as { version: string }).version;

describe('contract: version sync', () => {
  it('package.json, the contract README and the top CHANGELOG entry carry the same version', () => {
    expect(version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(/\*\*Version (\d+\.\d+\.\d+)\*\*/.exec(read('docs', 'contract', 'README.md'))?.[1]).toBe(version);
    expect(/^## (\d+\.\d+\.\d+)\b/m.exec(read('docs', 'contract', 'CHANGELOG.md'))?.[1]).toBe(version);
  });

  it('the release note docs/releases/v<version>.md exists', () => {
    expect(existsSync(join(ROOT, 'docs', 'releases', `v${version}.md`))).toBe(true);
  });
});
