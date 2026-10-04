import { http, HttpResponse, delay } from 'msw';
import { beforeEach, describe, expect, it } from 'vitest';
import { PorkbunAdapter } from '../../src/registrars/porkbun.js';
import { RegistrarError } from '../../src/registrars/types.js';
import { mswServer } from '../setup/network.js';
import { checkDomainBody, FAKE_KEYS, PORKBUN_BASE, pbError, record, recorded } from '../helpers/porkbun-msw.js';

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

describe('PorkbunAdapter.quote', () => {
  it('nulls prices above the Postgres integer range instead of throwing', async () => {
    mswServer.use(http.post(`${PORKBUN_BASE}/domain/checkDomain/:d`, async ({ request }) => {
      await record(request);
      return HttpResponse.json(checkDomainBody({ price: '99999999.99' }));
    }));
    const q = await pb().quote('examplecityroofing.com');
    expect(q.firstYearCents).toBeNull();
  });

  it('parses decimal-string prices into cents; privacy is free', async () => {
    mswServer.use(http.post(`${PORKBUN_BASE}/domain/checkDomain/:d`, async ({ request }) => {
      await record(request);
      return HttpResponse.json(checkDomainBody());
    }));
    const q = await pb().quote('examplecityroofing.com');
    expect(q).toMatchObject({
      available: true, premium: false, firstYearCents: 1108, renewalCents: 1108, privacyCentsPerYear: 0,
      currency: 'USD', minDurationYears: 1,
    });
  });

  it('sends keys only as headers, with a JSON body and no key fields', async () => {
    mswServer.use(http.post(`${PORKBUN_BASE}/domain/checkDomain/:d`, async ({ request }) => {
      await record(request);
      return HttpResponse.json(checkDomainBody());
    }));
    await pb().quote('examplecityroofing.com');
    const r = recorded[0]!;
    expect(r.path).toBe('/domain/checkDomain/examplecityroofing.com');
    expect(r.headers['x-api-key']).toBe(FAKE_KEYS.apiKey);
    expect(r.headers['x-secret-api-key']).toBe(FAKE_KEYS.secretKey);
    expect(JSON.stringify(r.body)).not.toMatch(/pk1_|sk1_|apikey/i);
  });

  it('promo first year: first year = price, renewal = additional.renewal.price', async () => {
    mswServer.use(http.post(`${PORKBUN_BASE}/domain/checkDomain/:d`, () =>
      HttpResponse.json(checkDomainBody({ price: '5.00', firstYearPromo: 'yes', regularPrice: '11.08' }, '25.00'))));
    const q = await pb().quote('x.com');
    expect(q.firstYearCents).toBe(500);
    expect(q.renewalCents).toBe(2500);
  });

  it('missing renewal price → renewalCents null (selection excludes it)', async () => {
    mswServer.use(http.post(`${PORKBUN_BASE}/domain/checkDomain/:d`, () => HttpResponse.json(checkDomainBody({}, null))));
    expect((await pb().quote('x.com')).renewalCents).toBeNull();
  });

  it('premium and unavailable flags', async () => {
    mswServer.use(http.post(`${PORKBUN_BASE}/domain/checkDomain/:d`, () =>
      HttpResponse.json(checkDomainBody({ avail: 'no', premium: 'yes' }))));
    expect(await pb().quote('x.com')).toMatchObject({ available: false, premium: true });
  });

  it('a coded error is a definite RegistrarError with that code', async () => {
    mswServer.use(http.post(`${PORKBUN_BASE}/domain/checkDomain/:d`, () => pbError('INVALID_API_KEYS_001', {}, { status: 403 })));
    const e = await errOf(pb().quote('x.com'));
    expect(e).toMatchObject({ registrar: 'porkbun', code: 'INVALID_API_KEYS_001', httpStatus: 403, ambiguous: false });
  });

  it('a coded error on HTTP 503 is ambiguous', async () => {
    mswServer.use(http.post(`${PORKBUN_BASE}/domain/checkDomain/:d`, () => pbError('SOME_CODE', {}, { status: 503 })));
    expect(await errOf(pb().quote('x.com'))).toMatchObject({ code: 'SOME_CODE', httpStatus: 503, ambiguous: true });
  });

  it('IDEMPOTENCY_KEY_IN_USE is ambiguous even at HTTP 409', async () => {
    mswServer.use(http.post(`${PORKBUN_BASE}/domain/checkDomain/:d`, () => pbError('IDEMPOTENCY_KEY_IN_USE', {}, { status: 409 })));
    expect(await errOf(pb().quote('x.com'))).toMatchObject({ code: 'IDEMPOTENCY_KEY_IN_USE', ambiguous: true });
  });

  it('RATE_LIMIT_EXCEEDED carries Retry-After seconds', async () => {
    mswServer.use(http.post(`${PORKBUN_BASE}/domain/checkDomain/:d`, () =>
      pbError('RATE_LIMIT_EXCEEDED', { ttlRemaining: 7 }, { status: 429, headers: { 'Retry-After': '7' } })));
    const e = await errOf(pb().quote('x.com'));
    expect(e).toMatchObject({ code: 'RATE_LIMIT_EXCEEDED', retryAfterSeconds: 7, ambiguous: false });
  });

  it('an ERROR without a code → UNKNOWN_REGISTRAR_ERROR (definite)', async () => {
    mswServer.use(http.post(`${PORKBUN_BASE}/domain/checkDomain/:d`, () => pbError(undefined)));
    expect(await errOf(pb().quote('x.com'))).toMatchObject({ code: 'UNKNOWN_REGISTRAR_ERROR', ambiguous: false });
  });

  it('HTTP 200 with HTML → ambiguous REGISTRAR_BAD_RESPONSE', async () => {
    mswServer.use(http.post(`${PORKBUN_BASE}/domain/checkDomain/:d`, () =>
      new HttpResponse('<html>edge error</html>', { status: 200, headers: { 'content-type': 'text/html' } })));
    expect(await errOf(pb().quote('x.com'))).toMatchObject({ code: 'REGISTRAR_BAD_RESPONSE', ambiguous: true });
  });

  it('SUCCESS with an unparseable price → ambiguous REGISTRAR_BAD_RESPONSE', async () => {
    mswServer.use(http.post(`${PORKBUN_BASE}/domain/checkDomain/:d`, () => HttpResponse.json(checkDomainBody({ price: '9.735' }))));
    expect(await errOf(pb().quote('x.com'))).toMatchObject({ code: 'REGISTRAR_BAD_RESPONSE', ambiguous: true });
  });

  it('HTTP 502 without JSON → ambiguous REGISTRAR_HTTP_5XX', async () => {
    mswServer.use(http.post(`${PORKBUN_BASE}/domain/checkDomain/:d`, () => new HttpResponse('bad gateway', { status: 502 })));
    expect(await errOf(pb().quote('x.com'))).toMatchObject({ code: 'REGISTRAR_HTTP_5XX', ambiguous: true, httpStatus: 502 });
  });

  it('timeout → ambiguous REGISTRAR_TIMEOUT', async () => {
    mswServer.use(http.post(`${PORKBUN_BASE}/domain/checkDomain/:d`, async () => {
      await delay(1000);
      return HttpResponse.json(checkDomainBody());
    }));
    expect(await errOf(pb().quote('x.com'))).toMatchObject({ code: 'REGISTRAR_TIMEOUT', ambiguous: true });
  });

  it('a caller abort signal also aborts', async () => {
    mswServer.use(http.post(`${PORKBUN_BASE}/domain/checkDomain/:d`, async () => {
      await delay(1000);
      return HttpResponse.json(checkDomainBody());
    }));
    const ac = new AbortController();
    const p = new PorkbunAdapter({ ...FAKE_KEYS, timeoutMs: 5000 }).quote('x.com', { signal: ac.signal });
    setTimeout(() => ac.abort(), 20);
    expect(await errOf(p)).toMatchObject({ code: 'REGISTRAR_TIMEOUT', ambiguous: true });
  });

  it('network failure → ambiguous REGISTRAR_NETWORK', async () => {
    mswServer.use(http.post(`${PORKBUN_BASE}/domain/checkDomain/:d`, () => HttpResponse.error()));
    expect(await errOf(pb().quote('x.com'))).toMatchObject({ code: 'REGISTRAR_NETWORK', ambiguous: true });
  });

  it('error messages never contain the keys', async () => {
    mswServer.use(http.post(`${PORKBUN_BASE}/domain/checkDomain/:d`, () => HttpResponse.error()));
    const e = await errOf(pb().quote('x.com'));
    expect(`${e.message} ${JSON.stringify(e)}`).not.toMatch(/pk1_|sk1_/);
  });
});

