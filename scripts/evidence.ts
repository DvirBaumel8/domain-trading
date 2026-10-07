// Generates docs/contract/test-evidence.md: every code of the contract's code index -> the automated tests that assert it, and
// every guarantee -> its test. `npm run evidence` rewrites the file; tests/unit/test-evidence.test.ts regenerates it in memory and
// fails when it differs from the committed file or when a code has no test (CR-005 v2.1.0, "evidence instead of switches").
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(import.meta.dirname, '..');
export const EVIDENCE_FILE = 'docs/contract/test-evidence.md';
/** The evidence test itself names codes (this list); it is not evidence for them. */
const EXCLUDED_TESTS = new Set(['tests/unit/test-evidence.test.ts']);

/**
 * Codes in the index that no automated test can produce, each with the reason. Ideally empty. Anything not here must have a test.
 */
export const UNTESTABLE: Readonly<Record<string, string>> = {
  DROP_DATE_UNKNOWN: 'unreachable by design: the database CHECK domains_owned_fields forbids an owned or listed name without a drop_date, so this guard in POST /list is defensive only',
  LABELLED_NAME_CONFLICT: 'needs two uploads of the same new name to race between the duplicate check and the insert (a unique-violation guard); it cannot be forced from a test without a hook in the service',
  OUTCOME_CHANGED_CONCURRENTLY: 'needs two outcome calls on one offer to interleave between the read and the conditional update; the guard is the conditional UPDATE itself and cannot be forced from a test without a hook in the service',
};

export interface TestBlock { file: string; name: string; body: string }

const walk = (d: string): string[] => readdirSync(d).flatMap((f) => { const p = join(d, f); return statSync(p).isDirectory() ? walk(p) : [p]; });

