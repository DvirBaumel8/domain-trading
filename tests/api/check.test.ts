import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { RegistrarError } from '../../src/modules/registrars/types.js';
import type { RdapFn } from '../../src/core/rdap.js';
import { makeApp } from '../helpers/app.js';
import { testDb as db } from '../helpers/db.js';
import { FakeAdapter } from '../helpers/fake-adapter.js';
import { issueToken } from '../helpers/tokens.js';

let app: FastifyInstance;
afterEach(async () => app?.close());

const rdapFree: RdapFn = async () => 'not_registered';
const rdapTaken: RdapFn = async () => 'registered';

async function check(domain: string, headers: Record<string, string>) {
  return app.inject({ method: 'GET', url: `/check?domain=${encodeURIComponent(domain)}`, headers });
}

describe('GET /check', () => {
  it('returns the spec shape: winner with cents + display, quotes, warnings, IDT time', async () => {
    const porkbun = new FakeAdapter('porkbun');
    const namecom = new FakeAdapter('namecom', { quote: { firstYearCents: 1299, renewalCents: 1799 } });
    app = await makeApp({ adapters: [namecom, porkbun], rdap: rdapFree, env: { ENABLED_REGISTRARS: 'porkbun,namecom' } });
    await db.updateTable('settings').set({ allowed_registrars: ['porkbun', 'namecom'] }).execute();
    const { auth } = await issueToken('read');
    const res = await check('PromptInjectionAudit.com', auth);
    expect(res.statusCode).toBe(200);
    const b = res.json();
    expect(b).toMatchObject({
      domain: 'promptinjectionaudit.com',
      availability: 'available',
      rdap: 'not_registered',
      winner: {
        registrar: 'porkbun', first_year: '$11.08', renewal: '$11.08', two_year: '$22.16',
        first_year_cents: 1108, renewal_cents: 1108, two_year_cents: 2216,
      },
      warnings: [],
    });
    expect(b.check_id).toMatch(/^chk_[0-9a-f]{24}$/);
    expect(b.checked_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\+0[23]:00$/);
    expect(b.quotes.map((q: { registrar: string }) => q.registrar)).toEqual(['porkbun', 'namecom']);
    expect(b.quotes[1]).toMatchObject({
      registrar: 'namecom', eligible: true, available: true, premium: false,
      first_year_cents: 1299, renewal_cents: 1799, privacy_cents_per_year: 0, two_year_cents: 3098, two_year: '$30.98',
    });
  });

  it('CK-1 end to end: cheap first year with a dear renewal loses; warning present', async () => {
    const promo = new FakeAdapter('namecom', { quote: { firstYearCents: 500, renewalCents: 2500 } });
    app = await makeApp({ adapters: [promo, new FakeAdapter('porkbun')], rdap: rdapFree });
    await db.updateTable('settings').set({ allowed_registrars: ['porkbun', 'namecom'] }).execute();
    const { auth } = await issueToken('read');
    const b = (await check('x.com', auth)).json();
    expect(b.winner.registrar).toBe('porkbun');
    expect(b.warnings).toEqual(['Cheapest first year (namecom $5.00) is not cheapest over 2 years']);
  });

  it('stores every quote under the check_id (eligible and excluded)', async () => {
    const premium = new FakeAdapter('namecom', { quote: { premium: true } });
    app = await makeApp({ adapters: [new FakeAdapter('porkbun'), premium], rdap: rdapFree });
    await db.updateTable('settings').set({ allowed_registrars: ['porkbun', 'namecom'] }).execute();
    const { auth } = await issueToken('read');
    const b = (await check('x.com', auth)).json();
    const rows = await db.selectFrom('quotes').selectAll().where('check_id', '=', b.check_id).orderBy('registrar').execute();
    expect(rows.map((r) => [r.registrar, r.eligible, r.exclusion_reason, r.two_year_cents])).toEqual([
      ['namecom', false, 'PREMIUM', null],
      ['porkbun', true, null, 2216],
    ]);
    expect(rows[1]!.domain).toBe('x.com');
  });

  it('CK-5: a timed-out adapter is excluded ADAPTER_ERROR; the rest still compared; 200', async () => {
    app = await makeApp({
      adapters: [new FakeAdapter('porkbun'), new FakeAdapter('namecom', { hang: true })],
      rdap: rdapFree, quoteTimeoutMs: 50,
    });
    await db.updateTable('settings').set({ allowed_registrars: ['porkbun', 'namecom'] }).execute();
    const { auth } = await issueToken('read');
    const res = await check('x.com', auth);
    expect(res.statusCode).toBe(200);
    const b = res.json();
    expect(b.winner.registrar).toBe('porkbun');
    expect(b.quotes.find((q: { registrar: string }) => q.registrar === 'namecom')).toMatchObject({
      eligible: false, exclusion_reason: 'ADAPTER_ERROR', error_code: 'REGISTRAR_TIMEOUT',
    });
  });

  it('Review Focus 5: every adapter fails → 200, unknown, no winner', async () => {
    const boom = new RegistrarError('porkbun', 'INVALID_API_KEYS_001', 'x');
    app = await makeApp({ adapters: [new FakeAdapter('porkbun', { error: boom })], rdap: rdapFree });
    const { auth } = await issueToken('read');
    const res = await check('x.com', auth);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ availability: 'unknown', winner: null });
    expect(res.json().quotes[0]).toMatchObject({ exclusion_reason: 'ADAPTER_ERROR', error_code: 'INVALID_API_KEYS_001' });
  });

  it('CK-6: RDAP registered but adapter says available → unknown, no winner', async () => {
    app = await makeApp({ adapters: [new FakeAdapter('porkbun')], rdap: rdapTaken });
    const { auth } = await issueToken('read');
    expect((await check('x.com', auth)).json()).toMatchObject({ availability: 'unknown', rdap: 'registered', winner: null });
  });

  it('taken: RDAP registered and adapter says no → taken, no winner', async () => {
    app = await makeApp({ adapters: [new FakeAdapter('porkbun', { quote: { available: false } })], rdap: rdapTaken });
    const { auth } = await issueToken('read');
    expect((await check('promptinjectionaudit.com', auth)).json()).toMatchObject({ availability: 'taken', winner: null });
  });

  it('S5: a registrar not in settings.allowed_registrars is listed but never called', async () => {
    const namecom = new FakeAdapter('namecom');
    app = await makeApp({ adapters: [new FakeAdapter('porkbun'), namecom], rdap: rdapFree });
    const { auth } = await issueToken('read');
    const b = (await check('x.com', auth)).json();
    expect(namecom.calls).toEqual([]);
    expect(b.quotes.find((q: { registrar: string }) => q.registrar === 'namecom')).toMatchObject({
      eligible: false, exclusion_reason: 'REGISTRAR_NOT_ALLOWED',
    });
  });

  it('S6: cached for 60 s per domain (same check_id, adapters called once), refreshed after', async () => {
    let t = 1_000_000;
    const porkbun = new FakeAdapter('porkbun');
    app = await makeApp({ adapters: [porkbun], rdap: rdapFree, now: () => t });
    const { auth } = await issueToken('read');
    const a = (await check('x.com', auth)).json();
    t += 59_000;
    const b = (await check('X.com', auth)).json();
    expect(b.check_id).toBe(a.check_id);
    expect(porkbun.calls).toHaveLength(1);
    t += 2_000;
    const c = (await check('x.com', auth)).json();
    expect(c.check_id).not.toBe(a.check_id);
    expect(porkbun.calls).toHaveLength(2);
    const stored = await db.selectFrom('quotes').select('check_id').distinct().execute();
    expect(stored).toHaveLength(2);
  });

  it('CK-10: .net → 422 TLD_NOT_SUPPORTED; subdomain → 422 DOMAIN_INVALID; missing param → 400', async () => {
    app = await makeApp({ adapters: [new FakeAdapter('porkbun')], rdap: rdapFree });
    const { auth } = await issueToken('read');
    expect((await check('example.net', auth)).json().error.code).toBe('TLD_NOT_SUPPORTED');
    expect((await check('www.example.com', auth)).json().error.code).toBe('DOMAIN_INVALID');
    const res = await app.inject({ method: 'GET', url: '/check', headers: auth });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('VALIDATION_ERROR');
  });

  it('CK-11: READ token → 200; no token → 401', async () => {
    app = await makeApp({ adapters: [new FakeAdapter('porkbun')], rdap: rdapFree });
    const { auth } = await issueToken('read');
    expect((await check('x.com', auth)).statusCode).toBe(200);
    expect((await check('x.com', {})).statusCode).toBe(401);
  });

  it('CK-13: body has no secret, key prefix or account balance; accountState never called', async () => {
    const porkbun = new FakeAdapter('porkbun');
    app = await makeApp({ adapters: [porkbun], rdap: rdapFree });
    const { auth } = await issueToken('read');
    const text = (await check('x.com', auth)).body;
    expect(text).not.toMatch(/pk1_|sk1_|balance|fake_godaddy|github_pat/i);
    expect(porkbun.calls).not.toContain('accountState');
  });

  it('a GET /check writes no audit row', async () => {
    app = await makeApp({ adapters: [new FakeAdapter('porkbun')], rdap: rdapFree });
    const { auth } = await issueToken('read');
    await check('x.com', auth);
    expect(await db.selectFrom('audit_log').selectAll().where('method', '<>', 'ADMIN').execute()).toHaveLength(0);
  });
});
