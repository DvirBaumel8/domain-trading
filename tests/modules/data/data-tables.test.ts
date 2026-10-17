// v5.12.0 (CR-063): POST/GET /data/{rdap,live-checks,tm-kills,bigco-names,sales-comps}, the append-only tables, the holdout guard, the size guard and the retention step.
import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { RetentionJob } from '../../../src/modules/ops/jobs/retention.js';
import { makeApp } from '../../helpers/app.js';
import { testDb as db } from '../../helpers/db.js';
import { FakeAdapter } from '../../helpers/fake-adapter.js';
import { issueToken } from '../../helpers/tokens.js';

let app: FastifyInstance;
afterEach(async () => app?.close());
const NOW = Date.parse('2026-10-17T09:00:00Z');
const HOUR = 3_600_000;
const DAY = 86_400_000;
const iso = (ms: number) => new Date(ms).toISOString();
async function setup(extra: Record<string, unknown> = {}) {
  app = await makeApp({ adapters: [new FakeAdapter('porkbun')], now: () => NOW, ...extra });
  return { w: (await issueToken('write', 'gavriel')).auth, d: (await issueToken('data', 'data-engineer-upload')).auth, r: (await issueToken('read')).auth };
}
const post = (url: string, h: Record<string, string>, payload: unknown, key: string = randomUUID()) =>
  app.inject({ method: 'POST', url, headers: { ...h, 'idempotency-key': key }, payload: payload as object });
const get = (url: string, h: Record<string, string>) => app.inject({ method: 'GET', url, headers: h });
async function intake(domain: string) {
  await db.insertInto('candidate_intake').values({ domain, lane: 'S2', source: 'scout', token_name: 'test', status: 'queued' } as never).execute();
}
const rdap = (host: string, o: Record<string, unknown> = {}) => ({ host, kind: 'rdap', created: '2015-03-04T00:00:00Z', expires: '2027-03-04T00:00:00Z', registrar: 'Example Registrar', reg: true, checked_utc: iso(NOW - HOUR), ...o });
const comp = (o: Record<string, unknown> = {}) => ({ domain: 'septicdrone.com', sale_date: '2026-09-01', price_usd: 1500, tier: 'T2', year_flag: 'ok', sale_year: 2026, reg_date_at_sale: '2019-01-02', net_reg_at_sale: 'no', org_reg_at_sale: 'no', source_url: 'https://example.test/s', dup_sources: '', ...o });

