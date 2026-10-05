import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { RdapFn } from '../../src/rdap.js';
import { RegistrarError } from '../../src/registrars/types.js';
import { failPurchase, markUnknown } from '../../src/services/bookkeeping.js';
import { Reconciler } from '../../src/services/reconciler.js';
import { makeApp } from '../helpers/app.js';
import { DOMAIN, T0, approvalNow, buyBody, postBuy, seedOwnedDomains, seedSpent } from '../helpers/buy.js';
import { testDb as db } from '../helpers/db.js';
import { FakeAdapter } from '../helpers/fake-adapter.js';
import { issueToken } from '../helpers/tokens.js';

let app: FastifyInstance;
afterEach(async () => app?.close());
const rdapFree: RdapFn = async () => 'not_registered';
const timeout = () => new RegistrarError('porkbun', 'REGISTRAR_TIMEOUT', 't', { ambiguous: true });

async function setup(pb: FakeAdapter, rdap: RdapFn = rdapFree) {
  const sleeps: number[] = [];
  app = await makeApp({ adapters: [pb], rdap, now: () => T0, sleep: async (ms) => { sleeps.push(ms); } });
  return { auth: (await issueToken('write')).auth, sleeps };
}
const one = <T>(xs: T[]) => {
  expect(xs).toHaveLength(1);
  return xs[0]!;
};

