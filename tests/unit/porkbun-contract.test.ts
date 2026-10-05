// Offline contract tests: the Porkbun adapter against the PINNED OpenAPI v3.53 snapshot
// (tests/fixtures/porkbun-openapi-v3.53.json). No network: MSW answers every request, and the
// snapshot is dereferenced from the local file only. Spec drift is handled per plan C3: fix the
// adapter to the spec, never weaken these tests.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import SwaggerParser from '@apidevtools/swagger-parser';
import { Ajv, type ValidateFunction } from 'ajv';
import _addFormats from 'ajv-formats';
import { http, HttpResponse } from 'msw';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PORKBUN_ENDPOINTS, PorkbunAdapter, type PorkbunEndpoint } from '../../src/registrars/porkbun.js';
import { AMBIGUOUS_CODES } from '../../src/registrars/types.js';
import { mswServer } from '../setup/network.js';
import { FAKE_KEYS, PORKBUN_BASE, record, recorded } from '../helpers/porkbun-msw.js';

const SPEC_FILE = fileURLToPath(new URL('../fixtures/porkbun-openapi-v3.53.json', import.meta.url));

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
let spec: Json; // dereferenced
let raw: Json; // as committed (keeps $refs, for text searches)

const ajv = new Ajv({ strict: false, allErrors: true }); // OpenAPI 3.0 `nullable` is handled natively by Ajv 8
// ajv-formats is CJS with a default export; under NodeNext the import is the namespace object.
const addFormats = ((_addFormats as unknown as { default?: unknown }).default ?? _addFormats) as (a: Ajv) => void;
addFormats(ajv);
const validator = (schema: Json): ValidateFunction => ajv.compile(schema);
const errs = (v: ValidateFunction) => JSON.stringify(v.errors);

beforeAll(async () => {
  raw = JSON.parse(readFileSync(SPEC_FILE, 'utf8')) as Json;
  // Local file only: no external or http resolution.
  spec = (await SwaggerParser.dereference(SPEC_FILE, { resolve: { external: false, http: false } })) as unknown as Json;
});
beforeEach(() => {
  recorded.length = 0;
});

const pb = () => new PorkbunAdapter({ ...FAKE_KEYS, timeoutMs: 500 });
const op = (ep: PorkbunEndpoint): Json => {
  const e = PORKBUN_ENDPOINTS[ep];
  return spec.paths[e.path]?.[e.method.toLowerCase()] as Json;
};
const reqSchema = (ep: PorkbunEndpoint): Json => op(ep).requestBody.content['application/json'].schema as Json;
const respSchema = (ep: PorkbunEndpoint): Json => op(ep).responses['200'].content['application/json'].schema as Json;

/** Documented example if the schema has one, else synthesised from the schema (every property). */
function synth(s: Json): unknown {
  if (s.example !== undefined) return s.example;
  if (s.enum) return s.enum[0];
  if (s.oneOf) return synth(s.oneOf[0] as Json);
  switch (s.type) {
    case 'object':
      return Object.fromEntries(Object.entries((s.properties ?? {}) as Json).map(([k, v]) => [
        k, k === 'status' && (v as Json).type === 'string' && !(v as Json).enum ? 'SUCCESS' : synth(v as Json),
      ]));
    case 'array':
      return [synth((s.items ?? {}) as Json)];
    case 'integer':
    case 'number':
      return 1;
    case 'boolean':
      return true;
    default:
      return 'x';
  }
}
function merge(base: unknown, over: unknown): unknown {
  if (over === null || typeof over !== 'object' || Array.isArray(over)) return over;
  const b = base !== null && typeof base === 'object' && !Array.isArray(base) ? (base as Json) : {};
  const out: Json = { ...b };
  for (const [k, v] of Object.entries(over as Json)) out[k] = merge(b[k], v);
  return out;
}
/**
 * Every override key path must exist in the response schema's `properties` (descending through properties/items),
 * so a field renamed in a refreshed snapshot fails here instead of being silently merged in. Map-like objects
 * (additionalProperties schema, no properties, e.g. `results`) are skipped.
 */
