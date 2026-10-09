// v3.5.0 / CR-030: the small-buy exception to the buy hold (fixed limits in code, no settings block).
import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import type { RdapFn } from '../../src/core/rdap.js';
import { SMALL_BUY_MAX_FIRST_YEAR_CENTS, SMALL_BUY_WEEKLY_CAP_CENTS } from '../../src/modules/buying/small-buy.js';
import { makeApp } from '../helpers/app.js';
import { DOMAIN, T0, buyBody, readyToBuy } from '../helpers/buy.js';
import { testDb as db } from '../helpers/db.js';
import { FakeAdapter } from '../helpers/fake-adapter.js';
import { patchActiveSettings } from '../helpers/screening.js';
import { issueToken } from '../helpers/tokens.js';

let app: FastifyInstance;
afterEach(async () => app?.close());
const rdapFree: RdapFn = async () => 'not_registered';
const smallLine = (domain = DOMAIN) => ({ text: `Dvir: small buy ${domain}, normal price`, approved_at: new Date(T0 - 3_600_000).toISOString() });

async function setup(quote: Record<string, unknown> = {}) {
  const pb = new FakeAdapter('porkbun', { quote });
  app = await makeApp({ adapters: [pb], rdap: rdapFree, now: () => T0, sleep: async () => {} });
  return { pb, auth: (await issueToken('write')).auth };
}
/** A held name (its latest screening run has buy_hold on) with a complete pack from that run and an open tranche. */
async function heldReady(domain = DOMAIN, o: Parameters<typeof readyToBuy>[1] = {}) {
  const r = await readyToBuy(domain, o);
  await patchActiveSettings(['buy_hold'], true);
  await db.updateTable('screening_runs').set({ buy_hold: true }).where('id', '=', r.runId).execute();
  return r;
}
const post = (auth: Record<string, string>, body: object, key: string = randomUUID()) =>
  app.inject({ method: 'POST', url: '/buy', headers: { ...auth, 'idempotency-key': key }, payload: body });
const sb = (over: Record<string, unknown> = {}) => buyBody({ small_buy_exception: true, approval_ref: smallLine(), ...over });
const holdState = async (auth: Record<string, string>) => (await app.inject({ method: 'GET', url: '/selection/buy-hold', headers: auth })).json();

async function seedSmallBuy(cents: number, o: { state?: 'succeeded' | 'created' | 'failed'; ageMs?: number; flag?: boolean; domain?: string } = {}) {
  const at = new Date(Date.now() - (o.ageMs ?? 3_600_000));
  await db.insertInto('purchases').values({
    idempotency_key: randomUUID(), request_hash: 'h', domain: o.domain ?? `seed${Math.floor(Math.random() * 1e9)}.com`, state: o.state ?? 'succeeded', dry_run: false,
    registrar: 'porkbun', max_price_cents: 5000, approval_text: 'small buy', approval_at: at, expected_cents: cents,
    charged_cents: (o.state ?? 'succeeded') === 'succeeded' ? cents : null, small_buy_exception: o.flag ?? true, created_at: at, updated_at: at,
  }).execute();
}

