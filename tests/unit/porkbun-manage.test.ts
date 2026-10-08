import { http, HttpResponse } from 'msw';
import { beforeEach, describe, expect, it } from 'vitest';
import { PorkbunAdapter } from '../../src/modules/registrars/porkbun.js';
import { RegistrarError } from '../../src/modules/registrars/types.js';
import { mswServer } from '../setup/network.js';
import { FAKE_KEYS, PORKBUN_BASE, pbError, record, recorded } from '../helpers/porkbun-msw.js';

const pb = () => new PorkbunAdapter({ ...FAKE_KEYS, timeoutMs: 200 });
beforeEach(() => {
  recorded.length = 0;
});
async function errOf(p: Promise<unknown>): Promise<RegistrarError> {
  try {
    await p;
  } catch (e) {
    if (e instanceof RegistrarError) return e;
    throw e;
  }
  throw new Error('expected a RegistrarError');
}

const dryRunOk = {
  status: 'SUCCESS', dryRun: true, wouldSucceed: true, operation: 'registration', domain: 'x.com', tld: 'com',
  available: 'available', premium: false, duration: 1, cost: 1108, costDisplay: '$11.08', balance: 5000,
  sufficientFunds: true, message: 'Dry run …', requestId: 'r1',
};

describe('PorkbunAdapter.register', () => {
  it('RN-6: real create sends exactly {cost, agreeToTerms, whoisPrivacy} + Idempotency-Key, no term field', async () => {
    mswServer.use(http.post(`${PORKBUN_BASE}/domain/create/:d`, async ({ request }) => {
      await record(request);
      return HttpResponse.json({ status: 'SUCCESS', domain: 'x.com', cost: 1108, orderId: 12345678, balance: 3892, requestId: 'r' });
    }));
    const r = await pb().register('x.com', { costCents: 1108, idempotencyKey: 'dt-42', dryRun: false });
    expect(r).toEqual({
      kind: 'registered', orderId: '12345678', chargedCents: 1108, balanceCents: 3892,
      raw: expect.objectContaining({ orderId: 12345678 }),
    });
    const req = recorded[0]!;
    expect(req.path).toBe('/domain/create/x.com');
    expect(req.body).toEqual({ cost: 1108, agreeToTerms: 'yes', whoisPrivacy: true });
    expect(req.headers['idempotency-key']).toBe('dt-42');
  });

  it('dry run sends dryRun:true and maps the preview', async () => {
    mswServer.use(http.post(`${PORKBUN_BASE}/domain/create/:d`, async ({ request }) => {
      await record(request);
      return HttpResponse.json({ ...dryRunOk, withinMonthlySpendLimit: true });
    }));
    const r = await pb().register('x.com', { costCents: 1108, idempotencyKey: 'dry-1', dryRun: true });
    expect(recorded[0]!.body).toEqual({ cost: 1108, agreeToTerms: 'yes', whoisPrivacy: true, dryRun: true });
    expect(r).toMatchObject({
      kind: 'dry_run', wouldSucceed: true, costCents: 1108, durationYears: 1, balanceCents: 5000,
      shortfallCents: null, withinMonthlySpendLimit: true,
    });
  });

  it('dry run with too little credit → wouldSucceed false + shortfall', async () => {
    mswServer.use(http.post(`${PORKBUN_BASE}/domain/create/:d`, () =>
      HttpResponse.json({ ...dryRunOk, wouldSucceed: false, sufficientFunds: false, balance: 500, shortfall: 608 })));
    const r = await pb().register('x.com', { costCents: 1108, idempotencyKey: 'dry-2', dryRun: true });
    expect(r).toMatchObject({ kind: 'dry_run', wouldSucceed: false, shortfallCents: 608, balanceCents: 500 });
  });

  it('dry run reporting a multi-year term → definite MULTI_YEAR_TERM error', async () => {
    mswServer.use(http.post(`${PORKBUN_BASE}/domain/create/:d`, () => HttpResponse.json({ ...dryRunOk, duration: 2 })));
    expect(await errOf(pb().register('x.com', { costCents: 1108, idempotencyKey: 'k', dryRun: true })))
      .toMatchObject({ code: 'MULTI_YEAR_TERM', ambiguous: false });
  });

  it('Review Focus 2: dryRun requested but response is not a dry run → ambiguous REGISTRAR_BAD_RESPONSE', async () => {
    mswServer.use(http.post(`${PORKBUN_BASE}/domain/create/:d`, () =>
      HttpResponse.json({ status: 'SUCCESS', domain: 'x.com', cost: 1108, orderId: 1, balance: 0 })));
    expect(await errOf(pb().register('x.com', { costCents: 1108, idempotencyKey: 'k', dryRun: true })))
      .toMatchObject({ code: 'REGISTRAR_BAD_RESPONSE', ambiguous: true });
  });

  it('real create answered with a dry-run body → ambiguous REGISTRAR_BAD_RESPONSE', async () => {
    mswServer.use(http.post(`${PORKBUN_BASE}/domain/create/:d`, () => HttpResponse.json(dryRunOk)));
    expect(await errOf(pb().register('x.com', { costCents: 1108, idempotencyKey: 'k', dryRun: false })))
      .toMatchObject({ code: 'REGISTRAR_BAD_RESPONSE', ambiguous: true });
  });

  it('real success without orderId → ambiguous REGISTRAR_BAD_RESPONSE', async () => {
    mswServer.use(http.post(`${PORKBUN_BASE}/domain/create/:d`, () => HttpResponse.json({ status: 'SUCCESS', cost: 1108 })));
    expect(await errOf(pb().register('x.com', { costCents: 1108, idempotencyKey: 'k', dryRun: false })))
      .toMatchObject({ code: 'REGISTRAR_BAD_RESPONSE', ambiguous: true });
  });

  it('refuses a non-positive or fractional cost without calling Porkbun', async () => {
    for (const costCents of [0, -1, 11.08]) {
      expect(await errOf(pb().register('x.com', { costCents, idempotencyKey: 'k', dryRun: true })))
        .toMatchObject({ code: 'INVALID_COST', ambiguous: false });
    }
    expect(recorded).toHaveLength(0);
  });

  const definiteCodes = [
    'VERIFICATION_REQUIRED', 'INSUFFICIENT_FUNDS', 'MONTHLY_SPEND_LIMIT_EXCEEDED', 'ORDER_TOO_LARGE', 'COST_MISMATCH',
    'DOMAIN_NOT_AVAILABLE', 'API_ACCESS_DISABLED', 'IDEMPOTENCY_KEY_MISMATCH',
  ];
  it.each(definiteCodes)('§5 code %s → definite RegistrarError with that code', async (code) => {
    mswServer.use(http.post(`${PORKBUN_BASE}/domain/create/:d`, () => pbError(code, { cost: 1108, balance: 500, shortfall: 608 })));
    const e = await errOf(pb().register('x.com', { costCents: 1108, idempotencyKey: 'k', dryRun: false }));
    expect(e).toMatchObject({ code, ambiguous: false });
  });

  // Controller ruling (step 2 Task 2 review): an earlier request with this key is still in flight → outcome unknown.
  it('§5 code IDEMPOTENCY_KEY_IN_USE → ambiguous RegistrarError', async () => {
    mswServer.use(http.post(`${PORKBUN_BASE}/domain/create/:d`, () => pbError('IDEMPOTENCY_KEY_IN_USE', {}, { status: 409 })));
    expect(await errOf(pb().register('x.com', { costCents: 1108, idempotencyKey: 'k', dryRun: false })))
      .toMatchObject({ code: 'IDEMPOTENCY_KEY_IN_USE', ambiguous: true });
  });

  it('a coded error on HTTP 5xx from create → ambiguous', async () => {
    mswServer.use(http.post(`${PORKBUN_BASE}/domain/create/:d`, () => pbError('INTERNAL_ERROR', {}, { status: 500 })));
    expect(await errOf(pb().register('x.com', { costCents: 1108, idempotencyKey: 'k', dryRun: false })))
      .toMatchObject({ code: 'INTERNAL_ERROR', ambiguous: true });
  });

  it('INSUFFICIENT_FUNDS keeps cost/balance/shortfall in details', async () => {
    mswServer.use(http.post(`${PORKBUN_BASE}/domain/create/:d`, () => pbError('INSUFFICIENT_FUNDS', { cost: 1108, balance: 500, shortfall: 608 })));
    const e = await errOf(pb().register('x.com', { costCents: 1108, idempotencyKey: 'k', dryRun: false }));
    expect(e.details).toEqual({ cost: 1108, balance: 500, shortfall: 608 });
  });

  it('RATE_LIMIT_EXCEEDED on create carries Retry-After', async () => {
    mswServer.use(http.post(`${PORKBUN_BASE}/domain/create/:d`, () =>
      pbError('RATE_LIMIT_EXCEEDED', {}, { status: 429, headers: { 'Retry-After': '1' } })));
    expect(await errOf(pb().register('x.com', { costCents: 1108, idempotencyKey: 'k', dryRun: false })))
      .toMatchObject({ code: 'RATE_LIMIT_EXCEEDED', retryAfterSeconds: 1, ambiguous: false });
  });
});

