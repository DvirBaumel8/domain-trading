import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const files = (dir: string): string[] => readdirSync(dir).flatMap((f) => { const p = join(dir, f); return statSync(p).isDirectory() ? files(p) : [p]; });

describe('the app is stateless (Dvir, 23 Nov 2026)', () => {
  it('no database package, and no file or database write in src/', () => {
    const { dependencies } = JSON.parse(readFileSync('package.json', 'utf8')) as { dependencies: Record<string, string> };
    expect(Object.keys(dependencies).sort()).toEqual(['fastify', 'zod']);
    const banned = /\b(kysely|pg|postgres|sqlite|DATABASE_URL)\b|writeFile|appendFile|createWriteStream/i;
    expect(files('src').filter((f) => banned.test(readFileSync(f, 'utf8')))).toEqual([]);
  });
  it('founder rule 12: nothing in src/ can register, renew or pay', () => {
    const banned = /domain\/(create|renew)|\/account\/|agreeToTerms/i;
    expect(files('src').filter((f) => banned.test(readFileSync(f, 'utf8')))).toEqual([]);
  });
});
