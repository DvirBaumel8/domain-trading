// v3.3.0 (CR-023 B): the registrable-domain rule that makes one firm count once.
import { describe, expect, it } from 'vitest';
import { registrableDomain } from '../../../../src/modules/selection/sellers.js';

describe('CR-023 B registrable domain', () => {
  it('www and sub-domains collapse to the registrable domain, also under a two-letter country code with a common second level', () => {
    expect(registrableDomain('www.acme.com')).toBe('acme.com');
    expect(registrableDomain('shop.eu.acme.com')).toBe('acme.com');
    expect(registrableDomain('acme.co.uk')).toBe('acme.co.uk');
    expect(registrableDomain('www.acme.co.uk')).toBe('acme.co.uk');
    expect(registrableDomain('acme.io')).toBe('acme.io');
    expect(registrableDomain('Acme.COM.')).toBe('acme.com');
    expect(registrableDomain('a.example.com.au')).toBe('example.com.au');
  });
});