const TEST_START = /\b(?:it|test)(?:\.(?:each|skip|only|concurrent|todo)\([^)]*\))?\(\s*(['"`])((?:\\.|(?!\1)[^\\])*)\1/g;

/** Every `it(...)` / `test(...)` block of a test source: its title and body text (up to the next test's start). */
export function testBlocks(file: string, text: string): TestBlock[] {
  const starts = [...text.matchAll(TEST_START)].map((m) => ({ at: m.index!, name: m[2]!.replace(/\s+/g, ' ').trim() }));
  return starts.map((s, i) => ({ file, name: s.name, body: text.slice(s.at, starts[i + 1]?.at ?? text.length) }));
}

export function loadTestBlocks(root = ROOT): TestBlock[] {
  return walk(join(root, 'tests')).filter((f) => f.endsWith('.test.ts')).map((f) => relative(root, f)).filter((f) => !EXCLUDED_TESTS.has(f)).sort()
    .flatMap((f) => testBlocks(f, readFileSync(join(root, f), 'utf8')));
}

/** The codes of the code index in endpoints.md: every backticked UPPER_SNAKE token after `## Code index`. */
export function indexCodes(root = ROOT): string[] {
  const md = readFileSync(join(root, 'docs/contract/endpoints.md'), 'utf8');
  const index = md.slice(md.indexOf('## Code index'));
  const listing = md.split('\n').filter((l) => l.startsWith('- **Listing rule codes (422):**')).join('\n');
  return [...new Set([...(index + '\n' + listing).matchAll(/`([A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*)`/g)].map((m) => m[1]!))].sort();
}

/** A block asserts a code when it has an expectation and names the code as a whole word in it (a string such as 'CODE' or 'x.com:CODE', or a regexp). */
const asserts = (b: TestBlock, code: string) => /expect|assert|toThrow/.test(b.body) && new RegExp(`(?<![A-Z0-9_])${code}(?![A-Z0-9_])`).test(b.body);

export function testsFor(blocks: TestBlock[], code: string): TestBlock[] {
  return blocks.filter((b) => asserts(b, code));
}

const SHOWN = 3;
const cell = (s: string) => s.replace(/\|/g, '\\|');
const ref = (b: TestBlock) => `\`${b.file}\`: ${cell(b.name)}`;

/** A guarantee and the test that proves it. `test` is a title fragment that must exist in `file`. */
interface Guarantee { what: string; file: string; test: string; note?: string }

/** Tables whose rows may never be changed or deleted (database triggers). */
export const APPEND_ONLY_TABLES = [
  'audit_log', 'cohort_decisions', 'cohort_names', 'cohort_outcomes', 'company_documents', 'domain_records', 'drop_list_checks', 'drop_list_rows', 'drop_lists', 'export_uploads', 'forbidden_terms', 'holdout_suites', 'job_runs', 'labelled_names', 'ledger_entries', 'listing_history', 'manual_quotes', 'pricing_evidence',
  'pricing_settings', 'portfolio_checks', 'post_images', 'posting_bursts', 'posting_switches', 'replay_runs', 'review_feedback', 'review_item_statuses', 'review_items', 'review_packets', 'review_retries', 'review_settings_changes', 'sales', 'screening_evidence', 'screening_packs', 'screening_results', 'screening_verdicts', 'selection_lists', 'selection_settings', 'sibling_method_approvals', 'test_set_rows',
] as const;

const GUARANTEES: Guarantee[] = [
  { what: 'No secret, key or token appears in a response, a log line or an audit row', file: 'tests/api/secrets.test.ts', test: 'responses, logs and audit rows contain no env secret' },
  { what: 'Tests never reach the network (an unmocked outbound request fails)', file: 'tests/unit/network-block.test.ts', test: 'fails any unmocked outbound HTTP request' },
  { what: 'One AI call only: the outside review (src/modules/outreach/review/gemini.ts); no AI SDK, no other provider host in src/', file: 'tests/unit/no-llm.test.ts', test: 'no LLM SDK dependency' },
  { what: 'No registrar top-up call, ever (no top-up endpoint is referenced in `src/`)', file: 'tests/unit/no-topup.test.ts', test: 'no source file references a top-up endpoint' },
  { what: 'Web Risk uses only the free Lookup API (no Update API call in `src/`)', file: 'tests/unit/no-web-risk-update.test.ts', test: 'no source file calls the Web Risk Update API' },
];

export function generateEvidence(root = ROOT): string {
  const blocks = loadTestBlocks(root);
  const codes = indexCodes(root);
  const lines: string[] = [];
  const version = (JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { version: string }).version;
  lines.push(`# Test evidence (contract v${version}, generated)`, '');
  lines.push('Generated by `npm run evidence` from the code index in `endpoints.md` and the test sources. **Do not edit by hand.** A test in the default suite (`tests/unit/test-evidence.test.ts`) regenerates this file and fails when it differs, or when a code has no test. A test is listed for a code when its body has an expectation and names the code as a string. Each entry is `file`: test name; at most three are shown, then the total.', '');
  lines.push('## Guarantees', '');
  lines.push('| Guarantee | Test |', '|---|---|');
  for (const g of GUARANTEES) {
    const b = blocks.find((x) => x.file === g.file && x.name.includes(g.test));
    const found = b ?? testBlocks(g.file, safeRead(join(root, g.file))).find((x) => x.name.includes(g.test));
    if (!found) throw new Error(`guarantee test missing: ${g.file} / ${g.test}`);
    lines.push(`| ${cell(g.what)} | ${ref(found)} |`);
  }
  lines.push('', '### Append-only tables', '');
  lines.push('Each table below refuses UPDATE, DELETE and TRUNCATE in the database (a trigger). `tests/api/append-only.test.ts` checks the triggers of every table and a refused write on each one. Tests that also check the table on one line with "append-only" or "immutable":', '');
  lines.push('| Table | Tests |', '|---|---|');
  const proof = blocks.find((b) => b.file === 'tests/api/append-only.test.ts' && b.name.includes('refuses UPDATE, DELETE and TRUNCATE'));
  if (!proof) throw new Error('append-only test missing: tests/api/append-only.test.ts');
  for (const t of APPEND_ONLY_TABLES) {
    const extra = blocks.filter((b) => b.file !== 'tests/api/append-only.test.ts' && b.body.split('\n').some((l) => /append-only|immutable/i.test(l) && new RegExp(`\\b${t}\\b`).test(l)));
    const names = [proof, ...extra];
    lines.push(`| \`${t}\` | ${names.slice(0, SHOWN).map(ref).join('; ')}${names.length > SHOWN ? ` (${names.length} tests)` : ''} |`);
  }
  lines.push('', '## Codes', '');
  lines.push('| Code | Tests |', '|---|---|');
  for (const code of codes) {
    const t = testsFor(blocks, code);
    const text = t.length === 0
      ? (UNTESTABLE[code] ? `no automated test: ${cell(UNTESTABLE[code]!)}` : '**none**')
      : `${t.slice(0, SHOWN).map(ref).join('; ')}${t.length > SHOWN ? ` (${t.length} tests)` : ''}`;
    lines.push(`| \`${code}\` | ${text} |`);
  }
  lines.push('', '## Platform responses (not from the service)', '');
  lines.push("Render's front door (Cloudflare) answers some malformed paths itself, before the request reaches the service. No DOM test can produce these; they were checked live on 2026-10-07 (CR-006).", '');
  lines.push('| Request | Answer | Who answers |', '|---|---|---|');
  lines.push('| A complete escape that decodes to invalid UTF-8 (`/portfolio/%C3%28`) | 400 `INVALID_REQUEST`, JSON error shape | the service (the tests above) |');
  lines.push('| An escape that is not hex (`/portfolio/%ZZ`, `%zz`) | 400, `text/html` Cloudflare page | the platform edge |');
  lines.push('| A truncated escape (`/portfolio/%E0%A4%A`, `a%`) | 520, `text/plain` "error code: 520" | the platform edge |');
  return `${lines.join('\n')}\n`;
}

function safeRead(p: string): string {
  try { return readFileSync(p, 'utf8'); } catch { return ''; }
}

/** Codes with no test and no allow-list reason. */
export function codesWithoutTests(root = ROOT): string[] {
  const blocks = loadTestBlocks(root);
  return indexCodes(root).filter((c) => testsFor(blocks, c).length === 0 && !UNTESTABLE[c]);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  writeFileSync(join(ROOT, EVIDENCE_FILE), generateEvidence());
  const missing = codesWithoutTests();
  console.log(`wrote ${EVIDENCE_FILE}${missing.length ? `; codes without a test: ${missing.join(', ')}` : ''}`);
}
