import { http, HttpResponse } from 'msw';
import { beforeEach, describe, expect, it } from 'vitest';
import { PorkbunAdapter, redactInvoice } from '../../src/registrars/porkbun.js';
import { mswServer } from '../setup/network.js';
import { FAKE_KEYS, PORKBUN_BASE, pbError, record, recorded } from '../helpers/porkbun-msw.js';

const pb = () => new PorkbunAdapter({ ...FAKE_KEYS, timeoutMs: 200 });
beforeEach(() => {
  recorded.length = 0;
});

const invoice = (id: number, domain: string, over: Record<string, unknown> = {}) => ({
  status: 'SUCCESS',
  invoice: {
    id, date: '2026-10-05', state: 'PAID',
    billTo: { company: null, name: 'Dvir X', address: '1 Secret St, Tel Aviv', vat: null },
    paymentMethods: ['Visa ending in 4242'],
    items: [{ domain, product: 'Domain Registration', type: 'registration', years: 1, expires: '2027-10-05 09:00:00', status: 'SUCCESS', price_cents: 1108, discount_cents: 0, tags: [] }],
    gross_cents: 1108, refunded_cents: 0, total_cents: 1108, total: '$11.08', currency: 'USD',
    url: 'https://porkbun.com/account/invoice/1', pdfUrl: 'https://x/pdf', downloadUrl: 'https://x/dl?token=abc', downloadExpires: '2026-10-05T10:00:00Z',
    ...over,
  },
});

describe('redactInvoice', () => {
  it('drops billing and download fields at any depth, keeps the money lines', () => {
    const r = redactInvoice(invoice(1, 'x.com')) as { invoice: Record<string, unknown> };
    expect(r.invoice).not.toHaveProperty('billTo');
    expect(r.invoice).not.toHaveProperty('paymentMethods');
    expect(r.invoice).not.toHaveProperty('url');
    expect(r.invoice).not.toHaveProperty('pdfUrl');
    expect(r.invoice).not.toHaveProperty('downloadUrl');
    expect(r.invoice).not.toHaveProperty('downloadExpires');
    expect(r.invoice).toMatchObject({ id: 1, total_cents: 1108, items: [expect.objectContaining({ price_cents: 1108 })] });
    expect(JSON.stringify(r)).not.toMatch(/Secret St|4242|token=abc/);
  });
});

describe('PorkbunAdapter.findRegistration (B5)', () => {
  it('finds the newest PAID invoice naming the domain, returns charge, order id, expiry; raw is redacted', async () => {
    mswServer.use(
      http.get(`${PORKBUN_BASE}/account/invoices`, async ({ request }) => {
        await record(request);
        return HttpResponse.json({
          status: 'SUCCESS',
          invoices: [
            { id: 9, date: '2026-10-05', state: 'PAID', total_cents: 999, domains: ['other.com'] },
            { id: 7, date: '2026-10-05', state: 'PAID', total_cents: 1108, domains: ['x.com'] },
            { id: 3, date: '2026-09-01', state: 'PAID', total_cents: 1108, domains: ['x.com'] },
          ],
          total: 3,
        });
      }),
      http.get(`${PORKBUN_BASE}/account/invoice/:id`, async ({ request, params }) => {
        await record(request);
        return HttpResponse.json(invoice(Number(params.id), 'x.com'));
      }),
    );
    const r = await pb().findRegistration('x.com', { since: '2026-10-01' });
    expect(r).toMatchObject({ orderId: '7', chargedCents: 1108, expiryDate: '2027-10-05', invoiceDate: '2026-10-05' });
    expect(JSON.stringify(r!.raw)).not.toMatch(/Secret St|4242/);
    expect(recorded.map((x) => x.path)).toEqual(['/account/invoices', '/account/invoice/7']);
  });

  it('charge = price_cents − discount_cents on the registration line', async () => {
    mswServer.use(
      http.get(`${PORKBUN_BASE}/account/invoices`, () =>
        HttpResponse.json({ status: 'SUCCESS', invoices: [{ id: 7, date: '2026-10-05', state: 'PAID', total_cents: 1000, domains: ['x.com'] }] })),
      http.get(`${PORKBUN_BASE}/account/invoice/:id`, () =>
        HttpResponse.json(invoice(7, 'x.com', {
          items: [{ domain: 'x.com', product: 'Domain Registration', years: 1, expires: '2027-10-05 09:00:00', status: 'SUCCESS', price_cents: 1108, discount_cents: 108 }],
        }))),
    );
    expect((await pb().findRegistration('x.com', { since: '2026-10-01' }))?.chargedCents).toBe(1000);
  });

  it('ignores invoices before `since`, refunded/unpaid ones, and non-SUCCESS lines → null', async () => {
    mswServer.use(
      http.get(`${PORKBUN_BASE}/account/invoices`, () =>
        HttpResponse.json({
          status: 'SUCCESS',
          invoices: [
            { id: 5, date: '2026-10-05', state: 'REFUNDED', total_cents: 0, domains: ['x.com'] },
            { id: 3, date: '2026-09-01', state: 'PAID', total_cents: 1108, domains: ['x.com'] },
          ],
        })),
    );
    expect(await pb().findRegistration('x.com', { since: '2026-10-01' })).toBeNull();
  });

  it('a line with status NOT_PROCESSED → null', async () => {
    mswServer.use(
      http.get(`${PORKBUN_BASE}/account/invoices`, () =>
        HttpResponse.json({ status: 'SUCCESS', invoices: [{ id: 7, date: '2026-10-05', state: 'PAID', total_cents: 0, domains: ['x.com'] }] })),
      http.get(`${PORKBUN_BASE}/account/invoice/:id`, () =>
        HttpResponse.json(invoice(7, 'x.com', { items: [{ domain: 'x.com', product: 'Domain Registration', status: 'NOT_PROCESSED', price_cents: 1108, discount_cents: 0 }] }))),
    );
    expect(await pb().findRegistration('x.com', { since: '2026-10-01' })).toBeNull();
  });

  it('queries every year from `since` to now (year boundary)', async () => {
    const years: string[] = [];
    mswServer.use(http.get(`${PORKBUN_BASE}/account/invoices`, ({ request }) => {
      years.push(new URL(request.url).searchParams.get('year') ?? '');
      return HttpResponse.json({ status: 'SUCCESS', invoices: [] });
    }));
    await pb().findRegistration('x.com', { since: '2025-12-31' });
    expect(years).toEqual(expect.arrayContaining(['2025', String(new Date().getUTCFullYear())]));
  });

  it('errors propagate as RegistrarError (never a silent null)', async () => {
    mswServer.use(http.get(`${PORKBUN_BASE}/account/invoices`, () => pbError('RATE_LIMIT_EXCEEDED', {}, { status: 429 })));
    await expect(pb().findRegistration('x.com', { since: '2026-10-01' })).rejects.toMatchObject({ code: 'RATE_LIMIT_EXCEEDED' });
  });

  it('getReceipt returns the redacted invoice', async () => {
    mswServer.use(http.get(`${PORKBUN_BASE}/account/invoice/:id`, () => HttpResponse.json(invoice(7, 'x.com'))));
    const r = await pb().getReceipt('7');
    expect(JSON.stringify(r)).not.toMatch(/Secret St|4242|downloadUrl/);
    expect(r).toMatchObject({ invoice: { id: 7, total_cents: 1108 } });
  });
});