describe('POST /buy purchase', () => {
  it('B-21/RN-2: success writes exactly the right rows; response shape', async () => {
    const pb = new FakeAdapter('porkbun');
    const { auth } = await setup(pb);
    const res = await postBuy(app, buyBody({ deal_id: 'D-002' }), auth);
    expect(res.statusCode).toBe(201);
    const b = res.json();
    expect(b).toMatchObject({
      domain: DOMAIN, registrar: 'porkbun', order_id: 'ord-1', charged: '$11.08', charged_cents: 1108,
      renewal: '$11.08', two_year: '$22.16', expiry_date: '2027-10-05', drop_date: '2028-10-05', renewals_used: 0,
      poc_spent_after: '$11.08', poc_remaining: '$1,488.92', domains_owned: 1,
      post_buy: { privacy: 'on', auto_renew: 'off', lander: 'afternic ns set', listing: null },
      warnings: [],
    });
    expect(b.audit_id).toMatch(/^aud_[0-9a-f]{32}$/);
    const ledger = one(await db.selectFrom('ledger_entries').selectAll().execute());
    expect(ledger).toMatchObject({ type: 'registration', amount_cents: -1108, counterparty: 'porkbun', receipt_ref: 'porkbun:ord-1', deal_id: 'D-002', audit_id: b.audit_id });
    expect(ledger.note).toMatch(/^1yr; privacy on; check chk_[0-9a-f]{24}; approval aud_/);
    const dom = one(await db.selectFrom('domains').selectAll().execute());
    expect(dom).toMatchObject({
      domain: DOMAIN, status: 'owned', registrar: 'porkbun', registrar_api: 'full', cost_cents: 1108, renewal_price_cents: 1108,
      renewals_used: 0, expiry_date: '2027-10-05', drop_date: '2028-10-05', category: 'geo', deal_id: 'D-002',
      lander: 'afternic', lander_ns: ['ns1.afternic.com', 'ns2.afternic.com'],
    });
    expect(one(await db.selectFrom('receipts').selectAll().execute())).toMatchObject({ registrar: 'porkbun', order_id: 'ord-1' });
    const p = one(await db.selectFrom('purchases').selectAll().execute());
    expect(p).toMatchObject({ state: 'succeeded', charged_cents: 1108, order_id: 'ord-1', expected_cents: 1108, dry_run: false, audit_id: b.audit_id });
    expect(one(await db.selectFrom('deals').selectAll().execute())).toMatchObject({ id: 'D-002', domain: DOMAIN });
    expect(await db.selectFrom('audit_log').selectAll().where('path', '=', '/buy').execute()).toHaveLength(1);
    expect(pb.charges).toBe(1);
  });

  it('ID-4: the real create uses key dt-<purchase id>; the dry run uses its own dtdry- key', async () => {
    const pb = new FakeAdapter('porkbun');
    const { auth } = await setup(pb);
    await postBuy(app, buyBody(), auth);
    const p = one(await db.selectFrom('purchases').select('id').execute());
    expect(pb.registerKeys).toEqual([`dt-${p.id}`]);
    expect(pb.calls.filter((c) => c.includes('dry=true'))[0]).toMatch(/key=dtdry-/);
  });

  it('B-3/ID-2: same key + same body twice → replayed response, exactly 1 register call', async () => {
    const pb = new FakeAdapter('porkbun');
    const { auth } = await setup(pb);
    const a = await postBuy(app, buyBody(), auth, 'k-b3');
    const b = await postBuy(app, buyBody(), auth, 'k-b3');
    expect(b.headers['idempotent-replayed']).toBe('true');
    expect(b.body).toBe(a.body);
    expect(pb.realRegisterCalls).toBe(1);
  });

  it('B-5: different key, same domain after a success → 409 ALREADY_OWNED_OR_PENDING, zero registrar calls', async () => {
    const pb = new FakeAdapter('porkbun');
    const { auth } = await setup(pb);
    await postBuy(app, buyBody(), auth);
    const before = pb.calls.length;
    const res = await postBuy(app, buyBody(), auth);
    expect(res.json().error.code).toBe('ALREADY_OWNED_OR_PENDING');
    expect(pb.calls.length).toBe(before);
  });

  it('B-6: 10 parallel buys of the same domain (different keys) → exactly 1 register, 9 refusals', async () => {
    const pb = new FakeAdapter('porkbun');
    const { auth } = await setup(pb);
    const res = await Promise.all(Array.from({ length: 10 }, () => postBuy(app, buyBody(), auth)));
    expect(res.filter((r) => r.statusCode === 201)).toHaveLength(1);
    expect(res.filter((r) => r.statusCode === 409)).toHaveLength(9);
    expect(pb.realRegisterCalls).toBe(1);
  });

  it('B-12/CAP-1: spent $480, two parallel $11.08 buys of different domains → exactly one succeeds', async () => {
    const pb = new FakeAdapter('porkbun');
    const { auth } = await setup(pb);
    await seedSpent(148000);
    const res = await Promise.all([postBuy(app, buyBody({ domain: 'alpha.com' }), auth), postBuy(app, buyBody({ domain: 'bravo.com' }), auth)]);
    expect(res.map((r) => r.statusCode).sort()).toEqual([201, 409]);
    expect(res.find((r) => r.statusCode === 409)!.json().error.code).toBe('POC_CAP_EXCEEDED');
    expect(pb.charges).toBe(1);
  });

  it('CAP-2: an unresolved (unknown) purchase counts toward the 50-domain cap', async () => {
    const stuck = new FakeAdapter('porkbun', { register: () => timeout(), findDomain: (_d, n) => (n === 0 ? null : new Error('down')) });
    const { auth } = await setup(stuck);
    await seedOwnedDomains(49);
    expect((await postBuy(app, buyBody({ domain: 'stuck.com' }), auth)).statusCode).toBe(202);
    expect((await postBuy(app, buyBody({ domain: 'next.com' }), auth)).json().error.code).toBe('DOMAIN_CAP_REACHED');
  });

  it('B-19: timeout on register, then the same-key replay returns success → one charge, bookkeeping done, 201', async () => {
    const pb = new FakeAdapter('porkbun', { register: (n) => (n === 0 ? timeout() : 'ok'), chargesOnAmbiguous: true });
    const { auth, sleeps } = await setup(pb);
    const res = await postBuy(app, buyBody(), auth);
    expect(res.statusCode).toBe(201);
    expect(pb.charges).toBe(1);
    expect(sleeps).toEqual([2000]);
    expect(new Set(pb.registerKeys).size).toBe(1);
    expect(await db.selectFrom('ledger_entries').selectAll().execute()).toHaveLength(1);
  });

  it('first attempt ambiguous but charged; the 2 s retry with the same key returns the stored result → 201', async () => {
    const pb = new FakeAdapter('porkbun', { register: () => timeout(), chargesOnAmbiguous: true });
    const { auth, sleeps } = await setup(pb);
    const res = await postBuy(app, buyBody(), auth);
    // first call charged (chargesOnAmbiguous); the replays hit the stored result → success on retry 1
    expect(res.statusCode).toBe(201);
    expect(sleeps).toEqual([2000]);
    expect(pb.charges).toBe(1);
  });

  it('all attempts ambiguous, registrar never acted, RDAP still 404 → never released in-call: 202 PURCHASE_STATE_UNKNOWN, purchase unknown, pending row kept', async () => {
    const pb = new FakeAdapter('porkbun', { register: () => timeout() });
    const { auth, sleeps } = await setup(pb);
    const res = await postBuy(app, buyBody(), auth);
    expect(res.statusCode).toBe(202);
    expect(res.json()).toMatchObject({ status: 'unknown', code: 'PURCHASE_STATE_UNKNOWN' });
    expect(sleeps).toEqual([2000, 5000, 10000]);
    expect(pb.realRegisterCalls).toBe(4);
    expect(one(await db.selectFrom('purchases').selectAll().execute()).state).toBe('unknown');
    expect(one(await db.selectFrom('domains').selectAll().execute())).toMatchObject({ domain: DOMAIN, status: 'pending_purchase' });
  });

  it('all attempts ambiguous and findDomain errors → 202 PURCHASE_STATE_UNKNOWN; purchase unknown; pending counts', async () => {
    const pb = new FakeAdapter('porkbun', { register: () => timeout(), findDomain: (_d, n) => (n === 0 ? null : new Error('down')) });
    const { auth } = await setup(pb);
    const res = await postBuy(app, buyBody(), auth);
    expect(res.statusCode).toBe(202);
    expect(res.json()).toMatchObject({ status: 'unknown', code: 'PURCHASE_STATE_UNKNOWN', domain: DOMAIN });
    expect(one(await db.selectFrom('purchases').selectAll().execute()).state).toBe('unknown');
    expect(one(await db.selectFrom('domains').selectAll().execute()).status).toBe('pending_purchase');
  });

  it('definite registrar failure → 409 REGISTRAR_REJECTED, purchase failed, domain row deleted, no ledger; a new key can try again', async () => {
    const pb = new FakeAdapter('porkbun', { register: (n) => (n === 0 ? new RegistrarError('porkbun', 'DOMAIN_NOT_AVAILABLE', 'x') : 'ok') });
    const { auth } = await setup(pb);
    const res = await postBuy(app, buyBody(), auth);
    expect(res.json().error).toMatchObject({ code: 'REGISTRAR_REJECTED', details: { registrar_code: 'DOMAIN_NOT_AVAILABLE' } });
    expect(pb.realRegisterCalls).toBe(1); // never retried
    expect(one(await db.selectFrom('purchases').selectAll().execute()).state).toBe('failed');
    expect(await db.selectFrom('domains').selectAll().execute()).toHaveLength(0);
    expect(await db.selectFrom('ledger_entries').selectAll().execute()).toHaveLength(0);
    expect((await postBuy(app, buyBody(), auth)).statusCode).toBe(201);
  });

  it('Review Focus 1: an unexpected error after register_sent → 202, never 5xx; same-key retry does not register again', async () => {
    const pb = new FakeAdapter('porkbun', { register: () => new Error('socket hang-up in adapter') });
    const { auth } = await setup(pb);
    const a = await postBuy(app, buyBody(), auth, 'k-rf1');
    expect(a.statusCode).toBe(202);
    const b = await postBuy(app, buyBody(), auth, 'k-rf1');
    expect(b.statusCode).toBe(202);
    expect(pb.realRegisterCalls).toBe(1);
  });

  it('Review Focus 2 / B4: HTTP idempotency row lost → purchase-level replay, no second register', async () => {
    const pb = new FakeAdapter('porkbun');
    const { auth } = await setup(pb);
    const a = await postBuy(app, buyBody(), auth, 'k-rf2');
    await db.deleteFrom('idempotency_keys').where('key', '=', 'k-rf2').execute();
    const b = await postBuy(app, buyBody(), auth, 'k-rf2');
    expect(b.statusCode).toBe(201);
    expect(b.json()).toEqual(a.json());
    expect(pb.realRegisterCalls).toBe(1);
  });

  it('Review Focus 5: domain already in our account with an invoice → booked without registering, warning FOUND_IN_ACCOUNT', async () => {
    const pb = new FakeAdapter('porkbun', { alreadyOwned: true });
    const { auth } = await setup(pb);
    const res = await postBuy(app, buyBody(), auth);
    expect(res.statusCode).toBe(201);
    expect(res.json().warnings).toEqual(expect.arrayContaining([expect.stringMatching(/^FOUND_IN_ACCOUNT/)]));
    expect(pb.realRegisterCalls).toBe(0);
    expect(one(await db.selectFrom('ledger_entries').selectAll().execute())).toMatchObject({ receipt_ref: 'porkbun:ord-prior' });
  });

  it('Review Focus 5: domain in our account but no invoice yet → 202 unknown, no guessed charge', async () => {
    const pb = new FakeAdapter('porkbun', { alreadyOwned: true, findRegistration: null });
    const { auth } = await setup(pb);
    expect((await postBuy(app, buyBody(), auth)).statusCode).toBe(202);
    expect(await db.selectFrom('ledger_entries').selectAll().execute()).toHaveLength(0);
  });

  it('B-22: 29 Feb expiry → drop_date 28 Feb next year', async () => {
    const pb = new FakeAdapter('porkbun', { domainInfo: { expiryDate: '2028-02-29' } });
    const { auth } = await setup(pb);
    const res = await postBuy(app, buyBody(), auth);
    expect(res.json()).toMatchObject({ expiry_date: '2028-02-29', drop_date: '2029-02-28' });
  });

  it('B6: no expiry from findDomain → invoice expiry; neither → estimated with EXPIRY_ESTIMATED', async () => {
    const pb = new FakeAdapter('porkbun', { domainInfo: { expiryDate: null }, findRegistration: null });
    const { auth } = await setup(pb);
    const res = await postBuy(app, buyBody(), auth);
    expect(res.statusCode).toBe(201);
    expect(res.json().warnings).toEqual(expect.arrayContaining([expect.stringMatching(/^EXPIRY_ESTIMATED/)]));
  });

  it('B-24: privacy off and NS failure → still 201; warnings list the manual fixes; purchase not rolled back', async () => {
    const pb = new FakeAdapter('porkbun', {
      domainInfo: { whoisPrivacy: false },
      setNs: new RegistrarError('porkbun', 'API_ACCESS_DISABLED', 'x'),
    });
    const { auth } = await setup(pb);
    const res = await postBuy(app, buyBody(), auth);
    expect(res.statusCode).toBe(201);
    expect(res.json().post_buy).toMatchObject({ privacy: 'off', lander: 'failed' });
    expect(res.json().warnings).toEqual(expect.arrayContaining([
      expect.stringMatching(/^PRIVACY_OFF/), expect.stringMatching(/^API_ACCESS_DISABLED.*Opt In All Domains/),
    ]));
    expect(one(await db.selectFrom('purchases').selectAll().execute()).state).toBe('succeeded');
  });

  it('auto-renew not confirmed off → warning AUTO_RENEW_NOT_CONFIRMED', async () => {
    const pb = new FakeAdapter('porkbun', { autoRenewAfter: true });
    const { auth } = await setup(pb);
    const res = await postBuy(app, buyBody(), auth);
    expect(res.json().post_buy.auto_renew).toBe('unconfirmed');
    expect(res.json().warnings).toEqual(expect.arrayContaining([expect.stringMatching(/^AUTO_RENEW_NOT_CONFIRMED/)]));
  });

  it('auto_list + proposed_listing → status listed, listing_history (source=buy) with approval + audit id', async () => {
    const pb = new FakeAdapter('porkbun');
    const { auth } = await setup(pb);
    const res = await postBuy(app, buyBody({ proposed_listing: { mode: 'bin', bin: 399 } }), auth);
    expect(res.json().post_buy.listing).toMatchObject({ mode: 'bin', bin: '$399', floor: '$399', min_offer: '$399', lto_max_months: null, settings_version: 2 });
    expect(one(await db.selectFrom('domains').selectAll().execute())).toMatchObject({ status: 'listed', listing_mode: 'bin', bin_cents: 39900, floor_cents: 39900, min_offer_cents: 39900 });
    const lh = one(await db.selectFrom('listing_history').selectAll().execute());
    expect(lh).toMatchObject({ source: 'buy', category: 'geo', mode: 'bin', bin_cents: 39900, lander: 'afternic', override: false, audit_id: res.json().audit_id });
    expect(lh.approval_text).toContain(DOMAIN);
  });

  it('postBuy: setNameservers returning { pending: true } → lander pending, lander_ns saved, NS_PENDING warning', async () => {
    const pb = new FakeAdapter('porkbun', { setNsResult: { pending: true } });
    const { auth } = await setup(pb);
    const res = await postBuy(app, buyBody({ proposed_listing: { mode: 'bin', bin: 399 } }), auth);
    expect(res.statusCode).toBe(201);
    expect(res.json().post_buy.lander).toBe('pending');
    expect(res.json().warnings).toEqual(expect.arrayContaining([expect.stringMatching(/^NS_PENDING: porkbun is still applying/)]));
    expect(pb.calls.some((c) => c.startsWith('getNameservers'))).toBe(false);
    expect(one(await db.selectFrom('domains').selectAll().execute())).toMatchObject({ lander: 'afternic', lander_ns: ['ns1.afternic.com', 'ns2.afternic.com'] });
  });

  it('auto_list:false → no NS calls, status owned, no listing', async () => {
    const pb = new FakeAdapter('porkbun');
    const { auth } = await setup(pb);
    const res = await postBuy(app, buyBody({ auto_list: false, proposed_listing: { mode: 'bin', bin: 399 } }), auth);
    expect(res.json().post_buy).toMatchObject({ lander: 'skipped', listing: null });
    expect(pb.calls.some((c) => c.startsWith('setNameservers'))).toBe(false);
    expect(one(await db.selectFrom('domains').selectAll().execute()).status).toBe('owned');
  });

  it('the /check cache is invalidated after a buy', async () => {
    const pb = new FakeAdapter('porkbun');
    const { auth } = await setup(pb);
    const read = (await issueToken('read')).auth;
    const before = (await app.inject({ method: 'GET', url: `/check?domain=${DOMAIN}`, headers: read })).json();
    await postBuy(app, buyBody(), auth);
    const after = (await app.inject({ method: 'GET', url: `/check?domain=${DOMAIN}`, headers: read })).json();
    expect(after.check_id).not.toBe(before.check_id);
  });

  it('purchases.request keeps the body without secrets; approval stored on the purchase', async () => {
    const pb = new FakeAdapter('porkbun');
    const { auth } = await setup(pb);
    await postBuy(app, buyBody(), auth);
    const p = one(await db.selectFrom('purchases').selectAll().execute());
    expect(p.request).toMatchObject({ domain: DOMAIN, category: 'geo' });
    expect(p.approval_text).toContain(DOMAIN);
  });

  it('ruling (a): a same-key retry replays the stored outcome even when the approval has since expired', async () => {
    const pb = new FakeAdapter('porkbun');
    const { auth } = await setup(pb);
    const a = await postBuy(app, buyBody(), auth, 'k-ra');
    expect(a.statusCode).toBe(201);
    await db.deleteFrom('idempotency_keys').where('key', '=', 'k-ra').execute();
    const stale = buyBody({ approval_ref: approvalNow(DOMAIN, 80) });
    const b = await postBuy(app, stale, auth, 'k-ra');
    expect(b.statusCode).toBe(201);
    expect(b.json()).toEqual(a.json());
    expect(pb.realRegisterCalls).toBe(1);
  });

  it('all 4 attempts ambiguous, no charge, then findDomain finds the domain with an invoice → booked via finishFound', async () => {
    const pb = new FakeAdapter('porkbun', {
      register: () => timeout(),
      findDomain: (_d, n) => (n === 0 ? null : { expiryDate: '2027-10-05', whoisPrivacy: true, autoRenew: false, apiAccess: true, ns: null }),
      findRegistration: { orderId: 'ord-x', chargedCents: 1108, expiryDate: '2027-10-05', invoiceDate: '2026-10-05', raw: {} },
    });
    const { auth, sleeps } = await setup(pb);
    const res = await postBuy(app, buyBody(), auth);
    expect(res.statusCode).toBe(201);
    expect(sleeps).toEqual([2000, 5000, 10000]);
    expect(pb.realRegisterCalls).toBe(4);
    expect(one(await db.selectFrom('ledger_entries').selectAll().execute()).receipt_ref).toBe('porkbun:ord-x');
  });

  it('definite error after an earlier ambiguous attempt is not trusted: resolves via findDomain → 201, one ledger row', async () => {
    const pb = new FakeAdapter('porkbun', {
      register: (n) => (n === 0 ? timeout() : new RegistrarError('porkbun', 'DOMAIN_NOT_AVAILABLE', 'x')),
      findDomain: (_d, n) => (n === 0 ? null : { expiryDate: '2027-10-05', whoisPrivacy: true, autoRenew: false, apiAccess: true, ns: null }),
      findRegistration: { orderId: 'ord-x', chargedCents: 1108, expiryDate: '2027-10-05', invoiceDate: '2026-10-05', raw: {} },
    });
    const { auth } = await setup(pb);
    const res = await postBuy(app, buyBody(), auth);
    expect(res.statusCode).toBe(201);
    expect(pb.realRegisterCalls).toBe(2);
    expect(one(await db.selectFrom('ledger_entries').selectAll().execute()).receipt_ref).toBe('porkbun:ord-x');
    expect(one(await db.selectFrom('purchases').selectAll().execute()).state).toBe('succeeded');
  });

  it('succeeded purchase with NULL response column → same-key replay rebuilds a 201', async () => {
    const pb = new FakeAdapter('porkbun');
    const { auth } = await setup(pb);
    await postBuy(app, buyBody(), auth, 'k-null');
    await db.updateTable('purchases').set({ response: null }).execute();
    await db.deleteFrom('idempotency_keys').where('key', '=', 'k-null').execute();
    const b = await postBuy(app, buyBody(), auth, 'k-null');
    expect(b.statusCode).toBe(201);
    expect(b.json()).toMatchObject({ order_id: 'ord-1', charged_cents: 1108, domain: DOMAIN });
    expect(pb.realRegisterCalls).toBe(1);
  });

  it('succeeded purchase with a stored 202 response (reconciler case) → same-key replay returns 201', async () => {
    const pb = new FakeAdapter('porkbun');
    const { auth } = await setup(pb);
    await postBuy(app, buyBody(), auth, 'k-202');
    await db.updateTable('purchases').set({ response: JSON.stringify({ status: 202, body: { status: 'unknown' } }) }).execute();
    await db.deleteFrom('idempotency_keys').where('key', '=', 'k-202').execute();
    const b = await postBuy(app, buyBody(), auth, 'k-202');
    expect(b.statusCode).toBe(201);
    expect(b.json()).toMatchObject({ order_id: 'ord-1', charged_cents: 1108 });
  });

  it('same Idempotency-Key reused for a different domain → 409 IDEMPOTENCY_KEY_MISMATCH, no new register', async () => {
    const pb = new FakeAdapter('porkbun');
    const { auth } = await setup(pb);
    await postBuy(app, buyBody(), auth, 'k-dom');
    await db.deleteFrom('idempotency_keys').where('key', '=', 'k-dom').execute();
    const b = await postBuy(app, buyBody({ domain: 'other.com' }), auth, 'k-dom');
    expect(b.statusCode).toBe(409);
    expect(b.json().error.code).toBe('IDEMPOTENCY_KEY_MISMATCH');
    expect(pb.realRegisterCalls).toBe(1);
  });
});

