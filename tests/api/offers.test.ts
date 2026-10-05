import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { PriceScheduleJob } from '../../src/jobs/price-schedule.js';
import { makeApp } from '../helpers/app.js';
import { insertOwnedDomain, testDb as db } from '../helpers/db.js';
import { FakeAdapter } from '../helpers/fake-adapter.js';
import { issueToken } from '../helpers/tokens.js';

let app: FastifyInstance;
afterEach(async () => app?.close());
const T = 'promptinjectionaudit.com';
const G = 'examplecityroofing.com';
const LISTED = Date.parse('2026-10-12T09:00:00Z');
let clock = LISTED;
const approval = (domain: string) => ({ text: `yes ${domain}`, approved_at: new Date(clock - 3_600_000).toISOString() });

async function setup() {
  clock = LISTED;
  const pb = new FakeAdapter('porkbun');
  app = await makeApp({ adapters: [pb], now: () => clock });
  const w = await issueToken('write', 'gavriel');
  const r = await issueToken('read');
  await insertOwnedDomain(db, { domain: T, category: 'trend', price_grade: null });
  await insertOwnedDomain(db, { domain: G });
  const list = (domain: string, b: object) => app.inject({ method: 'POST', url: `/list/${domain}`, headers: { ...w.auth, 'idempotency-key': randomUUID() }, payload: b });
  expect((await list(T, { mode: 'hybrid', bin: 1995, floor: 1295, walkaway: 950, pricing_exception: true, pricing_exception_reason: 'D-001 approved plan', approval_ref: approval(T) })).statusCode).toBe(200);
  expect((await list(G, { mode: 'bin', bin: 399, approval_ref: approval(G) })).statusCode).toBe(200);
  clock = Date.parse('2026-12-02T09:00:00Z');
  return { pb, w: w.auth, r: r.auth, list };
}
const post = (auth: Record<string, string>, body: object, key: string = randomUUID()) =>
  app.inject({ method: 'POST', url: '/offers', headers: { ...auth, 'idempotency-key': key }, payload: body });
const outcome = (auth: Record<string, string>, id: number, body: object) =>
  app.inject({ method: 'POST', url: `/offers/${id}/outcome`, headers: { ...auth, 'idempotency-key': randomUUID() }, payload: body });
const offer = (over: object = {}) => ({ domain: T, amount_usd: '450.00', source: 'afternic', received_at: '2026-12-01T09:12:00+02:00', ...over });
const rows = () => db.selectFrom('offers').selectAll().orderBy('id').execute();
const audits = async () => Number((await db.selectFrom('audit_log').select(db.fn.countAll().as('n')).executeTakeFirstOrThrow()).n);

