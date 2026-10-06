// v2.0.0: a real /buy needs a complete, current screening pack and an active member of the open tranche (spend cap included).
import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { RdapFn } from '../../src/rdap.js';
import { makeApp } from '../helpers/app.js';
import { DOMAIN, T0, buyBody, postBuy, readyToBuy } from '../helpers/buy.js';
import { testDb as db } from '../helpers/db.js';
import { FakeAdapter } from '../helpers/fake-adapter.js';
import { issueToken } from '../helpers/tokens.js';

let app: FastifyInstance;
afterEach(async () => app?.close());
const rdapFree: RdapFn = async () => 'not_registered';
const OTHER = 'tampapoolsco.com';

async function setup() {
  const pb = new FakeAdapter('porkbun');
  app = await makeApp({ adapters: [pb], rdap: rdapFree, now: () => T0, sleep: async () => {} });
  return { pb, auth: (await issueToken('write')).auth };
}
const real = (auth: Record<string, string>, domain = DOMAIN) => postBuy(app, buyBody({ domain }), auth, undefined, { ready: false });
const dry = async (auth: Record<string, string>, domain = DOMAIN) => (await postBuy(app, buyBody({ domain, dry_run: true }), auth)).json();

/** A later run that lists the name (so the earlier pack is not from the latest run), optionally held. */
async function laterRun(domain: string, over: { buy_hold?: boolean } = {}) {
  const s = await db.selectFrom('selection_settings').select(['id', 'label']).where('activation_seq', 'is not', null).orderBy('activation_seq', 'desc').executeTakeFirstOrThrow();
  await db.insertInto('screening_runs').values({
    id: 'run_999999999999', created_at: new Date(T0 + 48 * 3_600_000), created_by: 'test', audit_id: null, mode: 'full', backtest: false, settings_id: s.id, settings_label: s.label,
    buy_hold: over.buy_hold ?? false, tranche_id: null, input: JSON.stringify({ names: [{ domain, lane: 'S3' }] }), gate_plan: '{}', list_versions: '{}', status: 'done',
    deadline_at: new Date(T0), heartbeat_at: null, finished_at: new Date(T0), summary: null,
  }).execute();
}

describe('v2.0.0 /buy: screening pack', () => {
  it('no pack: 409 SCREENING_PACK_REQUIRED NO_PACK, no registrar call, no purchase row', async () => {
    const { pb, auth } = await setup();
    const res = await real(auth);
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toMatchObject({ code: 'SCREENING_PACK_REQUIRED', details: { reason: 'NO_PACK', pack_id: null } });
    expect(pb.calls).toEqual([]);
    expect(await db.selectFrom('purchases').selectAll().execute()).toHaveLength(0);
  });

  it.each([
    ['INCOMPLETE', { pack: { status: 'incomplete' as const } }],
    ['SETTINGS_NOT_ACTIVE', { pack: { settingsActive: false } }],
    ['PACK_TOO_OLD', { pack: { issuedAt: new Date(T0 - 73 * 3_600_000) } }],
  ])('%s: 409 with the reason and the pack id', async (reason, o) => {
    const { pb, auth } = await setup();
    const { packId } = await readyToBuy(DOMAIN, o);
    const res = await real(auth);
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toMatchObject({ code: 'SCREENING_PACK_REQUIRED', details: { reason, pack_id: packId } });
    expect(pb.calls).toEqual([]);
  });

  it('a pack aged exactly 72 h still passes (the limit is "no more than")', async () => {
    const { auth } = await setup();
    await readyToBuy(DOMAIN, { pack: { issuedAt: new Date(T0 - 72 * 3_600_000) } });
    expect((await real(auth)).statusCode).toBe(201);
  });

  it('NOT_FROM_LATEST_RUN: a later screening run of the name', async () => {
    const { auth } = await setup();
    const { packId } = await readyToBuy(DOMAIN);
    await laterRun(DOMAIN);
    const res = await real(auth);
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toMatchObject({ code: 'SCREENING_PACK_REQUIRED', details: { reason: 'NOT_FROM_LATEST_RUN', pack_id: packId } });
  });

  it('BUY_HOLD still comes first', async () => {
    const { auth } = await setup();
    await readyToBuy(DOMAIN);
    await laterRun(DOMAIN, { buy_hold: true });
    expect((await real(auth)).json().error.code).toBe('BUY_HOLD');
  });
});

