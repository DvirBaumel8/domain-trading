// v5.63.0 (CR-084 R-7): POST /decisions, GET /decisions, GET /decisions/{id}. IDs DEC-1..DEC-10, CR084-AT3, CR084-AT5, CR084-AT6.
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { makeApp } from '../../helpers/app.js';
import { insertOwnedDomain, testDb as db } from '../../helpers/db.js';
import { FakeAdapter } from '../../helpers/fake-adapter.js';
import { issueToken } from '../../helpers/tokens.js';

let app: FastifyInstance;
afterEach(async () => app?.close());
let clock = Date.parse('2026-10-27T09:00:00Z');

type H = Record<string, string>;
const call = (method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', url: string, h: H, payload?: unknown, key: string = randomUUID()) => {
  clock += 10_000; // stay under the general write limit
  return app.inject({ method, url, headers: { ...h, ...(method !== 'GET' ? { 'idempotency-key': key } : {}) }, ...(payload !== undefined ? { payload: payload as object } : {}) });
};
async function setup() {
  clock = Date.parse('2026-10-27T09:00:00Z');
  app = await makeApp({ adapters: [new FakeAdapter('porkbun')], now: () => clock });
  return {
    bots: (await issueToken('bots', 'bots-shared')).auth, write: (await issueToken('write', 'gavriel')).auth, read: (await issueToken('read', 'reader')).auth,
    data: (await issueToken('data', 'loader')).auth,
  };
}
const dec = (o: object = {}) => ({ id: 'D-2026-10-27-D005-PRICE', decided_at: '2026-10-27T02:44:00+03:00', decided_by: 'dvir', summary: 'One place per durable fact: the DOM database.', scope: 'strategy', ...o });