describe('POST /offers', () => {
  it('OF-1: $450 afternic on D-001 -> below_walkaway, auto_decline, declined_auto, snapshot, next_step', async () => {
    const { w } = await setup();
    const res = await post(w, offer({ external_ref: 'AFN-OFFER-123' }));
    expect(res.statusCode).toBe(201);
    const j = res.json();
    expect(j).toMatchObject({
      domain: T, amount_cents: 45000, amount: '$450.00', source: 'afternic', band: 'below_walkaway', routing: 'auto_decline', outcome: 'declined_auto',
      received_at: '2026-12-01T09:12:00+02:00', recorded_by: 'gavriel', external_ref: 'AFN-OFFER-123', warnings: [],
      snapshot: { bin_cents: 199500, bin: '$1,995.00', floor_cents: 129500, floor: '$1,295.00', walkaway_cents: 95000, walkaway: '$950 (private)', min_offer_cents: 10000, min_offer: '$100.00' },
    });
    expect(j.next_step).toMatch(/decline/i);
    expect(j.next_step).toMatch(/no Gate D/);
    expect(typeof j.listing_history_id).toBe('number');
    expect(JSON.stringify(j)).not.toMatch(/950\.00|"950"/);
    expect(await rows()).toHaveLength(1);
    expect((await rows())[0]).toMatchObject({ recorded_by: 'gavriel', audit_id: expect.any(String) });
  });

  it('OF-2: $1,000 afternic -> mid_range, dvir, open', async () => {
    const { w } = await setup();
    expect((await post(w, offer({ amount_usd: '1000' }))).json()).toMatchObject({ band: 'mid_range', routing: 'dvir', outcome: 'open' });
  });

  it('OF-3: $1,295 -> at_or_above_floor, auto_accept, warning; $1,995 -> at_or_above_bin', async () => {
    const { w } = await setup();
    expect((await post(w, offer({ amount_usd: '1295' }))).json()).toMatchObject({ band: 'at_or_above_floor', routing: 'auto_accept', warnings: ['OFFER_AT_OR_ABOVE_FLOOR'] });
    expect((await post(w, offer({ amount_usd: '1995' }))).json()).toMatchObject({ band: 'at_or_above_bin' });
  });

  it('OF-6 via API: geo $350 / $399', async () => {
    const { w } = await setup();
    expect((await post(w, offer({ domain: G, amount_usd: '350' }))).json()).toMatchObject({ band: 'geo_below_bin', routing: 'auto_decline' });
    expect((await post(w, offer({ domain: G, amount_usd: '399' }))).json()).toMatchObject({ band: 'at_or_above_bin' });
  });

  it('OF-7: bands use the prices in force at received_at (M6 applied 2027-04-12)', async () => {
    const { w } = await setup();
    await new PriceScheduleJob({ db, now: () => Date.parse('2027-04-12T00:30:00Z') }).runOnce({ today: '2027-04-12' });
    const d = await db.selectFrom('domains').select('floor_cents').where('domain', '=', T).executeTakeFirstOrThrow();
    expect(d.floor_cents).toBe(103500);
    clock = Date.parse('2027-04-14T09:00:00Z');
    const a = await post(w, offer({ amount_usd: '1100', received_at: '2027-04-11T12:00:00+03:00' }));
    expect(a.json()).toMatchObject({ band: 'mid_range', snapshot: { floor_cents: 129500 } });
    const b = await post(w, offer({ amount_usd: '1100', received_at: '2027-04-13T12:00:00+03:00' }));
    expect(b.json()).toMatchObject({ band: 'at_or_above_floor', snapshot: { floor_cents: 103500 } });
  });

  it('OF-8: duplicates by (source, external_ref), and by domain/amount/source/received_at', async () => {
    const { w } = await setup();
    const a = await post(w, offer({ external_ref: 'X1' }));
    const b = await post(w, offer({ external_ref: 'X1', amount_usd: '500' }));
    expect(a.statusCode).toBe(201);
    expect(b.statusCode).toBe(200);
    expect(b.json()).toMatchObject({ duplicate: true, id: a.json().id });
    const c = await post(w, offer({ amount_usd: '460' }));
    const d = await post(w, offer({ amount_usd: '460' }));
    expect(c.statusCode).toBe(201);
    expect(d.statusCode).toBe(200);
    expect(d.json()).toMatchObject({ duplicate: true, id: c.json().id });
    expect(await rows()).toHaveLength(2);
  });

  it('dedupe without external_ref matches a row that has one; external_ref may hold an @ (Message-ID)', async () => {
    const { w } = await setup();
    const a = await post(w, offer({ external_ref: '<abc@mail.example>', source: 'email_inbound' }));
    expect(a.statusCode).toBe(201);
    const b = await post(w, offer({ source: 'email_inbound' }));
    expect(b.statusCode).toBe(200);
    expect(b.json()).toMatchObject({ duplicate: true, id: a.json().id });
  });

  it('OF-9: scope, unknown domain, amount, source, future, PII, buyer type', async () => {
    const { w, r } = await setup();
    expect((await post(r, offer())).statusCode).toBe(403);
    const err = async (b: object) => { const x = await post(w, b); return [x.statusCode, x.json().error.code]; };
    expect(await err(offer({ domain: 'nosuchname.com' }))).toEqual([404, 'DOMAIN_NOT_FOUND']);
    expect(await err(offer({ amount_usd: '0' }))).toEqual([422, 'AMOUNT_INVALID']);
    expect(await err(offer({ amount_usd: '12.345' }))).toEqual([422, 'AMOUNT_INVALID']);
    expect(await err(offer({ source: 'ebay' }))).toEqual([422, 'SOURCE_INVALID']);
    expect(await err(offer({ received_at: new Date(clock + 3_600_000).toISOString() }))).toEqual([422, 'RECEIVED_AT_IN_FUTURE']);
    expect(await err(offer({ buyer_ref: 'a@b.com' }))).toEqual([422, 'NO_PII']);
    expect(await err(offer({ note: 'mail me a@b.com' }))).toEqual([422, 'NO_PII']);
    expect(await err(offer({ buyer_type: 'whale' }))).toEqual([422, 'BUYER_TYPE_INVALID']);
    expect(await err(offer({ received_at: '2026-12-01T09:12:00' }))).toEqual([422, 'VALIDATION_ERROR']);
    expect(await rows()).toHaveLength(0);
  });

  it('OF-9: pending_purchase domain -> 404', async () => {
    const { w } = await setup();
    await insertOwnedDomain(db, { domain: 'pendingname.com', status: 'pending_purchase' });
    expect((await post(w, offer({ domain: 'pendingname.com' }))).json().error.code).toBe('DOMAIN_NOT_FOUND');
  });

  it('OF-10: never-listed owned domain -> 201, OFFER_ON_UNLISTED, unpriced', async () => {
    const { w } = await setup();
    await insertOwnedDomain(db, { domain: 'neverlisted.com', category: 'trend', price_grade: null });
    const res = await post(w, offer({ domain: 'neverlisted.com' }));
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ band: 'unpriced', routing: 'dvir', warnings: ['OFFER_ON_UNLISTED'], listing_history_id: null });
  });

  it('OF-10: offer received before the listing -> plan prices + OFFER_ON_UNLISTED', async () => {
    const { w } = await setup();
    const res = await post(w, offer({ received_at: '2026-10-01T09:00:00+03:00', amount_usd: '1000' }));
    expect(res.json()).toMatchObject({ band: 'mid_range', warnings: ['OFFER_ON_UNLISTED'], snapshot: { floor_cents: 129500 } });
  });

  it('O7: pricing_hold needs a reason, not an approval; sets the hold and one history row', async () => {
    const { w } = await setup();
    const tid = (await db.selectFrom('domains').select('id').where('domain', '=', T).executeTakeFirstOrThrow()).id;
    const hist = () => db.selectFrom('listing_history').selectAll().where('domain_id', '=', tid).execute();
    const before = (await hist()).length;
    const neither = await post(w, offer({ pricing_hold: true }));
    expect([neither.statusCode, neither.json().error.code]).toEqual([422, 'HOLD_REASON_REQUIRED']);
    const nr = await post(w, offer({ pricing_hold: true, approval_ref: approval(T) }));
    expect([nr.statusCode, nr.json().error.code]).toEqual([422, 'HOLD_REASON_REQUIRED']);
    expect(await rows()).toHaveLength(0);
    expect((await db.selectFrom('domains').select('pricing_hold').where('domain', '=', T).executeTakeFirstOrThrow()).pricing_hold).toBe(false);
    expect(await hist()).toHaveLength(before);
    const wrong = await post(w, offer({ pricing_hold: true, pricing_hold_reason: 'buyer in talks', approval_ref: approval('other.com') }));
    expect([wrong.statusCode, wrong.json().error.code]).toEqual([422, 'APPROVAL_INVALID']);
    expect(await rows()).toHaveLength(0);
    expect(await hist()).toHaveLength(before);
    const ok = await post(w, offer({ pricing_hold: true, pricing_hold_reason: 'buyer in talks' }));
    expect(ok.statusCode).toBe(201);
    expect(await db.selectFrom('domains').select(['pricing_hold', 'pricing_hold_reason']).where('domain', '=', T).executeTakeFirstOrThrow())
      .toEqual({ pricing_hold: true, pricing_hold_reason: 'buyer in talks' });
    expect(await hist()).toHaveLength(before + 1);
    expect((await hist()).at(-1)).toMatchObject({ approval_text: null, approval_at: null });
  });
});

