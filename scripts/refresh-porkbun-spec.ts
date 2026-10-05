// Downloads the live Porkbun OpenAPI spec to a temp file and prints a diff summary against the
// committed snapshot. It NEVER overwrites the snapshot: to adopt a new version, review the diff,
// then copy the temp file over the snapshot by hand, update the .sha256, README and tests.
// Not run in tests (network). Usage: npm run contract:refresh-spec
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SPEC_URL = 'https://porkbun.com/api/json/v3/spec';
const SNAPSHOT = fileURLToPath(new URL('../tests/fixtures/porkbun-openapi-v3.53.json', import.meta.url));

type Spec = { info: { version: string }; paths: Record<string, Record<string, unknown>> };
const ops = (s: Spec): Set<string> =>
  new Set(Object.entries(s.paths).flatMap(([p, item]) => Object.keys(item).map((m) => `${m.toUpperCase()} ${p}`)));

const res = await fetch(SPEC_URL, { headers: { accept: 'application/json' } });
if (!res.ok) throw new Error(`GET ${SPEC_URL} -> HTTP ${res.status}`);
const text = await res.text();
const live = JSON.parse(text) as Spec;
const snap = JSON.parse(readFileSync(SNAPSHOT, 'utf8')) as Spec;

const out = join(mkdtempSync(join(tmpdir(), 'porkbun-spec-')), 'porkbun-openapi-live.json');
writeFileSync(out, text);

const a = ops(snap);
const b = ops(live);
const added = [...b].filter((x) => !a.has(x)).sort();
const removed = [...a].filter((x) => !b.has(x)).sort();
console.log(`snapshot version : ${snap.info.version}`);
console.log(`live version     : ${live.info.version}`);
console.log(`live sha256      : ${createHash('sha256').update(text).digest('hex')}`);
console.log(`operations added (${added.length}):${added.map((x) => `\n  + ${x}`).join('') || ' none'}`);
console.log(`operations removed (${removed.length}):${removed.map((x) => `\n  - ${x}`).join('') || ' none'}`);
console.log(`live spec saved to ${out} (the snapshot was NOT changed)`);