describe('PorkbunAdapter.accountState', () => {
  it('reads balance and apiSettings (spend limit remaining, autoTopup); never a top-up path', async () => {
    mswServer.use(
      http.get(`${PORKBUN_BASE}/account/balance`, async ({ request }) => {
        await record(request);
        return HttpResponse.json({ status: 'SUCCESS', balance: 5000, display: '$50.00' });
      }),
      http.get(`${PORKBUN_BASE}/account/apiSettings`, async ({ request }) => {
        await record(request);
        return HttpResponse.json({
          status: 'SUCCESS',
          settings: { monthlySpendLimit: 10000, autoTopup: false },
          monthlySpend: 1108,
          spendLimit: { limit: 10000, source: 'account', spent: 1108, remaining: 8892 },
        });
      }),
    );
    expect(await pb().accountState()).toEqual({ balanceCents: 5000, spendLimitRemainingCents: 8892, autoTopupEnabled: false });
    expect(recorded.map((r) => `${r.method} ${r.path}`).sort()).toEqual(['GET /account/apiSettings', 'GET /account/balance']);
  });

  it('non-integer balance → null', async () => {
    mswServer.use(
      http.get(`${PORKBUN_BASE}/account/balance`, () => HttpResponse.json({ status: 'SUCCESS', balance: 50.5 })),
      http.get(`${PORKBUN_BASE}/account/apiSettings`, () => HttpResponse.json({ status: 'SUCCESS', settings: {}, spendLimit: { remaining: 1.5 } })),
    );
    expect(await pb().accountState()).toEqual({ balanceCents: null, spendLimitRemainingCents: null, autoTopupEnabled: null });
  });

  it('no cap → spendLimitRemainingCents null', async () => {
    mswServer.use(
      http.get(`${PORKBUN_BASE}/account/balance`, () => HttpResponse.json({ status: 'SUCCESS', balance: 0, display: '$0.00' })),
      http.get(`${PORKBUN_BASE}/account/apiSettings`, () =>
        HttpResponse.json({ status: 'SUCCESS', settings: { autoTopup: true }, spendLimit: { limit: null, source: 'none', spent: 0, remaining: null } })),
    );
    expect(await pb().accountState()).toEqual({ balanceCents: 0, spendLimitRemainingCents: null, autoTopupEnabled: true });
  });
});

describe('PorkbunAdapter.capabilities', () => {
  it('full adapter; sandbox only for pk1_sb_ keys', () => {
    expect(pb().capabilities).toEqual({
      canQuote: true, canRegister: true, canManageNs: true, customNs: true,
      prepaid: true, freePrivacy: true, afternicFastTransfer: true, sandbox: false,
    });
    expect(new PorkbunAdapter({ apiKey: 'pk1_sb_x', secretKey: 'sk1_sb_x' }).capabilities.sandbox).toBe(true);
  });
});
