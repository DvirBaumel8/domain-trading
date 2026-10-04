import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? files(p) : [p];
  });
}

describe('B-25: never top up (static)', () => {
  it('no source file references a top-up endpoint', () => {
    const banned = /account\/topup|account\/autotopup|sandbox\/topup|topupcrypto|topupmpp/i;
    const hits = files('src').filter((f) => banned.test(readFileSync(f, 'utf8')));
    expect(hits).toEqual([]);
  });
});
