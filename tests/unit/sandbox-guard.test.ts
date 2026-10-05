import { describe, expect, it } from 'vitest';
import { assertCredentialFreeKeyRequest } from '../contract/sandbox-guard.js';

describe('sandbox guard: /apikey/request must be credential-free', () => {
  it('accepts the bare {"sandbox":true} request', () => {
    expect(() => assertCredentialFreeKeyRequest({ method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"sandbox":true}' })).not.toThrow();
  });
  it.each([
    ['x-api-key header', { headers: { 'X-API-Key': 'fake' }, body: '{"sandbox":true}' }],
    ['x-secret-api-key header', { headers: { 'x-secret-api-key': 'fake' }, body: '{"sandbox":true}' }],
    ['apikey in body', { body: '{"sandbox":true,"apikey":"fake"}' }],
    ['secretapikey in body', { body: '{"secretapikey":"fake"}' }],
    ['unparseable body', { body: 'not json' }],
  ])('refuses %s', (_n, init) => {
    expect(() => assertCredentialFreeKeyRequest({ method: 'POST', ...init })).toThrow(/no credentials/);
  });
});
