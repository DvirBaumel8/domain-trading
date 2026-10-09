import { describe, expect, it } from 'vitest';
import { canonicalJson } from '../../../../src/http/canonical-json.js';
import { requestHash } from '../../../../src/http/idempotency.js';

describe('canonical body hashing', () => {
  it('sorts keys recursively; arrays keep order', () => {
    expect(canonicalJson({ b: 1, a: { d: [2, 1], c: null } })).toBe('{"a":{"c":null,"d":[2,1]},"b":1}');
  });

  it('same body with different key order → same hash; different path → different hash', () => {
    const h1 = requestHash('POST', '/buy', { domain: 'x.com', max_price: 11.5 });
    const h2 = requestHash('POST', '/buy', { max_price: 11.5, domain: 'x.com' });
    expect(h1).toBe(h2);
    expect(requestHash('POST', '/list/x.com', { domain: 'x.com', max_price: 11.5 })).not.toBe(h1);
    expect(requestHash('POST', '/buy', { domain: 'x.com', max_price: 11.6 })).not.toBe(h1);
  });

  it('undefined body hashes like null', () => {
    expect(requestHash('POST', '/x', undefined)).toBe(requestHash('POST', '/x', null));
  });
});
