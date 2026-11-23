// npm run check-state: the rules of data/state.json, run by CI before Render may deploy.
// 1. The file follows every rule (src/state.ts), has no date in the future, and every approval record it names exists.
// 2. Walking the file's git history, no version rewrote an earlier row. A pushed version that did is skipped, so undoing it passes and building on it does not.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { parseState, rewrites, type State } from '../src/state.js';

const FILE = 'data/state.json';
const git = (...args: string[]): string => execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
const fail = (why: string[]): never => { for (const w of why) console.error(`::error::${FILE}: ${w}`); process.exit(1); };

const current = (() => { try { return parseState(readFileSync(FILE, 'utf8')); } catch (e) { return fail([(e as Error).message]); } })();
const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Jerusalem' });
const future = current.ledger.filter((r) => r.date > today);
if (future.length > 0) fail(future.map((r) => `ledger row ${r.id} is dated in the future`));

const lost = current.ledger.filter((r) => r.approval?.ref.startsWith('docs/') && !existsSync(r.approval.ref));
if (lost.length > 0) fail(lost.map((r) => `ledger row ${r.id}: its approval record ${r.approval?.ref} is missing`));

if (git('rev-parse', '--is-shallow-repository').trim() === 'true') fail(['the git history is cut (shallow clone), so old rows cannot be compared']);
let last: State | null = null;
for (const commit of git('log', '--reverse', '--format=%H', '--', FILE).split('\n').filter(Boolean)) {
  let version: State;
  try { version = parseState(git('show', `${commit}:${FILE}`)); } catch { continue; } // deleted or invalid then: not a version to build on
  if (last === null || rewrites(last, version).length === 0) last = version;
}
if (last) { const bad = rewrites(last, current); if (bad.length > 0) fail(bad); }
console.log(`${FILE} ok: ${current.domains.length} domains, ${current.ledger.length} ledger rows, only added to`);
