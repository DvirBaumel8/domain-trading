import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { RdapFn } from '../../src/rdap.js';
import { RegistrarError } from '../../src/registrars/types.js';
import { makeApp } from '../helpers/app.js';
import { DOMAIN, buyBody, postBuy, seedOwnedDomains, seedSpent } from '../helpers/buy.js';
import { insertOwnedDomain, testDb as db } from '../helpers/db.js';
import { FakeAdapter } from '../helpers/fake-adapter.js';
import { issueToken } from '../helpers/tokens.js';

let app: FastifyInstance;
afterEach(async () => app?.close());
const rdapFree: RdapFn = async () => 'not_registered';
const rdapTaken: RdapFn = async () => 'registered';

async function setup(adapters: FakeAdapter[] = [new FakeAdapter('porkbun')], rdap: RdapFn = rdapFree) {
  app = await makeApp({ adapters, rdap });
  return (await issueToken('write')).auth;
}
const rows = async () => ({
  purchases: await db.selectFrom('purchases').selectAll().execute(),
  domains: await db.selectFrom('domains').selectAll().execute(),
  ledger: await db.selectFrom('ledger_entries').selectAll().execute(),
});
const registerCalls = (a: FakeAdapter) => a.calls.filter((c) => c.startsWith('register'));

describe('POST /buy checks (no money moves)', () => {
  it('B-1/AU-3: READ token → 403, audit row, zero registrar calls', async () => {
    const pb = new FakeAdapter('porkbun');
    app = await makeApp({ adapters: [pb], rdap: rdapFree });
    const { auth } = await issueToken('read');
    const res = await postBuy(app, buyBody(), auth);
    expect(res.statusCode).toBe(403);
    expect(pb.calls).toEqual([]);
    expect(await db.selectFrom('audit_log').selectAll().where('path', '=', '/buy').execute()).toHaveLength(1);
  });

  it('B-2: no Idempotency-Key → 400', async () => {
    const auth = await setup();
    const res = await app.inject({ method: 'POST', url: '/buy', headers: auth, payload: buyBody() });
    expect(res.statusCode).toBe(400);
  });

  it('B-4: same key, different body → 409 IDEMPOTENCY_KEY_MISMATCH', async () => {
    const auth = await setup();
    await postBuy(app, buyBody({ dry_run: true }), auth, 'k-b4');
    const res = await postBuy(app, buyBody({ dry_run: true, max_price: 12 }), auth, 'k-b4');
    expect(res.json().error.code).toBe('IDEMPOTENCY_KEY_MISMATCH');
  });

  it('B-7/CAP-4: approval missing the domain / 73 h old / in the future → 422, no registrar call', async () => {
    const pb = new FakeAdapter('porkbun');
    const auth = await setup([pb]);
    const cases = [
      { text: 'yes buy it', approved_at: new Date().toISOString() },
      { text: `buy ${DOMAIN}`, approved_at: new Date(Date.now() - 73 * 3_600_000).toISOString() },
      { text: `buy ${DOMAIN}`, approved_at: new Date(Date.now() + 3_600_000).toISOString() },
    ];
    const codes = [];
    for (const approval_ref of cases) {
      const res = await postBuy(app, buyBody({ approval_ref }), auth);
      expect(res.statusCode).toBe(422);
      codes.push(res.json().error.code);
    }
    expect(codes).toEqual(['APPROVAL_INVALID', 'APPROVAL_EXPIRED', 'APPROVAL_INVALID']);
    expect(pb.calls).toEqual([]);
  });

  it('missing approval_ref → 422 APPROVAL_INVALID', async () => {
    const auth = await setup();
    const { approval_ref: _drop, ...body } = buyBody();
    expect((await postBuy(app, body, auth)).json().error.code).toBe('APPROVAL_INVALID');
  });

  it('LG-17: no category → 422 CATEGORY_REQUIRED, zero registrar calls', async () => {
    const pb = new FakeAdapter('porkbun');
    const auth = await setup([pb]);
    const { category: _c, ...body } = buyBody();
    const res = await postBuy(app, body, auth);
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe('CATEGORY_REQUIRED');
    expect(pb.calls).toEqual([]);
  });

  it('LG-16: proposed_listing breaking the geo guard → 422 before any registrar call', async () => {
    const pb = new FakeAdapter('porkbun');
    const auth = await setup([pb]);
    const res = await postBuy(app, buyBody({ proposed_listing: { mode: 'bin', bin: 650 } }), auth);
    expect(res.json().error.code).toBe('GEO_BIN_OUT_OF_RANGE');
    expect(pb.calls).toEqual([]);
  });

  it('CAP-5: a cap field in the body is rejected (strict schema); settings unchanged', async () => {
    const auth = await setup();
    const res = await postBuy(app, buyBody({ poc_cap: 999999 }), auth);
    expect(res.statusCode).toBe(422);
    expect((await db.selectFrom('settings').select('poc_cap_cents').executeTakeFirstOrThrow()).poc_cap_cents).toBe(150000);
  });

  it('B-14: RDAP says registered → 409 NOT_AVAILABLE, zero register calls', async () => {
    const pb = new FakeAdapter('porkbun');
    const auth = await setup([pb], rdapTaken);
    const res = await postBuy(app, buyBody(), auth);
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('NOT_AVAILABLE');
    expect(registerCalls(pb)).toEqual([]);
  });

  it('B-8: max_price 10.00 with best quote 11.08 → 409 PRICE_ABOVE_MAX, details show $11.08', async () => {
    const auth = await setup();
    const res = await postBuy(app, buyBody({ max_price: 10 }), auth);
    expect(res.json().error).toMatchObject({ code: 'PRICE_ABOVE_MAX', details: { cheapest: { registrar: 'porkbun', first_year: '$11.08', two_year: '$22.16' } } });
  });

  it('B-9: max_two_year_price below the best 2-yr → 409 PRICE_ABOVE_MAX', async () => {
    const auth = await setup();
    expect((await postBuy(app, buyBody({ max_two_year_price: 20 }), auth)).json().error.code).toBe('PRICE_ABOVE_MAX');
  });

  it('B-10: caps filter before the minimum (A $11.60/$20.00 vs B $11.08/$22.16, max 11.50) → B', async () => {
    const a = new FakeAdapter('dynadot', { quote: { firstYearCents: 1160, renewalCents: 840 } });
    const b = new FakeAdapter('porkbun');
    const auth = await setup([a, b]);
    await db.updateTable('settings').set({ allowed_registrars: ['porkbun', 'dynadot'] }).execute();
    const res = await postBuy(app, buyBody({ dry_run: true }), auth);
    expect(res.json()).toMatchObject({ dry_run: true, registrar: 'porkbun' });
  });

  it('B-11/CAP-1: spent $495.00 + $11.08 → 409 POC_CAP_EXCEEDED with remaining $5.00', async () => {
    const auth = await setup();
    await seedSpent(149500);
    const res = await postBuy(app, buyBody(), auth);
    expect(res.json().error).toMatchObject({ code: 'POC_CAP_EXCEEDED', details: { remaining: '$5.00', remaining_cents: 500 } });
  });

  it('B-13/CAP-2: 50 domains owned → 409 DOMAIN_CAP_REACHED', async () => {
    const pb = new FakeAdapter('porkbun');
    const auth = await setup([pb]);
    await seedOwnedDomains(50);
    expect((await postBuy(app, buyBody(), auth)).json().error.code).toBe('DOMAIN_CAP_REACHED');
    expect(pb.calls).toEqual([]);
  });

  it('check 4: domain already owned → 409 ALREADY_OWNED_OR_PENDING, zero registrar calls', async () => {
    const pb = new FakeAdapter('porkbun');
    const auth = await setup([pb]);
    await insertOwnedDomain(db, { domain: DOMAIN });
    expect((await postBuy(app, buyBody(), auth)).json().error.code).toBe('ALREADY_OWNED_OR_PENDING');
    expect(pb.calls).toEqual([]);
  });

  it('check 4: delisted domain is still held → 409 ALREADY_OWNED_OR_PENDING, zero registrar calls', async () => {
    const pb = new FakeAdapter('porkbun');
    const auth = await setup([pb]);
    await insertOwnedDomain(db, { domain: DOMAIN, status: 'delisted' });
    expect((await postBuy(app, buyBody(), auth)).json().error.code).toBe('ALREADY_OWNED_OR_PENDING');
    expect(pb.calls).toEqual([]);
  });

  it('check 4: open purchase row in register_sent → 409 ALREADY_OWNED_OR_PENDING, zero registrar calls', async () => {
    const pb = new FakeAdapter('porkbun');
    const auth = await setup([pb]);
    await db.insertInto('purchases').values({
      idempotency_key: 'other-key', request_hash: 'h', domain: DOMAIN, state: 'register_sent', dry_run: false, registrar: 'porkbun',
      max_price_cents: 1150, approval_text: `yes buy ${DOMAIN}`, approval_at: new Date(), expected_cents: 1108,
      request: JSON.stringify({}), audit_id: null,
    }).execute();
    expect((await postBuy(app, buyBody(), auth)).json().error.code).toBe('ALREADY_OWNED_OR_PENDING');
    expect(pb.calls).toEqual([]);
  });

  it('check 4: domain row with status sold → 409 ALREADY_IN_PORTFOLIO, zero registrar calls', async () => {
    const pb = new FakeAdapter('porkbun');
    const auth = await setup([pb]);
    await insertOwnedDomain(db, { domain: DOMAIN, status: 'sold' });
    expect((await postBuy(app, buyBody(), auth)).json().error.code).toBe('ALREADY_IN_PORTFOLIO');
    expect(pb.calls).toEqual([]);
  });

  it('INSUFFICIENT_FUNDS without details.shortfall → 409 REGISTRAR_FUNDS with no shortfall keys', async () => {
    const err = new RegistrarError('porkbun', 'INSUFFICIENT_FUNDS', 'x');
    const auth = await setup([new FakeAdapter('porkbun', { dryRun: () => err })]);
    const res = await postBuy(app, buyBody(), auth);
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('REGISTRAR_FUNDS');
    expect(res.json().error.details).not.toHaveProperty('shortfall');
    expect(res.json().error.details).not.toHaveProperty('shortfall_cents');
  });

  it('B-15: pinned registrar ineligible → 409 PINNED_REGISTRAR_INELIGIBLE, no fallback', async () => {
    const premium = new FakeAdapter('dynadot', { quote: { premium: true } });
    const pb = new FakeAdapter('porkbun');
    const auth = await setup([premium, pb]);
    await db.updateTable('settings').set({ allowed_registrars: ['porkbun', 'dynadot'] }).execute();
    const res = await postBuy(app, buyBody({ registrar: 'dynadot' }), auth);
    expect(res.json().error).toMatchObject({ code: 'PINNED_REGISTRAR_INELIGIBLE', details: { registrar: 'dynadot', exclusion_reason: 'PREMIUM' } });
    expect(registerCalls(pb)).toEqual([]);
  });

  it('no eligible registrar → 409 NO_ELIGIBLE_REGISTRAR', async () => {
    const auth = await setup([new FakeAdapter('porkbun', { quote: { renewalCents: null } })]);
    // availability is still 'available' (adapter says yes), but the only quote is excluded
    expect((await postBuy(app, buyBody(), auth)).json().error.code).toBe('NO_ELIGIBLE_REGISTRAR');
  });

  it('B2: auto top-up ON → 409 REGISTRAR_AUTO_TOPUP_ON', async () => {
    const auth = await setup([new FakeAdapter('porkbun', { account: { autoTopupEnabled: true } })]);
    expect((await postBuy(app, buyBody(), auth)).json().error.code).toBe('REGISTRAR_AUTO_TOPUP_ON');
  });

  it('B2: account state unreadable → 409 REGISTRAR_STATE_UNKNOWN', async () => {
    const auth = await setup([new FakeAdapter('porkbun', { account: new RegistrarError('porkbun', 'REGISTRAR_TIMEOUT', 't', { ambiguous: true }) })]);
    expect((await postBuy(app, buyBody(), auth)).json().error.code).toBe('REGISTRAR_STATE_UNKNOWN');
  });

  it('check 9: balance below cost → 409 REGISTRAR_FUNDS with the shortfall; spend-limit remaining below cost → 409', async () => {
    const auth = await setup([new FakeAdapter('porkbun', { account: { balanceCents: 500 } })]);
    expect((await postBuy(app, buyBody(), auth)).json().error).toMatchObject({ code: 'REGISTRAR_FUNDS', details: { shortfall_cents: 608 } });
    await app.close();
    const auth2 = await setup([new FakeAdapter('porkbun', { account: { spendLimitRemainingCents: 100 } })]);
    expect((await postBuy(app, buyBody(), auth2)).json().error).toMatchObject({ code: 'REGISTRAR_FUNDS', details: { reason: 'MONTHLY_SPEND_LIMIT' } });
  });

  it('B-17: registrar dry run says INSUFFICIENT_FUNDS → 409 REGISTRAR_FUNDS with shortfall, never the balance', async () => {
    const err = new RegistrarError('porkbun', 'INSUFFICIENT_FUNDS', 'x', { details: { cost: 1108, balance: 500, shortfall: 608 } });
    const auth = await setup([new FakeAdapter('porkbun', { dryRun: () => err })]);
    const res = await postBuy(app, buyBody(), auth);
    expect(res.json().error).toMatchObject({ code: 'REGISTRAR_FUNDS', details: { shortfall_cents: 608, shortfall: '$6.08' } });
    expect(res.body).not.toMatch(/"balance"/);
  });

  it('check 10: dry run wouldSucceed false (no shortfall) → 409 REGISTRAR_DRY_RUN_FAILED', async () => {
    const auth = await setup([new FakeAdapter('porkbun', { dryRun: () => ({ wouldSucceed: false }) })]);
    expect((await postBuy(app, buyBody(), auth)).json().error.code).toBe('REGISTRAR_DRY_RUN_FAILED');
  });

  it('check 10: a coded dry-run error → 409 REGISTRAR_DRY_RUN_FAILED with registrar_code', async () => {
    const auth = await setup([new FakeAdapter('porkbun', { dryRun: () => new RegistrarError('porkbun', 'VERIFICATION_REQUIRED', 'x') })]);
    expect((await postBuy(app, buyBody(), auth)).json().error).toMatchObject({ code: 'REGISTRAR_DRY_RUN_FAILED', details: { registrar_code: 'VERIFICATION_REQUIRED' } });
  });

  it('B-18: COST_MISMATCH on the dry run → re-quote once; new price within caps → proceeds with the new cost', async () => {
    const pb = new FakeAdapter('porkbun', {
      quoteSeq: [{}, { firstYearCents: 1150, renewalCents: 1150 }],
      dryRun: (n) => (n === 0 ? new RegistrarError('porkbun', 'COST_MISMATCH', 'x') : undefined),
    });
    const auth = await setup([pb]);
    const res = await postBuy(app, buyBody({ dry_run: true }), auth);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ first_year_cents: 1150, registrar_dry_run: { would_succeed: true, cost_cents: 1150 } });
  });

  it('B-18: re-quoted price above max_price → 409 PRICE_ABOVE_MAX', async () => {
    const pb = new FakeAdapter('porkbun', {
      quoteSeq: [{}, { firstYearCents: 1200, renewalCents: 1200 }],
      dryRun: (n) => (n === 0 ? new RegistrarError('porkbun', 'COST_MISMATCH', 'x') : undefined),
    });
    const auth = await setup([pb]);
    expect((await postBuy(app, buyBody({ dry_run: true }), auth)).json().error.code).toBe('PRICE_ABOVE_MAX');
  });

  it('B-16/DR-1: dry_run:true → 200, registrar dry run with the exact cost; only audit + quotes rows written', async () => {
    const pb = new FakeAdapter('porkbun');
    const auth = await setup([pb]);
    const res = await postBuy(app, buyBody({ dry_run: true, proposed_listing: { mode: 'bin', bin: 399 }, deal_id: 'D-002' }), auth);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      dry_run: true, domain: DOMAIN, registrar: 'porkbun', first_year: '$11.08', renewal: '$11.08', two_year: '$22.16',
      poc_spent: '$0.00', poc_remaining_after: '$1,488.92', registrar_dry_run: { would_succeed: true, cost: '$11.08', cost_cents: 1108 },
      proposed_listing: { mode: 'bin', bin: 399, floor: 399, min_offer: 399, lto_max_months: null },
    });
    expect(registerCalls(pb)).toEqual([expect.stringMatching(/^register examplecityroofing\.com dry=true key=dtdry-[0-9a-f-]{36} cost=1108$/)]);
    const r = await rows();
    expect([r.purchases.length, r.domains.length, r.ledger.length]).toEqual([0, 0, 0]);
    expect(await db.selectFrom('quotes').selectAll().execute()).not.toHaveLength(0);
    expect(await db.selectFrom('audit_log').selectAll().where('path', '=', '/buy').execute()).toHaveLength(1);
  });

  it('DR-2: dry run enforces every check (POC cap)', async () => {
    const auth = await setup();
    await seedSpent(149500);
    expect((await postBuy(app, buyBody({ dry_run: true }), auth)).json().error.code).toBe('POC_CAP_EXCEEDED');
  });

  it('DR-3: dry run, then the real call with the same key → 409 (different request hash)', async () => {
    const auth = await setup();
    await postBuy(app, buyBody({ dry_run: true }), auth, 'k-dr3');
    const res = await postBuy(app, buyBody(), auth, 'k-dr3');
    expect(res.json().error.code).toBe('IDEMPOTENCY_KEY_MISMATCH');
  });

  it('invalid max_price (3 decimals) → 422', async () => {
    const auth = await setup();
    expect((await postBuy(app, buyBody({ max_price: 11.505 }), auth)).statusCode).toBe(422);
  });
});