describe('POST /offers/{id}/outcome', () => {
  it('Gate D: accepting a below_walkaway auto_decline offer needs approval; an auto_accept offer does not', async () => {
    const { w } = await setup();
    const low = (await post(w, offer({ amount_usd: '150' }))).json();
    expect([low.band, low.routing]).toEqual(['below_walkaway', 'auto_decline']);
    const no = await outcome(w, low.id, { outcome: 'accepted' });
    expect([no.statusCode, no.json().error.code]).toEqual([422, 'APPROVAL_REQUIRED']);
    const noC = await outcome(w, low.id, { outcome: 'countered' });
    expect([noC.statusCode, noC.json().error.code]).toEqual([422, 'APPROVAL_REQUIRED']);
    const ok = await outcome(w, low.id, { outcome: 'accepted', approval_ref: approval(T) });
    expect(ok.statusCode, ok.body).toBe(200);
    const auto = (await post(w, offer({ amount_usd: '1295' }))).json();
    expect(auto.routing).toBe('auto_accept');
    expect((await outcome(w, auto.id, { outcome: 'accepted' })).statusCode).toBe(200);
  });

  it('OF-12: approvals, audit rows, finality, sold mismatch', async () => {
    const { w } = await setup();
    const mid = (await post(w, offer({ amount_usd: '1000' }))).json().id as number;
    const low = (await post(w, offer({ amount_usd: '200' }))).json().id as number;
    const a0 = await audits();
    const no = await outcome(w, mid, { outcome: 'countered' });
    expect([no.statusCode, no.json().error.code]).toEqual([422, 'APPROVAL_REQUIRED']);
    expect(await audits()).toBe(a0 + 1); // the failed call is audited too; successful ones add exactly one each
    const a1 = await audits();
    const ok = await outcome(w, mid, { outcome: 'countered', note: 'counter at 1500', approval_ref: approval(T) });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ outcome: 'countered', outcome_note: 'counter at 1500' });
    expect(await audits()).toBe(a1 + 1);
    const stored = (await rows()).find((r) => r.id === mid)!;
    expect(stored.outcome_approval_text).toBe(`yes ${T}`);
    expect(stored.outcome_at).not.toBeNull();
    const a2 = await audits();
    expect((await outcome(w, low, { outcome: 'declined' })).statusCode).toBe(200);
    expect(await audits()).toBe(a2 + 1);
    const fin = await outcome(w, low, { outcome: 'accepted', approval_ref: approval(T) });
    expect([fin.statusCode, fin.json().error.code]).toEqual([409, 'OUTCOME_FINAL']);
    const bad = await outcome(w, mid, { outcome: 'sold' });
    expect([bad.statusCode, bad.json().error.code]).toEqual([409, 'OUTCOME_TRANSITION_INVALID']);
    expect((await outcome(w, mid, { outcome: 'accepted', approval_ref: approval(T) })).statusCode).toBe(200);
    const mm = await outcome(w, mid, { outcome: 'sold' });
    expect([mm.statusCode, mm.json().error.code]).toEqual([409, 'OFFER_SOLD_MISMATCH']);
    await db.updateTable('domains').set({ status: 'sold' }).where('domain', '=', T).execute();
    expect((await outcome(w, mid, { outcome: 'sold' })).statusCode).toBe(200);
  });

  it('email offers need approval; wrong-domain approval, unknown id, PII note, read token', async () => {
    const { w, r } = await setup();
    const em = (await post(w, offer({ amount_usd: '1500', source: 'email_inbound' }))).json().id as number;
    expect((await outcome(w, em, { outcome: 'accepted' })).json().error.code).toBe('APPROVAL_REQUIRED');
    expect((await outcome(w, em, { outcome: 'accepted', approval_ref: approval(G) })).json().error.code).toBe('APPROVAL_INVALID');
    expect((await outcome(w, em, { outcome: 'withdrawn', note: 'a@b.com' })).json().error.code).toBe('NO_PII');
    expect((await outcome(w, 9999, { outcome: 'declined' })).json().error.code).toBe('OFFER_NOT_FOUND');
    expect((await outcome(r, em, { outcome: 'declined' })).statusCode).toBe(403);
  });
});