describe('CR-084 decisions store', () => {
  it('DEC-1 (CR084-AT6) POST /decisions then GET /decisions and GET /decisions/{id} round-trip a D-id; no price or listing is touched', async () => {
    const { bots, read } = await setup();
    await insertOwnedDomain(db, { domain: 'keepme.com', status: 'listed', listing_mode: 'hybrid', bin_cents: 148800, floor_cents: 96700, walkaway_cents: 71500, min_offer_cents: 10000 });
    const before = await db.selectFrom('domains').selectAll().execute();
    const r = await call('POST', '/decisions', bots, { rows: [dec({ domains: ['KeepMe.com'], source_ref: 'widget t981u' })] });
    expect(r.statusCode, r.body).toBe(201);
    expect(r.json()).toMatchObject({ dry_run: false, received_n: 1, accepted_n: 1, duplicate_n: 0, ids: ['D-2026-10-27-D005-PRICE'] });
    const one = (await call('GET', '/decisions/D-2026-10-27-D005-PRICE', read)).json();
    expect(one).toMatchObject({ id: 'D-2026-10-27-D005-PRICE', decided_by: 'dvir', scope: 'strategy', domains: ['keepme.com'], source_ref: 'widget t981u', supersedes: null, superseded_by: null, recorded_by: 'bots-shared' });
    expect(one.decided_at).toBe('2026-10-27T01:44:00+02:00'); // the same instant, shown in Asia/Jerusalem (winter time since 25 Oct)
    const list = (await call('GET', '/decisions', read)).json();
    expect(list).toMatchObject({ total_n: 1, limit: 100, offset: 0 });
    expect(list.decisions[0]).toEqual(one);
    expect(await db.selectFrom('domains').selectAll().execute()).toEqual(before);
  });

  it('DEC-2 the same id with the same content is a duplicate (201, accepted 0); the same id with other content is 409 DECISION_EXISTS and nothing is stored', async () => {
    const { write } = await setup();
    expect((await call('POST', '/decisions', write, { rows: [dec()] })).statusCode).toBe(201);
    const again = await call('POST', '/decisions', write, { rows: [dec(), dec({ id: 'D-2026-10-27-D006-X' })] });
    expect(again.statusCode, again.body).toBe(201);
    expect(again.json()).toMatchObject({ received_n: 2, accepted_n: 1, duplicate_n: 1, ids: ['D-2026-10-27-D006-X'] });
    const clash = await call('POST', '/decisions', write, { rows: [dec({ id: 'D-2026-10-27-D007-Y' }), dec({ summary: 'A different text' })] });
    expect(clash.statusCode).toBe(409);
    expect(clash.json().error).toMatchObject({ code: 'DECISION_EXISTS', details: { ids: ['D-2026-10-27-D005-PRICE'] } });
    expect(await db.selectFrom('decisions').select('id').orderBy('id').execute()).toEqual([{ id: 'D-2026-10-27-D005-PRICE' }, { id: 'D-2026-10-27-D006-X' }]);
  });

  it('DEC-3 a correction is a new id with supersedes; the old row shows superseded_by; an unknown or self supersedes is 422', async () => {
    const { write, read } = await setup();
    await call('POST', '/decisions', write, { rows: [dec()] });
    const fix = await call('POST', '/decisions', write, { rows: [dec({ id: 'D-2026-10-27-D005-PRICE-2', summary: 'Corrected wording', supersedes: 'D-2026-10-27-D005-PRICE' })] });
    expect(fix.statusCode, fix.body).toBe(201);
    expect((await call('GET', '/decisions/D-2026-10-27-D005-PRICE', read)).json().superseded_by).toBe('D-2026-10-27-D005-PRICE-2');
    expect((await call('GET', '/decisions/D-2026-10-27-D005-PRICE-2', read)).json().supersedes).toBe('D-2026-10-27-D005-PRICE');
    for (const supersedes of ['D-NOPE-1', 'D-SELF-1']) {
      const bad = await call('POST', '/decisions', write, { rows: [dec({ id: 'D-SELF-1', supersedes })] });
      expect(bad.statusCode, supersedes).toBe(422);
      expect(bad.json().error.code).toBe('VALIDATION_ERROR');
    }
    // a batch may supersede an earlier row of the same batch
    const batch = await call('POST', '/decisions', write, { rows: [dec({ id: 'D-B-1' }), dec({ id: 'D-B-2', supersedes: 'D-B-1' })] });
    expect(batch.statusCode, batch.body).toBe(201);
  });

  it('DEC-4 rows are validated and nothing is stored on any error: bad id, long summary, bad scope, unknown field, empty rows, 501 rows; an @ is 422 NO_PII', async () => {
    const { write } = await setup();
    const cases: [string, unknown][] = [
      ['bad id', { rows: [dec({ id: 'x' })] }], ['id with a space', { rows: [dec({ id: 'D 1 x' })] }], ['summary over 1000', { rows: [dec({ summary: 'a'.repeat(1001) })] }],
      ['empty summary', { rows: [dec({ summary: '' })] }], ['bad scope', { rows: [dec({ scope: 'Pricing Rules' })] }], ['unknown field', { rows: [dec({ price_cents: 5 })] }],
      ['decided_at without an offset', { rows: [dec({ decided_at: '2026-10-27T02:44:00' })] }], ['empty rows', { rows: [] }], ['501 rows', { rows: Array.from({ length: 501 }, (_, i) => dec({ id: `D-LOT-${i}` })) }],
    ];
    for (const [what, body] of cases) {
      const r = await call('POST', '/decisions', write, body);
      expect(r.statusCode, what).toBe(422);
      expect(r.json().error.code, what).toBe('VALIDATION_ERROR');
    }
    for (const row of [dec({ summary: 'mail dvir@example.com' }), dec({ source_ref: 'a@b' }), dec({ decided_by: 'x@y' })]) {
      const r = await call('POST', '/decisions', write, { rows: [row] });
      expect(r.statusCode).toBe(422);
      expect(r.json().error.code).toBe('NO_PII');
    }
    expect(await db.selectFrom('decisions').select('id').execute()).toEqual([]);
  });

  it('DEC-5 dry_run answers 200 and stores nothing; 500 rows are accepted', async () => {
    const { write } = await setup();
    const d = await call('POST', '/decisions', write, { rows: [dec()], dry_run: true });
    expect(d.statusCode).toBe(200);
    expect(d.json()).toMatchObject({ dry_run: true, accepted_n: 1 });
    expect(await db.selectFrom('decisions').select('id').execute()).toEqual([]);
    const big = await call('POST', '/decisions', write, { rows: Array.from({ length: 500 }, (_, i) => dec({ id: `D-LOT-${i}` })) });
    expect(big.statusCode, big.body.slice(0, 300)).toBe(201);
    expect(big.json().accepted_n).toBe(500);
  });

  it('DEC-6 GET /decisions filters: q (id or summary, case-insensitive, % and _ literal), scope, domain, since; newest decision first; limit and offset; total_n', async () => {
    const { write, read } = await setup();
    await call('POST', '/decisions', write, { rows: [
      dec({ id: 'D-1', decided_at: '2026-10-01T10:00:00+03:00', summary: 'Price ladder stays', scope: 'pricing', domains: ['alpha.com'] }),
      dec({ id: 'D-2', decided_at: '2026-10-10T10:00:00+03:00', summary: 'Sedo is off for new work', scope: 'listing' }),
      dec({ id: 'D-3_X', decided_at: '2026-10-20T10:00:00+03:00', summary: '50% discount rule', scope: 'pricing', domains: ['alpha.com', 'beta.com'] }),
    ] });
    const ids = async (q: string) => ((await call('GET', `/decisions${q}`, read)).json().decisions as { id: string }[]).map((d) => d.id);
    expect(await ids('')).toEqual(['D-3_X', 'D-2', 'D-1']);
    expect(await ids('?q=SEDO')).toEqual(['D-2']);
    expect(await ids('?q=d-3_x')).toEqual(['D-3_X']);
    expect(await ids('?q=%25')).toEqual(['D-3_X']); // a literal %
    expect(await ids('?q=_')).toEqual(['D-3_X']);   // a literal _
    expect(await ids('?scope=pricing')).toEqual(['D-3_X', 'D-1']);
    expect(await ids('?domain=ALPHA.com')).toEqual(['D-3_X', 'D-1']);
    expect(await ids('?domain=beta.com&scope=pricing')).toEqual(['D-3_X']);
    expect(await ids('?since=2026-10-05')).toEqual(['D-3_X', 'D-2']);
    expect(await ids('?limit=1&offset=1')).toEqual(['D-2']);
    expect((await call('GET', '/decisions?scope=pricing&limit=1', read)).json().total_n).toBe(2);
    for (const bad of ['?limit=0', '?limit=501', '?offset=-1', '?since=yesterday', '?nope=1', '?scope=Bad Scope']) expect((await call('GET', `/decisions${bad}`, read)).statusCode, bad).toBe(400);
  });

  it('DEC-7 GET /decisions/{id}: 404 DECISION_NOT_FOUND for an unknown id and for a malformed one', async () => {
    const { read } = await setup();
    for (const id of ['D-MISSING-1', 'x']) {
      const r = await call('GET', `/decisions/${id}`, read);
      expect(r.statusCode, id).toBe(404);
      expect(r.json().error.code).toBe('DECISION_NOT_FOUND');
    }
  });

  it('DEC-8 scopes: a READ token cannot POST (403); READ, bots and WRITE can GET; a data token cannot do either; a request without a token is 401', async () => {
    const { read, bots, write, data } = await setup();
    expect((await call('POST', '/decisions', read, { rows: [dec()] })).statusCode).toBe(403);
    expect((await call('POST', '/decisions', data, { rows: [dec()] })).statusCode).toBe(403);
    expect((await call('POST', '/decisions', bots, { rows: [dec()] })).statusCode).toBe(201);
    for (const h of [read, bots, write]) expect((await call('GET', '/decisions', h)).statusCode).toBe(200);
    expect((await call('GET', '/decisions', data)).statusCode).toBe(403);
    expect((await call('GET', '/decisions', {})).statusCode).toBe(401);
  });

  it('DEC-9 the table is append-only: UPDATE, DELETE and TRUNCATE are refused; PUT, PATCH and DELETE routes do not exist', async () => {
    const { write } = await setup();
    await call('POST', '/decisions', write, { rows: [dec()] });
    await expect(db.updateTable('decisions').set({ summary: 'changed' }).execute()).rejects.toThrow();
    await expect(db.deleteFrom('decisions').execute()).rejects.toThrow();
    const { sql } = await import('kysely');
    await expect(sql`truncate table decisions`.execute(db)).rejects.toThrow();
    for (const m of ['PUT', 'PATCH', 'DELETE'] as const) expect((await call(m, '/decisions/D-2026-10-27-D005-PRICE', write, {})).statusCode, m).toBeGreaterThanOrEqual(400);
  });

  it('DEC-10 POST /decisions is idempotent and audited: the same key and body replays, another body with the key is a mismatch; the audit row names the token and carries the row count summary', async () => {
    const { write } = await setup();
    const key = randomUUID();
    const a = await call('POST', '/decisions', write, { rows: [dec()] }, key);
    const b = await call('POST', '/decisions', write, { rows: [dec()] }, key);
    expect(a.statusCode).toBe(201);
    expect(b.statusCode).toBe(201);
    expect(b.headers['idempotent-replayed']).toBe('true');
    expect((await call('POST', '/decisions', write, { rows: [dec({ id: 'D-OTHER-1' })] }, key)).json().error.code).toBe('IDEMPOTENCY_KEY_MISMATCH');
    expect((await call('POST', '/decisions', write, { rows: [dec()] })).headers['idempotency-key']).toBeUndefined();
    const audit = await db.selectFrom('audit_log').select(['result_summary', 'scope']).where('path', '=', '/decisions').orderBy('at').execute();
    expect(audit[0]).toMatchObject({ scope: 'write', result_summary: 'decisions: 1 accepted, 0 duplicate of 1' });
    const missing = await app.inject({ method: 'POST', url: '/decisions', headers: write, payload: { rows: [dec()] } });
    expect(missing.json().error.code).toBe('IDEMPOTENCY_KEY_REQUIRED');
  });
});