describe('PorkbunAdapter.findDomain', () => {
  const getBody = {
    status: 'SUCCESS',
    domain: {
      domain: 'x.com', status: 'ACTIVE', tld: 'com', createDate: '2026-10-04 09:00:00', expireDate: '2027-10-04 09:00:00',
      securityLock: 1, whoisPrivacy: 1, autoRenew: 0, apiAccess: 1, notLocal: 0,
    },
  };

  it('maps domain/get + getNs', async () => {
    mswServer.use(
      http.get(`${PORKBUN_BASE}/domain/get/:d`, () => HttpResponse.json(getBody)),
      http.post(`${PORKBUN_BASE}/domain/getNs/:d`, () => HttpResponse.json({ status: 'SUCCESS', ns: ['NS1.Afternic.com.', 'ns2.afternic.com'] })),
    );
    expect(await pb().findDomain('x.com')).toEqual({
      expiryDate: '2027-10-04', whoisPrivacy: true, autoRenew: false, apiAccess: true,
      ns: ['ns1.afternic.com', 'ns2.afternic.com'],
    });
  });

  it('S7: DOMAIN_NOT_FOUND → null', async () => {
    mswServer.use(http.get(`${PORKBUN_BASE}/domain/get/:d`, () => pbError('DOMAIN_NOT_FOUND', {}, { status: 404 })));
    expect(await pb().findDomain('x.com')).toBeNull();
  });

  it('S7: INVALID_DOMAIN and other errors throw (never a silent null)', async () => {
    mswServer.use(http.get(`${PORKBUN_BASE}/domain/get/:d`, () => pbError('INVALID_DOMAIN')));
    expect(await errOf(pb().findDomain('x.com'))).toMatchObject({ code: 'INVALID_DOMAIN' });
  });

  it('API access off → ns null, apiAccess false', async () => {
    mswServer.use(
      http.get(`${PORKBUN_BASE}/domain/get/:d`, () => HttpResponse.json({ ...getBody, domain: { ...getBody.domain, apiAccess: 0 } })),
      http.post(`${PORKBUN_BASE}/domain/getNs/:d`, () => pbError('API_ACCESS_DISABLED')),
    );
    expect(await pb().findDomain('x.com')).toMatchObject({ apiAccess: false, ns: null });
  });
});

