// v5.18.0 (CR-068): POST /visits/settings {token: "request"} and `admin visits-token-handoff` (--done, --failed). IDs V518-16.. are listed in docs/internal/visits.md.
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { promisify } from 'node:util';
import { sql } from 'kysely';
import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { makeApp } from '../../helpers/app.js';
import { testDb as db } from '../../helpers/db.js';
import { testEnv } from '../../helpers/env.js';
import { FakeAdapter } from '../../helpers/fake-adapter.js';
import { issueToken } from '../../helpers/tokens.js';

const run = promisify(execFile);
const cli = (args: string[]) => run('npx', ['tsx', 'src/modules/ops/admin.ts', ...args], { env: { ...process.env, ...testEnv() } });
const NOW = Date.parse('2026-10-20T09:00:00Z');
let app: FastifyInstance;
afterEach(async () => app?.close());
const approval = (text: string) => ({ text, approved_at: '2026-10-20T11:30:00+03:00' });
const post = (url: string, h: Record<string, string>, payload: unknown) => app.inject({ method: 'POST', url, headers: { ...h, 'idempotency-key': randomUUID() }, payload: payload as object });
const tokens = () => db.selectFrom('api_tokens').select(['id', 'name', 'scope', 'revoked_at']).where('name', '=', 'visit-counter').orderBy('id').execute();
const state = () => db.selectFrom('settings').select(['visits_token_request', 'visits_token_requested_at', 'visits_token_issued_at']).executeTakeFirstOrThrow();

describe('visits token hand-off', () => {
  it('V518-16: POST /visits/settings {token:"request"} needs no approval line (5.19.0), is WRITE only and audited; it sets visits.token_request to requested', async () => {
    app = await makeApp({ adapters: [new FakeAdapter('porkbun')], now: () => NOW });
    const w = (await issueToken('write')).auth;
    const r = (await issueToken('read')).auth;
    await db.updateTable('settings').set({ visits_token_request: null, visits_token_requested_at: null }).execute(); // the 5.19.0 migration requests it; start clean
    expect((await post('/visits/settings', r, { token: 'request' })).statusCode).toBe(403);
    expect((await post('/visits/settings', w, { token: 'other' })).statusCode).toBe(422);
    expect((await post('/visits/settings', w, {})).statusCode).toBe(422);
    expect((await state()).visits_token_request).toBeNull();
    const ok = await post('/visits/settings', w, { token: 'request' });
    expect(ok.statusCode, ok.body).toBe(200);
    expect(ok.json()).toMatchObject({ token_request: 'requested', token_request_before: null });
    expect((await state()).visits_token_request).toBe('requested');
    const a = await db.selectFrom('audit_log').select('result_summary').where('path', '=', '/visits/settings').where('status_code', '=', 200).execute();
    expect(a.map((x) => x.result_summary)).toEqual(['visits token requested (was none)']);
  });

  it('V518-17: admin visits-token-handoff prints nothing and exits 3 when nothing is requested; with a request it prints only the raw token, revokes older visit-counter tokens, and creates a visits-scope token', async () => {
    await db.updateTable('settings').set({ visits_token_request: null, visits_token_requested_at: null }).execute(); // the 5.19.0 migration requests it; start clean
    await expect(cli(['visits-token-handoff'])).rejects.toMatchObject({ code: 3, stdout: '' });
    expect(await tokens()).toEqual([]);
    await cli(['token', 'create', '--scope', 'visits', '--name', 'visit-counter']); // an older one
    await db.updateTable('settings').set({ visits_token_request: 'requested', visits_token_requested_at: new Date(NOW) }).execute();
    const { stdout } = await cli(['visits-token-handoff']);
    expect(stdout).toMatch(/^dt_[A-Za-z0-9_-]{43}\n$/);
    const rows = await tokens();
    expect(rows.map((t) => [t.scope, t.revoked_at !== null])).toEqual([['visits', true], ['visits', false]]);
    expect((await state()).visits_token_request).toBe('requested'); // issued only after --done
    const raw = stdout.trim();
    const all = JSON.stringify(await db.selectFrom('audit_log').selectAll().execute()) + JSON.stringify(await db.selectFrom('api_tokens').selectAll().execute());
    expect(all).not.toContain(raw);
  });

  it('V518-18: --done marks the request issued (once); --failed revokes the newest visit-counter token and leaves the request open', async () => {
    await db.updateTable('settings').set({ visits_token_request: 'requested', visits_token_requested_at: new Date(NOW) }).execute();
    await cli(['visits-token-handoff']);
    await cli(['visits-token-handoff', '--failed']);
    expect((await tokens()).map((t) => t.revoked_at !== null)).toEqual([true]);
    expect((await state()).visits_token_request).toBe('requested');
    await cli(['visits-token-handoff']); // the next tick tries again
    expect((await tokens()).map((t) => t.revoked_at !== null)).toEqual([true, false]);
    await cli(['visits-token-handoff', '--done']);
    const s = await state();
    expect(s.visits_token_request).toBe('issued');
    expect(s.visits_token_issued_at).not.toBeNull();
    await expect(cli(['visits-token-handoff'])).rejects.toMatchObject({ code: 3, stdout: '' }); // nothing requested any more
    await expect(cli(['visits-token-handoff', '--done'])).rejects.toMatchObject({ code: 3 });
    expect((await tokens()).map((t) => t.revoked_at !== null)).toEqual([true, false]);
  });
});

describe('visits 5.19.0', () => {
  it('V519-1: a freshly migrated database has the counter on and the visit-counter token requested (no call, no approval line)', async () => {
    const col = await sql<{ d: string }>`select column_default as d from information_schema.columns where table_name = 'settings' and column_name = 'visits_enabled'`.execute(db);
    expect(col.rows[0]!.d).toBe('true');
    const up = readFileSync('migrations/1765000000000_v5-19-0.sql', 'utf8').split('-- Down Migration')[0]!;
    expect(up).toMatch(/UPDATE public\.settings SET visits_enabled = true;/);
    expect(up).toMatch(/visits_token_request = 'requested'.*WHERE visits_token_request IS NULL/);
  });
});

describe('visits 5.20.0', () => {
  it('V520-1: the migration deletes the visit_daily rows of the UTC day 2026-10-19 (BUG-046: all test hits) and nothing else', () => {
    const up = readFileSync('migrations/1765100000000_v5-20-0.sql', 'utf8').split('-- Down Migration')[0]!;
    const deletes = up.match(/DELETE FROM public\.visit_daily[^;]*;/g) ?? [];
    expect(deletes).toEqual(["DELETE FROM public.visit_daily WHERE date_utc = DATE '2026-10-19';"]);
  });
});
