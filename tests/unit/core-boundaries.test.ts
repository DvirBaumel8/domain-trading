import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { describe, expect, it } from 'vitest';

// R1 gate: helpers that live in src/core must not be defined again anywhere else in src.
const SRC = join(__dirname, '..', '..', 'src');

const walk = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(dir, e.name)) : e.name.endsWith('.ts') ? [join(dir, e.name)] : []));

const files = walk(SRC).filter((f) => !relative(SRC, f).startsWith(`core${sep}`));

const NAMES = [
  'addDays', 'addMonthsClamped', 'addOneYear', 'dayNumber', 'idtDay', 'idtDayStart', 'idtIsSunday', 'nextIdtMidnight', 'isRealDate', 'isIsoWithOffset',
  'utcMonth', 'todayIdt', 'jerusalemDate', 'toJerusalemIso', 'jerusalemDeep', 'monthOf',
  'formatUsd', 'wholeUsd', 'wholeDollars', 'pair', 'centsToDollars',
  'ISO_WITH_OFFSET', 'ISO_WITH_TZ',
  'redact', 'redactFreeText', 'scrubSecrets',
];
const DEFINITION = new RegExp(`\\b(?:function|const|let|var)\\s+(?:${NAMES.join('|')})\\b`);
// An inline copy of the ISO-with-offset regex.
const ISO_REGEX_COPY = /T\\d\{2\}:\\d\{2\}\(:\\d\{2\}\(\\\.\\d\{1,9\}\)\?\)\?\(Z\|/;

describe('core boundaries (R1)', () => {
  it('core-1: no helper that lives in src/core is defined outside it', () => {
    const hits: string[] = [];
    for (const f of files) {
      readFileSync(f, 'utf8').split('\n').forEach((line, i) => {
        if (DEFINITION.test(line)) hits.push(`${relative(SRC, f)}:${i + 1}: ${line.trim()}`);
      });
    }
    expect(hits).toEqual([]);
  });

  it('core-2: no inline copy of the ISO-with-offset regex outside src/core', () => {
    const hits = files.filter((f) => ISO_REGEX_COPY.test(readFileSync(f, 'utf8'))).map((f) => relative(SRC, f));
    expect(hits).toEqual([]);
  });

  it('core-3: the old helper modules are gone', () => {
    const all = walk(SRC).map((f) => relative(SRC, f));
    for (const gone of ['dates.ts', 'time.ts', 'money.ts', join('http', 'redact.ts')]) expect(all).not.toContain(gone);
  });
});
