import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// CLAUDE.md: "Every test ID in the internal docs is a real test with that ID in its name." This ratchet enforces it for new IDs:
// an ID in docs/internal/*.md that no test file mentions must be in KNOWN_STALE (old doc IDs from before the tests were renamed, to be
// fixed or removed from the docs one by one); a listed ID that a test now carries must leave the list.
// Not test IDs: gaps (G-nn), requests (CR-nnn), the retired backup drill and paid-PITR ids (BK-5, BK-6, BK-7).
const IGNORED = /^(G-\d+|CR-\d+|BUG-\d+|BK-[567])$/;
const ID = /(?<![A-Za-z0-9_/.])([A-Z]{1,6}\d{0,3}-\d{1,3}[a-z]?)(?![A-Za-z0-9-])/g;

const KNOWN_STALE = [
  'ADM-4',
  'B-27',
  'B-29',
  'B-30',
  'B-31',
  'B-32',
  'BT-001',
  'BT-1a',
  'BT-1c',
  'CAP-14',
  'CAP-16',
  'CAP-21b',
  'CAP-22',
  'CAP-23',
  'CAP-25',
  'CAP-3',
  'CAP-6',
  'CK-12',
  'CLI-1',
  'CLI-2',
  'CLI-3',
  'CLI-4',
  'COMPS-1',
  'DEMAND-1',
  'DR-001',
  'DR-002',
  'DR-003',
  'DR-004',
  'E-13',
  'E-14',
  'E-9',
  'EV-1',
  'EVENT-1',
  'FT-1',
  'HIST-1',
  'IM-12',
  'IM-13',
  'IM-14',
  'IM-15',
  'IM-16',
  'IM-17',
  'JOB-1',
  'JOB-2',
  'JOB-3',
  'JOB-4',
  'JOB-5',
  'JOB-6',
  'JOB-7',
  'L-10',
  'L-17',
  'LEAD-1',
  'LX-3b',
  'LX-8',
  'LX-9',
  'OF-13',
  'OF-15',
  'PA-1',
  'PA-8',
  'PO-5',
  'PR-24',
  'PR-33',
  'PR-34',
  'RATIO-1',
  'SCREEN-1',
  'SEL-1',
  'SEL-2',
  'SEL-3',
  'SEL-4',
  'SEL10-1',
  'SEL3-2',
  'SEL3-4',
  'SEL4-1',
  'SEL4-3',
  'SEL5-1',
  'SEL5-4',
  'SEL6-1',
  'SEL6-2',
  'SEL6-3',
  'SEL7-1',
  'SEL7-3',
  'SEL7-4',
  'SEL8-1',
  'SEL8-2',
  'SEL8-3',
  'SEL8-4',
  'SEL9-11',
  'SEL9-12',
  'SEL9-14',
  'SEL9-15',
  'SEL9-3',
  'SEL9-4',
  'SEL9-5',
  'SEL9-6',
  'SEL9-7',
  'SEL9-8',
  'SEL9-9',
];

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(dir, e.name)) : e.name.endsWith('.ts') ? [join(dir, e.name)] : []));
}

describe('test IDs named in docs/internal exist in the tests', () => {
  const docIds = new Set<string>();
  for (const f of readdirSync('docs/internal').filter((n) => n.endsWith('.md'))) {
    for (const m of readFileSync(join('docs/internal', f), 'utf8').matchAll(ID)) if (!IGNORED.test(m[1]!)) docIds.add(m[1]!);
  }
  const testSource = walk('tests').filter((f) => f !== join('tests', 'unit', 'doc-test-ids.test.ts')).map((f) => readFileSync(f, 'utf8')).join('\n');
  const missing = [...docIds].filter((id) => !testSource.includes(id)).sort();

  it('DOC-IDS-1: every ID in the internal docs is in a test, or is in the known-stale list', () => {
    expect(missing.filter((id) => !KNOWN_STALE.includes(id)), 'IDs in docs/internal with no test: add the ID to the test name or fix the doc').toEqual([]);
  });
  it('DOC-IDS-2: the known-stale list holds only IDs that are still missing', () => {
    expect(KNOWN_STALE.filter((id) => !missing.includes(id)), 'these IDs are now covered or gone from the docs: remove them from KNOWN_STALE').toEqual([]);
  });
});