describe('POST /buy concurrent reconciler', () => {
  it('reconciler books the purchase while /buy is resolving an ambiguous outcome → reconstructed 201, not 202', async () => {
    let id = 0;
    const pb = new FakeAdapter('porkbun', {
      register: () => timeout(),
      findDomain: (d, n) => {
        if (n === 0) return null; // pre-purchase availability lookup
        throw new Error('booked-by-reconciler'); // post-retry lookup fails, but meanwhile the reconciler books
      },
    });
    const { auth } = await setup(pb);
    const orig = pb.findDomain.bind(pb);
    pb.findDomain = async (d: string) => {
      try {
        return await orig(d);
      } catch (e) {
        const p = await db.selectFrom('purchases').select('id').executeTakeFirstOrThrow();
        id = p.id;
        await db.updateTable('purchases').set({ state: 'succeeded', charged_cents: 1108, order_id: 'ord-race' }).where('id', '=', p.id).execute();
        await db.updateTable('domains').set({ status: 'owned', cost_cents: 1108, renewal_price_cents: 1108, expiry_date: '2027-10-05', drop_date: '2028-10-05', buy_date: '2026-10-05', renewals_used: 0 }).execute();
        throw e;
      }
    };
    const res = await postBuy(app, buyBody(), auth);
    expect(id).toBeGreaterThan(0);
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ domain: DOMAIN, order_id: 'ord-race', charged_cents: 1108 });
    expect(one(await db.selectFrom('purchases').selectAll().execute()).state).toBe('succeeded');
  });
});

