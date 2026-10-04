import { describe, expect, it } from 'vitest';
import { generateToken, hashToken } from '../../src/auth/tokens.js';

describe('tokens', () => {
  it('generates dt_ + ≥32 random bytes (base64url, 43 chars)', () => {
    const t = generateToken();
    expect(t).toMatch(/^dt_[A-Za-z0-9_-]{43}$/);
    expect(generateToken()).not.toBe(t);
  });

  it('hashes to 64 lowercase hex chars, deterministically', () => {
    expect(hashToken('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });
});
