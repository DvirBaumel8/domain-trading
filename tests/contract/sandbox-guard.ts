// Safety guard for the porkbun-sandbox project (founder rule 12; plan "Sandbox safety guard").
// Every sandbox test goes through this file:
//  - keys come from env PORKBUN_SANDBOX_* or a throwaway pair from POST /apikey/request {"sandbox":true};
//    both prefixes (pk1_sb_ / sk1_sb_) are asserted before ANY other request, else the project aborts;
//  - the real-account env vars (PORKBUN_API_KEY / PORKBUN_SECRET_API_KEY) are never read here;
//  - installGuardFetch() wraps fetch: a request carrying a non-sandbox key never leaves, only an allowlist of
//    Porkbun paths may be called (the adapter's own plus the sandbox-only /sandbox/reset; no top-up of any kind, founder rule 6),
//    and every response must say it is a sandbox (header and, where documented, body.sandbox === true).
//  - no top-up of a real account: /account/topup*, /account/autoTopup are never allowed.
import { PORKBUN_ENDPOINTS } from '../../src/modules/registrars/porkbun.js';

export const SANDBOX_BASE = 'https://api.porkbun.com/api/json/v3';
const API_PREFIX = '/api/json/v3';
// The sandbox-only endpoints; whitelisted by exact name. These never touch a real account (a non-sandbox key never gets here).
const SANDBOX_ONLY = new Set(['/sandbox/reset']);
const KEY_REQUEST = '/apikey/request';

export interface SandboxKeys { apiKey: string; secretKey: string }

/** Throws (aborting the project) unless both keys are sandbox keys. */
export function assertSandboxKeys(k: { apiKey: unknown; secretKey: unknown }): asserts k is SandboxKeys {
  if (typeof k.apiKey !== 'string' || !k.apiKey.startsWith('pk1_sb_') || typeof k.secretKey !== 'string' || !k.secretKey.startsWith('sk1_sb_')) {
    throw new Error('SANDBOX GUARD: keys are not sandbox keys (pk1_sb_/sk1_sb_); aborting before any request');
  }
}

const allowedPaths: ((p: string) => boolean)[] = [
  ...Object.values(PORKBUN_ENDPOINTS).map((e) => {
    const re = new RegExp(`^${e.path.replace(/\{\w+\}/g, '[^/]+')}$`);
    return (p: string) => re.test(p);
  }),
  (p) => SANDBOX_ONLY.has(p),
  (p) => p === KEY_REQUEST,
];

let installed = false;
const sandboxSeen: string[] = [];
export const guardLog: string[] = []; // "METHOD /path -> status" lines, never keys

/** The unauthenticated key-minting call must carry no credentials at all (header or body); else refuse. */
export function assertCredentialFreeKeyRequest(init?: RequestInit): void {
  const headers = new Headers(init?.headers);
  let bad = headers.has('x-api-key') || headers.has('x-secret-api-key');
  const b = init?.body;
  if (typeof b === 'string' && b.length > 0) {
    try {
      const j = JSON.parse(b) as Record<string, unknown>;
      if (j && typeof j === 'object' && ('apikey' in j || 'secretapikey' in j)) bad = true;
    } catch { bad = true; } // an unparseable body cannot be shown credential-free
  } else if (b !== undefined && b !== null && typeof b !== 'string') {
    bad = true;
  }
  if (bad) throw new Error('SANDBOX GUARD: /apikey/request must carry no credentials; refused');
}

