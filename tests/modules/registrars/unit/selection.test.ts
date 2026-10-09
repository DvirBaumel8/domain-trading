import { describe, expect, it } from 'vitest';
import type { Capabilities, Quote } from '../../../../src/modules/registrars/types.js';
import { RegistrarError } from '../../../../src/modules/registrars/types.js';
import {
  evaluateQuote, firstYearWarning, overallAvailability, pickWinner, shouldCall, sortByAdapterOrder, twoYearCents,
  type EvaluatedQuote, type QuoteOutcome,
} from '../../../../src/modules/registrars/selection.js';

const caps = (over: Partial<Capabilities> = {}): Capabilities => ({
  canQuote: true, canRegister: true, canManageNs: true, customNs: true,
  prepaid: true, freePrivacy: true, afternicFastTransfer: false, sandbox: false, ...over,
});
const quote = (over: Partial<Quote> = {}): Quote => ({
  available: true, premium: false, firstYearCents: 1108, renewalCents: 1108, privacyCentsPerYear: 0,
  currency: 'USD', minDurationYears: 1, raw: {}, ...over,
});
const ALL = ['porkbun', 'dynadot', 'namecom', 'a', 'b', 'cf', 'gd', 'z'];
const ev = (registrar: string, q: Partial<Quote> = {}, c: Partial<Capabilities> = {}): EvaluatedQuote =>
  evaluateQuote({ registrar, capabilities: caps(c), quote: quote(q), error: null }, ALL);