describe('GET /offers and no side effects', () => {
  it('lists newest first with filters; bad band -> 400', async () => {
    const { w, r } = await setup();
    const a = (await post(w, offer({ received_at: '2026-11-01T10:00:00+02:00', amount_usd: '300' }))).json().id;
    const b = (await post(w, offer({ received_at: '2026-11-20T10:00:00+02:00', amount_usd: '1000', source: 'sedo' }))).json().id;
    const c = (await post(w, offer({ domain: G, received_at: '2026-11-20T10:00:00+02:00', amount_usd: '350' }))).json().id;
    const get = async (q: string) => { const x = await app.inject({ method: 'GET', url: `/offers${q}`, headers: r }); return x; };
    const ids = async (q: string) => (await get(q)).json().offers.map((o: { id: number }) => o.id);
    expect(await ids('')).toEqual([c, b, a]);
    expect(await ids(`?domain=${T}`)).toEqual([b, a]);
    expect(await ids('?band=mid_range')).toEqual([b]);
    expect(await ids('?source=sedo')).toEqual([b]);
    expect(await ids('?from=2026-11-20')).toEqual([c, b]);
    expect(await ids('?to=2026-11-01')).toEqual([a]);
    expect(await ids('?from=2026-11-01&to=2026-11-01')).toEqual([a]);
    expect(await ids('?from=2026-11-20T07:30:00Z')).toEqual([c, b]);
    expect((await get('?band=bogus')).statusCode).toBe(400);
    expect((await get('?from=nope')).json().error.code).toBe('VALIDATION_ERROR');
    expect((await get('?domain=not a domain')).statusCode).toBe(400);
  });

  it('OF-20: no registrar calls, no price or hold change without a hold request', async () => {
    const { w, r, pb } = await setup();
    const before = await db.selectFrom('domains').selectAll().where('domain', '=', T).executeTakeFirstOrThrow();
    const calls = [...pb.calls];
    const id = (await post(w, offer({ amount_usd: '1000' }))).json().id;
    await outcome(w, id, { outcome: 'countered', approval_ref: approval(T) });
    await app.inject({ method: 'GET', url: '/offers', headers: r });
    expect(pb.calls).toEqual(calls);
    const after = await db.selectFrom('domains').selectAll().where('domain', '=', T).executeTakeFirstOrThrow();
    expect(after).toEqual(before);
  });
});