function assertOverridePaths(schema: Json, over: unknown, at: string): void {
  if (Array.isArray(over)) {
    for (const el of over) assertOverridePaths((schema.items ?? {}) as Json, el, `${at}[]`);
    return;
  }
  if (over === null || typeof over !== 'object') return;
  const branches: Json[] = [schema, ...((schema.allOf ?? []) as Json[]), ...((schema.oneOf ?? []) as Json[])];
  const props: Json = Object.assign({}, ...branches.map((b) => (b.properties ?? {}) as Json));
  if (Object.keys(props).length === 0 && typeof schema.additionalProperties === 'object') return; // map-like
  for (const [k, v] of Object.entries(over as Json)) {
    if (!(k in props)) throw new Error(`override path ${at}.${k} does not exist in the response schema`);
    assertOverridePaths(props[k] as Json, v, `${at}.${k}`);
  }
}
/** Sample response for an endpoint: synthesised, overridden with the values the test asserts on, and itself validated against the spec. */
function sample(ep: PorkbunEndpoint, over: Json, schema: Json = respSchema(ep)): Json {
  assertOverridePaths(schema, over, ep);
  const body = merge(synth(schema), over) as Json;
  const v = validator(schema);
  expect(v(body), `sample for ${ep} must satisfy the spec schema: ${errs(v)}`).toBe(true);
  return body;
}
function serve(ep: PorkbunEndpoint, body: Json): void {
  const { method, path } = PORKBUN_ENDPOINTS[ep];
  const url = `${PORKBUN_BASE}${path.replace(/\{(\w+)\}/g, ':$1')}`;
  mswServer.use((method === 'GET' ? http.get : http.post)(url, async ({ request }) => {
    await record(request);
    return HttpResponse.json(body);
  }));
}
/** Request-body validation. Credentials are documented as header-or-body (AuthRequest); we use headers only, so only the credential fields are dropped from `required`. */
function bodySchema(ep: PorkbunEndpoint): Json {
  const s = structuredClone(reqSchema(ep));
  s.required = ((s.required ?? []) as string[]).filter((k) => k !== 'apikey' && k !== 'secretapikey');
  return s;
}
function expectBodyMatchesSpec(ep: PorkbunEndpoint, req: { body: unknown; headers: Record<string, string> }): void {
  const schema = bodySchema(ep);
  const body = (req.body ?? {}) as Json;
  const v = validator(schema);
  expect(v(body), `${ep} body ${JSON.stringify(body)}: ${errs(v)}`).toBe(true);
  // No field the spec does not declare.
  const unknown = Object.keys(body).filter((k) => !(k in (schema.properties as Json)));
  expect(unknown, `${ep} sends undeclared fields`).toEqual([]);
  // Auth stays in headers, never in the body (founder rule 7).
  expect(body).not.toHaveProperty('apikey');
  expect(body).not.toHaveProperty('secretapikey');
  expect(req.headers['x-api-key']).toBe(FAKE_KEYS.apiKey);
  expect(req.headers['x-secret-api-key']).toBe(FAKE_KEYS.secretKey);
  expect(JSON.stringify(req.body)).not.toContain(FAKE_KEYS.secretKey);
}

const DOMAIN = 'example.com';

