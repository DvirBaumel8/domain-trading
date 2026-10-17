// v5.10.0 (CR-061): the holdout guard (HOLDOUT_SEALED), POST/GET /engine/holdout-date, db_bytes_*, DB_SIZE_HIGH.
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { sql } from 'kysely';
import { advisoryXactLock } from '../../../src/core/locks.js';
import { makeApp } from '../../helpers/app.js';
import { testDb as db } from '../../helpers/db.js';
import { FakeAdapter } from '../../helpers/fake-adapter.js';
import { issueToken } from '../../helpers/tokens.js';

let app: FastifyInstance;
afterEach(async () => app?.close());
const NOW = Date.parse('2026-10-17T09:00:00Z');
async function setup(extra: Record<string, unknown> = {}) {
  app = await makeApp({ adapters: [new FakeAdapter('porkbun')], now: () => NOW, ...extra });
  return { w: (await issueToken('write', 'gavriel')).auth, d: (await issueToken('data', 'data-engineer-upload')).auth, r: (await issueToken('read')).auth };
}
const post = (url: string, h: Record<string, string>, payload: unknown, key: string = randomUUID()) =>
  app.inject({ method: 'POST', url, headers: { ...h, 'idempotency-key': key }, payload: payload as object });
const sale = (o: Record<string, unknown> = {}) => ({ domain: 'septicdrone.com', price_usd: 1500, sale_date: '2026-09-01', venue: 'namebio', source: 'x', ...o });
const approval = (text: string, at = '2026-10-17T11:30:00+03:00') => ({ text, approved_at: at });