describe('data tables (CR-063)', () => {
  it('DT-1: AC-1: domain_rdap keeps only pool names (intake or kept drop-list row); the rest is skipped_not_in_pool_n and not stored', async () => {
    const { d } = await setup();
    await intake('inpool.com');
    await db.insertInto('drop_lists').values({ name: 'dl1', list_date: '2026-10-16', created_by: 'test', received_n: 2, kept_n: 1 }).execute();
    await db.insertInto('drop_list_rows').values([{ list_name: 'dl1', domain: 'droplist.com', kept: true, reason: null, tokens: null }, { list_name: 'dl1', domain: 'dropped.com', kept: false, reason: 'x', tokens: null }]).execute();
    const res = await post('/data/rdap', d, { rows: [rdap('inpool.com'), rdap('outside.com'), rdap('bad_host'), rdap('inpool.com', { reg: 'maybe' }), rdap('droplist.com'), rdap('dropped.com')] });
    expect(res.statusCode, res.body).toBe(201);
    expect(res.json()).toMatchObject({ table: 'domain_rdap', received_n: 6, accepted_n: 2, duplicate_n: 0, rejected_n: 2, skipped_not_in_pool_n: 2 });
    expect((await db.selectFrom('domain_rdap').select('host').orderBy('host').execute()).map((r) => r.host)).toEqual(['droplist.com', 'inpool.com']);
    expect(res.json().rejects.map((r: { row: number; reason: string }) => [r.row, r.reason])).toEqual([[2, 'DOMAIN_INVALID'], [3, 'REG_INVALID']]);
  });

  it('DT-2: an rdap reload with a newer check updates the row, an older or equal one is a duplicate; dry_run stores nothing', async () => {
    const { d } = await setup();
    await intake('inpool.com');
    expect((await post('/data/rdap', d, { rows: [rdap('inpool.com')], dry_run: true })).json()).toMatchObject({ dry_run: true, accepted_n: 1 });
    expect(await db.selectFrom('domain_rdap').select('id').execute()).toEqual([]);
    await post('/data/rdap', d, { rows: [rdap('inpool.com')] });
    expect((await post('/data/rdap', d, { rows: [rdap('inpool.com')] })).json()).toMatchObject({ accepted_n: 0, duplicate_n: 1 });
    expect((await post('/data/rdap', d, { rows: [rdap('inpool.com', { reg: false, checked_utc: iso(NOW - 1000) })] })).json()).toMatchObject({ accepted_n: 1 });
    expect((await db.selectFrom('domain_rdap').select('reg').execute())).toEqual([{ reg: false }]);
  });

  it('DT-3: AC-2: GET /data/rdap marks a row older than 24 h stale; /check and /buy never read domain_rdap', async () => {
    const { d, r } = await setup();
    await intake('fresh.com'); await intake('old.com');
    await post('/data/rdap', d, { rows: [rdap('fresh.com', { checked_utc: iso(NOW - 23 * HOUR) }), rdap('old.com', { checked_utc: iso(NOW - 25 * HOUR) })] });
    const body = (await get('/data/rdap', r)).json();
    const by = Object.fromEntries(body.rows.map((x: { host: string; stale: boolean }) => [x.host, x.stale]));
    expect(by).toEqual({ 'fresh.com': false, 'old.com': true });
    expect((await get('/data/rdap?host=old.com', r)).json().rows).toHaveLength(1);
    expect((await get('/data/rdap?since=2026-10-16T09:00:00Z', r)).json().count).toBe(1);
    const { readdirSync, readFileSync } = await import('node:fs');
    for (const f of ['src/modules/registrars/check.ts', 'src/modules/buying/buy.ts']) expect(readFileSync(f, 'utf8')).not.toContain('domain_rdap');
    expect(readdirSync('src/modules/registrars').length).toBeGreaterThan(0);
  });

  it('DT-4: live_checks load, duplicate on the same (host, source, checked_at), source validated', async () => {
    const { d, r } = await setup();
    const row = { host: 'a.com', source: 'live', label: 'ok', park: 'none', checked_utc: iso(NOW - HOUR), value_json: { status: 200 } };
    const res = await post('/data/live-checks', d, { rows: [row, row, { ...row, host: 'b.com', source: 'weird' }, { ...row, source: 'cc', checked_utc: 'nope' }] });
    expect(res.json()).toMatchObject({ accepted_n: 1, duplicate_n: 1, rejected_n: 2 });
    const rows = (await get('/data/live-checks', r)).json().rows;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ host: 'a.com', source: 'live', value_json: { status: 200 } });
  });

  it('DT-5: AC-3: the retention step deletes live rows over 3 days and cc rows over 14 days, and rdap rows of names that left the pool; tm_kills/bigco_names/sales_comps stay', async () => {
    const { d } = await setup();
    const at = (days: number) => iso(NOW - days * DAY);
    await post('/data/live-checks', d, { rows: [
      { host: 'l1.com', source: 'live', checked_utc: at(4) }, { host: 'l2.com', source: 'live', checked_utc: at(2) },
      { host: 'f1.com', source: 'livefail', checked_utc: at(4) },
      { host: 'c1.com', source: 'cc', checked_utc: at(15) }, { host: 'c2.com', source: 'cc', checked_utc: at(10) },
    ] });
    await intake('stay.com');
    await post('/data/rdap', d, { rows: [rdap('stay.com')] });
    // a name that left the pool since it was loaded (a loaded row whose intake name is gone)
    await db.insertInto('domain_rdap').values({ host: 'leaves.com', created: null, expires: null, registrar: null, reg: true, checked_at: new Date(NOW) }).execute();
    await post('/data/tm-kills', d, { rows: [{ term: 'acme', reason: 'tm', source: 'x' }] });
    await post('/data/bigco-names', d, { rows: [{ name: 'bigco', reason: 'big', source: 'x' }] });
    await post('/data/sales-comps', d, { rows: [comp()] });
    const job = new RetentionJob({ db, now: () => NOW, dbBytes: async () => 1000, storageLimitBytes: 1_000_000 });
    const dry = await job.runOnce({ dryRun: true });
    expect('tables' in dry && dry.tables.live_checks!.deleted).toBe(3);
    const s = await job.runOnce();
    expect('tables' in s && s.tables.live_checks!.deleted).toBe(3);
    expect('tables' in s && s.tables.domain_rdap!.deleted).toBe(1);
    expect((await db.selectFrom('live_checks').select('host').orderBy('host').execute()).map((x) => x.host)).toEqual(['c2.com', 'l2.com']);
    expect((await db.selectFrom('domain_rdap').select('host').execute()).map((x) => x.host)).toEqual(['stay.com']);
    for (const t of ['tm_kills', 'bigco_names', 'sales_comps'] as const) expect(await db.selectFrom(t).select('id').execute()).toHaveLength(1);
  });

  it('DT-6: AC-4: UPDATE and DELETE on tm_kills and bigco_names fail; a correction row with supersedes is accepted; an unknown supersedes id is rejected', async () => {
    const { d } = await setup();
    await post('/data/tm-kills', d, { rows: [{ term: 'acme', reason: 'wrong', source: 'csv', raw: { k: 1 } }] });
    await post('/data/bigco-names', d, { rows: [{ name: 'bigco', reason: 'big', source: 'csv' }] });
    for (const t of ['tm_kills', 'bigco_names']) {
      await expect(sql`update ${sql.table(t)} set reason = 'x'`.execute(db)).rejects.toThrow(/append-only/);
      await expect(sql`delete from ${sql.table(t)}`.execute(db)).rejects.toThrow(/append-only/);
    }
    const id = (await db.selectFrom('tm_kills').select('id').executeTakeFirstOrThrow()).id;
    const res = await post('/data/tm-kills', d, { rows: [{ term: 'acme', reason: 'corrected', source: 'csv', supersedes: id }, { term: 'acme2', supersedes: 9999 }, { term: 'acme', reason: 'wrong', source: 'csv' }] });
    expect(res.json()).toMatchObject({ accepted_n: 1, duplicate_n: 1, rejected_n: 1, rejects: [{ row: 1, reason: 'SUPERSEDES_NOT_FOUND' }] });
    expect(await db.selectFrom('tm_kills').select('supersedes').orderBy('id').execute()).toEqual([{ supersedes: null }, { supersedes: id }]);
    expect((await post('/data/bigco-names', d, { rows: [{ name: '' }] })).json().rejects[0].reason).toBe('NAME_INVALID');
  });

  it('DT-11: M6 GET /data/tm-kills and /data/bigco-names filter case-insensitively on a term loaded with capitals', async () => {
    const { d, r } = await setup();
    await post('/data/tm-kills', d, { rows: [{ term: 'Acme Corp', reason: 'tm' }] });
    await post('/data/bigco-names', d, { rows: [{ name: 'BigCo' }] });
    const t = await get('/data/tm-kills?host=ACME%20corp', r);
    expect(t.json()).toMatchObject({ count: 1, rows: [{ term: 'Acme Corp' }] });
    expect((await get('/data/bigco-names?host=bigco', r)).json()).toMatchObject({ count: 1, rows: [{ name: 'BigCo' }] });
    expect((await get('/data/bigco-names?host=other', r)).json().count).toBe(0);
  });

  it('DT-7: AC-5: sales_comps rejects HOLDOUT_SEALED (after 2026-10-14), DATE_INVALID and a missing date, links engine_sale_id on a domain+date+price match, and counts add up', async () => {
    const { d, r } = await setup();
    const up = await db.insertInto('engine_uploads').values({ kind: 'sales', received_n: 0, accepted_n: 0, duplicate_n: 0, rejected_n: 0, rejects: '[]', by: 'test', audit_id: null, created_at: new Date(NOW) }).returning('id').executeTakeFirstOrThrow();
    const es = await db.insertInto('engine_sales').values({ domain: 'septicdrone.com', price_cents: 150_000, sale_date: '2026-09-01', venue: 'namebio', source: 'x', source_url: null, upload_id: up.id }).returning('id').executeTakeFirstOrThrow();
    const rows = [comp(), comp({ domain: 'sealed.com', sale_date: '2026-10-15' }), comp({ domain: 'nodate.com', sale_date: undefined }), comp({ domain: 'baddate.com', sale_date: '2026-02-30' }),
      comp({ domain: 'edge.com', sale_date: '2026-10-14' }), comp({ domain: 'tier.com', tier: 'T9' }), comp({ domain: 'yr.com', sale_year: 2025 }), comp()];
    const res = await post('/data/sales-comps', d, { rows });
    const b = res.json();
    expect(b).toMatchObject({ received_n: 8, accepted_n: 2, duplicate_n: 1, rejected_n: 5 });
    expect(b.accepted_n + b.duplicate_n + b.rejected_n).toBe(b.received_n);
    expect(b.rejects.map((x: { row: number; reason: string }) => x.reason)).toEqual(['HOLDOUT_SEALED', 'DATE_INVALID', 'DATE_INVALID', 'TIER_INVALID', 'SALE_YEAR_INVALID']);
    const got = (await get('/data/sales-comps', r)).json().rows;
    expect(got.find((x: { domain: string }) => x.domain === 'septicdrone.com')).toMatchObject({ engine_sale_id: es.id, price_cents: 150_000, price: '$1,500.00', tier: 'T2' });
    expect(got.find((x: { domain: string }) => x.domain === 'edge.com').engine_sale_id).toBeNull();
  });

  it('DT-8: AC-6: every load returns db_bytes_before/after and rows per table; the audit row names the counts and elides the rows', async () => {
    const { d } = await setup({ engineDbSize: { bytes: async () => 12_345 } });
    const rows = Array.from({ length: 25 }, (_, i) => ({ term: `term${i}` }));
    const b = (await post('/data/tm-kills', d, { rows })).json();
    expect(b).toMatchObject({ db_bytes_before: 12_345, db_bytes_after: 12_345, rows: { domain_rdap: 0, live_checks: 0, tm_kills: 25, bigco_names: 0, sales_comps: 0 } });
    const a = await db.selectFrom('audit_log').select(['result_summary', 'request']).where('path', '=', '/data/tm-kills').executeTakeFirstOrThrow();
    expect(a.result_summary).toContain('25 accepted');
    expect(JSON.stringify(a.request)).toContain('[25 rows]');
  });

  it('DT-9: AC-6: when the size plus the payload would pass 70% of 1 GB the load is refused with 409 DB_SIZE_HIGH and nothing is stored', async () => {
    const limit = 1024 ** 3; // 5.13.0: Neon free is 1 GB
    const { d } = await setup({ engineDbSize: { bytes: async () => limit * 0.7 - 10 } });
    for (const [p, row] of [['rdap', rdap('a.com')], ['live-checks', { host: 'a.com', source: 'live', checked_utc: iso(NOW) }], ['tm-kills', { term: 'x' }], ['bigco-names', { name: 'x' }], ['sales-comps', comp()]] as const) {
      const res = await post(`/data/${p}`, d, { rows: [row] });
      expect(res.statusCode, p).toBe(409);
      expect(res.json().error).toMatchObject({ code: 'DB_SIZE_HIGH', details: { warn_percent: 70, limit_bytes: limit } });
    }
    expect(await db.selectFrom('tm_kills').select('id').execute()).toEqual([]);
  });

  it('DT-10: AC-7: a READ token gets every GET and 403 on every load; a data token loads (and a WRITE token too) but gets 403 on the GETs', async () => {
    const { w, d, r } = await setup();
    for (const p of ['rdap', 'live-checks', 'tm-kills', 'bigco-names', 'sales-comps']) {
      expect((await get(`/data/${p}`, r)).statusCode, p).toBe(200);
      expect((await get(`/data/${p}`, w)).statusCode, p).toBe(200);
      expect((await post(`/data/${p}`, r, { rows: [{}] })).statusCode, p).toBe(403);
      expect((await get(`/data/${p}`, d)).statusCode, p).toBe(403);
      expect((await post(`/data/${p}`, d, { rows: [{}] })).statusCode, p).toBe(201);
      expect((await post(`/data/${p}`, w, { rows: [{}] })).statusCode, p).toBe(201);
    }
    expect((await app.inject({ method: 'POST', url: '/data/tm-kills', headers: d, payload: { rows: [{ term: 'x' }] } })).statusCode).toBe(400);
    expect((await post('/data/tm-kills', d, { rows: [] })).statusCode).toBe(422);
    expect((await get('/data/rdap?limit=0', r)).statusCode).toBe(422);
  });
});