describe('v2.0.0 /buy: tranche', () => {
  it('NO_TRANCHE: a complete pack but the name is in no open tranche (or only a closed or removed one)', async () => {
    const { pb, auth } = await setup();
    const { trancheId } = await readyToBuy(DOMAIN);
    await db.updateTable('tranche_members').set({ removed_at: new Date(T0), removed_by: 'test' }).where('domain', '=', DOMAIN).execute();
    const res = await real(auth);
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('NO_TRANCHE');
    expect(pb.calls).toEqual([]);
    expect(trancheId).toMatch(/^trn_/);
  });

  it('TRANCHE_SPEND_CAP: this buy on top of the tranche\'s purchases passes the cap; nothing is charged', async () => {
    const { pb, auth } = await setup();
    await readyToBuy(DOMAIN, { spendCapCents: 1000 });
    const res = await real(auth);
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toMatchObject({ code: 'TRANCHE_SPEND_CAP', details: { spend_cap_cents: 1000, spent_cents: 0, cost_cents: 1108 } });
    expect(pb.charges).toBe(0);
  });

  it('happy path: complete pack + open tranche -> 201 and the purchase records the tranche id', async () => {
    const { pb, auth } = await setup();
    const { trancheId } = await readyToBuy(DOMAIN, { spendCapCents: 5000 });
    const res = await real(auth);
    expect(res.statusCode).toBe(201);
    expect(pb.realRegisterCalls).toBe(1);
    expect(await db.selectFrom('purchases').select(['state', 'tranche_id']).execute()).toEqual([{ state: 'succeeded', tranche_id: trancheId }]);
  });

  it('two concurrent buys against a spend cap that fits one: exactly one passes', async () => {
    const { pb, auth } = await setup();
    const { trancheId } = await readyToBuy(DOMAIN, { spendCapCents: 1500 });
    await readyToBuy(OTHER); // joins the same open tranche
    const [a, b] = await Promise.all([real(auth, DOMAIN), real(auth, OTHER)]);
    expect([a.statusCode, b.statusCode].sort()).toEqual([201, 409]);
    const loser = a.statusCode === 409 ? a : b;
    expect(loser.json().error.code).toBe('TRANCHE_SPEND_CAP');
    expect(pb.realRegisterCalls).toBe(1);
    const rows = await db.selectFrom('purchases').select(['state', 'tranche_id']).where('state', '!=', 'failed').execute();
    expect(rows).toEqual([{ state: 'succeeded', tranche_id: trancheId }]);
  });
});

describe('v2.0.0 /buy: dry run', () => {
  it('would_be_blocked is the first blocking code, in order, or absent', async () => {
    const { auth } = await setup();
    expect((await dry(auth)).would_be_blocked).toBe('SCREENING_PACK_REQUIRED'); // no pack at all
    await readyToBuy(DOMAIN, { spendCapCents: 1000 });
    await db.updateTable('tranche_members').set({ removed_at: new Date(T0), removed_by: 'test' }).execute();
    expect((await dry(auth)).would_be_blocked).toBe('NO_TRANCHE');
    const gone = await db.selectFrom('tranche_members').selectAll().executeTakeFirstOrThrow();
    await db.insertInto('tranche_members').values({ tranche_id: gone.tranche_id, domain: gone.domain, lane: gone.lane, is_geo: false, main_lane: true, est_cost_cents: null, run_id: gone.run_id, added_by: 'test' }).execute();
    const capped = await dry(auth);
    expect(capped.would_be_blocked).toBe('TRANCHE_SPEND_CAP');
    expect(capped.dry_run).toBe(true);
    await db.updateTable('tranches').set({ spend_cap_cents: 5000 }).execute();
    expect((await dry(auth)).would_be_blocked).toBeUndefined();
    await laterRun(DOMAIN);
    expect((await dry(auth)).would_be_blocked).toBe('SCREENING_PACK_REQUIRED'); // not from the latest run
    await db.updateTable('screening_runs').set({ buy_hold: true }).where('id', '=', 'run_999999999999').execute();
    expect((await dry(auth)).would_be_blocked).toBe('BUY_HOLD');
  });
});