describe('holdout guard', () => {
  it('HG-1: AC-4: a sale dated 2026-10-15 is HOLDOUT_SEALED, 2026-10-14 is accepted; counts add up to rows sent', async () => {
    const { d } = await setup();
    const res = await post('/engine/sales', d, { rows: [sale({ domain: 'aaa.com', sale_date: '2026-10-15' }), sale({ domain: 'bbb.com', sale_date: '2026-10-14' }), sale({ domain: 'ccc.com', sale_date: 'nope' }), sale({ domain: 'ddd.com', sale_date: '2026-10-16' }), sale({ domain: 'bbb.com', sale_date: '2026-10-14' })] });
    expect(res.statusCode, res.body).toBe(201);
    const b = res.json();
    expect(b).toMatchObject({ received_n: 5, accepted_n: 1, duplicate_n: 1, rejected_n: 3 });
    expect(b.accepted_n + b.duplicate_n + b.rejected_n).toBe(b.received_n);
    expect(b.rejects.map((r: { row: number; reason: string }) => [r.row, r.reason])).toEqual([[0, 'HOLDOUT_SEALED'], [2, 'DATE_INVALID'], [3, 'HOLDOUT_SEALED']]);
    expect((await db.selectFrom('engine_sales').select('domain').execute()).map((r) => r.domain)).toEqual(['bbb.com']);
  });

  it('HG-2: the guard applies to /engine/unsold by observation_date', async () => {
    const { d } = await setup();
    const res = await post('/engine/unsold', d, { rows: [{ domain: 'aaa.com', type: 'dropped_after_held', observation_date: '2026-10-15' }, { domain: 'bbb.com', type: 'dropped_after_held', observation_date: '2026-10-14' }] });
    expect(res.json()).toMatchObject({ accepted_n: 1, rejected_n: 1, rejects: [{ row: 0, domain: 'aaa.com', reason: 'HOLDOUT_SEALED' }] });
  });

  it('HG-3: GET /engine/holdout-date defaults to 2026-10-14; a data token cannot read or change it', async () => {
    const { w, r, d } = await setup();
    expect((await app.inject({ method: 'GET', url: '/engine/holdout-date', headers: r })).json()).toEqual({ sales_max_date: '2026-10-14' });
    expect((await app.inject({ method: 'GET', url: '/engine/holdout-date', headers: w })).statusCode).toBe(200);
    for (const h of [d, r]) expect((await post('/engine/holdout-date', h, { date: '2026-10-20', approval_ref: approval('Dvir: unseal to 2026-10-20') })).statusCode).toBe(403);
  });

  it('HG-4: POST /engine/holdout-date with a valid approval moves the date, is audited, and then 10-15 rows are accepted', async () => {
    const { w, d } = await setup();
    const res = await post('/engine/holdout-date', w, { date: '2026-10-20', approval_ref: approval('Dvir approves unseal up to 2026-10-20') });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({ sales_max_date: '2026-10-20', previous: '2026-10-14' });
    const a = await db.selectFrom('audit_log').select(['path', 'approval_text', 'scope']).where('path', '=', '/engine/holdout-date').executeTakeFirstOrThrow();
    expect(a).toMatchObject({ scope: 'write' });
    expect(a.approval_text).toContain('2026-10-20');
    expect((await post('/engine/sales', d, { rows: [sale({ sale_date: '2026-10-15' })] })).json()).toMatchObject({ accepted_n: 1, rejected_n: 0 });
  });

  it('HG-5: the holdout-date approval must be present, name the date, not be in the future, not be older than 72 h; a bad date is a 422', async () => {
    const { w } = await setup();
    const date = '2026-10-20';
    const none = await post('/engine/holdout-date', w, { date });
    expect(none.statusCode).toBe(422); expect(none.json().error.code).toBe('APPROVAL_INVALID');
    const unnamed = await post('/engine/holdout-date', w, { date, approval_ref: approval('yes unseal it') });
    expect(unnamed.statusCode).toBe(422); expect(unnamed.json().error.code).toBe('APPROVAL_INVALID');
    const other = await post('/engine/holdout-date', w, { date, approval_ref: approval('unseal 2026-10-21') });
    expect(other.json().error.code).toBe('APPROVAL_INVALID');
    const future = await post('/engine/holdout-date', w, { date, approval_ref: approval('unseal 2026-10-20', '2026-10-18T09:00:00+03:00') });
    expect(future.json().error.code).toBe('APPROVAL_INVALID');
    const old = await post('/engine/holdout-date', w, { date, approval_ref: approval('unseal 2026-10-20', '2026-10-10T09:00:00+03:00') });
    expect(old.json().error.code).toBe('APPROVAL_EXPIRED');
    const bad = await post('/engine/holdout-date', w, { date: '2026-02-30', approval_ref: approval('unseal 2026-02-30') });
    expect(bad.statusCode).toBe(422); expect(bad.json().error.code).toBe('VALIDATION_ERROR');
    expect((await app.inject({ method: 'GET', url: '/engine/holdout-date', headers: w })).json().sales_max_date).toBe('2026-10-14');
    const noKey = await app.inject({ method: 'POST', url: '/engine/holdout-date', headers: w, payload: { date } });
    expect(noKey.json().error.code).toBe('IDEMPOTENCY_KEY_REQUIRED');
  });

  it('HG-6: AC-6: both upload routes return db_bytes_before and db_bytes_after (positive integers, after not below before the load)', async () => {
    const { d } = await setup();
    for (const [url, rows] of [['/engine/sales', [sale()]], ['/engine/unsold', [{ domain: 'aaa.com', type: 'registered_unsold', observation_date: '2026-10-01' }]]] as const) {
      const b = (await post(url, d, { rows })).json();
      expect(Number.isInteger(b.db_bytes_before) && b.db_bytes_before > 0, url).toBe(true);
      expect(Number.isInteger(b.db_bytes_after) && b.db_bytes_after >= b.db_bytes_before, url).toBe(true);
    }
  });

  it('HG-7: when the size plus the payload would pass 70% of 1 GB the load is refused with 409 DB_SIZE_HIGH and nothing is stored', async () => {
    const limit = 1024 ** 3; // 5.13.0: Neon free is 1 GB
    const { d } = await setup({ engineDbSize: { bytes: async () => limit * 0.7 - 10 } });
    const res = await post('/engine/sales', d, { rows: [sale()] });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toMatchObject({ code: 'DB_SIZE_HIGH', details: { warn_percent: 70, limit_bytes: limit } });
    expect(await db.selectFrom('engine_sales').select('id').execute()).toEqual([]);
    expect(await db.selectFrom('engine_uploads').select('id').execute()).toEqual([]);
  });

  it('HG-8: a size just under the ceiling still loads', async () => {
    const limit = 1024 ** 3; // 5.13.0: Neon free is 1 GB
    const { d } = await setup({ engineDbSize: { bytes: async () => limit * 0.7 - 100_000 } });
    const res = await post('/engine/sales', d, { rows: [sale()] });
    expect(res.statusCode).toBe(201);
    expect(res.json().db_bytes_before).toBe(limit * 0.7 - 100_000);
  });

  it('HG-9: M4 the sealed date is read inside the upload lock: an upload waiting for the lock sees a date changed meanwhile; POST /engine/holdout-date waits for the lock', async () => {
    const { w, d } = await setup();
    let release!: () => void;
    const hold = new Promise<void>((r) => { release = r; });
    let held!: () => void;
    const holding = new Promise<void>((r) => { held = r; });
    const trxDone = db.transaction().execute(async (trx) => {
      await advisoryXactLock(trx, 'engine_upload');
      held();
      await hold;
      await sql`update settings set engine_sales_max_date = '2026-10-20'`.execute(trx);
    });
    await holding;
    // an upload dated 10-15 starts while the date is still 10-14 on disk: it must wait, then see 10-20
    let uploadDone = false;
    const upload = post('/engine/sales', d, { rows: [sale({ sale_date: '2026-10-15' })] }).then((r) => { uploadDone = true; return r; });
    let setDone = false;
    const set = post('/engine/holdout-date', w, { date: '2026-10-22', approval_ref: approval('Dvir approves unseal up to 2026-10-22') }).then((r) => { setDone = true; return r; });
    await new Promise((r) => setTimeout(r, 300));
    expect([uploadDone, setDone]).toEqual([false, false]);
    release();
    await trxDone;
    const [u, sres] = await Promise.all([upload, set]);
    expect(u.statusCode, u.body).toBe(201);
    expect(u.json()).toMatchObject({ accepted_n: 1, rejected_n: 0 });
    expect(sres.statusCode, sres.body).toBe(200);
    expect(sres.json()).toMatchObject({ sales_max_date: '2026-10-22' });
  });
});
