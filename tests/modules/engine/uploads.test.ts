// v5.4.0 (CR-056 part 1): POST /engine/sales, POST /engine/unsold, GET /engine/health.
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { makeApp } from '../../helpers/app.js';
import { testDb as db } from '../../helpers/db.js';
import { FakeAdapter } from '../../helpers/fake-adapter.js';
import { issueToken } from '../../helpers/tokens.js';

let app: FastifyInstance;
afterEach(async () => app?.close());
const NOW = Date.parse('2026-10-14T09:00:00Z');
async function setup() {
  app = await makeApp({ adapters: [new FakeAdapter('porkbun')], now: () => NOW });
  return { w: (await issueToken('write', 'gavriel')).auth, r: (await issueToken('read')).auth };
}
const post = (url: string, h: Record<string, string>, payload: unknown, key: string = randomUUID()) =>
  app.inject({ method: 'POST', url, headers: { ...h, 'idempotency-key': key }, payload: payload as object });
const sale = (o: Record<string, unknown> = {}) => ({ domain: 'septicdrone.com', price_usd: 1500, sale_date: '2026-09-01', venue: 'sedo', source: 'unreported-sales', ...o });
const unsold = (o: Record<string, unknown> = {}) => ({ domain: 'septicdrone.com', type: 'dropped_after_held', observation_date: '2026-10-08', ...o });

