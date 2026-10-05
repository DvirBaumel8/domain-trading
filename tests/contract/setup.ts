// Setup for the opt-in contract projects (porkbun-mock, porkbun-sandbox). Unlike tests/setup/network.ts
// this lets requests out, but ONLY to api.porkbun.com (plus the public OpenAPI spec URL, which Porkbun
// serves from porkbun.com and 403s on api.porkbun.com). Any other host fails the test.
// Credentials never leave in a request to the mock server: the guard strips them there.
import { afterEach, beforeAll, expect } from 'vitest';

const ALLOWED_HOST = 'api.porkbun.com';
const SPEC_URL = 'https://porkbun.com/api/json/v3/spec';
const CREDENTIAL_HEADERS = ['x-api-key', 'x-secret-api-key'];

export const violations: string[] = [];

const realFetch = globalThis.fetch;

function urlOf(input: Parameters<typeof fetch>[0]): URL {
  return new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
}

beforeAll(() => {
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = urlOf(input);
    if (url.host !== ALLOWED_HOST && url.href !== SPEC_URL) {
      const msg = `contract tests may only call ${ALLOWED_HOST}; blocked ${url.origin}${url.pathname}`;
      violations.push(msg);
      throw new Error(msg);
    }
    // The mock project may only touch /mock paths on the real API host: nothing authenticated can leave.
    if (process.env.CONTRACT_MOCK_ONLY && url.host === ALLOWED_HOST && !url.pathname.startsWith('/api/json/v3/mock')) {
      const msg = `porkbun-mock may only call /api/json/v3/mock; blocked ${url.pathname}`;
      violations.push(msg);
      throw new Error(msg);
    }
    let nextInit = init;
    if (url.pathname.includes('/api/json/v3/mock')) {
      const headers = new Headers(init?.headers);
      for (const h of CREDENTIAL_HEADERS) headers.delete(h);
      nextInit = { ...init, headers };
    }
    const res = await realFetch(input, nextInit);
    if (url.pathname.includes('/api/json/v3/mock') && res.headers.get('x-porkbun-mock') !== 'true') {
      const msg = `response from ${url.pathname} lacks X-Porkbun-Mock: true; this is not the mock server`;
      violations.push(msg);
      throw new Error(msg);
    }
    return res;
  }) as typeof fetch;
});

afterEach(() => {
  expect(violations, 'network guard violations').toEqual([]);
});