describe('PorkbunAdapter nameservers, auto-renew, receipts', () => {
  it('setNameservers posts {ns}', async () => {
    mswServer.use(http.post(`${PORKBUN_BASE}/domain/updateNs/:d`, async ({ request }) => {
      await record(request);
      return HttpResponse.json({ status: 'SUCCESS' });
    }));
    await pb().setNameservers('x.com', ['ns1.afternic.com', 'ns2.afternic.com']);
    expect(recorded[0]).toMatchObject({ path: '/domain/updateNs/x.com', body: { ns: ['ns1.afternic.com', 'ns2.afternic.com'] } });
  });

  it('getNameservers returns a normalised set', async () => {
    mswServer.use(http.post(`${PORKBUN_BASE}/domain/getNs/:d`, () =>
      HttpResponse.json({ status: 'SUCCESS', ns: ['NS2.AFTERNIC.COM.', 'ns1.afternic.com'] })));
    expect(await pb().getNameservers('x.com')).toEqual(new Set(['ns1.afternic.com', 'ns2.afternic.com']));
  });

  it('setAutoRenew(false) posts {status:"off"}', async () => {
    mswServer.use(http.post(`${PORKBUN_BASE}/domain/updateAutoRenew/:d`, async ({ request }) => {
      await record(request);
      return HttpResponse.json({ status: 'SUCCESS', results: { 'x.com': { status: 'SUCCESS', message: 'ok' } } });
    }));
    await pb().setAutoRenew('x.com', false);
    expect(recorded[0]).toMatchObject({ path: '/domain/updateAutoRenew/x.com', body: { status: 'off' } });
  });

  it('setAutoRenew per-domain failure → AUTO_RENEW_UPDATE_FAILED', async () => {
    mswServer.use(http.post(`${PORKBUN_BASE}/domain/updateAutoRenew/:d`, () =>
      HttpResponse.json({ status: 'SUCCESS', results: { 'x.com': { status: 'ERROR', message: 'nope' } } })));
    expect(await errOf(pb().setAutoRenew('x.com', false))).toMatchObject({ code: 'AUTO_RENEW_UPDATE_FAILED' });
  });

  it('getReceipt reads /account/invoice/{orderId}', async () => {
    mswServer.use(http.get(`${PORKBUN_BASE}/account/invoice/:id`, async ({ request }) => {
      await record(request);
      return HttpResponse.json({ status: 'SUCCESS', invoice: { orderId: 12345678, total: 1108 } });
    }));
    expect(await pb().getReceipt('12345678')).toMatchObject({ invoice: { orderId: 12345678 } });
    expect(recorded[0]!.path).toBe('/account/invoice/12345678');
  });
});

