import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// L516-2 (G-111, BUG-042): a guard against real-clock time bombs in tests. An `approval_ref.approved_at` must be measured from the
// same clock the app under test uses. Two ways to break that, both caught here by a line scan of tests/**/*.test.ts:
//   (a) approved_at built from the real clock (`Date.now()`, `new Date()`) in a file whose app clock is a fixed date (the BUG-042 mix:
//       fixed 2026-10-12 on one side, today on the other). A file whose clock also starts at `Date.now()` is consistent and fine;
//   (b) approved_at a fixed date literal in a file that fixes no app clock at all (no `now:`, NOW, clock, T0, setSystemTime, fake timers):
//       the 72-hour window passes one day and the test goes red with no code change.
// Allow-list: a file that really talks to a real-clock server, or where the literal is only stored and never age-checked.
const ALLOWED: Record<string, string> = {
  'tests/contract/porkbun-sandbox.test.ts': 'opt-in contract test against the real sandbox: real clock on both sides',
  'tests/modules/core/unit/redact.test.ts': 'redaction of a body; no app, no age check',
  'tests/modules/http/audit.test.ts': 'the literal is only stored and echoed in audit_log (approval_at), never age-checked',
};
const FIXED_CLOCK = /\bnow:|\bNOW\b|\bclock\b|\bT0\b|setSystemTime|useFakeTimers|fixedNow/;
const FIXED_DATE_CLOCK = /(Date\.parse|new Date)\(\s*['"`]\d{4}-\d{2}-\d{2}|setSystemTime/;
const REAL_CLOCK = /approved_at\s*:[^\n]*(Date\.now\(\)|new Date\(\s*\))/;
const FIXED_LITERAL = /approved_at\s*:\s*['"`]\d{4}-\d{2}-\d{2}/;

function testFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? testFiles(p) : p.endsWith('.test.ts') ? [p] : [];
  });
}

/** The offending files, as `path: reason`. Pure so the guard itself can be tested. */
function clockViolations(files: { path: string; text: string }[]): string[] {
  const out: string[] = [];
  for (const { path, text } of files) {
    if (ALLOWED[path]) continue;
    if (REAL_CLOCK.test(text) && FIXED_DATE_CLOCK.test(text)) out.push(`${path}: approved_at from the real clock`);
    else if (!REAL_CLOCK.test(text) && FIXED_LITERAL.test(text) && !FIXED_CLOCK.test(text)) out.push(`${path}: fixed approved_at date and no fixed app clock`);
  }
  return out;
}

describe('L516-2 test clock guard', () => {
  it('L516-2: no test builds approved_at from the real clock or a fixed date without a fixed app clock', () => {
    // This file is skipped: its regexes and examples mention the patterns.
    const files = testFiles('tests').filter((p) => !p.endsWith('test-clock-guard.test.ts')).map((path) => ({ path, text: readFileSync(path, 'utf8') }));
    expect(clockViolations(files)).toEqual([]);
  });

  it('L516-2: the guard flags the BUG-042 patterns and passes the fixed-clock ones', () => {
    const bad1 = { path: 'a.test.ts', text: "const NOW = Date.parse('2026-10-12T09:00:00Z');\napproval_ref: { text: 'x', approved_at: new Date(Date.now() - 3600000).toISOString() }" };
    const bad2 = { path: 'b.test.ts', text: "const a = { text: 'x', approved_at: '2026-10-04T09:10:00+03:00' };" };
    const ok1 = { path: 'c.test.ts', text: "const NOW = 1;\nconst a = { approved_at: '2026-10-04T09:10:00Z' };" };
    const ok3 = { path: 'e.test.ts', text: 'let clock = Date.now();\napproved_at: new Date(Date.now() - 1).toISOString()' };
    const ok2 = { path: 'd.test.ts', text: 'approved_at: new Date(x.clock.t - HOUR).toISOString()' };
    expect(clockViolations([bad1, bad2, ok1, ok2, ok3])).toEqual(['a.test.ts: approved_at from the real clock', 'b.test.ts: fixed approved_at date and no fixed app clock']);
  });
});
