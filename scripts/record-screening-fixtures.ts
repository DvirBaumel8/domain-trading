// Opt-in recorder for the screening fixtures (tests/fixtures/screening/). Never imported by src/ or by tests.
//   RECORD_FIXTURES=1 npm run record:screening -- rdap promptinjectionaudit.com google.com
//   RECORD_FIXTURES=1 npm run record:screening -- iana
//   RECORD_FIXTURES=1 npm run record:screening -- rdap-ext netextend net org co io ai info us
// Real requests, paced by the settings' run.rdap_min_ms_between, honest User-Agent. Each file: {url, status, headers, body}.
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RDAP_COM_BASE, USER_AGENT } from '../src/rdap.js';
import { IANA_RDAP_URL, parseBootstrap } from '../src/screening/rdap-batch.js';
import { DEFAULT_SELECTION_VALUES } from '../src/screening/settings.js';

if (process.env.RECORD_FIXTURES !== '1') {
  console.error('Refusing to run: set RECORD_FIXTURES=1 (this script makes real network requests).');
  process.exit(2);
}

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'tests', 'fixtures', 'screening');
const PACE_MS = DEFAULT_SELECTION_VALUES.run.rdap_min_ms_between;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Fixture { url: string; status: number; headers: { 'content-type': string | null; 'retry-after': string | null }; body: string }

async function get(url: string, accept: string): Promise<Fixture> {
  const res = await fetch(url, { headers: { accept, 'user-agent': USER_AGENT }, signal: AbortSignal.timeout(15_000) });
  const body = await res.text();
  await sleep(PACE_MS);
  return { url, status: res.status, headers: { 'content-type': res.headers.get('content-type'), 'retry-after': res.headers.get('retry-after') }, body };
}

/** Keeps what the parser reads (ldhName, events, status, registrar fn, nameserver names); drops notices, links, contacts, DNSSEC. */
function trimRdap(body: string): string {
  let j: Record<string, unknown>;
  try { j = JSON.parse(body) as Record<string, unknown>; } catch { return body; }
  const entities = (Array.isArray(j.entities) ? (j.entities as Record<string, unknown>[]) : []).filter((e) => Array.isArray(e.roles) && e.roles.includes('registrar'))
    .map((e) => ({ roles: e.roles, vcardArray: e.vcardArray }));
  const ns = (Array.isArray(j.nameservers) ? (j.nameservers as Record<string, unknown>[]) : []).map((n) => ({ ldhName: n.ldhName }));
  return JSON.stringify({ objectClassName: j.objectClassName, ldhName: j.ldhName, status: j.status, events: j.events, entities, nameservers: ns });
}

function save(rel: string, f: Fixture): void {
  const p = join(OUT, rel);
  mkdirSync(dirname(p), { recursive: true });
  const text = `${JSON.stringify(f, null, 2)}\n`;
  writeFileSync(p, text);
  console.log(`${rel}\t${f.status}\t${Buffer.byteLength(text)} bytes`);
}

async function bootstrap(): Promise<{ fixture: Fixture; map: Map<string, string> }> {
  const f = await get(IANA_RDAP_URL, 'application/json');
  const full = parseBootstrap(f.body);
  // Trimmed to the extensions the tests use. co, io and us are NOT in the fixture because they are cut here; that the real bootstrap
  // has no entry for them is recorded in docs/internal/sources.md (the recorder's own output, from the untrimmed file).
  const keep = new Set(['com', 'net', 'org', 'info', 'ai']);
  const j = JSON.parse(f.body) as { services: [string[], string[]][]; publication?: string; version?: string; description?: string };
  const services = j.services.filter((s) => s[0].some((t) => keep.has(t))).map((s): [string[], string[]] => [s[0].filter((t) => keep.has(t)), s[1]]);
  const trimmed = JSON.stringify({ description: j.description, publication: j.publication, services, version: j.version });
  return { fixture: { ...f, body: trimmed }, map: full.map };
}

const [mode, ...args] = process.argv.slice(2);
if (mode === 'rdap') {
  for (const d of args) {
    const f = await get(`${RDAP_COM_BASE}domain/${d}`, 'application/rdap+json');
    save(`rdap/${d.replace(/\./g, '_')}.json`, { ...f, body: f.status === 200 ? trimRdap(f.body) : f.body.slice(0, 2000) });
  }
} else if (mode === 'iana') {
  const { fixture } = await bootstrap();
  save('iana-dns.json', fixture);
} else if (mode === 'rdap-ext') {
  const [sld, ...tlds] = args;
  const { map } = await bootstrap();
  for (const tld of tlds) {
    const base = tld === 'com' ? RDAP_COM_BASE : map.get(tld);
    if (!base) { console.log(`${sld}.${tld}\tno RDAP base in the IANA bootstrap: nothing recorded`); continue; }
    const f = await get(`${base}domain/${sld}.${tld}`, 'application/rdap+json');
    save(`rdap-ext/${sld}_${tld}.json`, { ...f, body: f.status === 200 ? trimRdap(f.body) : f.body.slice(0, 2000) });
  }
} else {
  console.error('usage: rdap <domain…> | iana | rdap-ext <sld> <tld…>');
  process.exit(2);
}
