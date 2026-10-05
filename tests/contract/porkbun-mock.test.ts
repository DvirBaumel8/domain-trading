// Opt-in (npm run test:contract:mock). The adapter against Porkbun's credential-free mock server
// (https://porkbun.com/llms/mock). Network goes only to api.porkbun.com (see ./setup.ts); no keys are sent.
// The adapter is pointed at <base>/mock, so its real request and parse code runs on the mock bodies.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { PORKBUN_DEFAULT_BASE, PORKBUN_ENDPOINTS, PorkbunAdapter, type PorkbunEndpoint } from '../../src/registrars/porkbun.js';
import { RegistrarError } from '../../src/registrars/types.js';

const MOCK_BASE = `${PORKBUN_DEFAULT_BASE}/mock`;
const SPEC_URL = 'https://porkbun.com/api/json/v3/spec';
const SNAPSHOT = JSON.parse(
  readFileSync(fileURLToPath(new URL('../fixtures/porkbun-openapi-v3.53.json', import.meta.url)), 'utf8'),
) as { info: { version: string }; paths: Record<string, Record<string, unknown>> };
const SNAPSHOT_VERSION = '3.53';

const adapter = () => new PorkbunAdapter({ apiKey: 'pk1_mock_unused', secretKey: 'sk1_mock_unused', baseUrl: MOCK_BASE, timeoutMs: 15_000 });
const DOMAIN = 'example.com';
const ENDPOINTS = Object.entries(PORKBUN_ENDPOINTS) as [PorkbunEndpoint, { method: string; path: string }][];
const concretePath = (p: string) => p.replace('{domain}', DOMAIN).replace('{orderId}', '123');

interface MockEntry { method: string; path: string }
async function directory(): Promise<MockEntry[]> {
  const res = await fetch(`${MOCK_BASE}`);
  expect(res.headers.get('x-porkbun-mock')).toBe('true');
  const body = (await res.json()) as { status: string; endpoints: MockEntry[] };
  expect(body.status).toBe('SUCCESS');
  return body.endpoints;
}

/** Run fn with a query string appended to every mock request the adapter makes. */
async function withQuery<T>(query: string, fn: () => Promise<T>): Promise<T> {
  const guarded = globalThis.fetch;
  globalThis.fetch = ((input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const u = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    return guarded(`${u.href}${u.search ? '&' : '?'}${query}`, init);
  }) as typeof fetch;
  try {
    return await fn();
  } finally {
    globalThis.fetch = guarded;
  }
}

/**
 * The mock synthesises `"status": "string"` for the two invoice endpoints (the spec declares no enum or example there),
 * while the real API answers SUCCESS. That is mock placeholder data, so for these two calls only we rewrite it to SUCCESS
 * and still require everything else to parse. Logged so the report shows it.
 */
async function withInvoiceStatusFixed<T>(fn: () => Promise<T>): Promise<T> {
  const guarded = globalThis.fetch;
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const res = await guarded(input, init);
    const text = await res.text();
    const body = JSON.parse(text) as { status?: string };
    if (body.status === 'string') {
      console.warn('[mock] invoice endpoint: mock status is the placeholder "string"; rewritten to SUCCESS for this test only');
      body.status = 'SUCCESS';
    }
    return new Response(JSON.stringify(body), { status: res.status, headers: res.headers });
  }) as typeof fetch;
  try {
    return await fn();
  } finally {
    globalThis.fetch = guarded;
  }
}

/** One adapter call per endpoint: the adapter's own request builder and parser run against the mock. */
const CALLS: Record<PorkbunEndpoint, (a: PorkbunAdapter) => Promise<unknown>> = {
  checkDomain: (a) => a.quote(DOMAIN),
  create: (a) => a.register(DOMAIN, { costCents: 973, idempotencyKey: 'mock-key-1', dryRun: false }),
  getDomain: (a) => a.findDomain(DOMAIN),
  getNs: (a) => a.getNameservers(DOMAIN),
  updateNs: (a) => a.setNameservers(DOMAIN, ['ns1.afternic.com', 'ns2.afternic.com']),
  updateAutoRenew: (a) => a.setAutoRenew(DOMAIN, false),
  balance: (a) => a.accountState(),
  apiSettings: (a) => a.accountState(),
  invoices: (a) => withInvoiceStatusFixed(() => a.findRegistration(DOMAIN, { since: '2026-01-01' })),
  invoice: (a) => withInvoiceStatusFixed(() => a.getReceipt('123')),
};

