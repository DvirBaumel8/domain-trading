// v2.1.0 (CR-005 N-7): dry_run "strict" returns the first real-buy gate refusal as the error; otherwise it is today's dry run.
import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { RdapFn } from '../../src/core/rdap.js';
import { makeApp } from '../helpers/app.js';
import { DOMAIN, T0, buyBody, postBuy, readyToBuy } from '../helpers/buy.js';
import { testDb as db } from '../helpers/db.js';
import { FakeAdapter } from '../helpers/fake-adapter.js';
import { issueToken } from '../helpers/tokens.js';

let app: FastifyInstance;
afterEach(async () => app?.close());
const rdapFree: RdapFn = async () => 'not_registered';

async function setup() {
  const pb = new FakeAdapter('porkbun');
  app = await makeApp({ adapters: [pb], rdap: rdapFree, now: () => T0, sleep: async () => {} });
  return { pb, auth: (await issueToken('write')).auth };
}
const strict = (auth: Record<string, string>) => postBuy(app, buyBody({ dry_run: 'strict' }), auth, undefined, { ready: false });
const plain = (auth: Record<string, string>) => postBuy(app, buyBody({ dry_run: true }), auth, undefined, { ready: false });

describe('POST /buy dry_run "strict"', () => {
  it('no pack: the error is SCREENING_PACK_REQUIRED NO_PACK, while dry_run true answers 200 with would_be_blocked', async () => {
    const { pb, auth } = await setup();
    const res = await strict(auth);
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toMatchObject({ code: 'SCREENING_PACK_REQUIRED', details: { reason: 'NO_PACK', pack_id: null } });
    expect(pb.calls).toEqual([]);
    const p = await plain(auth);
    expect(p.statusCode).toBe(200);
    expect(p.json().would_be_blocked).toBe('SCREENING_PACK_REQUIRED');
  });

  it('BUY_HOLD comes first, then the pack, then the tranche, then the spend cap (contract order)', async () => {
    const { auth } = await setup();
    const { runId } = await readyToBuy(DOMAIN, { spendCapCents: 1000, pack: { status: 'incomplete' } });
    await db.updateTable('screening_runs').set({ buy_hold: true }).where('id', '=', runId).execute();
    expect((await strict(auth)).json().error.code).toBe('BUY_HOLD');
    await db.updateTable('screening_runs').set({ buy_hold: false }).where('id', '=', runId).execute();
    expect((await strict(auth)).json().error).toMatchObject({ code: 'SCREENING_PACK_REQUIRED', details: { reason: 'INCOMPLETE' } });
  });

  it('NO_TRANCHE, then TRANCHE_SPEND_CAP (returned as the error, with its details)', async () => {
    const { pb, auth } = await setup();
    await readyToBuy(DOMAIN, { spendCapCents: 1000 });
    const cap = await strict(auth);
    expect(cap.statusCode).toBe(409);
    expect(cap.json().error).toMatchObject({ code: 'TRANCHE_SPEND_CAP', details: { spend_cap_cents: 1000, spent_cents: 0, cost_cents: 1108 } });
    expect(cap.json().error.details.would_be_blocked).toBeUndefined();
    await db.updateTable('tranche_members').set({ removed_at: new Date(T0), removed_by: 'test' }).where('domain', '=', DOMAIN).execute();
    expect((await strict(auth)).json().error.code).toBe('NO_TRANCHE');
    expect(pb.charges).toBe(0);
    expect(pb.realRegisterCalls).toBe(0);
  });

  it('every gate passing: the same 200 as dry_run true, with no purchase, no charge, no ledger row', async () => {
    const { pb, auth } = await setup();
    await readyToBuy(DOMAIN, { spendCapCents: 5000 });
    const s = await strict(auth);
    const p = await plain(auth);
    expect(s.statusCode).toBe(200);
    const { check_id: sCheck, ...sBody } = s.json(); // a dry run stores a new quote check each time
    const { check_id: pCheck, ...pBody } = p.json();
    expect(sCheck).toMatch(/^chk_/);
    expect(pCheck).toMatch(/^chk_/);
    expect(sBody).toEqual(pBody);
    expect(s.json()).toMatchObject({ dry_run: true, would_be_blocked: null });
    expect(pb.realRegisterCalls).toBe(0);
    expect(pb.charges).toBe(0);
    expect(await db.selectFrom('purchases').selectAll().execute()).toHaveLength(0);
    expect(await db.selectFrom('ledger_entries').selectAll().execute()).toHaveLength(0);
  });

  it('any other dry_run string is a 422 VALIDATION_ERROR', async () => {
    const { auth } = await setup();
    const res = await postBuy(app, buyBody({ dry_run: 'loose' }), auth, undefined, { ready: false });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe('VALIDATION_ERROR');
  });
});