describe('selection', () => {
  it('RN-1/CK-9: two_year = first year + exactly one renewal (+2× paid privacy), 20 random fixtures', () => {
    let seed = 7;
    const rnd = () => (seed = (seed * 48271) % 2147483647) % 5000;
    for (let i = 0; i < 20; i++) {
      const [f, r, p] = [rnd() + 1, rnd() + 1, rnd() % 500];
      expect(twoYearCents(f, r, p)).toBe(f + r + 2 * p);
      expect(ev('a', { firstYearCents: f, renewalCents: r, privacyCentsPerYear: p }).twoYearCents).toBe(f + r + 2 * p);
    }
  });

  it('CK-1: $5 + $25 renewal loses to $11.08 + $11.08; warning names the cheap first year', () => {
    const evals = [ev('a', { firstYearCents: 500, renewalCents: 2500 }), ev('porkbun')];
    const w = pickWinner(evals);
    expect(w?.registrar).toBe('porkbun');
    expect(w?.twoYearCents).toBe(2216);
    expect(firstYearWarning(evals, w)).toBe('Cheapest first year (a $5.00) is not cheapest over 2 years');
  });

  it('no warning when the winner also has the cheapest first year', () => {
    const evals = [ev('porkbun'), ev('a', { firstYearCents: 1200, renewalCents: 1200 })];
    expect(firstYearWarning(evals, pickWinner(evals))).toBeNull();
  });

  it('CK-2: a no-custom-NS (Cloudflare-type) adapter is excluded even when cheapest', () => {
    const cf = ev('cf', { firstYearCents: 100, renewalCents: 100 }, { customNs: false });
    expect(cf).toMatchObject({ eligible: false, exclusionReason: 'NO_CUSTOM_NAMESERVERS' });
    expect(pickWinner([cf, ev('porkbun')])?.registrar).toBe('porkbun');
  });

  it('CK-3: paid privacy $3/yr adds $6', () => {
    expect(ev('a', { privacyCentsPerYear: 300 }).twoYearCents).toBe(1108 + 1108 + 600);
  });

  it('CK-4: premium → PREMIUM', () => {
    expect(ev('a', { premium: true })).toMatchObject({ eligible: false, exclusionReason: 'PREMIUM' });
  });

  it('CK-7: missing renewal → NO_RENEWAL_PRICE (never renewal = 0)', () => {
    const e = ev('a', { renewalCents: null });
    expect(e).toMatchObject({ eligible: false, exclusionReason: 'NO_RENEWAL_PRICE', twoYearCents: null });
  });

  it('other exclusions: not available, not USD, multi-year minimum, no first-year price, not allowed, adapter error, management-only', () => {
    expect(ev('a', { available: false }).exclusionReason).toBe('NOT_AVAILABLE');
    expect(ev('a', { currency: 'EUR' }).exclusionReason).toBe('NOT_USD');
    expect(ev('a', { minDurationYears: 2 }).exclusionReason).toBe('MULTI_YEAR_MINIMUM');
    expect(ev('a', { firstYearCents: null }).exclusionReason).toBe('NO_FIRST_YEAR_PRICE');
    expect(evaluateQuote({ registrar: 'x', capabilities: caps(), quote: quote(), error: null }, ['porkbun']).exclusionReason)
      .toBe('REGISTRAR_NOT_ALLOWED');
    const err = evaluateQuote(
      { registrar: 'a', capabilities: caps(), quote: null, error: new RegistrarError('a', 'REGISTRAR_TIMEOUT', 't', { ambiguous: true }) }, ALL);
    expect(err).toMatchObject({ eligible: false, exclusionReason: 'ADAPTER_ERROR', errorCode: 'REGISTRAR_TIMEOUT' });
    const gd = evaluateQuote({ registrar: 'gd', capabilities: caps({ canQuote: false, canRegister: false }), quote: null, error: null }, ALL);
    expect(gd).toMatchObject({ eligible: false, exclusionReason: 'NO_AVAILABILITY_ACCESS' });
  });

  it('shouldCall: never for management-only, no-custom-NS or not-allowed registrars (S5)', () => {
    expect(shouldCall(caps(), 'porkbun', ['porkbun'])).toBe(true);
    expect(shouldCall(caps({ canQuote: false }), 'porkbun', ['porkbun'])).toBe(false);
    expect(shouldCall(caps({ canRegister: false }), 'porkbun', ['porkbun'])).toBe(false);
    expect(shouldCall(caps({ customNs: false }), 'porkbun', ['porkbun'])).toBe(false);
    expect(shouldCall(caps(), 'dynadot', ['porkbun'])).toBe(false);
  });

  it('CK-8: exact tie → prepaid first, then Fast Transfer, then porkbun > dynadot > namecom > others (stable)', () => {
    const t = (r: string, c: Partial<Capabilities> = {}) => ev(r, {}, c);
    expect(pickWinner([t('z'), t('a', { prepaid: false })])?.registrar).toBe('z');
    expect(pickWinner([t('b'), t('a', { afternicFastTransfer: true })])?.registrar).toBe('a');
    expect(pickWinner([t('namecom'), t('dynadot'), t('porkbun')])?.registrar).toBe('porkbun');
    expect(pickWinner([t('z'), t('namecom')])?.registrar).toBe('namecom');
    expect(pickWinner([t('b'), t('a')])?.registrar).toBe('a');
    for (let i = 0; i < 5; i++) expect(pickWinner([t('b'), t('a'), t('dynadot')].reverse())?.registrar).toBe('dynadot');
  });

  it('B-10: caps filter BEFORE the minimum', () => {
    const A = ev('a', { firstYearCents: 1160, renewalCents: 840 });   // $11.60 first year, $20.00 2-yr
    const B = ev('b', { firstYearCents: 1108, renewalCents: 1108 });  // $11.08, $22.16
    expect(pickWinner([A, B])?.registrar).toBe('a');
    expect(pickWinner([A, B], { maxFirstYearCents: 1150 })?.registrar).toBe('b');
    expect(pickWinner([A, B], { maxFirstYearCents: 1150, maxTwoYearCents: 2000 })).toBeNull();
  });

  it('no eligible quote → no winner', () => {
    expect(pickWinner([ev('a', { premium: true })])).toBeNull();
  });

  describe('overallAvailability (S2)', () => {
    const yes = ev('a');
    const no = ev('b', { available: false });
    const errored = evaluateQuote({ registrar: 'c', capabilities: caps(), quote: null, error: new RegistrarError('c', 'X', 'x') }, ALL);
    it.each([
      ['not_registered', [yes], 'available'],
      ['registered', [no], 'taken'],
      ['registered', [], 'taken'],
      ['registered', [yes], 'unknown'],        // CK-6
      ['not_registered', [no], 'unknown'],
      ['not_registered', [yes, no], 'unknown'],
      ['not_registered', [errored], 'unknown'],
      ['not_registered', [], 'unknown'],
      ['rdap_unknown', [yes], 'unknown'],
      ['rdap_unknown', [no], 'taken'],
    ] as const)('rdap %s + %j → %s', (rdap, evals, expected) => {
      expect(overallAvailability(rdap, [...evals])).toBe(expected);
    });
  });

  it('sortByAdapterOrder: porkbun, dynadot, namecom, then alphabetical', () => {
    expect(sortByAdapterOrder([{ registrar: 'z' }, { registrar: 'namecom' }, { registrar: 'a' }, { registrar: 'porkbun' }])
      .map((x) => x.registrar)).toEqual(['porkbun', 'namecom', 'a', 'z']);
  });
});