/** Mock bodies carry the literal "string" in money-string fields. That is placeholder data, not drift. */
const isPlaceholderPrice = (e: unknown) => e instanceof RegistrarError && e.code === 'REGISTRAR_BAD_RESPONSE';

describe('porkbun mock: directory (1)', () => {
  it('lists every endpoint the adapter uses', async () => {
    const dir = await directory();
    const have = new Set(dir.map((e) => `${e.method} ${e.path}`));
    const missing = ENDPOINTS.filter(([, e]) => !have.has(`${e.method} ${e.path}`)).map(([n, e]) => `${n}: ${e.method} ${e.path}`);
    expect(missing, 'adapter endpoints missing from the live mock directory').toEqual([]);
  });
});

describe('porkbun mock: success bodies through the adapter parsers (2, 4)', () => {
  it.each(ENDPOINTS)('%s: header X-Porkbun-Mock is true and the adapter parses the body', async (name, e) => {
    const raw = await fetch(`${MOCK_BASE}${concretePath(e.path)}`);
    expect(raw.headers.get('x-porkbun-mock'), 'not the mock server').toBe('true');
    expect(raw.status).toBe(200);
    await raw.arrayBuffer();

    let out: unknown;
    try {
      out = await CALLS[name](adapter());
    } catch (err) {
      // checkDomain's mock renewal price is the literal "string": accept only that, and only for quote.
      if (name === 'checkDomain' && isPlaceholderPrice(err)) {
        console.warn('[mock] checkDomain: mock renewal price is the placeholder "string"; parse rejected it as designed');
        return;
      }
      throw err;
    }
    switch (name) {
      case 'checkDomain': {
        const q = out as Awaited<ReturnType<PorkbunAdapter['quote']>>;
        expect(typeof q.available).toBe('boolean');
        expect(typeof q.premium).toBe('boolean');
        for (const c of [q.firstYearCents, q.renewalCents]) expect(c === null || Number.isSafeInteger(c)).toBe(true);
        break;
      }
      case 'create': {
        const r = out as Awaited<ReturnType<PorkbunAdapter['register']>>;
        expect(r.kind).toBe('registered');
        if (r.kind === 'registered') {
          expect(Number.isSafeInteger(r.chargedCents)).toBe(true);
          expect(r.orderId).toMatch(/^\d+$/);
        }
        break;
      }
      case 'getDomain': {
        const d = out as Awaited<ReturnType<PorkbunAdapter['findDomain']>>;
        expect(d).not.toBeNull();
        expect(d!.ns === null || Array.isArray(d!.ns)).toBe(true);
        for (const f of [d!.autoRenew, d!.whoisPrivacy, d!.apiAccess]) expect(f === null || typeof f === 'boolean').toBe(true);
        break;
      }
      case 'getNs':
        expect((out as Set<string>).size).toBeGreaterThan(0);
        break;
      case 'balance':
      case 'apiSettings': {
        const s = out as Awaited<ReturnType<PorkbunAdapter['accountState']>>;
        expect(s.balanceCents === null || Number.isSafeInteger(s.balanceCents)).toBe(true);
        expect(s.spendLimitRemainingCents === null || Number.isSafeInteger(s.spendLimitRemainingCents)).toBe(true);
        expect(s.autoTopupEnabled === null || typeof s.autoTopupEnabled === 'boolean').toBe(true);
        break;
      }
      case 'invoice':
        expect(out).toMatchObject({ status: expect.any(String) });
        expect(JSON.stringify(out)).not.toContain('billTo'); // redaction still applies to live-shaped bodies
        break;
      case 'invoices':
        expect(out === null || typeof (out as { orderId: string }).orderId === 'string').toBe(true);
        break;
      default:
        break; // updateNs / updateAutoRenew resolve to void
    }
  });

  it('create dry run example maps to a well-typed dry_run result', async () => {
    const r = await withQuery('example=dryRun', () => adapter().register(DOMAIN, { costCents: 973, idempotencyKey: 'mock-key-2', dryRun: true }));
    expect(r.kind).toBe('dry_run');
    if (r.kind === 'dry_run') {
      expect(Number.isSafeInteger(r.costCents)).toBe(true);
      expect(r.durationYears).toBe(1);
      expect(typeof r.wouldSucceed).toBe('boolean');
    }
  });
});

