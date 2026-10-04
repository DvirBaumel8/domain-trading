import { describe, expect, it } from 'vitest';
import { normalizeDomain } from '../../src/domain-name.js';
import { AppError } from '../../src/http/errors.js';

function codeOf(fn: () => unknown): string | null {
  try {
    fn();
    return null;
  } catch (e) {
    return e instanceof AppError ? `${e.status} ${e.code}` : 'not AppError';
  }
}

describe('normalizeDomain', () => {
  it('lowercases, trims and drops one trailing dot', () => {
    expect(normalizeDomain('  Example.COM. ')).toBe('example.com');
    expect(normalizeDomain('PromptInjectionAudit.com')).toBe('promptinjectionaudit.com');
  });

  it('accepts hyphens, digits and punycode labels', () => {
    expect(normalizeDomain('austin-roof-repair2.com')).toBe('austin-roof-repair2.com');
    expect(normalizeDomain('xn--bcher-kva.com')).toBe('xn--bcher-kva.com');
  });

  it('CK-10: a valid non-.com name → 422 TLD_NOT_SUPPORTED', () => {
    expect(codeOf(() => normalizeDomain('example.net'))).toBe('422 TLD_NOT_SUPPORTED');
    expect(codeOf(() => normalizeDomain('example.co.uk'))).toBe('422 TLD_NOT_SUPPORTED');
  });

  it.each(['www.example.com', 'a.b.example.com', '-x.com', 'x-.com', 'ex ample.com', 'example', '.com', '', 'exa_mple.com',
    `${'a'.repeat(64)}.com`, 'example..com', 'http://example.com'])('%j → 422 DOMAIN_INVALID', (s) => {
    expect(codeOf(() => normalizeDomain(s))).toBe('422 DOMAIN_INVALID');
  });

  it('a 63-char label is fine', () => {
    expect(normalizeDomain(`${'a'.repeat(63)}.com`)).toBe(`${'a'.repeat(63)}.com`);
  });
});
