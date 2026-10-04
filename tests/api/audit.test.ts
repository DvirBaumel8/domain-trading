import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { makeApp } from '../helpers/app.js';
import { testDb as db } from '../helpers/db.js';
import { issueToken } from '../helpers/tokens.js';

let app: FastifyInstance;
afterEach(async () => app?.close());

const httpAuditRows = () =>
  db.selectFrom('audit_log').selectAll().where('method', '<>', 'ADMIN').orderBy('at').execute();

const approval = { text: 'yes buy examplecityroofing.com', approved_at: '2026-10-04T09:10:00+03:00' };

describe('audit (AL)', () => {
  it('AL-1: exactly one audit row per POST: success, 401, 403, 400, 422, 500', async () => {
    app = await makeApp();
    const w = await issueToken('write');
    const r = await issueToken('read');
    const calls = [
      { headers: { ...w.auth, 'idempotency-key': 'a1' }, payload: { value: 'ok' }, url: '/__test/echo' },  // 201
      { headers: {}, payload: { value: 'x' }, url: '/__test/echo' },                                          // 401
      { headers: { ...r.auth, 'idempotency-key': 'a2' }, payload: { value: 'x' }, url: '/__test/echo' },  // 403
      { headers: { ...w.auth }, payload: { value: 'x' }, url: '/__test/echo' },                              // 400 (Task 6)
      { headers: { ...w.auth, 'idempotency-key': 'a3' }, payload: { nope: 1 }, url: '/__test/echo' },     // 422
      { headers: { ...w.auth, 'idempotency-key': 'a4' }, payload: {}, url: '/__test/boom' },               // 500
    ];
    for (const c of calls) await app.inject({ method: 'POST', ...c });
    const rows = await httpAuditRows();
    expect(rows).toHaveLength(calls.length);
    expect(new Set(rows.map((x) => x.id)).size).toBe(calls.length);
  });

  it('GET requests write no audit row', async () => {
    app = await makeApp();
    const { auth } = await issueToken('read');
    await app.inject({ method: 'GET', url: '/__test/ping', headers: auth });
    expect(await httpAuditRows()).toHaveLength(0);
  });

  it('AL-3: row has scope, token id, approval text/time, idempotency key, status, summary, request; no token', async () => {
    app = await makeApp();
    const w = await issueToken('write');
    await app.inject({
      method: 'POST', url: '/__test/echo',
      headers: { ...w.auth, 'idempotency-key': 'k-al3' },
      payload: { value: 'hello', approval_ref: approval },
    });
    const [row] = await httpAuditRows();
    expect(row).toMatchObject({
      token_id: w.id,
      scope: 'write',
      method: 'POST',
      path: '/__test/echo',
      idempotency_key: 'k-al3',
      approval_text: approval.text,
      status_code: 201,
      result_summary: 'ok',
    });
    expect(row!.id).toMatch(/^aud_[0-9a-f]{32}$/);
    expect(row!.approval_at?.toISOString()).toBe('2026-10-04T06:10:00.000Z');
    expect(row!.request).toMatchObject({ value: 'hello' });
    expect(JSON.stringify(row)).not.toContain(w.token);
  });

  it('AL-3: an error row carries the error code as summary', async () => {
    app = await makeApp();
    const w = await issueToken('write');
    await app.inject({
      method: 'POST', url: '/__test/echo', headers: { ...w.auth, 'idempotency-key': 'k-422' }, payload: { nope: 1 },
    });
    const [row] = await httpAuditRows();
    expect(row).toMatchObject({ status_code: 422, result_summary: 'VALIDATION_ERROR' });
  });

  it('a 401 row has no token and scope', async () => {
    app = await makeApp();
    await app.inject({ method: 'POST', url: '/__test/echo', payload: { value: 'x' } });
    const [row] = await httpAuditRows();
    expect(row).toMatchObject({ token_id: null, scope: null, status_code: 401, result_summary: 'UNAUTHORIZED' });
  });

  it('an unparseable approved_at keeps the text and stores a null time', async () => {
    app = await makeApp();
    const w = await issueToken('write');
    await app.inject({
      method: 'POST', url: '/__test/echo', headers: { ...w.auth, 'idempotency-key': 'k-bad-date' },
      payload: { value: 'x', approval_ref: { text: 'yes', approved_at: 'yesterday' } },
    });
    const [row] = await httpAuditRows();
    expect(row).toMatchObject({ approval_text: 'yes', approval_at: null });
  });

  it('a Fastify framework error (bad percent-encoding) gets the error envelope and exactly one audit row', async () => {
    app = await makeApp();
    const w = await issueToken('write');
    const res = await app.inject({
      method: 'POST', url: '/__test/echo%ZZ', headers: { ...w.auth, 'idempotency-key': 'k-fw' }, payload: { value: 'x' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('INVALID_REQUEST');
    expect(await httpAuditRows()).toHaveLength(1);
  });
});
