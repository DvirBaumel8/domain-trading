import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { dbAuditWriter, type AuditWriter } from '../../../src/http/audit.js';
import { makeApp, sideEffects } from '../../helpers/app.js';
import { testDb as db } from '../../helpers/db.js';
import { issueToken } from '../../helpers/tokens.js';

let app: FastifyInstance;
afterEach(async () => app?.close());

async function post(url: string, key: string | undefined, payload: unknown, auth: Record<string, string>) {
  const headers: Record<string, string> = { ...auth, 'content-type': 'application/json' };
  if (key !== undefined) headers['idempotency-key'] = key;
  return app.inject({ method: 'POST', url, headers, payload: typeof payload === 'string' ? payload : JSON.stringify(payload) });
}

describe('idempotency (ID)', () => {
  it('ID-1: missing key → 400 IDEMPOTENCY_KEY_REQUIRED, handler not run', async () => {
    app = await makeApp();
    const { auth } = await issueToken('write');
    const res = await post('/__test/echo', undefined, { value: 'x' }, auth);
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('IDEMPOTENCY_KEY_REQUIRED');
    expect(sideEffects.count).toBe(0);
  });

  it('ID-1: empty or oversized key → 400', async () => {
    app = await makeApp();
    const { auth } = await issueToken('write');
    expect((await post('/__test/echo', '', { value: 'x' }, auth)).statusCode).toBe(400);
    expect((await post('/__test/echo', 'k'.repeat(256), { value: 'x' }, auth)).statusCode).toBe(400);
  });

  it('ID-2: same key + same body → stored response replayed with Idempotent-Replayed: true; side effect once', async () => {
    app = await makeApp();
    const { auth } = await issueToken('write');
    const a = await post('/__test/echo', 'k1', { value: 'x' }, auth);
    const b = await post('/__test/echo', 'k1', { value: 'x' }, auth);
    expect(a.statusCode).toBe(201);
    expect(b.statusCode).toBe(201);
    expect(b.body).toBe(a.body);
    expect(b.headers['idempotent-replayed']).toBe('true');
    expect(a.headers['idempotent-replayed']).toBeUndefined();
    expect(sideEffects.count).toBe(1);
  });

  it('canonical body hashing: same body, different key order and whitespace → replay', async () => {
    app = await makeApp();
    const { auth } = await issueToken('write');
    await post('/__test/echo', 'k-order', '{"value":"x","approval_ref":{"text":"t","approved_at":"2026-10-04T09:00:00Z"}}', auth);
    const b = await post('/__test/echo', 'k-order', '{ "approval_ref": {"approved_at":"2026-10-04T09:00:00Z","text":"t"},  "value": "x" }', auth);
    expect(b.headers['idempotent-replayed']).toBe('true');
    expect(sideEffects.count).toBe(1);
  });

  it('a stored 4xx (422) is replayed too', async () => {
    app = await makeApp();
    const { auth } = await issueToken('write');
    const a = await post('/__test/echo', 'k-422', { nope: 1 }, auth);
    const b = await post('/__test/echo', 'k-422', { nope: 1 }, auth);
    expect(a.statusCode).toBe(422);
    expect(b.statusCode).toBe(422);
    expect(b.headers['idempotent-replayed']).toBe('true');
  });

  it('ID-3: same key, different body → 409 IDEMPOTENCY_KEY_MISMATCH, not executed', async () => {
    app = await makeApp();
    const { auth } = await issueToken('write');
    await post('/__test/echo', 'k2', { value: 'x' }, auth);
    const res = await post('/__test/echo', 'k2', { value: 'y' }, auth);
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('IDEMPOTENCY_KEY_MISMATCH');
    expect(sideEffects.count).toBe(1);
  });

  it('ID-3: same key on a different path → 409 mismatch', async () => {
    app = await makeApp();
    const { auth } = await issueToken('write');
    await post('/__test/echo', 'k3', { value: 'x' }, auth);
    expect((await post('/__test/slow', 'k3', { value: 'x' }, auth)).statusCode).toBe(409);
  });

  it('concurrent same key: one executes, the other gets 409 IDEMPOTENCY_KEY_IN_USE', async () => {
    app = await makeApp();
    const { auth } = await issueToken('write');
    const [a, b] = await Promise.all([post('/__test/slow', 'k-c', {}, auth), post('/__test/slow', 'k-c', {}, auth)]);
    const codes = [a.statusCode, b.statusCode].sort();
    expect(codes).toEqual([201, 409]);
    const conflict = a.statusCode === 409 ? a : b;
    expect(conflict.json().error.code).toBe('IDEMPOTENCY_KEY_IN_USE');
    expect(sideEffects.count).toBe(1);
  });

  it('500 releases the key: a retry with the same key runs again, and both attempts are audited', async () => {
    app = await makeApp();
    const { auth } = await issueToken('write');
    expect((await post('/__test/boom', 'k-500', {}, auth)).statusCode).toBe(500);
    expect((await post('/__test/boom', 'k-500', {}, auth)).statusCode).toBe(500);
    expect(sideEffects.count).toBe(2);
    const rows = await db.selectFrom('idempotency_keys').selectAll().where('key', '=', 'k-500').execute();
    expect(rows).toHaveLength(0);
    const audits = await db.selectFrom('audit_log').selectAll().where('idempotency_key', '=', 'k-500').execute();
    expect(audits).toHaveLength(2);
  });

  it('403 and 401 responses are not stored under the key', async () => {
    app = await makeApp();
    const r = await issueToken('read');
    const w = await issueToken('write');
    expect((await post('/__test/echo', 'k-scope', { value: 'x' }, r.auth)).statusCode).toBe(403);
    expect((await post('/__test/echo', 'k-scope', { value: 'x' }, w.auth)).statusCode).toBe(201);
  });

  it('replays write their own audit row marked replayed', async () => {
    app = await makeApp();
    const { auth } = await issueToken('write');
    await post('/__test/echo', 'k-aud', { value: 'x' }, auth);
    await post('/__test/echo', 'k-aud', { value: 'x' }, auth);
    const audits = await db
      .selectFrom('audit_log').select(['result_summary']).where('idempotency_key', '=', 'k-aud').orderBy('at').execute();
    expect(audits.map((a) => a.result_summary)).toEqual(['ok', 'replayed:ok']);
  });

  it('audit failure keeps stored result: client gets 500 AUDIT_WRITE_FAILED, retry replays without re-executing', async () => {
    const real = dbAuditWriter(db);
    let failNext = true;
    const flaky: AuditWriter = {
      async write(row) {
        if (failNext) {
          failNext = false;
          throw new Error('db down');
        }
        await real.write(row);
      },
    };
    app = await makeApp({ audit: flaky });
    const { auth } = await issueToken('write');
    const a = await post('/__test/echo', 'k-af', { value: 'x' }, auth);
    expect(a.statusCode).toBe(500);
    expect(a.json().error.code).toBe('AUDIT_WRITE_FAILED');
    const b = await post('/__test/echo', 'k-af', { value: 'x' }, auth);
    expect(b.statusCode).toBe(201);
    expect(b.headers['idempotent-replayed']).toBe('true');
    expect(sideEffects.count).toBe(1);
  });
});
