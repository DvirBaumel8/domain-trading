// v2.0.2: a dry-run /buy error thrown after the DOM gates carries would_be_blocked, screening_pack and advisories.
import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { RdapFn } from '../../src/core/rdap.js';
import { makeApp } from '../helpers/app.js';
import { DOMAIN, T0, buyBody, postBuy, readyToBuy } from '../helpers/buy.js';
import { FakeAdapter } from '../helpers/fake-adapter.js';
import { issueToken } from '../helpers/tokens.js';

let app: FastifyInstance;
afterEach(async () => app?.close());

async function setup(pb: FakeAdapter, rdap: RdapFn = async () => 'not_registered') {
  app = await makeApp({ adapters: [pb], rdap, now: () => T0, sleep: async () => {} });
  return (await issueToken('write')).auth;
}

describe('v2.0.2 dry-run /buy errors after the DOM gates', () => {
  it('REGISTRAR_FUNDS (dry run, ready name): details carry would_be_blocked null, screening_pack, advisories', async () => {
    const auth = await setup(new FakeAdapter('porkbun', { account: { balanceCents: 0 } }));
    await readyToBuy(DOMAIN);
    const res = await postBuy(app, buyBody({ dry_run: true }), auth, undefined, { ready: false });
    expect(res.statusCode).toBe(409);
    const e = res.json().error;
    expect(e.code).toBe('REGISTRAR_FUNDS');
    expect(e.details).toHaveProperty('shortfall_cents');
    expect(e.details.would_be_blocked).toBeNull();
    expect(e.details.screening_pack).toMatchObject({ status: 'complete' });
    expect(e.details.advisories).toEqual([]);
  });

  it('REGISTRAR_FUNDS (dry run, no pack): would_be_blocked names the first gate', async () => {
    const auth = await setup(new FakeAdapter('porkbun', { account: { balanceCents: 0 } }));
    const res = await postBuy(app, buyBody({ dry_run: true }), auth, undefined, { ready: false });
    const e = res.json().error;
    expect(e.code).toBe('REGISTRAR_FUNDS');
    expect(e.details.would_be_blocked).toBe('SCREENING_PACK_REQUIRED');
    expect(e.details.screening_pack).toMatchObject({ status: 'none', pack_id: null });
    expect(e.details.advisories).toContain('SCREENING_PACK_REQUIRED');
  });

  it('NOT_AVAILABLE after the gates (dry run) carries the fields, availability kept', async () => {
    const auth = await setup(new FakeAdapter('porkbun'), async () => 'registered');
    const res = await postBuy(app, buyBody({ dry_run: true }), auth, undefined, { ready: false });
    const e = res.json().error;
    expect(e.code).toBe('NOT_AVAILABLE');
    expect(e.details).toHaveProperty('availability');
    expect(e.details.would_be_blocked).toBe('SCREENING_PACK_REQUIRED');
    expect(e.details).toHaveProperty('screening_pack');
    expect(Array.isArray(e.details.advisories)).toBe(true);
  });

  it('real buy REGISTRAR_FUNDS details are unchanged', async () => {
    const auth = await setup(new FakeAdapter('porkbun', { account: { balanceCents: 0 } }));
    const res = await postBuy(app, buyBody(), auth);
    const e = res.json().error;
    expect(e.code).toBe('REGISTRAR_FUNDS');
    expect(e.details).not.toHaveProperty('would_be_blocked');
    expect(e.details).not.toHaveProperty('screening_pack');
    expect(e.details).not.toHaveProperty('advisories');
  });

  it('an error before the gates (approval) has no gate fields', async () => {
    const auth = await setup(new FakeAdapter('porkbun'));
    const res = await postBuy(app, buyBody({ dry_run: true, approval_ref: { text: 'ok', approved_at: new Date(T0 - 1000).toISOString() } }), auth, undefined, { ready: false });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.details).not.toHaveProperty('would_be_blocked');
  });
});