describe('fix round 1', () => {
  it('external_ref reused for another domain -> 409 EXTERNAL_REF_CONFLICT; a real duplicate shows its own domain', async () => {
    const { w } = await setup();
    const a = await post(w, offer({ external_ref: 'Z1' }));
    const c = await post(w, offer({ domain: G, external_ref: 'Z1' }));
    expect(c.statusCode).toBe(409);
    expect(c.json().error).toMatchObject({ code: 'EXTERNAL_REF_CONFLICT', details: { offer_id: a.json().id } });
    expect(JSON.stringify(c.json())).not.toContain(T);
    const dup = await post(w, offer({ external_ref: 'Z1' }));
    expect(dup.json()).toMatchObject({ duplicate: true, domain: T });
    expect(await rows()).toHaveLength(1);
  });

  it('hold: second held offer adds no history row; duplicate with hold applies nothing; delisted -> 404', async () => {
    const { w } = await setup();
    const hist = async () => (await db.selectFrom('listing_history').select('id').execute()).length;
    const held = (extra: object) => post(w, offer({ pricing_hold: true, pricing_hold_reason: 'talks', approval_ref: approval(T), ...extra }));
    const dupFirst = await post(w, offer({ amount_usd: '470' }));
    expect(dupFirst.statusCode).toBe(201);
    const h0 = await hist();
    const dup = await held({ amount_usd: '470' });
    expect(dup.statusCode).toBe(200);
    expect(dup.json().duplicate).toBe(true);
    expect(await hist()).toBe(h0);
    expect((await db.selectFrom('domains').select('pricing_hold').where('domain', '=', T).executeTakeFirstOrThrow()).pricing_hold).toBe(false);
    expect((await held({ amount_usd: '480' })).statusCode).toBe(201);
    expect(await hist()).toBe(h0 + 1);
    expect((await held({ amount_usd: '490' })).statusCode).toBe(201);
    expect(await hist()).toBe(h0 + 1);
    await db.updateTable('domains').set({ status: 'delisted', delisted_at: new Date('2026-11-15T00:00:00Z') }).where('domain', '=', T).execute();
    const nd = await held({ amount_usd: '495' });
    expect([nd.statusCode, nd.json().error.code]).toEqual([404, 'NOT_IN_PORTFOLIO']);
  });

  it('unpriced offer countered without approval -> 422 APPROVAL_REQUIRED', async () => {
    const { w } = await setup();
    await insertOwnedDomain(db, { domain: 'neverlisted.com', category: 'trend', price_grade: null });
    const id = (await post(w, offer({ domain: 'neverlisted.com' }))).json().id;
    const r = await outcome(w, id, { outcome: 'countered' });
    expect([r.statusCode, r.json().error.code]).toEqual([422, 'APPROVAL_REQUIRED']);
  });

  it('received_at must be a real calendar date', async () => {
    const { w } = await setup();
    const r = await post(w, offer({ received_at: '2026-02-30T10:00:00+02:00' }));
    expect([r.statusCode, r.json().error.code]).toEqual([422, 'VALIDATION_ERROR']);
  });

  it('an offer received exactly at a history row\'s at uses the new prices', async () => {
    const { w } = await setup();
    await new PriceScheduleJob({ db, now: () => Date.parse('2027-04-12T00:30:00Z') }).runOnce({ today: '2027-04-12' });
    clock = Date.parse('2027-04-14T09:00:00Z');
    const r = await post(w, offer({ amount_usd: '1100', received_at: '2027-04-12T00:30:00Z' }));
    expect(r.json()).toMatchObject({ band: 'at_or_above_floor', snapshot: { floor_cents: 103500 } });
  });

  it('delisted domain, offer after delisted_at: old prices plus OFFER_ON_UNLISTED', async () => {
    const { w } = await setup();
    await db.updateTable('domains').set({ status: 'delisted', delisted_at: new Date('2026-11-15T00:00:00Z') }).where('domain', '=', T).execute();
    const r = await post(w, offer({ amount_usd: '1000', received_at: '2026-11-20T10:00:00+02:00' }));
    expect(r.json()).toMatchObject({ band: 'mid_range', warnings: ['OFFER_ON_UNLISTED'], snapshot: { floor_cents: 129500 } });
  });

  it('GET from/to around IDT midnight; from > to -> 400; truncated flag', async () => {
    const { w, r } = await setup();
    const a = (await post(w, offer({ received_at: '2026-11-20T23:30:00+02:00', amount_usd: '300' }))).json().id;
    await post(w, offer({ received_at: '2026-11-21T00:10:00+02:00', amount_usd: '310' }));
    const res = await app.inject({ method: 'GET', url: '/offers?from=2026-11-20&to=2026-11-20', headers: r });
    expect(res.json().offers.map((o: { id: number }) => o.id)).toEqual([a]);
    expect(res.json().truncated).toBe(false);
    for (const q of ['from=2026-11-21&to=2026-11-20', 'from=2026-11-21T00:00:00Z&to=2026-11-20T00:00:00Z',
      'from=2026-13-01', 'from=2026-01-32', 'to=2026-00-10', 'to=2026-02-30', 'from=2026-02-30T10:00:00%2B02:00']) {
      const bad = await app.inject({ method: 'GET', url: `/offers?${q}`, headers: r });
      expect([bad.statusCode, bad.json().error.code]).toEqual([400, 'VALIDATION_ERROR']);
    }
    const dom = await db.selectFrom('domains').select('id').where('domain', '=', T).executeTakeFirstOrThrow();
    await db.insertInto('offers').values(Array.from({ length: 500 }, (_, i) => ({
      domain_id: dom.id, amount_cents: 1000 + i, source: 'other' as const, received_at: new Date('2026-10-20T00:00:00Z'),
      band: 'below_min' as const, routing: 'auto_decline' as const, outcome: 'declined_auto' as const, recorded_by: 'x',
    }))).execute();
    const all = await app.inject({ method: 'GET', url: '/offers', headers: r });
    expect(all.json().offers).toHaveLength(500);
    expect(all.json().truncated).toBe(true);
  });
});
