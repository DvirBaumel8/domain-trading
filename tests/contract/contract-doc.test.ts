/**
 * The interface contract (docs/contract/) must cover what the code actually serves and emits.
 * Offline: the app is built against a DB URL that is never connected to (no query runs while registering routes).
 *  - every registered route (method + path) appears in endpoints.md, and every route documented there exists;
 *  - every error/warning code string the API code can emit appears somewhere in docs/contract/.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app.js';
import { loadConfig } from '../../src/config.js';
import { createDb } from '../../src/db/client.js';
import { testEnv } from '../helpers/env.js';

const ROOT = join(import.meta.dirname, '..', '..');
const CONTRACT = join(ROOT, 'docs', 'contract');
const read = (p: string) => readFileSync(p, 'utf8');
const walk = (d: string): string[] =>
  readdirSync(d).flatMap((f) => { const p = join(d, f); return statSync(p).isDirectory() ? walk(p) : [p]; });

const endpointsMd = read(join(CONTRACT, 'endpoints.md'));
const contractText = walk(CONTRACT).filter((f) => f.endsWith('.md')).map(read).join('\n');

/** `/list/:domain` → `/list/{domain}` (the notation the contract uses). */
const docPath = (url: string) => url.replace(/:([A-Za-z_]+)/g, '{$1}');

describe('contract: routes', () => {
  let app: FastifyInstance;
  const db = createDb('postgres://contract-doc:unused@127.0.0.1:1/unused');
  beforeAll(async () => {
    app = await buildApp({ config: loadConfig(testEnv()), db, logger: false });
    await app.ready();
  });
  afterAll(async () => {
    await app.close();
    await db.destroy();
  });

  // HEAD is served automatically for every GET (Fastify); the contract states that once instead of per route.
  const routes = () => [...new Set(app.routeTable.filter((r) => r.method !== 'HEAD').map((r) => `${r.method} ${docPath(r.url)}`))].sort();

  it('every registered route appears in endpoints.md', () => {
    expect(routes().length).toBeGreaterThan(10);
    const missing = routes().filter((r) => !endpointsMd.includes(`\`${r}\``));
    expect(missing).toEqual([]);
  });

  it('every route documented in endpoints.md (### `METHOD /path` headings) is registered', () => {
    const documented = [...endpointsMd.matchAll(/^### `([A-Z]+ \/[^`]*)`/gm)].map((m) => m[1]!);
    expect(documented.length).toBeGreaterThan(10);
    const known = new Set(routes());
    expect(documented.filter((r) => !known.has(r))).toEqual([]);
    expect(new Set(documented).size).toBe(documented.length);
  });
});

describe('contract: codes', () => {
  /** Admin and job CLIs are DOM-internal (docs/internal/cli.md), not the API. */
  const CLI_ONLY = ['src/admin', 'src/admin.ts', 'src/job.ts', 'src/jobs/backup-import.ts'];
  /** UPPER_SNAKE literals in src that are not codes the API emits. */
  const NOT_CODES = new Set([
    'FST_ERR_VALIDATION', // Fastify's internal code; answered as VALIDATION_ERROR
    'PARTIALLY_REFUNDED', // a Porkbun invoice state the adapter reads
  ]);
  const envNames = new Set([...read(join(ROOT, '.env.example')).matchAll(/^#?\s*([A-Z][A-Z0-9_]+)=/gm)].map((m) => m[1]!));

  const files = walk(join(ROOT, 'src')).filter((f) => f.endsWith('.ts'))
    .filter((f) => { const r = relative(ROOT, f); return !CLI_ONLY.some((c) => r === c || r.startsWith(`${c}/`)); });
  const codes = new Map<string, string>();
  const PATTERNS = [
    /[`'"]([A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+)(?=[`'":\s$])/g, // UPPER_SNAKE string literals ('CODE', 'CODE: message', `CODE:${x}`)
    /AppError\(\s*\d+,\s*'([A-Z][A-Z0-9_]*)'/g, // one-word codes thrown as AppError (UNAUTHORIZED)
    /errorBody\(\s*'([A-Z][A-Z0-9_]*)'/g, // one-word codes in a raw error body (INTERNAL)
    /exclude\(\s*'([A-Z][A-Z0-9_]*)'/g, // one-word /check exclusion reasons (PREMIUM)
  ];
  for (const f of files) {
    const text = read(f);
    for (const re of PATTERNS) {
      for (const m of text.matchAll(re)) {
        const c = m[1]!;
        if (!envNames.has(c) && !NOT_CODES.has(c) && !codes.has(c)) codes.set(c, relative(ROOT, f));
      }
    }
  }

  it('finds the codes it is meant to find', () => {
    for (const c of ['UNAUTHORIZED', 'INTERNAL', 'PREMIUM', 'POC_CAP_EXCEEDED', 'NS_PENDING', 'SALE_UNCONFIRMED']) expect(codes.has(c), c).toBe(true);
    expect(codes.has('DATABASE_URL')).toBe(false);
  });

  it('every code the API code can emit appears in docs/contract/', () => {
    const missing = [...codes].filter(([c]) => !new RegExp(`\\b${c}\\b`).test(contractText)).map(([c, f]) => `${c} (${f})`);
    expect(missing).toEqual([]);
  });
});
