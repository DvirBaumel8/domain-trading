// CR-008 AC-6 (a report, not a test): how often DOM's `form` word split equals the research `tokens` column of bt1_vectors.csv.
// Usage: npx tsx --env-file-if-exists=.env scripts/ac6-split.ts [--method bt1@v2]   (bt1@v2: DOM's frozen split-v2, no database needed)
// (v1) npx tsx --env-file-if-exists=.env scripts/ac6-split.ts   (reads the versioned word lists from DATABASE_URL, else TEST_DATABASE_URL)
import { readFileSync } from 'node:fs';
import { createDb } from '../src/db/client.js';
import { analyzeForm } from '../src/screening/form.js';
import { buildLexicon, loadDataLexicon } from '../src/screening/lexicon.js';
import { currentLists } from '../src/screening/lists.js';
import { splitV2OfDomain } from '../src/screening/split-v2.js';
import { DEFAULT_SELECTION_VALUES } from '../src/screening/settings.js';

const mi = process.argv.indexOf('--method');
const method = mi >= 0 ? process.argv[mi + 1] : 'bt1@v1';
if (method !== 'bt1@v1' && method !== 'bt1@v2') throw new Error('--method is bt1@v1 or bt1@v2');
const FORM_LISTS = ['trade', 'regime', 'tech', 'generic_head', 'state', 'legal', 'city_extra', 'dictionary_extra'];
const f = DEFAULT_SELECTION_VALUES.form;
let db: ReturnType<typeof createDb> | undefined;
let lexicon: ReturnType<typeof buildLexicon> | undefined;
if (method === 'bt1@v1') {
  const url = process.env.DATABASE_URL ?? process.env.TEST_DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL (or TEST_DATABASE_URL) is needed to read the versioned word lists');
  db = createDb(url);
  lexicon = buildLexicon(loadDataLexicon(), await currentLists(db, FORM_LISTS), { cityOneToken: f.geo_city_one_token, cityWordAllowlist: f.city_word_allowlist });
}
const rows = readFileSync(new URL('../docs/requests/CR-008-reference/bt1_vectors.csv', import.meta.url), 'utf8').split(/\r?\n/).filter((l) => l.trim() !== '').slice(1)
  .map((l) => { const c = l.split(','); return { domain: c[0]!, theirs: c[1]!.split(' ') }; });
let agree = 0;
const diffs: { domain: string; ours: string; theirs: string }[] = [];
for (const r of rows) {
  const ours = method === 'bt1@v2' ? splitV2OfDomain(r.domain) : analyzeForm(r.domain, 'S7', lexicon!, f).tokens;
  if (ours.join(' ') === r.theirs.join(' ')) agree++;
  else diffs.push({ domain: r.domain, ours: ours.join(' '), theirs: r.theirs.join(' ') });
}
console.log(`method ${method}`);
console.log(`agree ${agree} of ${rows.length}`);
console.log(`differences ${diffs.length} (domain, ours, theirs)`);
for (const d of diffs) console.log(`${d.domain}\t${d.ours}\t${d.theirs}`);
await db?.destroy();
