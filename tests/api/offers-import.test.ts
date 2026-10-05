import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
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
const HEADER = 'domain,amount_usd,source,received_at,buyer_type,external_ref,outcome,note';

async function setup() {
  clock = LISTED;
  app = await makeApp({ adapters: [new FakeAdapter('porkbun')], now: () => clock });
  const w = await issueToken('write', 'gavriel');
  const r = await issueToken('read');
  await insertOwnedDomain(db, { domain: T, category: 'trend', price_grade: null });
  await insertOwnedDomain(db, { domain: G });
  const list = (domain: string, b: object) => app.inject({ method: 'POST', url: `/list/${domain}`, headers: { ...w.auth, 'idempotency-key': randomUUID() }, payload: b });
  expect((await list(T, { mode: 'hybrid', bin: 1995, floor: 1295, walkaway: 950, pricing_exception: true, pricing_exception_reason: 'D-001 approved plan', approval_ref: approval(T) })).statusCode).toBe(200);
  expect((await list(G, { mode: 'bin', bin: 399, approval_ref: approval(G) })).statusCode).toBe(200);
  clock = Date.parse('2026-12-02T09:00:00Z');
  return { w: w.auth, r: r.auth };
}
const imp = (auth: Record<string, string>, csv: string, q = '', key: string | null = randomUUID(), ct = 'text/csv') =>
  app.inject({ method: 'POST', url: `/offers/import${q}`, headers: { ...auth, ...(key ? { 'idempotency-key': key } : {}), 'content-type': ct }, payload: csv });
const line = (o: Partial<Record<string, string>> = {}) =>
  [o.domain ?? T, o.amount ?? '450.00', o.source ?? 'afternic', o.received_at ?? '2026-12-01T09:12:00+02:00', o.buyer_type ?? '', o.external_ref ?? '', o.outcome ?? '', o.note ?? ''].join(',');
const five = () => [1, 2, 3, 4, 5].map((i) => line({ amount: `${400 + i * 100}.00`, external_ref: `AFN-${i}` }));
const file = (...lines: string[]) => [HEADER, ...lines].join('\r\n') + '\r\n';
const count = async () => Number((await db.selectFrom('offers').select(db.fn.countAll().as('n')).executeTakeFirstOrThrow()).n);
const imports = () => db.selectFrom('offer_imports').selectAll().execute();

