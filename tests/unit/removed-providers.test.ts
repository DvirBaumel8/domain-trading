import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// The names are split so this file doesn't contain them.
const removed = new RegExp(['dyna' + 'dot', String.raw`(?<![a-z])se` + String.raw`do(?!n)`, 'space' + 'ship', String.raw`(?<![\w-])name` + String.raw`\.com\b`, 'name' + 'com', 'name' + 'cheap', 'name' + 'silo',
  'buffer' + 'app', String.raw`buf` + String.raw`fer[._](com|api|channel)`, 'companies.?' + 'house', 'name' + 'bio'].join('|'), 'i');

describe('CR-113: the removed providers stay out', () => {
  it('no code, config, workflow, contract or internal doc names one', () => {
    const files = execFileSync('git', ['ls-files', '-z', ...['src', 'tests', 'scripts', '.github', '.claude', 'data/state.json', 'docs/contract', 'docs/internal', 'docs/DEPLOYMENT.md', 'render.yaml', '.env.example', 'README.md', 'CLAUDE.md', 'package.json']], { encoding: 'utf8' }).split('\0').filter(Boolean);
    expect(files.length).toBeGreaterThan(30);
    expect(files.filter((f) => removed.test(f) || removed.test(readFileSync(f, 'utf8')))).toEqual([]);
  });
});