export function installGuardFetch(): void {
  if (installed) return;
  installed = true;
  const inner = globalThis.fetch; // already wrapped by tests/contract/setup.ts (host allowlist)
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    if (url.host !== 'api.porkbun.com') return inner(input, init);
    const path = url.pathname.startsWith(API_PREFIX) ? url.pathname.slice(API_PREFIX.length) : url.pathname;
    if (/^\/account\/(topup|autotopup)/i.test(path) || !allowedPaths.some((f) => f(path))) {
      throw new Error(`SANDBOX GUARD: path not allowed: ${path}`);
    }
    const headers = new Headers(init?.headers);
    if (path === KEY_REQUEST) assertCredentialFreeKeyRequest(init);
    else assertSandboxKeys({ apiKey: headers.get('x-api-key'), secretKey: headers.get('x-secret-api-key') });
    const res = await inner(input, init);
    guardLog.push(`${init?.method ?? 'GET'} ${path} -> ${res.status}`);
    // /apikey/request is the unauthenticated key-minting call: it has no sandbox header, so getSandboxKeys()
    // checks its body (sandbox:true) and the key prefixes instead; everything else must carry the header.
    if (path === KEY_REQUEST) return res;
    // Observed 5 Oct 2026: an Idempotent-Replayed response is served from the stored first response and carries
    // no X-Porkbun-Sandbox header (llms.txt says every response does). Such a replay must still say sandbox:true in
    // its body (checked below, required for SUCCESS bodies); an error replay with no marker is refused.
    const replayed = res.headers.get('idempotent-replayed') === 'true';
    if (res.headers.get('x-porkbun-sandbox') !== 'true' && !replayed) {
      guardLog.push(`VIOLATION ${path}: no X-Porkbun-Sandbox header; headers=${JSON.stringify([...res.headers.keys()])}`);
      throw new Error(`SANDBOX GUARD: ${path} response lacks X-Porkbun-Sandbox: true; aborting`);
    }
    const text = await res.clone().text();
    let body: unknown = null;
    try { body = JSON.parse(text); } catch { /* non-JSON: header check above is all we can assert */ }
    if (replayed && !(body && typeof body === 'object' && (body as Record<string, unknown>).sandbox === true)) {
      guardLog.push(`VIOLATION ${path}: replayed response without sandbox:true body`);
      throw new Error(`SANDBOX GUARD: replayed ${path} response is not marked sandbox; aborting`);
    }
    if (body && typeof body === 'object' && (body as Record<string, unknown>).status === 'SUCCESS') {
      try {
        assertSandboxResponse(path, body as Record<string, unknown>);
      } catch (e) {
        guardLog.push(`VIOLATION ${path}: body sandbox flag missing; keys=${JSON.stringify(Object.keys(body))}; replayed=${res.headers.get('idempotent-replayed')}`);
        throw e;
      }
    }
    sandboxSeen.push(path);
    return res;
  }) as typeof fetch;
}

/** Every SUCCESS body from the sandbox must carry sandbox: true (llms.txt: "Every response carries sandbox: true"). */
export function assertSandboxResponse(path: string, body: Record<string, unknown>): void {
  if (body.sandbox !== true) throw new Error(`SANDBOX GUARD: ${path} body lacks sandbox:true; aborting`);
}

/** Env pair if set, else a throwaway pair. Never logged. The real-account env vars are not read. */
export async function getSandboxKeys(): Promise<SandboxKeys> {
  const envPk = process.env.PORKBUN_SANDBOX_API_KEY;
  const envSk = process.env.PORKBUN_SANDBOX_SECRET_API_KEY;
  let keys: { apiKey: unknown; secretKey: unknown };
  if (envPk && envSk) {
    keys = { apiKey: envPk, secretKey: envSk };
  } else {
    const res = await fetch(`${SANDBOX_BASE}${KEY_REQUEST}`, {
      method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' }, body: JSON.stringify({ sandbox: true }),
    });
    const j = (await res.json()) as Record<string, unknown>;
    if (j.sandbox !== true) throw new Error('SANDBOX GUARD: /apikey/request did not answer sandbox:true; aborting');
    keys = { apiKey: j.apikey ?? j.apiKey, secretKey: j.secretapikey ?? j.secretApiKey ?? j.secretKey };
  }
  assertSandboxKeys(keys);
  return keys;
}

/** Direct sandbox calls (the same guarded fetch). Auth in headers only. */
export function sandboxClient(keys: SandboxKeys) {
  const h = (extra: Record<string, string> = {}) => ({
    accept: 'application/json', 'content-type': 'application/json', 'X-API-Key': keys.apiKey, 'X-Secret-API-Key': keys.secretKey, ...extra,
  });
  return {
    async post(path: string, body: unknown = {}, headers: Record<string, string> = {}) {
      const res = await fetch(`${SANDBOX_BASE}${path}`, { method: 'POST', headers: h(headers), body: JSON.stringify(body) });
      return { status: res.status, headers: res.headers, json: (await res.json()) as Record<string, any> };
    },
    async get(path: string) {
      const res = await fetch(`${SANDBOX_BASE}${path}`, { method: 'GET', headers: h() });
      return { status: res.status, headers: res.headers, json: (await res.json()) as Record<string, any> };
    },
  };
}

/** Replace any key material in text with a marker. */
export function redact(text: string, keys: SandboxKeys): string {
  return text.split(keys.apiKey).join('<pk>').split(keys.secretKey).join('<sk>').replace(/[ps]k1_sb_[A-Za-z0-9]+/g, '<sandbox-key>');
}