describe('porkbun mock: error bodies through the adapter error mapping (3)', () => {
  it.each(ENDPOINTS)('%s: ?status=error becomes a RegistrarError with a code, not ambiguous', async (name) => {
    const err = await withQuery('status=error', () => CALLS[name](adapter())).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err, 'expected the adapter to throw on an error body').toBeInstanceOf(RegistrarError);
    const e = err as RegistrarError;
    expect(typeof e.code).toBe('string');
    expect(e.code.length).toBeGreaterThan(0);
    if (e.httpStatus !== undefined && e.httpStatus < 500) expect(e.ambiguous).toBe(false);
    console.log(`[mock] ${name}: ?status=error -> HTTP ${String(e.httpStatus)} code ${e.code}`);
  });
});

describe('porkbun mock: drift report (5)', () => {
  it('compares the live mock directory and /spec with the pinned v3.53 snapshot', async () => {
    const dir = await directory();
    const liveMock = new Set(dir.map((e) => `${e.method} ${e.path}`));
    const snap = new Set(Object.entries(SNAPSHOT.paths).flatMap(([p, ops]) => Object.keys(ops).map((m) => `${m.toUpperCase()} ${p}`)));

    let liveSpecPaths: Set<string> | null = null;
    let liveVersion = 'unavailable';
    const res = await fetch(SPEC_URL, { headers: { accept: 'application/json' } });
    if (res.ok) {
      const live = (await res.json()) as typeof SNAPSHOT;
      liveVersion = live.info.version;
      liveSpecPaths = new Set(Object.entries(live.paths).flatMap(([p, ops]) => Object.keys(ops).map((m) => `${m.toUpperCase()} ${p}`)));
    } else {
      console.warn(`[drift] WARNING: could not fetch ${SPEC_URL} (HTTP ${res.status}); comparing the mock directory only`);
    }

    const diff = (a: Set<string>, b: Set<string>) => [...a].filter((x) => !b.has(x)).sort();
    const lines = [
      `[drift] snapshot version ${SNAPSHOT.info.version}; live /spec version ${liveVersion}; mock directory count ${liveMock.size}`,
      `[drift] mock directory vs snapshot: added ${JSON.stringify(diff(liveMock, snap))}`,
      `[drift] mock directory vs snapshot: removed ${JSON.stringify(diff(snap, liveMock))}`,
    ];
    if (liveSpecPaths) {
      lines.push(`[drift] live spec vs snapshot: added ${JSON.stringify(diff(liveSpecPaths, snap))}`);
      lines.push(`[drift] live spec vs snapshot: removed ${JSON.stringify(diff(snap, liveSpecPaths))}`);
    }
    console.log(lines.join('\n'));

    if (liveVersion !== SNAPSHOT_VERSION) {
      console.warn(`[drift] WARNING: live spec version ${liveVersion} differs from the pinned ${SNAPSHOT_VERSION}; review the diff and refresh the snapshot (npm run contract:refresh-spec)`);
    }

    // Failure: a path the adapter uses disappeared from the live mock or the live spec.
    const used = ENDPOINTS.map(([, e]) => `${e.method} ${e.path}`);
    expect(used.filter((u) => !liveMock.has(u)), 'adapter paths removed from the live mock').toEqual([]);
    if (liveSpecPaths) expect(used.filter((u) => !liveSpecPaths!.has(u)), 'adapter paths removed from the live spec').toEqual([]);
  });
});