describe('fix round 1', () => {
  it('findDomain: DOMAIN_NOT_FOUND on 5xx is ambiguous and throws', async () => {
    mswServer.use(http.get(`${PORKBUN_BASE}/domain/get/:d`, () => pbError('DOMAIN_NOT_FOUND', {}, { status: 503 })));
    expect(await errOf(pb().findDomain('x.com'))).toMatchObject({ code: 'DOMAIN_NOT_FOUND', ambiguous: true });
  });
  it('register refuses empty/whitespace idempotency key without calling Porkbun', async () => {
    for (const idempotencyKey of ['', '  ']) {
      expect(await errOf(pb().register('x.com', { costCents: 1108, idempotencyKey, dryRun: false })))
        .toMatchObject({ code: 'INVALID_IDEMPOTENCY_KEY', ambiguous: false });
    }
    expect(recorded).toHaveLength(0);
  });
  it('real success with fractional cost -> ambiguous BAD_RESPONSE', async () => {
    mswServer.use(http.post(`${PORKBUN_BASE}/domain/create/:d`, () => HttpResponse.json({ status: 'SUCCESS', cost: 11.08, orderId: 1 })));
    expect(await errOf(pb().register('x.com', { costCents: 1108, idempotencyKey: 'k', dryRun: false })))
      .toMatchObject({ code: 'REGISTRAR_BAD_RESPONSE', ambiguous: true });
  });
  it('dry run without cost -> ambiguous BAD_RESPONSE', async () => {
    const { cost: _c, ...noCost } = dryRunOk;
    mswServer.use(http.post(`${PORKBUN_BASE}/domain/create/:d`, () => HttpResponse.json(noCost)));
    expect(await errOf(pb().register('x.com', { costCents: 1108, idempotencyKey: 'k', dryRun: true })))
      .toMatchObject({ code: 'REGISTRAR_BAD_RESPONSE', ambiguous: true });
  });
  it('dry run without duration -> ambiguous BAD_RESPONSE', async () => {
    const { duration: _d, ...noDur } = dryRunOk;
    mswServer.use(http.post(`${PORKBUN_BASE}/domain/create/:d`, () => HttpResponse.json(noDur)));
    expect(await errOf(pb().register('x.com', { costCents: 1108, idempotencyKey: 'k', dryRun: true })))
      .toMatchObject({ code: 'REGISTRAR_BAD_RESPONSE', ambiguous: true });
  });
});