describe('v3.5.0 CR-030 small buy', () => {
  it('T30-1: held name, complete pack, flag + "small buy" line: the dry run shows would_be_blocked null and the cap state', async () => {
    const { auth } = await setup();
    await heldReady();
    const res = await post(auth, sb({ dry_run: true }));
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ dry_run: true, would_be_blocked: null, small_buy: { cap_cents: SMALL_BUY_WEEKLY_CAP_CENTS, spent_cents: 0, cost_cents: 1108, remaining_cents: 3892 } });
  });

  it('T30-2: the same call without the flag, or without "small buy" in the line, stays BUY_HOLD (dry run and real)', async () => {
    const { pb, auth } = await setup();
    await heldReady();
    const noFlag = buyBody({ approval_ref: smallLine() });
    const noPhrase = buyBody({ small_buy_exception: true });
    for (const body of [noFlag, noPhrase]) {
      expect((await post(auth, { ...body, dry_run: true })).json()).toMatchObject({ would_be_blocked: 'BUY_HOLD' });
      const real = await post(auth, body);
      expect([real.statusCode, real.json().error.code]).toEqual([409, 'BUY_HOLD']);
    }
    expect((await post(auth, sb({ small_buy_exception: false, dry_run: true }))).json().small_buy).toBeUndefined();
    expect(pb.realRegisterCalls).toBe(0);
    expect(await db.selectFrom('purchases').selectAll().execute()).toHaveLength(0);
  });

  it('T30-3: the line must still name the domain; "small buy" alone is APPROVAL_INVALID', async () => {
    const { auth } = await setup();
    await heldReady();
    const res = await post(auth, sb({ approval_ref: { text: 'small buy of that one', approved_at: new Date(T0 - 3_600_000).toISOString() } }));
    expect([res.statusCode, res.json().error.code]).toEqual([422, 'APPROVAL_INVALID']);
    expect(smallLine().text.toUpperCase()).toContain('SMALL BUY');
    const upper = await post(auth, sb({ approval_ref: { text: `Dvir: SMALL BUY ${DOMAIN}`, approved_at: new Date(T0 - 3_600_000).toISOString() }, dry_run: true }));
    expect(upper.json().would_be_blocked).toBeNull();
  });

  it('T30-4: an incomplete pack, no pack, no tranche or a full tranche cap still refuse, with the flag', async () => {
    const { pb, auth } = await setup();
    const none = await post(auth, sb());
    expect([none.statusCode, none.json().error.code, none.json().error.details.reason]).toEqual([409, 'SCREENING_PACK_REQUIRED', 'NO_PACK']);
    await heldReady(DOMAIN, { pack: { status: 'incomplete' } });
    const inc = await post(auth, sb());
    expect([inc.json().error.code, inc.json().error.details.reason]).toEqual(['SCREENING_PACK_REQUIRED', 'INCOMPLETE']);
    expect((await post(auth, sb({ dry_run: true }))).json().would_be_blocked).toBe('SCREENING_PACK_REQUIRED');
    expect(pb.realRegisterCalls).toBe(0);
  });

  it('T30-5: NO_TRANCHE and TRANCHE_SPEND_CAP are untouched by the flag', async () => {
    const { pb, auth } = await setup();
    await heldReady(DOMAIN, { spendCapCents: 1000 });
    const cap = await post(auth, sb());
    expect([cap.statusCode, cap.json().error.code]).toEqual([409, 'TRANCHE_SPEND_CAP']);
    await db.updateTable('tranche_members').set({ removed_at: new Date(T0), removed_by: 'test' }).execute();
    const no = await post(auth, sb());
    expect([no.statusCode, no.json().error.code]).toEqual([409, 'NO_TRANCHE']);
    expect(pb.realRegisterCalls).toBe(0);
  });

  it('T30-6: a first-year price above the limit is SMALL_BUY_PRICE (real: 409, dry run: would_be_blocked)', async () => {
    const { pb, auth } = await setup({ firstYearCents: SMALL_BUY_MAX_FIRST_YEAR_CENTS + 1 });
    await heldReady();
    const dry = await post(auth, sb({ max_price: 20, dry_run: true }));
    expect(dry.statusCode).toBe(200);
    expect(dry.json()).toMatchObject({ would_be_blocked: 'SMALL_BUY_PRICE' });
    expect(dry.json().small_buy).toBeUndefined();
    const real = await post(auth, sb({ max_price: 20 }));
    expect([real.statusCode, real.json().error.code]).toEqual([409, 'SMALL_BUY_PRICE']);
    expect(real.json().error.details).toMatchObject({ max_first_year_cents: 1108, cost_cents: 1109 });
    expect(pb.realRegisterCalls).toBe(0);
    expect(await db.selectFrom('purchases').selectAll().execute()).toHaveLength(0);
  });

  it('T30-7: a premium quote is never a small buy (the registrar selection refuses it before the exception is reached)', async () => {
    const { pb, auth } = await setup({ premium: true });
    await heldReady();
    const real = await post(auth, sb());
    expect(real.statusCode).toBe(409);
    expect(real.json().error.code).not.toBe('BUY_HOLD');
    expect(pb.realRegisterCalls).toBe(0);
  });

  it('T30-8: a buy that would push the rolling 7-day sum past $50 is SMALL_BUY_WEEKLY_CAP with the numbers and next_allowed_at', async () => {
    const { pb, auth } = await setup();
    await heldReady();
    await seedSmallBuy(2500, { ageMs: 2 * 86_400_000 });
    await seedSmallBuy(2000, { state: 'created', ageMs: 3_600_000 }); // an open purchase counts
    const dry = await post(auth, sb({ dry_run: true }));
    expect(dry.json().would_be_blocked).toBe('SMALL_BUY_WEEKLY_CAP');
    const real = await post(auth, sb());
    expect([real.statusCode, real.json().error.code]).toEqual([409, 'SMALL_BUY_WEEKLY_CAP']);
    const d = real.json().error.details;
    expect(d).toMatchObject({ cap_cents: 5000, spent_cents: 4500, cost_cents: 1108 });
    // the 2 500 buy (2 days old) ages out first, which frees enough room
    expect(Date.parse(d.next_allowed_at)).toBeGreaterThan(Date.now() + 4 * 86_400_000);
    expect(Date.parse(d.next_allowed_at)).toBeLessThan(Date.now() + 5.1 * 86_400_000);
    expect(pb.realRegisterCalls).toBe(0);
  });

  it('T30-9: exactly at the cap passes; failed, older-than-7-days and unmarked purchases are not counted', async () => {
    const { auth } = await setup();
    await heldReady();
    await seedSmallBuy(3892);
    await seedSmallBuy(4000, { state: 'failed' });
    await seedSmallBuy(4000, { ageMs: 8 * 86_400_000 });
    await seedSmallBuy(4000, { flag: false });
    const dry = (await post(auth, sb({ dry_run: true }))).json();
    expect(dry).toMatchObject({ would_be_blocked: null, small_buy: { spent_cents: 3892, cost_cents: 1108, remaining_cents: 0 } });
  });

  it('T30-10: a real small buy is 201, marks the purchase row and the audit summary, and buy_hold stays true', async () => {
    const { pb, auth } = await setup();
    await heldReady();
    const before = await holdState(auth);
    expect(before.buy_hold).toBe(true);
    const res = await post(auth, sb());
    expect(res.statusCode).toBe(201);
    expect(pb.realRegisterCalls).toBe(1);
    const p = await db.selectFrom('purchases').selectAll().where('domain', '=', DOMAIN).executeTakeFirstOrThrow();
    expect([p.small_buy_exception, p.state, p.charged_cents]).toEqual([true, 'succeeded', 1108]);
    const a = await db.selectFrom('audit_log').selectAll().where('path', '=', '/buy').where('status_code', '=', 201).executeTakeFirstOrThrow();
    expect(a.result_summary).toContain('small buy');
    expect(a.approval_text).toContain('small buy');
    const { small_buy: _after, ...afterHold } = await holdState(auth); // v3.7.0 (G-3): small_buy now counts the purchase
    const { small_buy: _before, ...beforeHold } = before;
    expect(afterHold).toEqual(beforeHold);
    // the purchase now counts against the week
    expect((await post(auth, sb({ domain: 'tampapoolsco.com', approval_ref: smallLine('tampapoolsco.com'), dry_run: true }))).statusCode).toBe(200);
    await heldReady('tampapoolsco.com');
    const next = (await post(auth, sb({ domain: 'tampapoolsco.com', approval_ref: smallLine('tampapoolsco.com'), dry_run: true }))).json();
    expect(next.small_buy).toMatchObject({ spent_cents: 1108, remaining_cents: 5000 - 2 * 1108 });
  });

  it('T30-11: an ordinary (released-hold) buy is not marked as a small buy', async () => {
    const { auth } = await setup();
    await readyToBuy(DOMAIN);
    const res = await post(auth, buyBody());
    expect(res.statusCode).toBe(201);
    const p = await db.selectFrom('purchases').select('small_buy_exception').where('domain', '=', DOMAIN).executeTakeFirstOrThrow();
    expect(p.small_buy_exception).toBe(false);
  });
});
