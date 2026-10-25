// v5.47.0 (F5): builds data/lift-seed/cr002.jsonl from docs/requests/CR-002-reference/features.csv (one-off; the output is frozen and checked into the repo).
// Columns used: label, sld_chars, n_words, alt_tld_before_n, registered_share, prior_history. An empty cell stays null (nothing is imputed).
// Run: npx tsx scripts/build-lift-seed.ts
import { readFileSync, writeFileSync } from 'node:fs';

const [head, ...lines] = readFileSync('docs/requests/CR-002-reference/features.csv', 'utf8').trim().split('\n');
const cols = head!.split(',');
const at = (name: string): number => { const i = cols.indexOf(name); if (i < 0) throw new Error(`column ${name} missing`); return i; };
const [iLabel, iChars, iWords, iAlt, iShare, iHist] = ['label', 'sld_chars', 'n_words', 'alt_tld_before_n', 'registered_share', 'prior_history'].map(at) as [number, number, number, number, number, number];
const num = (s: string | undefined): number | null => (s === undefined || s === '' ? null : Number(s));
const out = lines.map((l) => {
  const c = l.split(',');
  const hist = num(c[iHist]);
  return JSON.stringify({ label: c[iLabel], len: num(c[iChars]), words: num(c[iWords]), endings_before: num(c[iAlt]), registered_share: num(c[iShare]), past_site: hist === null ? null : hist === 1 });
});
writeFileSync('data/lift-seed/cr002.jsonl', `${out.join('\n')}\n`);
console.log(`wrote ${out.length} rows`);
