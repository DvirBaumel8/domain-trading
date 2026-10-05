import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { makeApp } from '../helpers/app.js';
import { testDb as db } from '../helpers/db.js';
import { FakeAdapter } from '../helpers/fake-adapter.js';
import { listedDomain } from '../helpers/listing.js';
import { issueToken } from '../helpers/tokens.js';

let app: FastifyInstance;
afterEach(async () => app?.close());
const D = 'examplecityroofing.com';
const NOW = Date.parse('2026-10-20T09:00:00Z');
const approval = { text: `it sold on afternic for 1995 (${D})`, approved_at: new Date(NOW - 30_000).toISOString() };

async function setup() {
  app = await makeApp({ adapters: [new FakeAdapter('porkbun')], now: () => NOW });
  const id = await listedDomain({ domain: D, lander: 'afternic', lander_set_at: new Date('2026-10-10T00:00:00Z') });
  await db.insertInto('ledger_entries').values({ occurred_on: '2026-10-04', domain_id: id, type: 'registration', amount_cents: -1108 }).execute();
  const write = (await issueToken('write')).auth;
  const s = await app.inject({
    method: 'POST', url: `/sold/${D}`, headers: { ...write, 'idempotency-key': randomUUID() },
    payload: { venue: 'afternic', sale_price: 1995, commission: 299.25, sold_at: '2026-10-12T11:00:00+02:00', transaction_ref: 'AFN-1', approval_ref: { ...approval, approved_at: new Date(NOW - 30_000).toISOString() }, payout: { amount: 1680.75, method: 'wire', fee: 15 } },
  });
  expect(s.statusCode).toBe(200);
  const pid = (await db.selectFrom('payouts').select('id').executeTakeFirstOrThrow()).id;
  return { write, pid, read: (await issueToken('read')).auth };
}
const post = (pid: number | string, body: object, auth: Record<string, string>, key: string = randomUUID()) =>
  app.inject({ method: 'POST', url: `/payouts/${pid}/received`, headers: { ...auth, 'idempotency-key': key }, payload: body });

describe('POST /payouts/{id}/received', () => {
  it('PO-4: sets received_on once; status received; same-key replay -> same response; new key -> 409', async () => {
    const { write, pid } = await setup();
    const key = randomUUID();
    const r = await post(pid, { received_on: '2026-10-15' }, write, key);
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ id: pid, domain: D, payout: { amount_cents: 168075, amount: '$1,680.75', fee_cents: 1500, fee: '$15.00', method: 'wire', received_on: '2026-10-15', status: 'received' } });
    expect((await db.selectFrom('payouts').select('received_on').executeTakeFirstOrThrow()).received_on).toBe('2026-10-15');
    const again = await post(pid, { received_on: '2026-10-15' }, write, key);
    expect(again.statusCode).toBe(200);
    expect(again.json()).toEqual(r.json());
    const second = await post(pid, { received_on: '2026-10-16' }, write);
    expect(second.statusCode).toBe(409);
    expect(second.json().error.code).toBe('PAYOUT_ALREADY_RECEIVED');
    expect((await db.selectFrom('payouts').select('received_on').executeTakeFirstOrThrow()).received_on).toBe('2026-10-15');
  });

  it('PO-4: a future date -> 422; before the sale date -> 422; nothing written', async () => {
    const { write, pid } = await setup();
    expect((await post(pid, { received_on: '2026-10-21' }, write)).statusCode).toBe(422);
    expect((await post(pid, { received_on: '2026-10-11' }, write)).statusCode).toBe(422);
    expect((await post(pid, { received_on: 'nope' }, write)).statusCode).toBe(422);
    expect((await db.selectFrom('payouts').select('received_on').executeTakeFirstOrThrow()).received_on).toBeNull();
  });

  it('PO-4: unknown id -> 404 PAYOUT_NOT_FOUND', async () => {
    const { write } = await setup();
    const r = await post(9999, { received_on: '2026-10-15' }, write);
    expect(r.statusCode).toBe(404);
    expect(r.json().error.code).toBe('PAYOUT_NOT_FOUND');
    expect((await post('abc', { received_on: '2026-10-15' }, write)).statusCode).toBe(404);
  });

  it('PO-4: a READ token -> 403; Idempotency-Key required', async () => {
    const { write, read, pid } = await setup();
    expect((await post(pid, { received_on: '2026-10-15' }, read)).statusCode).toBe(403);
    const noKey = await app.inject({ method: 'POST', url: `/payouts/${pid}/received`, headers: write, payload: { received_on: '2026-10-15' } });
    expect(noKey.statusCode).toBeGreaterThanOrEqual(400);
    expect((await db.selectFrom('payouts').select('received_on').executeTakeFirstOrThrow()).received_on).toBeNull();
  });

  it('PO-4: optional approval_ref is validated; invalid -> 422 APPROVAL_INVALID, nothing written; valid or absent -> 200', async () => {
    const { write, pid } = await setup();
    const bad = await post(pid, { received_on: '2026-10-15', approval_ref: { text: 'ok received', approved_at: new Date(NOW - 30_000).toISOString() } }, write);
    expect(bad.statusCode).toBe(422);
    expect(bad.json().error.code).toBe('APPROVAL_INVALID');
    expect((await db.selectFrom('payouts').select('received_on').executeTakeFirstOrThrow()).received_on).toBeNull();
    const good = await post(pid, { received_on: '2026-10-15', approval_ref: { text: `the payout for ${D} arrived`, approved_at: new Date(NOW - 30_000).toISOString() } }, write);
    expect(good.statusCode).toBe(200);
  });
});
