// DOM-only data builder (needs network). Never imported by src/ and never run in tests.
// Usage: npx tsx scripts/build-wordlists.ts
// Writes data/wordlists/en-scowl-60.txt and data/wordlists/us-places.txt, then prints the table for data/README.md.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(root, 'data', 'wordlists');
const UA = 'domain-trading-api/1.1.0 (+https://github.com/DvirBaumel8/domain-trading)';

const SCOWL_URL =
  'http://app.aspell.net/create?max_size=60&spelling=US&max_variant=0&diacritic=strip&download=wordlist&encoding=utf-8&format=inline';
const GAZ_URL = 'https://www2.census.gov/geo/docs/maps-data/data/gazetteer/2026_Gazetteer/2026_Gaz_place_national.zip';

// Trailing legal/statistical suffixes (longest first). Stripped repeatedly from the end of a Gazetteer NAME.
const SUFFIXES = [
  'consolidated government',
  'metropolitan government',
  'unified government',
  'metro government',
  'zona urbana',
  'municipality',
  'corporation',
  'government',
  'comunidad',
  'borough',
  'village',
  'urbana',
  'county',
  'city',
  'town',
  'cdp',
];

/** Gazetteer NAME -> lowercase letters only (`losangeles`) plus the number of words in the real name (`Los Angeles` = 2). */
export function placeKey(name: string): { key: string; words: number } {
  let n = name.replace(/\([^)]*\)/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase();
  for (let again = true; again; ) {
    again = false;
    for (const s of SUFFIXES) {
      if (n.endsWith(' ' + s)) {
        n = n.slice(0, -s.length - 1).trim();
        again = true;
        break;
      }
    }
  }
  const words = n.split(/[\s-]+/).filter((w) => /[a-z]/.test(w)).length;
  return { key: n.replace(/[^a-z]/g, ''), words: Math.max(1, words) };
}

async function get(url: string): Promise<Buffer> {
  const r = await fetch(url, { headers: { 'User-Agent': UA } });
  if (!r.ok) throw new Error(`${url} -> HTTP ${r.status}`);
  return Buffer.from(await r.arrayBuffer());
}

const sha = (b: string | Buffer) => createHash('sha256').update(b).digest('hex');

async function main(): Promise<void> {
  mkdirSync(outDir, { recursive: true });

  // SCOWL: skip the licence header (everything up to the first "---" line), keep a-z words of length >= 2.
  const scowl = (await get(SCOWL_URL)).toString('utf8');
  const body = scowl.split(/^---$/m)[1] ?? '';
  const words = [...new Set(body.split('\n').map((w) => w.trim().toLowerCase()).filter((w) => /^[a-z]{2,}$/.test(w)))].sort();
  if (words.length < 50_000) throw new Error(`SCOWL list suspiciously small: ${words.length}`);
  const wordsTxt = words.join('\n') + '\n';
  writeFileSync(join(outDir, 'en-scowl-60.txt'), wordsTxt);

  // Gazetteer: pipe- or tab-delimited, header row with USPS and NAME columns.
  const zip = await get(GAZ_URL);
  const tmp = join(outDir, '.gaz.zip');
  writeFileSync(tmp, zip);
  const txt = execFileSync('unzip', ['-p', tmp], { maxBuffer: 64 * 1024 * 1024 }).toString('utf8');
  const lines = txt.split(/\r?\n/).filter(Boolean);
  const delim = lines[0]!.includes('|') ? '|' : '\t';
  const head = lines[0]!.split(delim).map((h) => h.trim());
  const iState = head.indexOf('USPS');
  const iName = head.indexOf('NAME');
  if (iState < 0 || iName < 0) throw new Error('Gazetteer header changed: ' + lines[0]);
  const pairs = new Set<string>();
  for (const l of lines.slice(1)) {
    const c = l.split(delim);
    const { key, words: nw } = placeKey(c[iName] ?? '');
    const st = (c[iState] ?? '').trim();
    if (key.length >= 3 && /^[A-Z]{2}$/.test(st)) pairs.add(`${key}\t${st}\t${nw}`);
  }
  const placesTxt = [...pairs].sort().join('\n') + '\n';
  writeFileSync(join(outDir, 'us-places.txt'), placesTxt);
  rmSync(tmp, { force: true });

  const total = Buffer.byteLength(wordsTxt) + Buffer.byteLength(placesTxt);
  console.log(`en-scowl-60.txt  lines=${words.length} bytes=${Buffer.byteLength(wordsTxt)} sha256=${sha(wordsTxt)}`);
  console.log(`us-places.txt    lines=${pairs.size} bytes=${Buffer.byteLength(placesTxt)} sha256=${sha(placesTxt)}`);
  console.log(`total bytes=${total}${total > 1_500_000 ? '  EXCEEDS 1.5 MB: stop and report (fallback: SCOWL size 50)' : ''}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
