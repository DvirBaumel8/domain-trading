// v2.1.0: docs/contract/test-evidence.md is generated from the test sources and checked here (CR-005 §12.4, N-11b).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { EVIDENCE_FILE, UNTESTABLE, codesWithoutTests, generateEvidence, indexCodes } from '../../scripts/evidence.js';

const ROOT = join(import.meta.dirname, '..', '..');

describe('test evidence map', () => {
  it('the committed docs/contract/test-evidence.md is what `npm run evidence` generates (run it and commit the result)', () => {
    expect(readFileSync(join(ROOT, EVIDENCE_FILE), 'utf8')).toBe(generateEvidence(ROOT));
  });

  it('every code in the contract code index has at least one test, or a stated reason in UNTESTABLE', () => {
    expect(indexCodes(ROOT).length).toBeGreaterThan(100);
    expect(codesWithoutTests(ROOT)).toEqual([]);
  });

  it('UNTESTABLE only names codes that are in the index, each with a reason', () => {
    const codes = new Set(indexCodes(ROOT));
    for (const [code, reason] of Object.entries(UNTESTABLE)) {
      expect(codes.has(code), code).toBe(true);
      expect(reason.length, code).toBeGreaterThan(10);
    }
  });
});
