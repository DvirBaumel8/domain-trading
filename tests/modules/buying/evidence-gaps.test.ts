// v2.1.0 evidence map: codes of the contract index that had no automated test until the map was built.
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { sql } from 'kysely';
import type { FastifyInstance } from 'fastify';
import { RegistrarError } from '../../../src/modules/registrars/types.js';
import { Reconciler } from '../../../src/modules/buying/reconciler.js';
import { resolvePurchaseFailed } from '../../../src/modules/ops/admin/resolve-purchase.js';
import { makeApp } from '../../helpers/app.js';
import { DOMAIN, buyBody, postBuy } from '../../helpers/buy.js';
import { insertOwnedDomain, testDb as db } from '../../helpers/db.js';
import { FakeAdapter } from '../../helpers/fake-adapter.js';
import { screeningHarness } from '../../helpers/screening.js';
import { issueToken } from '../../helpers/tokens.js';

let app: FastifyInstance | undefined;
afterEach(async () => app?.close());

/** Runs `fn` on one connection with triggers bypassed (the same way the test reset does); the change is committed. */
async function bypassTriggers(fn: (conn: typeof db) => Promise<unknown>): Promise<void> {
  await db.connection().execute(async (conn) => {
    await sql`SET session_replication_role = replica`.execute(conn);
    try { await fn(conn); } finally { await sql`SET session_replication_role = origin`.execute(conn); }
  });
}

describe('codes without a test before 2.1.0', () => {
  it('ADAPTER_FAILED: an adapter that throws a plain error shows as error_code ADAPTER_FAILED on /check', async () => {
    const pb = new FakeAdapter('porkbun');
    pb.quote = async () => { throw new Error('boom'); };
    app = await makeApp({ adapters: [pb], rdap: async () => 'not_registered' });
    const { auth } = await issueToken('read');
    const res = await app.inject({ method: 'GET', url: `/check?domain=${DOMAIN}`, headers: auth });
    expect(res.statusCode).toBe(200);
    expect(JSON.stringify(res.json())).toContain('ADAPTER_FAILED');
    expect(res.body).not.toContain('boom');
  });

  it('LANDER_INVALID: 422 from POST /list for an unknown lander', async () => {
    app = await makeApp({ adapters: [new FakeAdapter('porkbun')], now: () => Date.parse('2026-10-12T09:00:00Z') });
    const { auth } = await issueToken('write');
    await insertOwnedDomain(db, { domain: DOMAIN });
    const bad = await app.inject({ method: 'POST', url: `/list/${DOMAIN}`, headers: { ...auth, 'idempotency-key': randomUUID() }, payload: { lander: 'bogus' } });
    expect(bad.statusCode).toBe(422);
    expect(bad.json().error.code).toBe('LANDER_INVALID');
  });

  it('TRANCHE_NAME_TAKEN: a new tranche with the name of a closed one', async () => {
    const x = await screeningHarness();
    app = x.app;
    await db.insertInto('tranches').values({ id: 'trn_000000000001', name: 'T1', status: 'closed', opened_by: 'test', closed_at: new Date(), closed_by: 'test', settings_label: 'v1', close_report: '{}' }).execute();
    const res = await x.post('/tranches', { name: 'T1' });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('TRANCHE_NAME_TAKEN');
  });

  it('PRICING_SETTINGS_MISSING: no pricing_settings version in effect is a 500, not a guess', async () => {
    app = await makeApp();
    const { auth } = await issueToken('read');
    await bypassTriggers((c) => sql`DELETE FROM pricing_settings`.execute(c));
    const res = await app.inject({ method: 'GET', url: '/pricing/preview?category=trend&bin=1995', headers: auth });
    expect(res.statusCode).toBe(500);
    expect(res.json().error.code).toBe('PRICING_SETTINGS_MISSING');
  });

  it('SELECTION_SETTINGS_MISSING and SELECTION_SETTINGS_INVALID: 500 from a route that reads the active selection settings', async () => {
    app = await makeApp();
    const { auth } = await issueToken('write');
    const evaluate = () => app!.inject({ method: 'POST', url: '/selection/evaluate', headers: { ...auth, 'idempotency-key': randomUUID() }, payload: { domain: 'tampapoolsco.com', lane: 'S3' } });
    await bypassTriggers((c) => sql`UPDATE selection_settings SET values = '{"broken": true}'::jsonb`.execute(c));
    const invalid = await evaluate();
    expect(invalid.statusCode).toBe(500);
    expect(invalid.json().error.code).toBe('SELECTION_SETTINGS_INVALID');
    await bypassTriggers((c) => sql`UPDATE selection_settings SET activation_seq = NULL, activated_at = NULL, activation_approval_text = NULL, activation_approval_at = NULL, activated_by = NULL`.execute(c));
    const missing = await evaluate();
    expect(missing.statusCode).toBe(500);
    expect(missing.json().error.code).toBe('SELECTION_SETTINGS_MISSING');
  });

  describe('a retry with the key of a purchase the reconciler settled', () => {
    const NOW = Date.parse('2026-10-05T12:00:00Z');
    const ago = (m: number) => new Date(NOW - m * 60_000);
    async function seed(domain: string) {
      await db.insertInto('quotes').values({ check_id: 'chk_1', domain, registrar: 'porkbun', available: true, premium: false, first_year_cents: 1108, renewal_cents: 1108, privacy_cents_per_year: 0, two_year_cents: 2216, eligible: true, exclusion_reason: null, raw: null }).execute();
      await db.insertInto('purchases').values({
        idempotency_key: 'k-settled', request_hash: 'h', domain, state: 'register_sent', registrar: 'porkbun', check_id: 'chk_1', max_price_cents: 1150,
        approval_text: `buy ${domain}`, approval_at: ago(35), expected_cents: 1108, request: JSON.stringify({ domain, category: 'geo', deal_id: 'D-003' }),
        audit_id: `aud_${'a'.repeat(32)}`, created_at: ago(31), updated_at: ago(31),
      }).execute();
      await db.insertInto('domains').values({ domain, status: 'pending_purchase', registrar: 'porkbun', category: 'geo', deal_id: 'D-003' }).execute();
    }
    const retry = async () => {
      app = await makeApp({ adapters: [new FakeAdapter('porkbun')], now: () => NOW });
      return postBuy(app, buyBody({ domain: DOMAIN }), (await issueToken('write')).auth, 'k-settled', { ready: false });
    };

    it('PURCHASE_FAILED: the registrar never registered the name, so the stored answer is 409 PURCHASE_FAILED', async () => {
      await seed(DOMAIN);
      // v3.9.0: the reconciler no longer fails an absent name; the administrator does (resolve-purchase)
      const p = await db.selectFrom('purchases').select('id').where('idempotency_key', '=', 'k-settled').executeTakeFirstOrThrow();
      await resolvePurchaseFailed(db, { purchaseId: p.id, reason: 'checked the registrar account' });
      const res = await retry();
      expect(res.statusCode).toBe(409);
      expect(res.json().error.code).toBe('PURCHASE_FAILED');
    });

    it('RECONSTRUCTED: the reconciler booked it, so the answer is a 201 rebuilt from the ledger with a RECONSTRUCTED warning', async () => {
      await seed(DOMAIN);
      expect(await new Reconciler({ db, adapters: [new FakeAdapter('porkbun', { alreadyOwned: true })], now: () => NOW }).runOnce()).toMatchObject({ booked: 1 });
      const res = await retry();
      expect(res.statusCode).toBe(201);
      expect(res.json().warnings.join(' ')).toContain('RECONSTRUCTED');
    });
  });
});
