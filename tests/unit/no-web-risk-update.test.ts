import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? files(p) : [p];
  });
}

describe('CR-007 G-6: Web Risk Lookup API only (static)', () => {
  it('no source file calls the Web Risk Update API (computeDiff, threatLists, hashes:search)', () => {
    const banned = /computeDiff|threatLists|hashes:search/;
    const hits = files('src').filter((f) => banned.test(readFileSync(f, 'utf8')));
    expect(hits).toEqual([]);
  });
});