describe('POST /offers/import', () => {
  it('OF-13: dry run with 5 valid rows writes nothing', async () => {
    const { w } = await setup();
    const res = await imp(w, file(...five()), '?dry_run=true');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ dry_run: true, rows: 5, would_insert: 5, duplicates: 0 });
    expect(Object.values(res.json().by_band as Record<string, number>).reduce((a, b) => a + b, 0)).toBe(5);
    expect(await count()).toBe(0);
    expect(await imports()).toHaveLength(0);
  });

  it('OF-15: bad domain row fails all; then valid file inserts 5; then the same file is a no-op with the same import_id', async () => {
    const { w } = await setup();
    const bad = await imp(w, file(...five(), line({ domain: 'nothere.com', external_ref: 'X' })));
    expect(bad.statusCode).toBe(422);
    expect(bad.json().error.code).toBe('IMPORT_INVALID');
    expect(bad.json().error.details.errors).toContainEqual({ row: 6, field: 'domain', code: 'DOMAIN_NOT_FOUND' });
    expect(await count()).toBe(0);

    const ok = await imp(w, file(...five()));
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ rows: 5, inserted: 5, duplicates: 0 });
    expect(await count()).toBe(5);
    const [row] = await imports();
    expect(row).toMatchObject({ rows: 5, inserted: 5, duplicates: 0, recorded_by: 'gavriel', audit_id: expect.any(String) });
    const offers = await db.selectFrom('offers').selectAll().execute();
    expect(offers.every((o) => o.import_id === row!.id && o.recorded_by === 'gavriel' && o.audit_id !== null)).toBe(true);

    const again = await imp(w, file(...five()));
    expect(again.statusCode).toBe(200);
    expect(again.json()).toMatchObject({ import_id: ok.json().import_id, rows: 5, inserted: 0, duplicates: 5 });
    expect(await count()).toBe(5);
    expect(await imports()).toHaveLength(1);
  });

  it('a wrong header is CSV_HEADER_INVALID', async () => {
    const { w } = await setup();
    const res = await imp(w, 'domain,amount\r\n' + line() + '\r\n');
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe('CSV_HEADER_INVALID');
  });

  it('a 7-column row is a COLUMN_COUNT row error', async () => {
    const { w } = await setup();
    const res = await imp(w, file(line({ external_ref: 'A' }), 'promptinjectionaudit.com,450.00,afternic,2026-12-01T09:12:00+02:00,,,'));
    expect(res.statusCode).toBe(422);
    expect(res.json().error.details.errors).toEqual([{ row: 2, field: 'row', code: 'COLUMN_COUNT' }]);
    expect(await count()).toBe(0);
  });

  it('a quoted note with a comma parses and is stored; LF line endings and a BOM work', async () => {
    const { w } = await setup();
    const csv = '﻿' + [HEADER, line({ external_ref: 'Q1', note: '"asked about renewal, said ""maybe"""' })].join('\n') + '\n';
    const res = await imp(w, csv);
    expect(res.statusCode).toBe(200);
    expect(res.json().inserted).toBe(1);
    expect((await db.selectFrom('offers').select('note').executeTakeFirstOrThrow()).note).toBe('asked about renewal, said "maybe"');
  });

  it('outcome: declined sets outcome and outcome_at; countered needs approval; unknown is invalid', async () => {
    const { w } = await setup();
    const okRes = await imp(w, file(line({ external_ref: 'O1', outcome: 'declined' })));
    expect(okRes.statusCode).toBe(200);
    expect(await db.selectFrom('offers').select(['outcome', 'outcome_at']).executeTakeFirstOrThrow()).toMatchObject({ outcome: 'declined', outcome_at: new Date(clock) });

    const res = await imp(w, file(line({ external_ref: 'O2', outcome: 'countered' }), line({ external_ref: 'O3', outcome: 'accepted' }), line({ external_ref: 'O4', outcome: 'sold' }), line({ external_ref: 'O5', outcome: 'bogus' })));
    expect(res.statusCode).toBe(422);
    expect(res.json().error.details.errors).toEqual([
      { row: 1, field: 'outcome', code: 'OUTCOME_NEEDS_APPROVAL' },
      { row: 2, field: 'outcome', code: 'OUTCOME_NEEDS_APPROVAL' },
      { row: 3, field: 'outcome', code: 'OUTCOME_NEEDS_APPROVAL' },
      { row: 4, field: 'outcome', code: 'OUTCOME_INVALID' },
    ]);
  });

  it('a duplicate row inside the file counts once as a duplicate', async () => {
    const { w } = await setup();
    const res = await imp(w, file(line({ external_ref: 'D1' }), line({ external_ref: 'D1' }), line({ amount: '500.00' }), line({ amount: '500.00' })));
    expect(res.json()).toMatchObject({ rows: 4, inserted: 2, duplicates: 2 });
    expect(await count()).toBe(2);
  });

  it('a row already in the DB (recorded via another file) is a duplicate', async () => {
    const { w } = await setup();
    await imp(w, file(line({ external_ref: 'A1' })));
    const res = await imp(w, file(line({ external_ref: 'A1' }), line({ external_ref: 'A2' })));
    expect(res.json()).toMatchObject({ rows: 2, inserted: 1, duplicates: 1 });
    expect(await imports()).toHaveLength(2);
  });

  it('external_ref used for another domain is an EXTERNAL_REF_CONFLICT row error (DB and in-file)', async () => {
    const { w } = await setup();
    await imp(w, file(line({ external_ref: 'C1' })));
    const res = await imp(w, file(line({ domain: G, external_ref: 'C1' })));
    expect(res.statusCode).toBe(422);
    expect(res.json().error.details.errors).toEqual([{ row: 1, field: 'external_ref', code: 'EXTERNAL_REF_CONFLICT' }]);
    const inFile = await imp(w, file(line({ external_ref: 'C2' }), line({ domain: G, external_ref: 'C2' })));
    expect(inFile.json().error.details.errors).toEqual([{ row: 2, field: 'external_ref', code: 'EXTERNAL_REF_CONFLICT' }]);
  });

  it('shares the single-offer rules: NO_PII, bad amount, source, buyer_type, received_at, future', async () => {
    const { w } = await setup();
    const res = await imp(w, file(
      line({ note: 'a@b.com' }), line({ amount: '-5' }), line({ source: 'nope' }), line({ buyer_type: 'alien' }),
      line({ received_at: '2026-02-30T00:00:00Z' }), line({ received_at: '2027-01-01T00:00:00Z' }), line({ domain: 'bad' }),
    ));
    expect(res.statusCode).toBe(422);
    expect(res.json().error.details.errors).toEqual([
      { row: 1, field: 'note', code: 'NO_PII' }, { row: 2, field: 'amount_usd', code: 'AMOUNT_INVALID' },
      { row: 3, field: 'source', code: 'SOURCE_INVALID' }, { row: 4, field: 'buyer_type', code: 'BUYER_TYPE_INVALID' },
      { row: 5, field: 'received_at', code: 'VALIDATION_ERROR' }, { row: 6, field: 'received_at', code: 'RECEIVED_AT_IN_FUTURE' },
      { row: 7, field: 'domain', code: 'DOMAIN_INVALID' },
    ]);
  });

  it('imported rows are classified like single offers (snapshot, band)', async () => {
    const { w } = await setup();
    await imp(w, file(line({ external_ref: 'S1', amount: '450.00' })));
    expect(await db.selectFrom('offers').select(['band', 'routing', 'outcome', 'walkaway_cents_at']).executeTakeFirstOrThrow())
      .toMatchObject({ band: 'below_walkaway', routing: 'auto_decline', outcome: 'declined_auto', walkaway_cents_at: 95000 });
  });

  it('a READ token gets 403; a missing Idempotency-Key gets 400', async () => {
    const { r, w } = await setup();
    expect((await imp(r, file(line()))).statusCode).toBe(403);
    const res = await imp(w, file(line()), '', null);
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('IDEMPOTENCY_KEY_REQUIRED');
    expect(await count()).toBe(0);
  });

  it('same Idempotency-Key replays the stored response; a different body with it is a mismatch', async () => {
    const { w } = await setup();
    const key = randomUUID();
    const a = await imp(w, file(line({ external_ref: 'R1' })), '', key);
    const b = await imp(w, file(line({ external_ref: 'R1' })), '', key);
    expect(b.statusCode).toBe(200);
    expect(b.headers['idempotent-replayed']).toBe('true');
    expect(b.json()).toEqual(a.json());
    const c = await imp(w, file(line({ external_ref: 'R2' })), '', key);
    expect(c.statusCode).toBe(409);
    expect(c.json().error.code).toBe('IDEMPOTENCY_KEY_MISMATCH');
  });

  it('rejects over 1 MB with 413 INVALID_BODY; the global 64 KB limit does not apply to this route; JSON body is refused', async () => {
    const { w } = await setup();
    const sizeable = file(...Array.from({ length: 700 }, (_, i) => line({ external_ref: `BIG-${i}`, note: 'x'.repeat(60) })));
    expect(sizeable.length).toBeGreaterThan(64 * 1024);
    expect((await imp(w, sizeable, '?dry_run=true')).statusCode).toBe(200);
    const huge = await imp(w, HEADER + '\n' + 'x'.repeat(1024 * 1024 + 10));
    expect(huge.statusCode).toBe(413);
    expect(huge.json().error.code).toBe('INVALID_BODY');
    const json = await imp(w, '{}', '', randomUUID(), 'application/json');
    expect(json.statusCode).toBe(415);
    expect(json.json().error.code).toBe('INVALID_BODY');
  });

  it('the text/csv parser is scoped: POST /offers with text/csv is not accepted', async () => {
    const { w } = await setup();
    const res = await app.inject({ method: 'POST', url: '/offers', headers: { ...w, 'idempotency-key': randomUUID(), 'content-type': 'text/csv' }, payload: 'a' });
    expect(res.statusCode).toBe(415);
  });
});
