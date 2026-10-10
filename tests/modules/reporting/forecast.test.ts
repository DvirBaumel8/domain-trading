// v2.1.0 part 1: daily-only runner, BUG-2 timestamps, CR-004 §10.3 (lander none, forecast fixes, legacy comps).
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { makeApp, runJobToEnd } from '../../helpers/app.js';
import { insertOwnedDomain, testDb as db } from '../../helpers/db.js';
import { FakeAdapter } from '../../helpers/fake-adapter.js';
import { listedDomain } from '../../helpers/listing.js';
import { issueToken } from '../../helpers/tokens.js';
import { readyToBuy } from '../../helpers/buy.js';

let app: FastifyInstance;
afterEach(async () => app?.close());
const NOW = Date.parse('2026-10-12T09:00:00Z');
const D = 'examplecityroofing.com';
const JOB = 'job_token_fake_0123456789abcdef0123456789';
const OFFSET = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\+0[23]:00$/;

async function boot(pb = new FakeAdapter('porkbun')) {
  app = await makeApp({ adapters: [pb], nsLookup: async () => null, now: () => NOW });
  const w = (await issueToken('write')).auth;
  const r = (await issueToken('read')).auth;
  const post = (url: string, payload: object) => app.inject({ method: 'POST', url, headers: { ...w, 'idempotency-key': randomUUID() }, payload });
  const get = (url: string) => app.inject({ method: 'GET', url, headers: r });
  return { pb, post, get };
}

describe('forecast fixes (CR-004 §10.3)', () => {
  it('a name with drop_date = expiry_date counts no renewal in committed_forward and has no RENEWAL_PRICE_UNKNOWN', async () => {
    await insertOwnedDomain(db, { domain: 'first-expiry.com', expiry_date: '2027-10-05', drop_date: '2027-10-05', renewal_price_cents: null });
    await insertOwnedDomain(db, { domain: 'renews-later.com', expiry_date: '2027-10-05', drop_date: '2028-10-05', renewal_price_cents: 1500 });
    await insertOwnedDomain(db, { domain: 'renews-unknown.com', expiry_date: '2027-10-05', drop_date: '2028-10-05', renewal_price_cents: null });
    const t = await boot();
    const rep = (await t.get('/report')).json();
    expect(rep.budget.committed_forward).toMatchObject({ total_cents: 1500, complete: false, missing: ['renews-unknown.com'] });
    const unknown = (rep.warnings as { code: string; domain: string }[]).filter((x) => x.code === 'RENEWAL_PRICE_UNKNOWN').map((x) => x.domain);
    expect(unknown).toEqual(['renews-unknown.com']);
  });

  it('only drop-at-first-expiry names without a renewal price: committed_forward is complete', async () => {
    await insertOwnedDomain(db, { domain: 'first-expiry.com', expiry_date: '2027-10-05', drop_date: '2027-10-05', renewal_price_cents: null });
    const t = await boot();
    expect((await t.get('/report')).json().budget.committed_forward).toMatchObject({ total_cents: 0, complete: true, missing: [] });
  });

  it('v3.9.0: POST_BUY_INCOMPLETE = a bought name with no screening pack; comps are not needed, and an imported name (no purchase row) is exempt', async () => {
    const base = { request_hash: 'h', max_price_cents: 2000, approval_text: 'ok', approval_at: new Date(NOW - 86_400_000) };
    await db.insertInto('purchases').values({ ...base, idempotency_key: 'kl1', domain: 'has-pack.com', state: 'succeeded' }).execute();
    await db.insertInto('purchases').values({ ...base, idempotency_key: 'kl2', domain: 'no-pack.com', state: 'succeeded' }).execute();
    await insertOwnedDomain(db, { domain: 'has-pack.com' });
    await insertOwnedDomain(db, { domain: 'no-pack.com' });
    const imported = await insertOwnedDomain(db, { domain: 'imported.com' });
    await db.insertInto('pricing_evidence').values({ domain_id: imported, comps: null, rationale: null, legacy_no_comps_reason: 'bought before the comps rule' }).execute();
    await readyToBuy('has-pack.com');
    const t = await boot();
    const w = (await t.get('/report')).json().warnings as { code: string; domain: string }[];
    expect(w.filter((x) => x.code === 'POST_BUY_INCOMPLETE').map((x) => x.domain)).toEqual(['no-pack.com']);
  });
});