describe('Porkbun contract (pinned OpenAPI v3.53, offline)', () => {
  it('PK-C1: every (method, path) in PORKBUN_ENDPOINTS exists in the snapshot; no top-up endpoint', () => {
    for (const [name, e] of Object.entries(PORKBUN_ENDPOINTS)) {
      const item = raw.paths[e.path] as Json | undefined;
      expect(item, `${name}: path ${e.path} missing from snapshot`).toBeDefined();
      expect(item?.[e.method.toLowerCase()], `${name}: ${e.method} ${e.path} missing from snapshot`).toBeDefined();
      expect(e.path.toLowerCase()).not.toContain('topup');
    }
  });

  it('PK-C2: request bodies the adapter sends validate against the snapshot requestBody schemas', async () => {
    const a = pb();
    serve('checkDomain', sample('checkDomain', { response: { avail: 'yes', premium: 'no', price: '9.73', additional: { renewal: { price: '10.98' } } } }));
    await a.quote(DOMAIN);
    expectBodyMatchesSpec('checkDomain', recorded.pop()!);

    serve('create', sample('create', { cost: 973 }, (respSchema('create') as Json).oneOf[0] as Json));
    await a.register(DOMAIN, { costCents: 973, idempotencyKey: 'dt-1', dryRun: false });
    const real = recorded.pop()!;
    expectBodyMatchesSpec('create', real);
    expect(real.body).toMatchObject({ cost: 973, agreeToTerms: 'yes' });
    expect(real.body).not.toHaveProperty('dryRun');

    serve('create', sample('create', { dryRun: true, wouldSucceed: true, cost: 973, duration: 1 }, (respSchema('create') as Json).oneOf[1] as Json));
    await a.register(DOMAIN, { costCents: 973, idempotencyKey: 'dt-2', dryRun: true });
    const dry = recorded.pop()!;
    expectBodyMatchesSpec('create', dry);
    expect(dry.body).toMatchObject({ cost: 973, dryRun: true });

    serve('updateNs', sample('updateNs', { status: 'SUCCESS' }));
    await a.setNameservers(DOMAIN, ['ns1.afternic.com', 'ns2.afternic.com']);
    expectBodyMatchesSpec('updateNs', recorded.pop()!);

    serve('updateAutoRenew', sample('updateAutoRenew', { results: { [DOMAIN]: { status: 'SUCCESS' } } }));
    await a.setAutoRenew(DOMAIN, false);
    const ar = recorded.pop()!;
    expectBodyMatchesSpec('updateAutoRenew', ar);
    expect(ar.body).toMatchObject({ status: 'off' });

    serve('getNs', sample('getNs', { ns: ['ns1.afternic.com'] }));
    await a.getNameservers(DOMAIN);
    expectBodyMatchesSpec('getNs', recorded.pop()!);

    // GET endpoints: no body, and the query parameters are declared by the spec with matching constraints.
    let query = '';
    mswServer.use(http.get(`${PORKBUN_BASE}/account/invoices`, async ({ request }) => {
      query = new URL(request.url).search;
      await record(request);
      return HttpResponse.json(sample('invoices', { invoices: [] }));
    }));
    await a.findRegistration(DOMAIN, { since: `${new Date().getUTCFullYear()}-01-01` });
    const inv = recorded.pop()!;
    expect(inv.body).toBeNull();
    expect(inv.headers['x-api-key']).toBe(FAKE_KEYS.apiKey);
    const params = op('invoices').parameters as Json[];
    const sent = [...new URLSearchParams(query)];
    expect(sent.length).toBeGreaterThan(0);
    for (const [k, val] of sent) {
      const p = params.find((x) => x.in === 'query' && x.name === k);
      expect(p, `query param ${k} is not declared by the spec`).toBeDefined();
      const v = validator(p!.schema as Json);
      expect(v(Number(val)), `query ${k}=${val}: ${errs(v)}`).toBe(true);
    }
  });

  it('PK-C3: documented example/synthesised responses parse and map to the right values', async () => {
    const a = pb();

    serve('checkDomain', sample('checkDomain', {
      response: { avail: 'yes', premium: 'no', price: '9.73', minDuration: 1, additional: { renewal: { price: '10.98' } } },
    }));
    const q = await a.quote(DOMAIN);
    expect(q).toMatchObject({ available: true, premium: false, firstYearCents: 973, renewalCents: 1098, minDurationYears: 1 });

    // Documented examples of /domain/create (live registration and dry run).
    const ex = op('create').responses['200'].content['application/json'].examples as Json;
    serve('create', ex.registered.value as Json);
    const real = await a.register(DOMAIN, { costCents: 973, idempotencyKey: 'dt-1', dryRun: false });
    expect(real).toMatchObject({ kind: 'registered', orderId: '12345678', chargedCents: 973, balanceCents: 4027 });
    serve('create', ex.dryRun.value as Json);
    const dry = await a.register(DOMAIN, { costCents: 973, idempotencyKey: 'dt-2', dryRun: true });
    expect(dry).toMatchObject({ kind: 'dry_run', wouldSucceed: true, costCents: 973, durationYears: 1, balanceCents: 5000 });

    serve('getNs', sample('getNs', { ns: ['NS2.Afternic.com.', 'ns1.afternic.com'] }));
    expect([...(await a.getNameservers(DOMAIN))].sort()).toEqual(['ns1.afternic.com', 'ns2.afternic.com']);

    serve('getDomain', sample('getDomain', {
      domain: { domain: DOMAIN, expireDate: '2027-10-04 13:16:00', whoisPrivacy: 1, autoRenew: 0, apiAccess: 1 },
    }));
    const info = await a.findDomain(DOMAIN);
    expect(info).toEqual({ expiryDate: '2027-10-04', whoisPrivacy: true, autoRenew: false, apiAccess: true, ns: ['ns1.afternic.com', 'ns2.afternic.com'] });

    serve('balance', sample('balance', { balance: 4027, display: '$40.27' }));
    serve('apiSettings', sample('apiSettings', { settings: { autoTopup: false }, spendLimit: { remaining: 8027 } }));
    expect(await a.accountState()).toEqual({ balanceCents: 4027, spendLimitRemainingCents: 8027, autoTopupEnabled: false });

    serve('updateAutoRenew', sample('updateAutoRenew', { results: { [DOMAIN]: { status: 'SUCCESS' } } }));
    await expect(a.setAutoRenew(DOMAIN, false)).resolves.toBeUndefined();

    // Invoice line amount: charged = price_cents - discount_cents.
    const since = `${new Date().getUTCFullYear()}-01-01`;
    serve('invoices', sample('invoices', {
      invoices: [{ id: 555, date: `${new Date().getUTCFullYear()}-09-30`, state: 'PAID', total_cents: 973, domains: [DOMAIN] }],
    }));
    serve('invoice', sample('invoice', {
      invoice: {
        id: 555, state: 'PAID',
        items: [{ domain: DOMAIN, product: 'Domain Registration', status: 'SUCCESS', expires: '2027-09-30 10:00:00', price_cents: 1073, discount_cents: 100 }],
      },
    }));
    const rec = await a.findRegistration(DOMAIN, { since });
    expect(rec).toMatchObject({ orderId: '555', chargedCents: 973, expiryDate: '2027-09-30' });
    const receipt = (await a.getReceipt('555')) as Json;
    expect(receipt.invoice.items[0].price_cents).toBe(1073);
    expect(JSON.stringify(receipt)).not.toMatch(/billTo|paymentMethods|downloadUrl/);
  });

  it('PK-C4: every error code the adapter or its callers branch on is documented in the snapshot', () => {
    const documented = (code: string): boolean => {
      // Documented either in the error-code tables (`CODE`) or in prose (e.g. `code: CODE` in the Idempotency section).
      const word = new RegExp(`\\b${code}\\b`);
      return word.test(raw.info.description as string) || word.test(JSON.stringify(raw.paths));
    };
    // REGISTRAR_TIMEOUT / _NETWORK / _HTTP_5XX / _BAD_RESPONSE are adapter-local transport codes (ours, not Porkbun's).
    const adapterLocal = /^REGISTRAR_/;
    const fromAmbiguous = AMBIGUOUS_CODES.filter((c) => !adapterLocal.test(c));
    // Codes porkbun.ts and buy.ts/list.ts match by name on RegistrarError.code.
    const branchedOn = [
      'DOMAIN_NOT_FOUND', 'API_ACCESS_DISABLED', 'COST_MISMATCH', 'INSUFFICIENT_FUNDS',
      'MONTHLY_SPEND_LIMIT_EXCEEDED', 'IDEMPOTENCY_KEY_MISMATCH', 'IDEMPOTENCY_KEY_IN_USE',
    ];
    const missing = [...new Set([...fromAmbiguous, ...branchedOn])].filter((c) => !documented(c));
    expect(missing, `codes absent from the snapshot: ${missing.join(', ')}`).toEqual([]);
    // Error bodies carry a machine-readable `code` (the adapter reads it, never `message`).
    expect(spec.components.schemas.ErrorResponse.properties.code.type).toBe('string');
  });

  it('PK-C5: domain/create sends Idempotency-Key, spelled as in the snapshot', async () => {
    const specName = (raw.components.parameters.IdempotencyKeyHeader as Json).name as string;
    expect(specName).toBe('Idempotency-Key');
    expect(raw.info.description as string).toContain(`${specName}:`);
    serve('create', sample('create', { cost: 973 }, (respSchema('create') as Json).oneOf[0] as Json));
    await pb().register(DOMAIN, { costCents: 973, idempotencyKey: 'dt-key-9', dryRun: false });
    expect(recorded.pop()!.headers[specName.toLowerCase()]).toBe('dt-key-9');
    // maxLength 255 documented: the schema is the contract for the key we generate.
    expect((raw.components.parameters.IdempotencyKeyHeader as Json).schema.maxLength).toBe(255);
  });

  it('PK-C3b: sample() rejects an override path that is not in the response schema', () => {
    expect(() => sample('balance', { balanceRenamed: 1 })).toThrow(/does not exist in the response schema/);
    expect(() => sample('checkDomain', { response: { nope: 'x' } })).toThrow(/does not exist/);
  });

  it('PK-C7: expandPath throws on a missing template param', async () => {
    const { expandPath } = await import('../../src/registrars/porkbun.js');
    expect(expandPath('/domain/get/{domain}', { domain: 'a.com' })).toBe('/domain/get/a.com');
    expect(() => expandPath('/domain/get/{domain}', {})).toThrow(/missing path param: domain/);
  });

  it('PK-C6: snapshot integrity: sha256 matches the .sha256 file; spec version is 3.53', () => {
    const digest = createHash('sha256').update(readFileSync(SPEC_FILE)).digest('hex');
    const expected = readFileSync(`${SPEC_FILE}.sha256`, 'utf8').trim().split(/\s+/)[0];
    expect(digest).toBe(expected);
    expect(raw.info.version).toBe('3.53');
  });
});