describe('engine uploads', () => {
  it('EN-1: sales are stored in cents with counts; a bad row is rejected with its reason and the rest are stored', async () => {
    const { w } = await setup();
    const res = await post('/engine/sales', w, { rows: [
      sale(), sale({ domain: 'Plain-Name9.com', price_usd: '99.5', source_url: 'https://x.test/1' }),
      sale({ domain: 'foo.net' }), sale({ domain: 'a.b.com' }), sale({ domain: 'bad domain.com' }), sale({ domain: 5 }), 'nope',
      sale({ domain: 'free.com', price_usd: 0 }), sale({ domain: 'free2.com', price_usd: 'abc' }),
      sale({ domain: 'fut.com', sale_date: '2026-10-15' }), sale({ domain: 'bad.com', sale_date: '2026-02-30' }), sale({ domain: 'old.com', sale_date: '1999-12-31' }),
      sale({ domain: 'nov.com', venue: '' }), sale({ domain: 'nos.com', source: undefined }), sale({ domain: 'url.com', source_url: 5 }),
    ] });
    expect(res.statusCode, res.body).toBe(201);
    const b = res.json();
    expect(b).toMatchObject({ received_n: 15, accepted_n: 2, duplicate_n: 0, rejected_n: 13 });
    expect(b.audit_id).toMatch(/^aud_/);
    expect(b.rejects.map((r: { row: number; reason: string }) => [r.row, r.reason])).toEqual([
      [2, 'TLD_NOT_SUPPORTED'], [3, 'DOMAIN_INVALID'], [4, 'DOMAIN_INVALID'], [5, 'DOMAIN_INVALID'], [6, 'ROW_INVALID'],
      [7, 'PRICE_INVALID'], [8, 'PRICE_INVALID'], [9, 'DATE_IN_FUTURE'], [10, 'DATE_INVALID'], [11, 'DATE_INVALID'], [12, 'VENUE_INVALID'], [13, 'SOURCE_INVALID'], [14, 'SOURCE_URL_INVALID'],
    ]);
    expect(b.rejects[0]).toEqual({ row: 2, domain: 'foo.net', reason: 'TLD_NOT_SUPPORTED' });
    const rows = await db.selectFrom('engine_sales').selectAll().orderBy('id').execute();
    expect(rows.map((r) => [r.domain, r.price_cents, r.sale_date, r.source_url])).toEqual([['septicdrone.com', 150000, '2026-09-01', null], ['plain-name9.com', 9950, '2026-09-01', 'https://x.test/1']]);
    const up = await db.selectFrom('engine_uploads').selectAll().executeTakeFirstOrThrow();
    expect(up).toMatchObject({ kind: 'sales', received_n: 15, accepted_n: 2, rejected_n: 13, by: 'gavriel', audit_id: b.audit_id });
    expect(rows.every((r) => r.upload_id === up.id)).toBe(true);
  });

  it('EN-1b (v5.41.0): a row whose venue, source or source_url names NameBio is refused SOURCE_NAMEBIO_FORBIDDEN (its terms forbid training models on its data)', async () => {
    const { w } = await setup();
    const res = await post('/engine/sales', w, { rows: [
      sale(), sale({ domain: 'nb1.com', venue: 'NameBio' }), sale({ domain: 'nb2.com', source: 'namebio daily' }), sale({ domain: 'nb3.com', source_url: 'https://namebio.com/x' }),
    ] });
    expect(res.statusCode, res.body).toBe(201);
    expect(res.json().rejects.map((r: { row: number; reason: string }) => [r.row, r.reason])).toEqual([[1, 'SOURCE_NAMEBIO_FORBIDDEN'], [2, 'SOURCE_NAMEBIO_FORBIDDEN'], [3, 'SOURCE_NAMEBIO_FORBIDDEN']]);
    expect((await db.selectFrom('engine_sales').select('domain').execute()).map((r) => r.domain)).toEqual(['septicdrone.com']);
  });

  it('EN-2: a sale within 20 days of a stored sale of the same name is a duplicate (also inside one call and across calls); 21 days is not', async () => {
    const { w } = await setup();
    const first = (await post('/engine/sales', w, { rows: [sale({ sale_date: '2026-09-01' }), sale({ sale_date: '2026-09-21' }), sale({ sale_date: '2026-09-10' }), sale({ sale_date: '2026-08-12' }), sale({ domain: 'other.com', sale_date: '2026-09-02' })] })).json();
    // 09-01 stored; 09-21 is 20 days later: duplicate; 09-10 duplicate; 08-12 is 20 days earlier: duplicate; other name stored
    expect(first).toMatchObject({ accepted_n: 2, duplicate_n: 3, rejected_n: 0 });
    const second = (await post('/engine/sales', w, { rows: [sale({ sale_date: '2026-09-22' }), sale({ sale_date: '2026-08-11' }), sale({ sale_date: '2026-09-05' })] })).json();
    expect(second).toMatchObject({ accepted_n: 2, duplicate_n: 1 }); // 21 days after and 21 days before are new sales; 09-05 is a duplicate
    const ups = await db.selectFrom('engine_uploads').select(['accepted_n', 'duplicate_n']).orderBy('id').execute();
    expect(ups).toEqual([{ accepted_n: 2, duplicate_n: 3 }, { accepted_n: 2, duplicate_n: 1 }]);
    expect((await db.selectFrom('engine_sales').select('id').execute()).length).toBe(4);
  });

  it('EN-3: unsold rows: type, date and catcher flag are checked; the same name on the same day is a duplicate whatever its type', async () => {
    const { w } = await setup();
    const res = await post('/engine/unsold', w, { rows: [
      unsold(), unsold({ type: 'registered_unsold' }), unsold({ observation_date: '2026-10-09', caught_by_catcher: true }), unsold({ domain: 'x.com', type: 'sold' }),
      unsold({ domain: 'y.com', observation_date: '2026-10-15' }), unsold({ domain: 'z.com', caught_by_catcher: 'yes' }), unsold({ domain: 'w.org' }), unsold({ domain: 'n.com', caught_by_catcher: null }),
    ] });
    expect(res.statusCode, res.body).toBe(201);
    const b = res.json();
    expect(b).toMatchObject({ received_n: 8, accepted_n: 3, duplicate_n: 1, rejected_n: 4 });
    expect(b.rejects.map((r: { reason: string }) => r.reason)).toEqual(['TYPE_INVALID', 'DATE_IN_FUTURE', 'CAUGHT_BY_CATCHER_INVALID', 'TLD_NOT_SUPPORTED']);
    const rows = await db.selectFrom('engine_unsold').select(['domain', 'type', 'observation_date', 'caught_by_catcher']).orderBy('id').execute();
    expect(rows).toEqual([
      { domain: 'septicdrone.com', type: 'dropped_after_held', observation_date: '2026-10-08', caught_by_catcher: null },
      { domain: 'septicdrone.com', type: 'dropped_after_held', observation_date: '2026-10-09', caught_by_catcher: true },
      { domain: 'n.com', type: 'dropped_after_held', observation_date: '2026-10-08', caught_by_catcher: null },
    ]);
    const again = (await post('/engine/unsold', w, { rows: [unsold(), unsold({ observation_date: '2026-10-10' })] })).json();
    expect(again).toMatchObject({ accepted_n: 1, duplicate_n: 1 });
  });

  it('EN-4: the same Idempotency-Key returns the stored answer and stores nothing again', async () => {
    const { w } = await setup();
    const key = randomUUID();
    const a = await post('/engine/sales', w, { rows: [sale()] }, key);
    const b = await post('/engine/sales', w, { rows: [sale()] }, key);
    expect(b.statusCode).toBe(201);
    expect(b.headers['idempotent-replayed']).toBe('true');
    expect(b.json()).toEqual(a.json());
    expect((await db.selectFrom('engine_sales').select('id').execute()).length).toBe(1);
    expect((await db.selectFrom('engine_uploads').select('id').execute()).length).toBe(1);
    const noKey = await app.inject({ method: 'POST', url: '/engine/sales', headers: w, payload: { rows: [sale()] } });
    expect(noKey.statusCode).toBe(400);
    expect(noKey.json().error.code).toBe('IDEMPOTENCY_KEY_REQUIRED');
  });

  it('EN-5: no token gives 401, a READ token on a POST gives 403 SCOPE_FORBIDDEN, and READ may read the health', async () => {
    const { r } = await setup();
    expect((await app.inject({ method: 'POST', url: '/engine/sales', headers: { 'idempotency-key': randomUUID() }, payload: { rows: [sale()] } })).statusCode).toBe(401);
    const res = await post('/engine/unsold', r, { rows: [unsold()] });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('SCOPE_FORBIDDEN');
    expect((await app.inject({ method: 'GET', url: '/engine/health' })).statusCode).toBe(401);
    expect((await app.inject({ method: 'GET', url: '/engine/health', headers: r })).statusCode).toBe(200);
    expect((await db.selectFrom('engine_uploads').select('id').execute()).length).toBe(0);
  });

  it('EN-6: 0 rows, more than 20,000 rows, a missing rows key and an unknown key give 422 VALIDATION_ERROR', async () => {
    const { w } = await setup();
    for (const body of [{ rows: [] }, {}, { rows: [sale()], extra: 1 }, { rows: 'x' }, { rows: Array.from({ length: 20_001 }, (_, i) => ({ domain: `n${i}.com` })) }]) {
      const res = await post('/engine/sales', w, body);
      expect(res.statusCode, JSON.stringify(body).slice(0, 40)).toBe(422);
      expect(res.json().error.code).toBe('VALIDATION_ERROR');
    }
    expect((await db.selectFrom('engine_uploads').select('id').execute()).length).toBe(0);
  });

  it('EN-7: 20,000 rows fit in one call; the audit log keeps the row count, not the rows; rejects are capped at 200', async () => {
    const { w } = await setup();
    const rows = Array.from({ length: 20_000 }, (_, i) => (i < 250 ? { domain: `bad${i}.org`, price_usd: 10, sale_date: '2026-09-01', venue: 'v', source: 's' } : sale({ domain: `name${i}x.com`, price_usd: 100 + (i % 50) })));
    const res = await post('/engine/sales', w, { rows });
    expect(res.statusCode, res.body.slice(0, 300)).toBe(201);
    const b = res.json();
    expect(b).toMatchObject({ received_n: 20_000, accepted_n: 19_750, duplicate_n: 0, rejected_n: 250 });
    expect(b.rejects).toHaveLength(200);
    expect(b.rejects[199].row).toBe(199);
    const up = await db.selectFrom('engine_uploads').select(['rejected_n', 'rejects']).executeTakeFirstOrThrow();
    expect(up.rejected_n).toBe(250);
    expect((up.rejects as unknown[]).length).toBe(200);
    const audit = await db.selectFrom('audit_log').select(['request', 'result_summary']).where('path', '=', '/engine/sales').executeTakeFirstOrThrow();
    expect(JSON.stringify(audit.request)).toContain('[20000 rows]');
    expect(JSON.stringify(audit.request).length).toBeLessThan(200);
    expect(audit.result_summary).toContain('19750 accepted');
  }, 60_000);

  it('EN-8: the stored sales and unsold rows cannot be changed or deleted', async () => {
    const { w } = await setup();
    await post('/engine/sales', w, { rows: [sale()] });
    await post('/engine/unsold', w, { rows: [unsold()] });
    for (const t of ['engine_sales', 'engine_unsold', 'engine_uploads']) {
      await expect(db.deleteFrom(t as 'engine_sales').execute()).rejects.toThrow();
    }
    await expect(db.updateTable('engine_sales').set({ price_cents: 1 }).execute()).rejects.toThrow();
  });

  it('EN-9: GET /engine/health on an empty database', async () => {
    const { r } = await setup();
    const res = await app.inject({ method: 'GET', url: '/engine/health', headers: r });
    const h = res.json();
    expect(h.bars.map((b: { id: number }) => b.id)).toEqual([1, 2, 3, 4, 5, 6]); // 5.6.0, see health.test.ts
    delete h.bars;
    expect(h).toEqual({
      model_version: null, trained_at: null, train_rows: null, test: null, chosen_weighting: null, last_training: null, ablation: null, bar4_pass: null, drift: null, slices: null, bars_passed: [],
      data: { sales_n: 0, unsold_n: 0, auction_ends_n: { opening: 0, low: 0, mid: 0, total: 0 }, auction_ends_newest: null, sales_newest: null, unsold_newest: null, data_age_days: { sold: null, unsold: null }, last_upload: { sales: null, unsold: null } },
      endings: { names_n: 0, pairs_n: 0, checked_n: 0, unknown_n: 0, pending_n: 0, by_tld: Object.fromEntries(['net', 'co', 'org', 'io', 'ai', 'com'].map((t) => [t, { checked_n: 0, registered_n: 0, unknown_n: 0, pending_n: 0 }])) },
    });
  });

  it('EN-10: GET /engine/health counts rows, newest dates, age in days, last uploads and the pairs waiting for the endings fill', async () => {
    const { w, r } = await setup();
    await post('/engine/sales', w, { rows: [sale({ sale_date: '2026-09-01' }), sale({ domain: 'second.com', sale_date: '2026-10-10' })] });
    await post('/engine/unsold', w, { rows: [unsold(), unsold({ domain: 'third.com', observation_date: '2026-10-13' })] });
    const h = (await app.inject({ method: 'GET', url: '/engine/health', headers: r })).json();
    expect(h.model_version).toBeNull();
    expect(h.data).toMatchObject({ sales_n: 2, unsold_n: 2, sales_newest: '2026-10-10', unsold_newest: '2026-10-13', data_age_days: { sold: 4, unsold: 1 } });
    expect(h.data.last_upload.sales).toMatchObject({ received_n: 2, accepted_n: 2, duplicate_n: 0, rejected_n: 0, by: 'gavriel' });
    expect(h.data.last_upload.unsold).toMatchObject({ upload_id: 2, accepted_n: 2 });
    expect(h.endings).toMatchObject({ names_n: 3, pairs_n: 18, checked_n: 0, unknown_n: 0, pending_n: 18 });
    expect(h.endings.by_tld.net).toEqual({ checked_n: 0, registered_n: 0, unknown_n: 0, pending_n: 3 });
  });
});
