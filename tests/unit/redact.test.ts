import { describe, expect, it } from 'vitest';
import { redact } from '../../src/core/redact.js';

describe('redact', () => {
  it('masks secret-looking keys at any depth, keeps the rest', () => {
    expect(
      redact({
        domain: 'x.com',
        api_key: 'pk1_x',
        nested: { secretApiKey: 's', list: [{ password: 'p', ok: 1 }] },
        godaddy_pat: 'g',
        authorization: 'Bearer t',
        approval_ref: { text: 'yes buy x.com', approved_at: '2026-10-04T09:00:00+03:00' },
      }),
    ).toEqual({
      domain: 'x.com',
      api_key: '[REDACTED]',
      nested: { secretApiKey: '[REDACTED]', list: [{ password: '[REDACTED]', ok: 1 }] },
      godaddy_pat: '[REDACTED]',
      authorization: '[REDACTED]',
      approval_ref: { text: 'yes buy x.com', approved_at: '2026-10-04T09:00:00+03:00' },
    });
  });

  it('passes through primitives and null', () => {
    expect(redact(null)).toBeNull();
    expect(redact('a')).toBe('a');
    expect(redact(3)).toBe(3);
  });
});

describe('redact (step 2 widening)', () => {
  it('masks private keys, credentials and plural forms', () => {
    expect(
      redact({ private_key: 'a', privateKey: 'b', secret_key: 'c', credentials: 'd', api_keys: ['e'], tokens: 'f', ok: 'g' }),
    ).toEqual({
      private_key: '[REDACTED]', privateKey: '[REDACTED]', secret_key: '[REDACTED]', credentials: '[REDACTED]',
      api_keys: '[REDACTED]', tokens: '[REDACTED]', ok: 'g',
    });
  });
});