describe('POST /buy final-review fixes', () => {
  const stuck = () => new FakeAdapter('porkbun', { register: () => timeout(), findDomain: (_d, n) => (n === 0 ? null : new Error('down')) });

  it('same-key retry after a 202 reaches priorOutcome: reconciler booked it → 201, no extra register; stored 201/409 still replay', async () => {
    const pb = stuck();
    const { auth } = await setup(pb);
    const a = await postBuy(app, buyBody(), auth, 'k-202r');
    expect(a.statusCode).toBe(202);
    const calls = pb.realRegisterCalls;
    // while still unknown, a same-key retry is answered by the purchase (202), not registered again
    const again = await postBuy(app, buyBody(), auth, 'k-202r');
    expect(again.statusCode).toBe(202);
    expect(pb.realRegisterCalls).toBe(calls);
    const owned = new FakeAdapter('porkbun', { alreadyOwned: true });
    const r = await new Reconciler({ db, adapters: [owned], rdap: rdapFree, now: () => T0 + 10 * 60_000 }).runOnce();
    expect(r.booked).toBe(1);
    const b = await postBuy(app, buyBody(), auth, 'k-202r');
    expect(b.statusCode).toBe(201);
    expect(b.json()).toMatchObject({ domain: DOMAIN, charged_cents: 1108 });
    expect(b.headers['idempotent-replayed']).toBeUndefined();
    expect(pb.realRegisterCalls).toBe(calls);
    // the new outcome replaced the stored 202: the next retry is a plain replay of the 201
    const c = await postBuy(app, buyBody(), auth, 'k-202r');
    expect(c.statusCode).toBe(201);
    expect(c.headers['idempotent-replayed']).toBe('true');
    // a stored 409 is still replayed
    const d1 = await postBuy(app, buyBody(), auth, 'k-409');
    expect(d1.statusCode).toBe(409);
    const d2 = await postBuy(app, buyBody(), auth, 'k-409');
    expect(d2.statusCode).toBe(409);
    expect(d2.headers['idempotent-replayed']).toBe('true');
  });

  it('ambiguous dry run → 409 REGISTRAR_DRY_RUN_AMBIGUOUS, unknown purchase + pending domain row recorded, no real register; re-buy blocked; reconciler books it', async () => {
    const amb = new RegistrarError('porkbun', 'REGISTRAR_BAD_RESPONSE', 'dry run answered as real', { ambiguous: true });
    const pb = new FakeAdapter('porkbun', { dryRun: () => amb });
    const { auth } = await setup(pb);
    const res = await postBuy(app, buyBody({ deal_id: 'D-009' }), auth);
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toMatchObject({ code: 'REGISTRAR_DRY_RUN_AMBIGUOUS', details: { registrar: 'porkbun', registrar_code: 'REGISTRAR_BAD_RESPONSE' } });
    expect(pb.realRegisterCalls).toBe(0);
    const p = one(await db.selectFrom('purchases').selectAll().execute());
    expect(p).toMatchObject({ state: 'unknown', expected_cents: 1108, dry_run: false, domain: DOMAIN, registrar: 'porkbun' });
    expect(p.idempotency_key).toMatch(/^.+#dry-ambiguous-[0-9a-f-]{36}$/);
    expect(one(await db.selectFrom('domains').selectAll().execute())).toMatchObject({ domain: DOMAIN, status: 'pending_purchase', category: 'geo', deal_id: 'D-009' });
    // (b)
    const again = await postBuy(app, buyBody(), auth);
    expect(again.statusCode).toBe(409);
    expect(again.json().error.code).toBe('ALREADY_OWNED_OR_PENDING');
    // (c)
    const owned = new FakeAdapter('porkbun', { alreadyOwned: true });
    const r = await new Reconciler({ db, adapters: [owned], rdap: rdapFree, now: () => T0 + 10 * 60_000 }).runOnce();
    expect(r.booked).toBe(1);
    expect(one(await db.selectFrom('ledger_entries').selectAll().execute())).toMatchObject({ amount_cents: -1108, deal_id: 'D-009' });
    expect(one(await db.selectFrom('domains').selectAll().execute())).toMatchObject({ domain: DOMAIN, status: 'owned' });
    expect(one(await db.selectFrom('purchases').selectAll().execute()).state).toBe('succeeded');
  });

  it('ambiguous dry run counts toward the 50-domain cap: 49 owned + ambiguous A → buy of B is DOMAIN_CAP_REACHED', async () => {
    const amb = new RegistrarError('porkbun', 'REGISTRAR_BAD_RESPONSE', 'x', { ambiguous: true });
    const pb = new FakeAdapter('porkbun', { dryRun: (n) => (n === 0 ? amb : undefined) });
    const { auth } = await setup(pb);
    await seedOwnedDomains(49);
    expect((await postBuy(app, buyBody({ domain: 'a-amb.com' }), auth)).json().error.code).toBe('REGISTRAR_DRY_RUN_AMBIGUOUS');
    expect((await postBuy(app, buyBody({ domain: 'b-next.com' }), auth)).json().error.code).toBe('DOMAIN_CAP_REACHED');
  });

  it('failPurchase with fromStates [created] on an already-failed purchase does not delete another purchase\'s pending row', async () => {
    const mk = async (state: 'failed' | 'created', key: string) => (await db.insertInto('purchases').values({
      idempotency_key: key, request_hash: 'h', domain: DOMAIN, state, dry_run: false, registrar: 'porkbun', max_price_cents: 2000,
      approval_text: DOMAIN, approval_at: new Date(), expected_cents: 1108, request: '{}', audit_id: 'aud_x',
    }).returning('id').executeTakeFirstOrThrow()).id;
    const failedId = await mk('failed', 'k-old');
    await mk('created', 'k-new');
    await db.insertInto('domains').values({ domain: DOMAIN, status: 'pending_purchase', registrar: 'porkbun', category: 'geo' }).execute();
    await failPurchase(db, failedId, DOMAIN, { status: 409, body: {} }, { fromStates: ['created'] });
    expect(one(await db.selectFrom('domains').selectAll().execute())).toMatchObject({ domain: DOMAIN, status: 'pending_purchase' });
  });

  it('execute guard: purchase abandoned before register_sent → 409 PURCHASE_ABANDONED, nothing registered', async () => {
    const pb = new FakeAdapter('porkbun', {
      findDomain: () => {
        throw new Error('replaced below');
      },
    });
    const { auth } = await setup(pb);
    pb.findDomain = async () => {
      await db.updateTable('purchases').set({ state: 'failed' }).execute();
      return null;
    };
    const res = await postBuy(app, buyBody(), auth);
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('PURCHASE_ABANDONED');
    expect(pb.realRegisterCalls).toBe(0);
    expect(one(await db.selectFrom('purchases').selectAll().execute()).state).toBe('failed');
  });

  it('found-in-account path persists register_sent before booking (a crash there is reconciled)', async () => {
    const pb = new FakeAdapter('porkbun', { alreadyOwned: true });
    const { auth } = await setup(pb);
    let seen: string | undefined;
    const orig = pb.findRegistration.bind(pb);
    pb.findRegistration = async (d: string, o: { since: string }) => {
      seen = (await db.selectFrom('purchases').select('state').executeTakeFirstOrThrow()).state;
      return orig(d, o);
    };
    expect((await postBuy(app, buyBody(), auth)).statusCode).toBe(201);
    expect(seen).toBe('register_sent');
  });

  it('markUnknown never moves a failed or succeeded purchase', async () => {
    const pb = new FakeAdapter('porkbun');
    const { auth } = await setup(pb);
    await postBuy(app, buyBody(), auth);
    const p = one(await db.selectFrom('purchases').select('id').execute());
    await markUnknown(db, p.id, { status: 202, body: {} });
    expect((await db.selectFrom('purchases').select('state').executeTakeFirstOrThrow()).state).toBe('succeeded');
    await db.updateTable('purchases').set({ state: 'failed' }).execute();
    await markUnknown(db, p.id, { status: 202, body: {} });
    expect((await db.selectFrom('purchases').select('state').executeTakeFirstOrThrow()).state).toBe('failed');
  });
});
